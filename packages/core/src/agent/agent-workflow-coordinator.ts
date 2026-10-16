/** 非交互工作流的可信归属；等待完整根协作收束，不装配另一套模型循环。 */
import { randomUUID } from 'node:crypto'
import type { AgentCompletionPayload, AgentSendInput, AgentSendResult, AgentSessionMeta, AgentTypedError,
  AgentWorkflowControlInput, AgentWorkflowResult, BackendAgentRunEvent, BackendAgentWorkflow,
  BackendAgentWorkflowEvent, BackendOwnedRun } from '@axon/shared'
import type { BackendClientRegistry } from '../backend-client-registry'
import { AsyncWorkTracker } from '../async/async-work-tracker'
import { AgentServiceError } from './agent-service'

export interface AgentWorkflowCoordinatorOptions {
  clients: Pick<BackendClientRegistry, 'has' | 'getSignal'>
  getSession: (sessionId: string) => AgentSessionMeta | undefined
  busy: (sessionId: string) => boolean
  send: (owner: string, input: AgentSendInput, workflowId: string) => Promise<AgentSendResult>
  stop: (owner: string, sessionId: string) => void
  cancelDescendants?: (sessionId: string) => void
  waitForDescendants?: (sessionId: string) => Promise<void>
}
interface Scope {
  owner: string
  workflow: BackendAgentWorkflow
  stopping: boolean
  canceled: boolean
  lastRun?: BackendOwnedRun
  completion?: AgentCompletionPayload
  error?: AgentTypedError
}
function failure(code = 'runtime_error'): AgentTypedError {
  return { code, category: code === 'persistence_error' ? 'persistence' : 'runtime',
    message: code === 'persistence_error' ? '工作流结果未完整保存' : '工作流未完整完成', retryable: false }
}

export class AgentWorkflowCoordinator {
  private readonly scopes = new Map<string, Scope>()
  private readonly listeners = new Map<string, Set<(event: BackendAgentWorkflowEvent) => void>>()
  private readonly work = new AsyncWorkTracker()
  private disposed = false

  constructor(private readonly options: AgentWorkflowCoordinatorOptions) {}

  /** send 只能由原工作流内部调用；普通入口不能在主轮空隙接管或追加用户消息。 */
  permitsSend(owner: string, sessionId: string, workflowId?: string): boolean {
    const scope = this.scopes.get(sessionId)
    return scope ? scope.owner === owner && scope.workflow.workflowId === workflowId && !scope.stopping : workflowId === undefined
  }
  active(sessionId: string): boolean { return this.scopes.has(sessionId) }
  getOwned(owner: string, sessionId: string): BackendAgentWorkflow | undefined {
    const scope = this.scopes.get(sessionId)
    return scope?.owner === owner && this.options.clients.has(owner) ? { ...scope.workflow } : undefined
  }
  subscribe(owner: string, listener: (event: BackendAgentWorkflowEvent) => void): () => void {
    if (this.disposed || !this.options.clients.has(owner)) throw new AgentServiceError('invalid_input', '工作流客户端不可用')
    const group = this.listeners.get(owner) ?? new Set<(event: BackendAgentWorkflowEvent) => void>()
    group.add(listener); this.listeners.set(owner, group)
    return () => { group.delete(listener); if (!group.size && this.listeners.get(owner) === group) this.listeners.delete(owner) }
  }
  private emit(scope: Scope, event: BackendAgentWorkflowEvent): void {
    if (!this.options.clients.has(scope.owner)) return
    for (const listener of this.listeners.get(scope.owner) ?? []) {
      try { listener(event) } catch { console.warn('[Agent 工作流] 事件投递失败') }
    }
  }

  /** 初始发送前登记身份，直到子执行/交付/合成续跑全部结束才释放；取消仍等待真实 Promise。 */
  execute(owner: string, input: AgentSendInput, signal?: AbortSignal): Promise<AgentWorkflowResult> {
    const ownerSignal = this.options.clients.getSignal(owner)
    const session = this.options.getSession(input.sessionId)
    if (this.disposed || !ownerSignal || ownerSignal.aborted || signal?.aborted) throw new AgentServiceError('invalid_input', '工作流客户端已取消')
    if (!session || session.parentSessionId) throw new AgentServiceError('not_found', '工作流根会话不存在')
    if (session.approvalPolicy !== 'never' || session.userInputPolicy !== 'reject') throw new AgentServiceError('invalid_input', '工作流需要非交互策略')
    if (!this.options.waitForDescendants || !this.options.cancelDescendants) throw new AgentServiceError('invalid_input', '宿主未提供完整协作收束能力')
    if (this.active(input.sessionId) || this.options.busy(input.sessionId)) throw new AgentServiceError('already_active', '会话已有运行或工作流')
    const scope: Scope = { owner, workflow: { workflowId: randomUUID(), sessionId: input.sessionId, startedAt: Date.now() }, stopping: false, canceled: false }
    this.scopes.set(input.sessionId, scope)
    const abort = (): void => { scope.canceled = true; this.stop(scope) }
    ownerSignal.addEventListener('abort', abort, { once: true }); signal?.addEventListener('abort', abort, { once: true })
    this.emit(scope, { type: 'workflow_started', workflow: { ...scope.workflow } })
    return this.work.run(async () => {
      try {
        if (!scope.stopping) {
          try {
            const sent = await this.options.send(owner, input, scope.workflow.workflowId)
            if (!sent.success || sent.disposition !== 'started') scope.error ??= failure(!sent.success && sent.code === 'persistence_error' ? 'persistence_error' : 'runtime_error')
          } catch { scope.error ??= failure() }
        }
        if (scope.error) this.stop(scope)
        // 取消只封口/停止；不取消这个等待，不能把 canceled 状态当执行器已经退出。
        try { await this.options.waitForDescendants!(input.sessionId) }
        catch (error) {
          const persistence = error !== null && typeof error === 'object' && 'code' in error && error.code === 'persistence_error'
          // 取消后的迟到续跑拒绝是预期结果；存储失败仍是故障，不能被 canceled 掩盖。
          if (persistence || !scope.canceled) scope.error ??= failure(persistence ? 'persistence_error' : 'runtime_error')
        }
        if (!scope.canceled && !scope.error && (!scope.completion || scope.completion.resultSubtype !== 'success' || !scope.completion.persisted)) scope.error = failure()
        const result: AgentWorkflowResult = { workflow: { ...scope.workflow },
          status: scope.error ? 'failed' : scope.canceled ? 'canceled' : 'completed',
          ...(scope.lastRun ? { lastRun: { ...scope.lastRun } } : {}), ...(scope.completion ? { completion: scope.completion } : {}),
          ...(scope.error ? { error: scope.error } : {}) }
        this.emit(scope, { type: 'workflow_finished', result })
        return result
      } finally {
        ownerSignal.removeEventListener('abort', abort); signal?.removeEventListener('abort', abort)
        if (this.scopes.get(input.sessionId) === scope) this.scopes.delete(input.sessionId)
      }
    })
  }

  /** 只消费原 owner 的真实主轮；子轮失败由主模型处理，子交付故障由根等待报告。 */
  observe(owner: string, packet: BackendAgentRunEvent): void {
    const scope = this.scopes.get(packet.run.sessionId)
    if (!scope || scope.owner !== owner || packet.visibleSessionId !== scope.workflow.sessionId) return
    if (packet.event.type === 'run_started') { scope.lastRun = { ...packet.run }; scope.completion = undefined }
    else if (packet.event.type === 'run_finished') {
      scope.lastRun = { ...packet.run }; scope.completion = packet.event.completion
      if (!scope.completion.persisted) scope.error ??= failure('persistence_error')
      else if (scope.completion.stoppedByUser) { scope.canceled = true; this.stop(scope) }
      else if (scope.completion.resultSubtype !== 'success' || scope.completion.error) scope.error ??= scope.completion.error ?? failure()
      if (scope.error) this.stop(scope)
    }
  }

  /** 精确身份与客户端同时匹配；已结束或上一工作流令牌不能停止新执行。 */
  cancel(owner: string, target: AgentWorkflowControlInput): boolean {
    const scope = this.scopes.get(target.sessionId)
    if (!this.options.clients.has(owner) || !scope || scope.owner !== owner || scope.workflow.workflowId !== target.workflowId || scope.stopping) return false
    scope.canceled = true; this.stop(scope); return true
  }
  private stop(scope: Scope): void {
    if (scope.stopping) return
    scope.stopping = true
    // 先封住后续 send，再取消子树和主发送链；一个清理失败不能跳过另一个。
    for (const action of [() => this.options.cancelDescendants?.(scope.workflow.sessionId), () => this.options.stop(scope.owner, scope.workflow.sessionId)]) {
      try { action() } catch { scope.error ??= failure() }
    }
  }
  cancelOwner(owner: string): void {
    for (const scope of this.scopes.values()) if (scope.owner === owner) { scope.canceled = true; this.stop(scope) }
    this.listeners.delete(owner)
  }
  dispose(): void {
    if (this.disposed) return
    this.disposed = true
    for (const scope of this.scopes.values()) { scope.canceled = true; this.stop(scope) }
    this.listeners.clear()
  }
  drain(): Promise<void> { return this.work.drain() }
}
