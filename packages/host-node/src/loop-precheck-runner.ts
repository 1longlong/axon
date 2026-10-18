/** JS 预检在独立、真实 Seatbelt 进程运行；此模块不装配业务或 Runtime。 */
import { constants, closeSync, fstatSync, lstatSync, mkdtempSync, openSync, readFileSync, realpathSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { AgentSandboxEscalationError } from '@axon/shared'
import type { AgentHostToolExecutionPort, AgentSandboxPolicy, RpcJsonValue } from '@axon/shared'
import { AsyncWorkTracker } from '@axon/core'

export interface LoopPrecheckInput {
  code: string
  prev: RpcJsonValue
  cwd: string
  policy: AgentSandboxPolicy
  control: { socketPath: string; token: string }
  signal: AbortSignal
}
export interface LoopPrecheckResult { message?: string; cursor?: RpcJsonValue; signals: string[] }

/** 序列化为自包含脚本；process 只存在于受沙箱约束的执行进程。 */
async function precheckMain(): Promise<void> {
  const fs = await import('node:fs')
  const net = await import('node:net')
  const { StringDecoder } = await import('node:string_decoder')
  const input = JSON.parse(fs.readFileSync(process.argv[2]!, 'utf8')) as {
    code: string; prev: unknown; control: { socketPath: string; token: string }
  }
  const signals: string[] = []
  let controlUsed = false
  const agent = (message: string, data?: unknown): void => {
    if (signals.length >= 16 || typeof message !== 'string' || message.length > 4000) throw new Error('预检信号超限')
    const signal = message + (data === undefined ? '' : `\n${JSON.stringify(data)}`)
    if (signal.length > 8000) throw new Error('预检数据超限')
    signals.push(signal)
  }
  const tools = { call: async (name: string, args: Record<string, unknown> = {}): Promise<unknown> => {
    controlUsed = true
    const request = JSON.stringify({ token: input.control.token, argv: ['mcp-call', '--name', name, '--args', JSON.stringify(args)] }) + '\n'
    if (Buffer.byteLength(request) > 256 * 1024) throw new Error('预检 MCP 参数超限')
    return new Promise((done, failed) => {
      const socket = net.createConnection(input.control.socketPath)
      const decoder = new StringDecoder('utf8')
      let buffer = '', size = 0, settled = false
      const fail = (error: Error): void => { if (!settled) { settled = true; failed(error) }; socket.destroy() }
      const unsafe = (message: string): Error => Object.assign(new Error(message), { code: 'control_unknown' })
      socket.setTimeout(25_000, () => fail(unsafe('MCP 交付结果未知，不自动重发')))
      socket.once('connect', () => socket.write(request))
      socket.once('error', () => fail(unsafe('预检 MCP 通道不可用')))
      socket.on('data', (chunk: Buffer) => {
        size += chunk.length; buffer += decoder.write(chunk)
        if (size > 512 * 1024) return fail(unsafe('MCP 结果超限'))
        if (!buffer.includes('\n')) return
        try {
          const response = JSON.parse(buffer.slice(0, buffer.indexOf('\n'))) as { exitCode: number; text: string }
          if (response.exitCode !== 0) return fail(unsafe(response.text))
          const value: unknown = JSON.parse(response.text)
          settled = true; done(value); socket.destroy()
        } catch { fail(unsafe('MCP 应答无效')) }
      })
      socket.once('close', () => { if (!settled) fail(unsafe('MCP 通道中断，交付结果未知')) })
    })
  } }
  // 动态代码仅在本子进程执行；不在持有业务状态和凭据桥的 app-server 中 eval。
  const AsyncFunction = Object.getPrototypeOf(async function () {}).constructor as new (...args: string[]) => (...values: unknown[]) => Promise<unknown>
  try {
    const value: unknown = await new AsyncFunction('prev', 'agent', 'tools', 'fetch', input.code)(input.prev, agent, tools, fetch)
    const result = value == null ? {} : value as { message?: unknown; state?: unknown }
    if (typeof result !== 'object' || Array.isArray(result) || result.message !== undefined && typeof result.message !== 'string') throw new Error('预检须返回 {message,state} 或空值')
    const text = JSON.stringify({ ...(result.message === undefined ? {} : { message: result.message }), ...(result.state === undefined ? {} : { cursor: result.state }), signals })
    if (Buffer.byteLength(text) > 192 * 1024) throw new Error('预检结果过大')
    fs.writeFileSync(process.argv[3]!, text, { flag: 'wx', mode: 0o600 })
  } catch (error) {
    // 工具可能已有外部副作用；之后的脚本异常不能把整个原任务再交给模型盲目执行。
    if (controlUsed) throw Object.assign(new Error('预检工具调用后未完成'), { code: 'control_unknown' })
    throw error
  }
}

export class LoopPrecheckRunner {
  private readonly work = new AsyncWorkTracker()
  private readonly lifetime = new AbortController()
  constructor(private readonly executor: Pick<AgentHostToolExecutionPort, 'executeCommand'>) {}

  /** 固定解释器、清空继承环境、写入私有输入，再等待实际 close 后解析有界结果。 */
  run(input: LoopPrecheckInput): Promise<LoopPrecheckResult> {
    if (this.lifetime.signal.aborted) return Promise.reject(new Error('预检宿主已关闭'))
    return this.work.run(() => this.execute(input))
  }
  private async execute(input: LoopPrecheckInput): Promise<LoopPrecheckResult> {
    const signal = AbortSignal.any([input.signal, this.lifetime.signal])
    signal.throwIfAborted()
    const directory = mkdtempSync(join(realpathSync(tmpdir()), 'axon-loop-precheck-'))
    const identity = lstatSync(directory)
    try {
      const script = join(directory, 'precheck.mjs'), data = join(directory, 'input.json'), output = join(directory, 'output.json'), config = join(directory, 'bun.toml')
      writeFileSync(script, `(${precheckMain.toString()})().catch(async error => { const fs = await import('node:fs'); const denied = ['EPERM','EACCES'].includes(error?.code) || ['EPERM','EACCES'].includes(error?.cause?.code); fs.writeFileSync(process.argv[3], JSON.stringify({ error: '预检脚本执行失败', fatal: error?.code === 'control_unknown' ? 'delivery_unknown' : denied ? 'permission' : null }), { flag: 'wx', mode: 0o600 }); })`, { flag: 'wx', mode: 0o600 })
      writeFileSync(data, JSON.stringify({ code: input.code, prev: input.prev, control: input.control }), { flag: 'wx', mode: 0o600 })
      writeFileSync(config, '# Axon 固定执行配置\n', { flag: 'wx', mode: 0o600 })
      const environment: Record<string, string | undefined> = Object.fromEntries(Object.keys(process.env).map((key) => [key, undefined]))
      Object.assign(environment, { PATH: '/usr/bin:/bin:/usr/sbin:/sbin', HOME: process.env.HOME, LANG: 'en_US.UTF-8', ...(process.versions.electron ? { ELECTRON_RUN_AS_NODE: '1' } : {}) })
      const argv = process.versions.bun ? [process.execPath, 'run', '--no-env-file', `--config=${config}`, script, data, output] : [process.execPath, script, data, output]
      const result = await this.executor.executeCommand({ argv, cwd: input.cwd, policy: { ...input.policy, controlSocketPath: input.control.socketPath },
        grants: [{ scope: 'once', permission: { type: 'filesystemWrite', roots: [directory] } }], environment, abortSignal: signal, timeoutMs: 30000 })
      signal.throwIfAborted()
      if (result.timedOut || result.exitCode !== 0) throw new Error(result.timedOut ? '预检超过 30 秒' : '预检脚本执行失败，请检查语法和所需权限')
      const fd = openSync(output, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK)
      try {
        const info = fstatSync(fd)
        if (!info.isFile() || info.size > 192 * 1024) throw new Error('预检输出超限')
        const bytes = readFileSync(fd)
        if (bytes.length > 192 * 1024) throw new Error('预检输出超限')
        const value: unknown = JSON.parse(bytes.toString('utf8'))
        if (value && typeof value === 'object' && 'error' in value) {
          if ('fatal' in value && (value.fatal === 'delivery_unknown' || value.fatal === 'permission')) throw new LoopPrecheckPermissionError(value.fatal)
          throw new Error('预检脚本执行失败，请检查任务设置中的脚本')
        }
        if (!value || typeof value !== 'object' || !('signals' in value) || !Array.isArray(value.signals) || value.signals.length > 16
          || value.signals.some((item: unknown) => typeof item !== 'string' || item.length > 8000)
          || 'message' in value && (typeof value.message !== 'string' || value.message.length > 64000)) throw new Error('预检输出格式无效')
        return value as LoopPrecheckResult
      } finally { closeSync(fd) }
    } catch (error) {
      if (error instanceof AgentSandboxEscalationError) throw new LoopPrecheckPermissionError()
      throw error
    } finally {
      try {
        const current = lstatSync(directory)
        if (current.isSymbolicLink() || current.dev !== identity.dev || current.ino !== identity.ino || realpathSync(directory) !== directory) throw new Error('目录身份变化')
        rmSync(directory, { recursive: true })
      } catch { throw new LoopPrecheckPermissionError('cleanup') }
    }
  }
  dispose(): void { this.lifetime.abort() }
  async drain(): Promise<void> { await this.work.drain() }
}
export class LoopPrecheckPermissionError extends Error {
  constructor(reason: 'permission' | 'delivery_unknown' | 'cleanup' = 'permission') {
    super(reason === 'permission' ? '预检需要未获授权的权限'
      : reason === 'delivery_unknown' ? '预检 MCP 调用后未能完成，未自动重发或转模型执行；请检查工具及本次记录。'
        : '预检私有目录清理未确认，已保留可疑目录；未继续模型执行。')
    this.name = 'LoopPrecheckPermissionError'
  }
}
