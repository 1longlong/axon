/** CLI 可信父端只管理自有 child/协议/凭据，不加载 core、宿主执行器或 Runtime。 */
import { spawn } from 'node:child_process'
import type { ChildProcessWithoutNullStreams } from 'node:child_process'
import { isAbsolute } from 'node:path'
import { JsonRpcPeer, RpcFault, registerExecHostBridge, registerPrivateHostBridge } from '@axon/app-server'
import type { RpcRequestOptions } from '@axon/app-server'
import { APP_SERVER_DIRECTORY_LOCK_ERROR, APP_SERVER_METHODS as methods, APP_SERVER_PROTOCOL_VERSION,
  APP_SERVER_RPC_OPTIONS, APP_SERVER_STOP_TIMEOUT_MS } from '@axon/shared'
import type { AppServerClient, AppServerInitializeResult, RpcJsonValue } from '@axon/shared'
import { version } from '../package.json'
import { ExecInputError } from './arguments'
import { checkExecCredential } from './preflight'
import type { PreparedExec } from './preflight'
import { defaultExecBackendLaunch } from './backend-launch'

type BusinessMethod = Exclude<typeof methods[keyof typeof methods],
  typeof methods.INITIALIZE | typeof methods.REGISTER_CLIENT | typeof methods.DETACH_CLIENT>

export interface ExecBackendLaunch {
  executable: string
  /** 仅由可信源码/构建入口选择，不接受用户配置中的任意执行命令。 */
  entryArgs: readonly string[]
}
export interface ExecBackendProcessOptions {
  prepared: PreparedExec
  childEnvironment: NodeJS.ProcessEnv
  launch?: ExecBackendLaunch
  startupTimeoutMs?: number
  stopTimeoutMs?: number
  /** 下一层在握手前安装中立业务通知，不将 raw peer 提供给不可信任务。 */
  configurePeer?: (peer: JsonRpcPeer) => void
  /** 已编译的中立最终输出要求，只交给后端根会话，不传 SDK 私有字段。 */
  finalOutputInstruction?: string
}
export interface ExecBackendExit { code: number | null; signal: NodeJS.Signals | null; spawnFailed: boolean }
export class ExecBackendError extends Error {
  constructor(readonly code: 'busy' | 'unavailable' | 'startup' | 'closed' | 'shutdown') {
    super({ busy: 'CLI 数据目录正被另一后端使用', unavailable: 'CLI 数据目录无法独占',
      startup: 'CLI 后端启动或握手失败，未自动重试', closed: 'CLI 后端连接中断，交付状态未知',
      shutdown: 'CLI 后端未正常退出' }[code])
    this.name = 'ExecBackendError'
  }
}

function object(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
}

/** 确认响应属于本次启动，并以真实宿主能力守住所选沙箱；不接受仅 configured 的声明。 */
function initializeResult(value: RpcJsonValue, prepared: PreparedExec): AppServerInitializeResult {
  if (!object(value) || value.protocolVersion !== APP_SERVER_PROTOCOL_VERSION
    || typeof value.connectionId !== 'string' || !value.connectionId || value.applicationVersion !== version
    || value.dataDirectory !== prepared.dataDir || !object(value.capabilities)
    || value.capabilities.credentialStorage !== 'unavailable' || value.capabilities.channelTargetConfirmation !== false
    || !Array.isArray(value.capabilities.runtimes)) throw new ExecBackendError('startup')
  const runtimes = value.capabilities.runtimes
  if (runtimes.length !== 2 || runtimes.filter((item) => object(item) && item.runtimeId === 'pi').length !== 1
    || runtimes.filter((item) => object(item) && item.runtimeId === 'zima').length !== 1) throw new ExecBackendError('startup')
  for (const item of runtimes) {
    if (!object(item) || typeof item.configured !== 'boolean' || !object(item.capabilities)
      || typeof item.capabilities.thinkingLevel !== 'boolean' || typeof item.capabilities.osSandbox !== 'boolean'
      || !['automatic', 'manual'].includes(String(item.capabilities.nestedProjectInstructions)) || !object(item.sandbox)
      || typeof item.sandbox.supported !== 'boolean' || item.capabilities.osSandbox !== item.sandbox.supported
      || !Array.isArray(item.sandbox.modes) || !item.sandbox.modes.every((mode) => mode === 'readOnly' || mode === 'workspaceWrite')
      || !Array.isArray(item.sandbox.sandboxedTools) || !item.sandbox.sandboxedTools.every((tool) =>
        ['bash', 'read', 'write', 'edit', 'grep', 'glob', 'ls'].includes(String(tool)))
      || item.sandbox.limitation !== undefined && !['hostExecutorUnavailable', 'partialToolDelegation',
        'runtimeToolDelegationUnavailable', 'platformUnsupported'].includes(String(item.sandbox.limitation))) throw new ExecBackendError('startup')
  }
  const pi = runtimes.find((item) => object(item) && item.runtimeId === 'pi') as Record<string, unknown>
  const sandbox = pi.sandbox as Record<string, unknown>
  if (pi.configured !== true || sandbox.supported !== true
    || !(sandbox.modes as unknown[]).includes(prepared.configuration.settings.sandbox)
    || !['bash', 'read', 'write', 'edit', 'grep', 'glob', 'ls'].every((tool) => (sandbox.sandboxedTools as unknown[]).includes(tool))) {
    throw new ExecInputError('Pi 的真实宿主沙箱不可用或不覆盖所选模式，不执行任务')
  }
  return value as unknown as AppServerInitializeResult
}

/** 每次 exec 只拥有一个后端与 external 身份；失败不重建、不重新投递用户任务。 */
export class ExecBackendProcess {
  private state: 'idle' | 'starting' | 'ready' | 'stopping' | 'stopped' = 'idle'
  private readonly lifetime = new AbortController()
  private child?: ChildProcessWithoutNullStreams
  private peer?: JsonRpcPeer
  private client?: AppServerClient
  private exited?: Promise<ExecBackendExit>
  private starting?: Promise<AppServerInitializeResult>
  private stopping?: Promise<void>
  private readonly launch: ExecBackendLaunch
  private authorized?: { channelId: string; provider: string; baseUrl: string }

  constructor(private readonly options: ExecBackendProcessOptions) {
    this.launch = options.launch ?? defaultExecBackendLaunch()
    if (![this.launch.executable, options.prepared.cwd, options.prepared.dataDir, options.prepared.homeDir]
      .every((path) => isAbsolute(path) && !path.includes('\0'))
      || this.launch.entryArgs.some((arg) => arg.includes('\0'))
      || [options.startupTimeoutMs ?? 30_000, options.stopTimeoutMs ?? APP_SERVER_STOP_TIMEOUT_MS]
        .some((ms) => !Number.isSafeInteger(ms) || ms <= 0)) throw new ExecBackendError('startup')
  }
  get signal(): AbortSignal { return this.lifetime.signal }
  get pid(): number | undefined { return this.child?.pid }
  get clientId(): string | undefined { return this.client?.clientId }

  /** 同一实例的并发启动共用一次握手；未完成启动也可由 stop 收束迟到装配。 */
  start(): Promise<AppServerInitializeResult> {
    if (this.starting && (this.state === 'starting' || this.state === 'ready')) return this.starting
    if (this.state !== 'idle') return Promise.reject(new ExecBackendError('closed'))
    this.state = 'starting'
    this.starting = this.initialize()
    return this.starting
  }

  /** 凭据闭包先于握手注册，取锁/能力确认后登记 owner；日志只排空，永不回显原文。 */
  private async initialize(): Promise<AppServerInitializeResult> {
    const { prepared, childEnvironment } = this.options
    try {
      if (prepared.configuration.settings.runtime !== 'pi') throw new ExecInputError('非交互执行首版仅支持 Pi')
      if (prepared.args.kind === 'exec') checkExecCredential(prepared.configuration)
      const environment = { ...childEnvironment }
      delete environment.AXON_API_KEY
      delete environment.AXON_ZIMA_PYTHON
      const child = spawn(this.launch.executable, [...this.launch.entryArgs, '--entry', 'exec',
        '--data-dir', prepared.dataDir, '--home-dir', prepared.homeDir, '--application-version', version],
      { shell: false, cwd: prepared.cwd, env: environment, stdio: 'pipe' })
      this.child = child
      let spawnFailed = false
      this.exited = new Promise((resolve) => {
        child.on('error', () => { spawnFailed = true; this.unavailable() })
        child.once('close', (code, signal) => {
          this.unavailable()
          child.stdin.destroy(); child.stdout.destroy(); child.stderr.destroy()
          resolve({ code, signal, spawnFailed })
        })
      })
      child.stderr.on('error', () => this.unavailable())
      child.stderr.resume()
      const peer = new JsonRpcPeer(child.stdout, child.stdin, APP_SERVER_RPC_OPTIONS)
      this.peer = peer
      peer.onClose(() => this.unavailable())
      const hostCapabilities = registerPrivateHostBridge(peer, {
        credentialCodec: { isSecure: false, storageKind: 'unavailable',
          encrypt: async (value) => { if (value) throw new Error('安全存储不可用'); return '' },
          decrypt: async (value) => { if (value) throw new Error('安全存储不可用'); return '' } },
        getClientSignal: (id) => id === this.client?.clientId ? this.signal : undefined,
      })
      const { settings, channels, channel: selected } = prepared.configuration
      this.authorized = prepared.args.kind === 'exec' && selected?.enabled
        ? { channelId: selected.id, provider: selected.provider, baseUrl: selected.baseUrl } : undefined
      registerExecHostBridge(peer, { bootstrap: {
        channels: channels.map(({ id, name, provider, baseUrl, enabled, models }) => ({ id, name, provider, baseUrl, enabled, models })),
        agent: { systemPrompt: settings.systemPrompt, generateTitle: false,
          ...(this.options.finalOutputInstruction === undefined ? {} : { finalOutputInstruction: this.options.finalOutputInstruction }),
          features: { skills: settings.skills, mcp: settings.mcp, memory: settings.memory, tasks: settings.tasks } },
      }, resolveCredential: (target) => {
        // 恢复完成元数据校验之前不授权任何目标；单次运行授权后不能改投另一渠道。
        const authorized = this.authorized
        if (this.signal.aborted || !authorized || target.channelId !== authorized.channelId
          || target.provider !== authorized.provider || target.baseUrl !== authorized.baseUrl) throw new Error('凭据目标未授权')
        // 每个渠道独立取密钥；默认渠道与恢复的原渠道可以不同，不借用另一渠道凭据。
        return channels.find((channel) => channel.id === authorized.channelId)?.apiKey ?? ''
      } })
      this.options.configurePeer?.(peer)
      const timeoutMs = this.options.startupTimeoutMs ?? 30_000
      const result = initializeResult(await peer.request(methods.INITIALIZE, { protocolVersion: APP_SERVER_PROTOCOL_VERSION,
        client: { name: 'axon-exec', version }, hostCapabilities }, { timeoutMs, signal: this.signal }), prepared)
      const registration = await peer.request(methods.REGISTER_CLIENT, { kind: 'external' }, { timeoutMs, signal: this.signal })
      if (!object(registration) || registration.kind !== 'external' || typeof registration.clientId !== 'string'
        || !registration.clientId || this.signal.aborted || peer.closed || this.state !== 'starting') throw new ExecBackendError('startup')
      this.client = { clientId: registration.clientId, kind: 'external' }
      this.state = 'ready'
      return result
    } catch (error) {
      // 不确定是否已装配/登记时关闭整个自有连接，不能重发或让迟到身份继续执行。
      await this.stop().catch(() => {})
      if (error instanceof ExecInputError || error instanceof ExecBackendError) throw error
      if (error instanceof RpcFault && error.code === APP_SERVER_DIRECTORY_LOCK_ERROR) {
        const busy = object(error.data) && error.data.code === 'busy'
        throw new ExecBackendError(busy ? 'busy' : 'unavailable')
      }
      throw new ExecBackendError('startup')
    }
  }

  /** 目标必须来自已校验的可信配置；恢复元数据只提供 ID，不提供可直接授权的 URL。 */
  authorizeChannel(channelId: string): void {
    this.signal.throwIfAborted()
    if (this.state !== 'ready') throw new ExecBackendError('closed')
    const channel = this.options.prepared.configuration.channels.find((item) => item.id === channelId && item.enabled)
    if (!channel || this.authorized && this.authorized.channelId !== channelId) throw new ExecInputError('恢复渠道未获本次可信配置授权')
    checkExecCredential({ ...this.options.prepared.configuration, channel })
    this.authorized = { channelId, provider: channel.provider, baseUrl: channel.baseUrl }
  }

  /** 物理故障立刻失效当前 owner；清理异步等待实际 close，不生成新后端或新身份。 */
  private unavailable(): void {
    if (this.state === 'stopping' || this.state === 'stopped') return
    this.lifetime.abort(new ExecBackendError('closed'))
    void this.stop().catch(() => { /* 调用者通过 signal/stop 获知失败，不回显底层异常。 */ })
  }

  /** 可信入口使用固定方法，归属自动附加；取消 RPC 不代表业务副作用已撤销。 */
  request(method: BusinessMethod, input?: RpcJsonValue, options: RpcRequestOptions = {}): Promise<RpcJsonValue> {
    if (this.state !== 'ready' || !this.peer || !this.client || this.signal.aborted) return Promise.reject(new ExecBackendError('closed'))
    return this.peer.request(method, { clientId: this.client.clientId, ...(input === undefined ? {} : { input }) },
      { ...options, signal: options.signal ? AbortSignal.any([this.signal, options.signal]) : this.signal })
  }

  /** 先禁止新请求，再 EOF；无论此前收到什么响应，都等待实际 child close 并检查清理结果。 */
  stop(): Promise<void> {
    if (this.stopping) return this.stopping
    let resolve!: () => void, reject!: (error: unknown) => void
    this.stopping = new Promise<void>((done, failed) => { resolve = done; reject = failed })
    this.state = 'stopping'
    this.lifetime.abort(new ExecBackendError('closed'))
    this.client = undefined
    this.peer?.close()
    void this.stopChild().then(resolve, reject)
    return this.stopping
  }

  /** 正常 EOF 给后端 drain 留出期限；升级仅作用于自有 child，强制退出不能算清理成功。 */
  private async stopChild(): Promise<void> {
    const child = this.child
    let failed = false
    if (child && this.exited) {
      child.stdout.resume()
      child.stdin.end()
      let forced = false
      const timeout = this.options.stopTimeoutMs ?? APP_SERVER_STOP_TIMEOUT_MS
      const terminate = setTimeout(() => {
        if (child.exitCode === null && child.signalCode === null) { forced = true; child.kill('SIGTERM') }
      }, timeout)
      const kill = setTimeout(() => {
        forced = true
        if (child.exitCode === null && child.signalCode === null) child.kill('SIGKILL')
        // 直接 child 可能已退出，但异常后代仍持有 stdio；不让它无限阻塞 close。
        // 这是失败兜底，不宣称异常后代已被回收或后端 drain 成功。
        child.stdin.destroy(); child.stdout.destroy(); child.stderr.destroy()
      }, timeout * 2)
      try {
        const exit = await this.exited
        failed = forced || exit.spawnFailed || exit.code !== 0 || exit.signal !== null
      } finally { clearTimeout(terminate); clearTimeout(kill) }
    }
    this.state = 'stopped'
    if (failed) throw new ExecBackendError('shutdown')
  }
}
