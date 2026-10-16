/** Agent 能力查询：会话与项目归 core，模型目录与本机探测由中立端口提供。 */
import type { AgentEnvironmentCheckResult, AgentProviderAdapter, AgentReasoningCapability, AgentReasoningSelection, AgentRuntimeId } from '@axon/shared'
import type { AgentSessionManager } from './agent-session-manager'
import type { ChannelManager } from '../channel/channel-manager'
import type { AgentProjectManager } from '../project/agent-project-manager'
import { waitWithSignal } from '../async/wait-with-signal'
import { AsyncWorkTracker } from '../async/async-work-tracker'

export interface AgentEnvironmentProbeInput { cwd?: string }
export interface AgentCapabilityControllerOptions {
  sessions: Pick<AgentSessionManager, 'get'>
  channels: Pick<ChannelManager, 'get'>
  projects: Pick<AgentProjectManager, 'resolveProjectCwd'>
  resolveAdapter: (runtimeId: AgentRuntimeId) => AgentProviderAdapter
  /** 可信装配入口注入；不接受客户端指定 cwd 或要执行的命令。 */
  checkEnvironment?: (input: AgentEnvironmentProbeInput, signal: AbortSignal) => Promise<AgentEnvironmentCheckResult>
}
export class AgentCapabilityControllerError extends Error {
  constructor(readonly code: 'invalid_input' | 'unavailable', message: string) {
    super(message)
    this.name = 'AgentCapabilityControllerError'
  }
}

function id(value: unknown, max = 200): string {
  if (typeof value !== 'string' || !value.trim() || value.length > max) {
    throw new AgentCapabilityControllerError('invalid_input', '能力查询标识无效')
  }
  return value.trim()
}

export class AgentCapabilityController {
  private readonly lifetime = new AbortController()
  private readonly work = new AsyncWorkTracker()
  constructor(private readonly options: AgentCapabilityControllerOptions) {}

  /** 按会话或创建前选择查询；渠道决定 provider，不解密/请求模型，未知能力不猜测。 */
  getReasoningCapability(value: unknown, signal?: AbortSignal): Promise<AgentReasoningCapability | undefined> {
    return this.work.run(() => this.resolveReasoningCapability(value, signal))
  }

  /** 共享目录只取消本次等待，底层加载继续登记到真实完成；迟到选择仍须复核。 */
  private async resolveReasoningCapability(value: unknown, signal?: AbortSignal): Promise<AgentReasoningCapability | undefined> {
    const stop = this.signal(signal)
    this.ensureActive(stop)
    let sessionId: string | undefined
    let selection: AgentReasoningSelection
    if (typeof value === 'string') {
      sessionId = id(value)
      const session = this.options.sessions.get(sessionId)
      if (!session?.channelId || !session.modelId) return undefined
      selection = { runtimeId: session.runtimeId, channelId: session.channelId, modelId: session.modelId }
    } else {
      if (!value || typeof value !== 'object' || Array.isArray(value)
        || Object.keys(value).some((key) => !['runtimeId', 'channelId', 'modelId'].includes(key))) {
        throw new AgentCapabilityControllerError('invalid_input', '模型能力选择无效')
      }
      const input = value as Record<string, unknown>
      if (input.runtimeId !== 'pi' && input.runtimeId !== 'zima') throw new AgentCapabilityControllerError('invalid_input', 'Runtime 标识无效')
      selection = { runtimeId: input.runtimeId, channelId: id(input.channelId, 512), modelId: id(input.modelId, 512) }
    }
    const channel = this.options.channels.get(selection.channelId)
    if (!channel?.enabled || !channel.models.some((model) => model.id === selection.modelId && model.enabled)) return undefined
    const adapter = this.options.resolveAdapter(selection.runtimeId)
    const pending = this.work.run(() => Promise.resolve(adapter.getReasoningCapability?.({ provider: channel.provider, model: selection.modelId })))
    const result = await waitWithSignal(pending, stop)
    this.ensureActive(stop)
    // 目录加载可能跨过用户切换模型/删除会话；旧选择的结果不能重新显示在新选择上。
    const current = sessionId === undefined ? selection : this.options.sessions.get(sessionId)
    const latest = this.options.channels.get(selection.channelId)
    if (!current || current.runtimeId !== selection.runtimeId || current.channelId !== selection.channelId || current.modelId !== selection.modelId
      || !latest?.enabled || latest.provider !== channel.provider
      || !latest.models.some((model) => model.id === selection.modelId && model.enabled)) return undefined
    return result
  }

  /** 只接受项目 ID；先解析可信工作区再调用固定只读探测，取消不消费迟到结果。 */
  checkEnvironment(value: unknown, signal?: AbortSignal): Promise<AgentEnvironmentCheckResult> {
    return this.work.run(() => this.probeEnvironment(value, signal))
  }

  /** 登记宿主探测本身，取消响应后仍等待端口清理，不能提前报告原生进程已退出。 */
  private async probeEnvironment(value: unknown, signal?: AbortSignal): Promise<AgentEnvironmentCheckResult> {
    const stop = this.signal(signal)
    this.ensureActive(stop)
    if (value !== undefined && (!value || typeof value !== 'object' || Array.isArray(value)
      || Object.keys(value).some((key) => key !== 'projectId'))) {
      throw new AgentCapabilityControllerError('invalid_input', '环境检查参数无效')
    }
    const input = (value ?? {}) as { projectId?: unknown }
    const cwd = input.projectId === undefined ? undefined : this.options.projects.resolveProjectCwd(id(input.projectId))
    if (!this.options.checkEnvironment) throw new AgentCapabilityControllerError('unavailable', '宿主环境检查不可用')
    const result = await waitWithSignal(this.work.run(() => this.options.checkEnvironment!(cwd ? { cwd } : {}, stop)), stop)
    this.ensureActive(stop)
    // 项目在异步检查期间可能换目录或删除；不能交付旧目录的有效性报告。
    if (input.projectId !== undefined && this.options.projects.resolveProjectCwd(id(input.projectId)) !== cwd) {
      throw new AgentCapabilityControllerError('unavailable', '项目工作区已变化，请重新检查')
    }
    return result
  }

  private signal(signal?: AbortSignal): AbortSignal {
    return signal ? AbortSignal.any([signal, this.lifetime.signal]) : this.lifetime.signal
  }
  private ensureActive(signal: AbortSignal): void {
    if (signal.aborted) throw new DOMException('能力查询已取消', 'AbortError')
  }
  /** 退出只撤销查询，不中止其他运行或共享 Runtime 目录的加载。 */
  dispose(): void { this.lifetime.abort(new DOMException('能力查询已取消', 'AbortError')) }

  /** 等待真实目录/探测 Promise 和本次查询收束，不替代 adapter/host 的资源等待。 */
  drain(): Promise<void> { return this.work.drain() }
}
