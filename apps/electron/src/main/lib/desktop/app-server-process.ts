/** 桌面父进程连接管理；只持有管道/身份，不装配业务或 Runtime。 */
import { spawn } from 'node:child_process'
import type { ChildProcessWithoutNullStreams } from 'node:child_process'
import { isAbsolute, resolve } from 'node:path'
import { JsonRpcPeer, RpcFault, registerPrivateHostBridge } from '@axon/app-server'
import type { PrivateHostBridgeOptions, RpcRequestOptions } from '@axon/app-server'
import { APP_SERVER_METHODS as methods, APP_SERVER_PROTOCOL_VERSION, APP_SERVER_RPC_OPTIONS, APP_SERVER_STOP_TIMEOUT_MS } from '@axon/shared'
import type { AppServerClient, AppServerClientKind, AppServerInitializeResult, RpcJsonValue } from '@axon/shared'

export interface AppServerLaunch {
  executable: string
  /** 开发传独立入口文件；随包执行器可为空，不拼接 Shell 命令。 */
  entryArgs: readonly string[]
  dataDir: string
  homeDir: string
  applicationVersion: string
  zimaPython?: string
  cwd?: string
  environment?: NodeJS.ProcessEnv
}
export type AppServerProcessState = 'idle' | 'starting' | 'ready' | 'unavailable' | 'stopping' | 'stopped'
export interface AppServerProcessOptions {
  launch: AppServerLaunch
  credentialCodec: PrivateHostBridgeOptions['credentialCodec']
  confirmChannelTarget?: PrivateHostBridgeOptions['confirmChannelTarget']
  /** 可信桌面在握手前安装固定通知/反向 UI 方法；不把 peer 暴露给 renderer。 */
  configurePeer?: (peer: JsonRpcPeer) => void
  onState?: (state: AppServerProcessState) => void
  startupTimeoutMs?: number
  stopTimeoutMs?: number
}
type BusinessMethod = Exclude<typeof methods[keyof typeof methods], typeof methods.INITIALIZE | typeof methods.REGISTER_CLIENT | typeof methods.DETACH_CLIENT>
interface ClientEntry { client: AppServerClient; controller: AbortController }

function object(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
}
function member(value: unknown, allowed: readonly string[]): value is string {
  return typeof value === 'string' && allowed.includes(value)
}

/** 只认可同一启动配置的响应；错误版本/目录/能力不能把桌面推进 ready。 */
function initializeResult(value: RpcJsonValue, launch: AppServerLaunch): AppServerInitializeResult {
  if (!object(value) || value.protocolVersion !== APP_SERVER_PROTOCOL_VERSION
    || typeof value.connectionId !== 'string' || !value.connectionId
    || value.applicationVersion !== launch.applicationVersion || value.dataDirectory !== resolve(launch.dataDir)
    || !object(value.capabilities) || !member(value.capabilities.credentialStorage, ['safe-storage', 'unavailable'])
    || typeof value.capabilities.channelTargetConfirmation !== 'boolean' || !Array.isArray(value.capabilities.runtimes)) throw new Error('后端握手响应无效')
  const runtimes = value.capabilities.runtimes
  if (runtimes.length !== 2 || new Set(runtimes.map((item) => object(item) ? item.runtimeId : undefined)).size !== 2) throw new Error('后端能力响应无效')
  for (const item of runtimes) {
    if (!object(item) || !member(item.runtimeId, ['pi', 'zima']) || typeof item.configured !== 'boolean'
      || !object(item.capabilities) || typeof item.capabilities.thinkingLevel !== 'boolean' || typeof item.capabilities.osSandbox !== 'boolean'
      || !member(item.capabilities.nestedProjectInstructions, ['automatic', 'manual']) || !object(item.sandbox)
      || typeof item.sandbox.supported !== 'boolean' || item.capabilities.osSandbox !== item.sandbox.supported
      || !Array.isArray(item.sandbox.modes) || !item.sandbox.modes.every((mode) => member(mode, ['readOnly', 'workspaceWrite']))
      || !Array.isArray(item.sandbox.sandboxedTools) || !item.sandbox.sandboxedTools.every((tool) => member(tool, ['bash', 'read', 'write', 'edit', 'grep', 'glob', 'ls']))
      || item.sandbox.limitation !== undefined && !member(item.sandbox.limitation, ['hostExecutorUnavailable', 'partialToolDelegation', 'runtimeToolDelegationUnavailable', 'platformUnsupported'])) throw new Error('后端能力响应无效')
  }
  return value as unknown as AppServerInitializeResult
}

/** 一个实例管理一个实际子进程；失败不自动重建/重投，关闭窗口不等于停止后端。 */
export class AppServerProcess {
  private currentState: AppServerProcessState = 'idle'
  private child?: ChildProcessWithoutNullStreams
  private connection?: JsonRpcPeer
  private starting?: Promise<AppServerInitializeResult>
  private initialized?: AppServerInitializeResult
  private stopping?: Promise<void>
  private exited?: Promise<void>
  private readonly clients = new Map<string, ClientEntry>()

  constructor(private readonly options: AppServerProcessOptions) {
    const launch = options.launch
    if (![launch.executable, launch.dataDir, launch.homeDir].every((path) => isAbsolute(path) && !path.includes('\0'))
      || !launch.applicationVersion.trim() || launch.applicationVersion.length > 100 || /[\r\n\0]/.test(launch.applicationVersion)
      || launch.entryArgs.some((arg) => arg.includes('\0'))
      || [options.startupTimeoutMs ?? 30_000, options.stopTimeoutMs ?? APP_SERVER_STOP_TIMEOUT_MS].some((ms) => !Number.isSafeInteger(ms) || ms <= 0)) throw new Error('后端启动配置无效')
  }
  get state(): AppServerProcessState { return this.currentState }
  get pid(): number | undefined { return this.child?.pid }
  getClientSignal(clientId: string): AbortSignal | undefined { return this.clients.get(clientId)?.controller.signal }

  private setState(state: AppServerProcessState): void {
    this.currentState = state
    try { this.options.onState?.(state) } catch { console.warn('[应用服务] 桌面状态投影失败') }
  }
  private invalidateClients(): void {
    const entries = [...this.clients.values()]
    this.clients.clear()
    for (const entry of entries) entry.controller.abort()
  }
  private unavailable(): void {
    if (this.currentState === 'stopping' || this.currentState === 'stopped' || this.currentState === 'unavailable') return
    this.setState('unavailable')
    this.invalidateClients()
    this.connection?.close()
    // 物理失败先撤销所有交互，再只收束本实例启动的进程；不触碰其他应用进程。
    void this.stop().catch(() => console.warn('[应用服务] 子进程退出未确认'))
  }

  /** 并发启动复用同一握手；日志只消费不回显，私有方法先安装再请求初始化。 */
  start(): Promise<AppServerInitializeResult> {
    if (this.currentState === 'ready') return Promise.resolve(this.initialized!)
    if (this.starting && this.currentState === 'starting') return this.starting
    if (this.currentState !== 'idle') return Promise.reject(new Error('后端连接不可用'))
    this.setState('starting')
    if (this.state !== 'starting') return Promise.reject(new Error('后端启动已中断'))
    this.starting = this.spawnAndInitialize()
    return this.starting
  }
  /** 启动真实 argv 子进程并核对握手；任一失败先收束该进程，再返回固定错误。 */
  private async spawnAndInitialize(): Promise<AppServerInitializeResult> {
    const launch = this.options.launch
    try {
      const child = spawn(launch.executable, [...launch.entryArgs, '--data-dir', launch.dataDir, '--home-dir', launch.homeDir,
        '--application-version', launch.applicationVersion, ...(launch.zimaPython ? ['--zima-python', launch.zimaPython] : [])],
      { shell: false, cwd: launch.cwd, env: launch.environment ?? process.env, stdio: 'pipe' })
      this.child = child
      this.exited = new Promise<void>((done) => child.once('close', () => {
        this.unavailable()
        child.stdin.destroy(); child.stdout.destroy(); child.stderr.destroy()
        done()
      }))
      child.on('error', () => this.unavailable())
      child.stderr.on('error', () => this.unavailable())
      child.stderr.resume()
      const peer = new JsonRpcPeer(child.stdout, child.stdin, APP_SERVER_RPC_OPTIONS)
      this.connection = peer
      peer.onClose(() => this.unavailable())
      const hostCapabilities = registerPrivateHostBridge(peer, { credentialCodec: this.options.credentialCodec,
        getClientSignal: (id) => this.getClientSignal(id), confirmChannelTarget: this.options.confirmChannelTarget })
      this.options.configurePeer?.(peer)
      const result = initializeResult(await peer.request(methods.INITIALIZE, { protocolVersion: APP_SERVER_PROTOCOL_VERSION,
        client: { name: 'axon-desktop', version: launch.applicationVersion }, hostCapabilities }, { timeoutMs: this.options.startupTimeoutMs ?? 30_000 }), launch)
      if (this.currentState !== 'starting' || peer.closed) throw new Error('后端启动已中断')
      if (result.capabilities.credentialStorage !== hostCapabilities.credentialStorage
        || result.capabilities.channelTargetConfirmation !== hostCapabilities.channelTargetConfirmation) throw new Error('后端宿主能力不匹配')
      this.initialized = result
      this.setState('ready')
      if (this.state !== 'ready' || peer.closed) throw new Error('后端启动已中断')
      return result
    } catch {
      this.unavailable()
      await this.stopping?.catch(() => {}) // 启动仍返回统一诊断，清理异常不能泄露原始执行器原因。
      throw new Error('后端启动失败或连接不可用')
    }
  }

  /** 后端生成身份后才登记父端信号；取消等待期间的迟到身份先注销，不能复活页面。 */
  async registerClient(kind: AppServerClientKind, signal?: AbortSignal): Promise<AppServerClient> {
    signal?.throwIfAborted()
    await this.start()
    signal?.throwIfAborted()
    const peer = this.readyPeer()
    let result: RpcJsonValue
    try { result = await peer.request(methods.REGISTER_CLIENT, { kind }) }
    catch (error) {
      // 超时无法确定登记是否已接纳：关闭物理连接清理未知身份，而不是重发登记。
      if (!(error instanceof RpcFault)) this.unavailable()
      throw error
    }
    if (!object(result) || typeof result.clientId !== 'string' || !result.clientId || result.kind !== kind || this.clients.has(result.clientId)) {
      this.unavailable()
      throw new Error('后端客户端登记响应无效')
    }
    const client: AppServerClient = { clientId: result.clientId, kind }
    if (signal?.aborted || this.currentState !== 'ready') {
      if (!peer.closed) await peer.request(methods.DETACH_CLIENT, { clientId: client.clientId }).catch(() => this.unavailable())
      signal?.throwIfAborted()
      throw new Error('后端客户端登记已失效')
    }
    this.clients.set(client.clientId, { client, controller: new AbortController() })
    return client
  }

  /** 先取消本地交互和请求，再注销服务端 owner；晚到答复不等待注销成功才失效。 */
  async detachClient(clientId: string): Promise<boolean> {
    const entry = this.clients.get(clientId)
    if (!entry) return false
    this.clients.delete(clientId)
    entry.controller.abort()
    try { return await this.readyPeer().request(methods.DETACH_CLIENT, { clientId }) === true }
    catch { this.unavailable(); return false }
  }

  /** 主进程固定方法调用；归属/取消由父端登记表确定，不允许业务输入覆盖 clientId。 */
  request(clientId: string, method: BusinessMethod, input?: RpcJsonValue, options: RpcRequestOptions = {}): Promise<RpcJsonValue> {
    const signal = this.getClientSignal(clientId)
    if (!signal || signal.aborted) return Promise.reject(new Error('后端客户端已失效'))
    const combined = options.signal ? AbortSignal.any([signal, options.signal]) : signal
    try { return this.readyPeer().request(method, { clientId, ...(input === undefined ? {} : { input }) }, { ...options, signal: combined }) }
    catch (error) { return Promise.reject(error) }
  }

  /** 仅可信父端使用，用于完整历史客户端；renderer 不能获取原始协议对象。 */
  readyPeer(): JsonRpcPeer {
    if (this.currentState !== 'ready' || !this.connection || this.connection.closed) throw new Error('后端连接不可用')
    return this.connection
  }

  /** 停止先让请求/身份失效，再 EOF；有界升级只发给自有 child，等待实际 close。 */
  stop(): Promise<void> {
    if (this.stopping) return this.stopping
    let done!: () => void, failed!: (error: unknown) => void
    // 先固定幂等 Promise，状态通知回调即使再次退出也不能递归启动清理。
    this.stopping = new Promise<void>((resolve, reject) => { done = resolve; failed = reject })
    this.setState('stopping')
    this.invalidateClients()
    this.connection?.close()
    void this.stopChild().then(done, failed)
    return this.stopping
  }
  /** EOF 留给子进程处理，超时 TERM/KILL 兜底；close 是直接子进程退出证据，不是业务 drain。 */
  private async stopChild(): Promise<void> {
    const child = this.child
    let failed = false
    if (child && this.exited) {
      child.stdout.resume()
      child.stdin.end()
      const timeout = this.options.stopTimeoutMs ?? APP_SERVER_STOP_TIMEOUT_MS
      const terminate = setTimeout(() => { if (child.exitCode === null && child.signalCode === null) child.kill('SIGTERM') }, timeout)
      const kill = setTimeout(() => { if (child.exitCode === null && child.signalCode === null) child.kill('SIGKILL') }, timeout * 2)
      try { await this.exited } finally { clearTimeout(terminate); clearTimeout(kill) }
      // PID 消失只证明进程结束；非零/被信号强杀不能冒充成功清理。
      failed = child.pid !== undefined && (child.exitCode !== 0 || child.signalCode !== null)
    }
    this.setState('stopped')
    if (failed) throw new Error('后端未正常退出')
  }
}
