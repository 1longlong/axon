/** Agent 协作编排：派生子会话、按根任务限流运行，并把终态写回委派记录。 */

import {
  MAX_AGENT_DELEGATION_CONCURRENCY,
  MAX_AGENT_DELEGATION_DEPTH,
  MAX_AGENT_DELEGATION_RESULT_LENGTH,
  isAgentDelegationTerminal,
} from '@axon/shared'
import type {
  AgentDelegation,
  AgentDelegationCreateInput,
  AgentGenerationEvent,
  AgentSessionCreateInput,
  AgentSessionMeta,
  AgentSubagentType,
  AgentTypedError,
  SDKResultMessage,
} from '@axon/shared'
import { AgentDelegationManagerError } from './agent-delegation-manager'
import type { AgentDelegationManager } from './agent-delegation-manager'
import { AgentSessionManagerError } from '../agent/agent-session-manager'
import type { AgentSessionManager } from '../agent/agent-session-manager'
import type { AgentRunOutcome, AgentService } from '../agent/agent-service'

export interface AgentCollaborationServiceOptions {
  sessions: Pick<AgentSessionManager, 'get' | 'create' | 'delete'>
  delegations: Pick<AgentDelegationManager, 'list' | 'get' | 'create' | 'transition'>
  agent: Pick<AgentService, 'sendMessage' | 'stop' | 'isActive'>
  resolveProjectCwd: (projectId: string) => string
  /** renderer 父任务存在时，把同一 owner 临时绑定到子会话；外部任务可返回 undefined。 */
  bindChildInteractionOwner?: (parentSessionId: string, childSessionId: string) => (() => void) | undefined
}

export type AgentBackgroundCompletionHandler = (delegation: AgentDelegation) => Promise<void>

export interface AgentDelegateInput {
  parentSessionId: string
  parentToolUseId: string
  title: string
  objective: string
  subagentType: AgentSubagentType
  runInBackground: boolean
}

export class AgentCollaborationServiceError extends Error {
  constructor(
    readonly code: 'invalid_input' | 'not_found' | 'parent_inactive' | 'workspace_unavailable' | 'limit_reached' | 'persistence_error' | 'runtime_error',
    message: string,
  ) {
    super(message)
    this.name = 'AgentCollaborationServiceError'
  }
}

interface DelegationWaiter {
  resolve: (delegation: AgentDelegation) => void
  reject: (error: Error) => void
  signal?: AbortSignal
  onAbort?: () => void
}

function normalizeRequired(value: unknown, label: string): string {
  if (typeof value !== 'string' || !value.trim()) {
    throw new AgentCollaborationServiceError('invalid_input', `${label}不能为空`)
  }
  return value.trim()
}

function normalizeSubagentType(value: unknown): AgentSubagentType {
  if (value !== 'coder' && value !== 'explore' && value !== 'plan') {
    throw new AgentCollaborationServiceError('invalid_input', '子 Agent 类型无效')
  }
  return value
}

/** 父上下文只接收子 Agent 的最终文本摘要，完整执行轨迹继续留在子会话 JSONL。 */
function buildResultSummary(finalText: string | undefined): string {
  return finalText?.trim().slice(0, MAX_AGENT_DELEGATION_RESULT_LENGTH) || '子任务已完成'
}

function createChildFailure(result: SDKResultMessage | undefined, cause?: unknown): AgentTypedError {
  if (result?.error) return result.error
  if (cause instanceof AgentCollaborationServiceError) {
    return { code: cause.code, category: 'runtime', message: cause.message, retryable: false }
  }
  return {
    code: 'child_agent_failed',
    category: 'runtime',
    message: result?.errors?.[0] ?? '子 Agent 运行失败',
    retryable: false,
  }
}

export class AgentCollaborationService {
  private readonly executions = new Map<string, Promise<void>>()
  private readonly waiters = new Map<string, Set<DelegationWaiter>>()
  private readonly interactionReleases = new Map<string, () => void>()
  private readonly pendingInteractions = new Map<string, Set<string>>()
  private backgroundCompletionHandler?: AgentBackgroundCompletionHandler

  constructor(private readonly options: AgentCollaborationServiceOptions) {}

  /** UI/宿主装配完成后注册后台完成处理器；编排层不直接依赖 Electron 窗口。 */
  setBackgroundCompletionHandler(handler: AgentBackgroundCompletionHandler): void {
    this.backgroundCompletionHandler = handler
  }

  /**
   * 从可信父会话派生子会话并建立委派记录。
   * 子会话创建成功但委派落盘失败时立即删除子会话，避免留下不可达历史。
   */
  delegate(rawInput: AgentDelegateInput): AgentDelegation {
    if (typeof rawInput.runInBackground !== 'boolean') {
      throw new AgentCollaborationServiceError('invalid_input', '子任务运行模式无效')
    }
    const input = {
      parentSessionId: normalizeRequired(rawInput.parentSessionId, '父会话 ID'),
      parentToolUseId: normalizeRequired(rawInput.parentToolUseId, '父工具调用 ID'),
      title: normalizeRequired(rawInput.title, '子任务标题'),
      objective: normalizeRequired(rawInput.objective, '子任务目标'),
      subagentType: normalizeSubagentType(rawInput.subagentType),
      runInBackground: rawInput.runInBackground,
    }
    const parent = this.options.sessions.get(input.parentSessionId)
    if (!parent) throw new AgentCollaborationServiceError('not_found', '父 Agent 会话不存在')
    if (parent.parentSessionId) {
      throw new AgentCollaborationServiceError('limit_reached', '子 Agent 不能继续创建子 Agent')
    }
    if (!this.options.agent.isActive(parent.id)) {
      throw new AgentCollaborationServiceError('parent_inactive', '只能从正在运行的父 Agent 创建子任务')
    }
    if (!parent.projectId || !parent.channelId || !parent.modelId) {
      throw new AgentCollaborationServiceError('invalid_input', '父 Agent 缺少项目、渠道或模型')
    }
    try {
      if (!this.options.resolveProjectCwd(parent.projectId)) throw new Error('empty cwd')
    } catch {
      throw new AgentCollaborationServiceError('workspace_unavailable', '父 Agent 项目或工作区不可用')
    }

    const lineage = this.resolveChildLineage(parent)
    const existing = this.options.delegations.list(lineage.rootSessionId).find((item) => (
      item.parentSessionId === parent.id && item.parentToolUseId === input.parentToolUseId
    ))
    // runtime 重放同一工具调用时返回原记录，不能再次创建会话或重复执行任务。
    if (existing) return existing
    const childInput: AgentSessionCreateInput = {
      title: input.title,
      runtimeId: parent.runtimeId,
      channelId: parent.channelId,
      modelId: parent.modelId,
      projectId: parent.projectId,
      permissionMode: parent.permissionMode,
      thinkingLevel: parent.thinkingLevel,
      parentSessionId: parent.id,
      rootSessionId: lineage.rootSessionId,
      parentToolUseId: input.parentToolUseId,
      subagentType: input.subagentType,
    }
    let child: AgentSessionMeta
    try { child = this.options.sessions.create(childInput) }
    catch { throw new AgentCollaborationServiceError('persistence_error', '创建子 Agent 会话失败') }

    let releaseInteractionOwner: (() => void) | undefined
    try {
      releaseInteractionOwner = this.options.bindChildInteractionOwner?.(parent.id, child.id)
    } catch {
      try { this.options.sessions.delete(child.id) } catch { /* 已记录主错误，回收尽力而为。 */ }
      throw new AgentCollaborationServiceError('runtime_error', '绑定子 Agent 交互窗口失败')
    }

    let delegation: AgentDelegation
    try {
      const delegationInput: AgentDelegationCreateInput = {
        rootSessionId: lineage.rootSessionId,
        parentSessionId: parent.id,
        childSessionId: child.id,
        parentToolUseId: input.parentToolUseId,
        title: input.title,
        objective: input.objective,
        subagentType: input.subagentType,
        runInBackground: input.runInBackground,
        depth: lineage.depth,
      }
      delegation = this.options.delegations.create(delegationInput)
    } catch (error) {
      releaseInteractionOwner?.()
      try { this.options.sessions.delete(child.id) }
      catch { console.error(`[Agent 协作] 回收孤立子会话失败: ${child.id}`) }
      if (error instanceof AgentDelegationManagerError && error.code === 'limit_reached') {
        throw new AgentCollaborationServiceError('limit_reached', error.message)
      }
      throw new AgentCollaborationServiceError('persistence_error', '创建子任务关联失败')
    }

    if (releaseInteractionOwner) this.interactionReleases.set(delegation.id, releaseInteractionOwner)
    this.schedule(lineage.rootSessionId)
    return delegation
  }

  /**
   * 权限、追问和计划审批开始时把子任务标为 blocked；最后一个等待项解决后恢复 running。
   * 请求 ID 集合处理 runtime 并行发出多个交互的情况，避免过早释放调度槽语义。
   */
  handleInteractionEvent(event: AgentGenerationEvent): void {
    const reason = event.type === 'permission_request'
      ? 'permission'
      : event.type === 'ask_user_request'
        ? 'ask_user'
        : event.type === 'exit_plan_mode_request'
          ? 'plan_approval'
          : undefined
    const requestId = event.type === 'permission_request'
      || event.type === 'ask_user_request'
      || event.type === 'exit_plan_mode_request'
      ? event.request.requestId
      : event.type === 'permission_resolved'
        || event.type === 'ask_user_resolved'
        || event.type === 'exit_plan_mode_resolved'
        ? event.requestId
        : undefined
    if (!requestId) return
    const session = this.options.sessions.get(event.sessionId)
    if (!session?.parentSessionId || !session.rootSessionId) return
    const delegation = this.options.delegations.list(session.rootSessionId)
      .find((item) => item.childSessionId === session.id)
    if (!delegation || isAgentDelegationTerminal(delegation.status)) return
    const key = `${event.type.split('_').slice(0, -1).join('_')}:${requestId}`

    if (reason) {
      const pending = this.pendingInteractions.get(delegation.id) ?? new Set<string>()
      pending.add(key)
      this.pendingInteractions.set(delegation.id, pending)
      if (delegation.status === 'running') {
        this.options.delegations.transition(delegation.id, { status: 'blocked', blockedReason: reason })
      }
      return
    }

    const pending = this.pendingInteractions.get(delegation.id)
    if (!pending) return
    // request/resolved 的事件前缀不同，按 requestId 删除才能覆盖三种交互类型。
    for (const candidate of pending) {
      if (candidate.endsWith(`:${requestId}`)) pending.delete(candidate)
    }
    if (pending.size > 0) return
    this.pendingInteractions.delete(delegation.id)
    const latest = this.options.delegations.get(delegation.id)
    if (latest?.status === 'blocked') {
      this.options.delegations.transition(delegation.id, { status: 'running' })
    }
  }

  /** 等待指定子任务进入终态；调用者的 AbortSignal 只结束等待，不单独改变任务状态。 */
  async wait(
    callerSessionId: string,
    delegationId: string,
    signal?: AbortSignal,
  ): Promise<AgentDelegation> {
    const id = normalizeRequired(delegationId, '子任务 ID')
    const current = this.requireAccessibleDelegation(callerSessionId, id)
    if (isAgentDelegationTerminal(current.status)) return current
    if (signal?.aborted) throw new AgentCollaborationServiceError('runtime_error', '等待子任务已取消')
    return await new Promise<AgentDelegation>((resolve, reject) => {
      const waiter: DelegationWaiter = { resolve, reject, ...(signal ? { signal } : {}) }
      const group = this.waiters.get(id) ?? new Set<DelegationWaiter>()
      group.add(waiter)
      this.waiters.set(id, group)
      if (signal) {
        waiter.onAbort = () => {
          this.removeWaiter(id, waiter)
          reject(new AgentCollaborationServiceError('runtime_error', '等待子任务已取消'))
        }
        signal.addEventListener('abort', waiter.onAbort, { once: true })
        if (signal.aborted) {
          waiter.onAbort()
          return
        }
      }

      // 注册后再复查一次，封住终态写入与 waiter 登记之间的竞态窗口。
      const latest = this.options.delegations.get(id)
      if (latest && isAgentDelegationTerminal(latest.status)) this.resolveWaiters(latest)
    })
  }

  /** 返回调用者根任务树中的任务快照；默认只列尚未结束的后台任务。 */
  listTasks(callerSessionId: string, activeOnly = true, limit = 20): AgentDelegation[] {
    const caller = this.options.sessions.get(normalizeRequired(callerSessionId, '调用会话 ID'))
    if (!caller) throw new AgentCollaborationServiceError('not_found', 'Agent 会话不存在')
    const rootSessionId = caller.rootSessionId ?? caller.id
    return this.options.delegations.list(rootSessionId)
      .filter((item) => item.runInBackground && (!activeOnly || !isAgentDelegationTerminal(item.status)))
      .slice(-Math.max(1, Math.min(100, limit)))
  }

  /** 读取同一根任务树中的任务；TaskOutput 的非阻塞路径不会建立 waiter。 */
  getTask(callerSessionId: string, delegationId: string): AgentDelegation {
    return this.requireAccessibleDelegation(callerSessionId, normalizeRequired(delegationId, '子任务 ID'))
  }

  /** 取消一个委派及其全部后代；已进入终态的记录保持原样。 */
  cancel(callerSessionId: string, delegationId: string): boolean {
    const delegation = this.requireAccessibleDelegation(
      callerSessionId,
      normalizeRequired(delegationId, '子任务 ID'),
    )
    if (isAgentDelegationTerminal(delegation.status)) return false
    this.cancelDescendants(delegation.childSessionId, delegation.id)
    return true
  }

  /** 父会话停止时先把整棵活动子树落为 canceled，再向每个 runtime 发 abort。 */
  cancelDescendants(parentSessionId: string, includeDelegationId?: string): number {
    const normalizedParentId = normalizeRequired(parentSessionId, '父会话 ID')
    const all = this.options.delegations.list()
    const targetIds = new Set<string>()
    const sessionQueue = [normalizedParentId]
    if (includeDelegationId) targetIds.add(includeDelegationId)
    while (sessionQueue.length > 0) {
      const parentId = sessionQueue.shift()!
      for (const item of all) {
        if (item.parentSessionId !== parentId || targetIds.has(item.id)) continue
        targetIds.add(item.id)
        sessionQueue.push(item.childSessionId)
      }
    }

    const canceled: AgentDelegation[] = []
    const roots = new Set<string>()
    for (const id of targetIds) {
      const current = this.options.delegations.get(id)
      if (!current || isAgentDelegationTerminal(current.status)) continue
      try {
        const updated = this.options.delegations.transition(id, { status: 'canceled' })
        canceled.push(updated)
        roots.add(updated.rootSessionId)
        this.resolveWaiters(updated)
        this.releaseInteractionOwner(updated.id)
      } catch (error) {
        if (!(error instanceof AgentDelegationManagerError && error.code === 'invalid_transition')) throw error
      }
    }
    // 状态先落盘，异步运行即使在 abort 后立刻返回，也只能观察到已经取消的终态。
    for (const item of canceled) {
      if (this.options.agent.isActive(item.childSessionId)) this.options.agent.stop(item.childSessionId)
    }
    for (const rootSessionId of roots) this.schedule(rootSessionId)
    return canceled.length
  }

  /** 每个根任务按创建顺序填充可用槽位；blocked 仍占槽，防止等待期间无界派生。 */
  private schedule(rootSessionId: string): void {
    const records = this.options.delegations.list(rootSessionId)
    const occupied = records.filter((item) => item.status === 'running' || item.status === 'blocked').length
    const queued = records.filter((item) => item.status === 'queued')
    for (const item of queued.slice(0, Math.max(0, MAX_AGENT_DELEGATION_CONCURRENCY - occupied))) {
      let running: AgentDelegation
      try { running = this.options.delegations.transition(item.id, { status: 'running' }) }
      catch (error) {
        console.warn(`[Agent 协作] 启动排队子任务失败: ${item.id}`, error)
        continue
      }
      const execution = this.execute(running)
      this.executions.set(running.id, execution)
      const finish = (): void => {
        if (this.executions.get(running.id) === execution) this.executions.delete(running.id)
        this.releaseInteractionOwner(running.id)
        this.schedule(running.rootSessionId)
      }
      void execution.then(finish, (error) => {
        console.error(`[Agent 协作] 子任务执行器意外失败: ${running.id}`, error)
        finish()
      })
    }
  }

  /** 消费 AgentService 的直接运行结果并收束委派；JSONL 只保留完整子会话轨迹。 */
  private async execute(delegation: AgentDelegation): Promise<void> {
    let cause: unknown
    let outcome: AgentRunOutcome | undefined
    try {
      outcome = await this.options.agent.sendMessage(
        { sessionId: delegation.childSessionId, text: delegation.objective },
        { source: 'delegation' },
      )
    } catch (error) {
      cause = error
    }
    const current = this.options.delegations.get(delegation.id)
    if (!current || isAgentDelegationTerminal(current.status)) return

    const result = outcome?.result
    let terminal: AgentDelegation
    try {
      if (result?.stopped_by_user) {
        terminal = this.options.delegations.transition(delegation.id, { status: 'canceled' })
      } else if (result?.subtype === 'success') {
        terminal = this.options.delegations.transition(delegation.id, {
          status: 'completed',
          resultSummary: buildResultSummary(outcome?.finalText),
        })
      } else {
        terminal = this.options.delegations.transition(delegation.id, {
          status: 'failed',
          error: createChildFailure(result, cause),
        })
      }
      this.resolveWaiters(terminal)
      if (terminal.runInBackground) this.notifyBackgroundCompletion(terminal)
    } catch (error) {
      if (
        !(error instanceof AgentDelegationManagerError && error.code === 'invalid_transition')
        && !(error instanceof AgentSessionManagerError)
      ) console.error(`[Agent 协作] 收束子任务失败: ${delegation.id}`, error)
      this.rejectWaiters(
        delegation.id,
        new AgentCollaborationServiceError('persistence_error', '无法保存子任务终态'),
      )
    }
  }

  /** 后台通知失败不改变已经持久化的任务终态，结果仍可通过 TaskOutput 读取。 */
  private notifyBackgroundCompletion(delegation: AgentDelegation): void {
    const handler = this.backgroundCompletionHandler
    if (!handler) {
      console.warn(`[Agent 协作] 后台任务完成处理器不可用: ${delegation.id}`)
      return
    }
    void handler(delegation).catch((error) => {
      console.warn(`[Agent 协作] 后台任务自动通知失败: ${delegation.id}`, error)
    })
  }

  private resolveChildLineage(parent: AgentSessionMeta): { rootSessionId: string; depth: number } {
    if (!parent.parentSessionId) return { rootSessionId: parent.id, depth: 1 }
    const parentDelegation = this.options.delegations.list(parent.rootSessionId)
      .find((item) => item.childSessionId === parent.id)
    if (!parentDelegation || isAgentDelegationTerminal(parentDelegation.status)) {
      throw new AgentCollaborationServiceError('not_found', '父子任务关联不存在或已结束')
    }
    if (parentDelegation.depth >= MAX_AGENT_DELEGATION_DEPTH) {
      throw new AgentCollaborationServiceError('limit_reached', '子任务委派深度已达上限')
    }
    return { rootSessionId: parent.rootSessionId!, depth: parentDelegation.depth + 1 }
  }

  /** Task ID 只在同一根任务树内可见，防止一个 Agent 操作其他会话的后台任务。 */
  private requireAccessibleDelegation(callerSessionId: string, delegationId: string): AgentDelegation {
    const caller = this.options.sessions.get(normalizeRequired(callerSessionId, '调用会话 ID'))
    const delegation = this.options.delegations.get(delegationId)
    if (!caller || !delegation) throw new AgentCollaborationServiceError('not_found', '子任务不存在')
    const callerRootSessionId = caller.rootSessionId ?? caller.id
    if (delegation.rootSessionId !== callerRootSessionId) {
      throw new AgentCollaborationServiceError('not_found', '子任务不存在')
    }
    return delegation
  }

  private resolveWaiters(delegation: AgentDelegation): void {
    const group = this.waiters.get(delegation.id)
    if (!group) return
    this.waiters.delete(delegation.id)
    for (const waiter of group) {
      if (waiter.signal && waiter.onAbort) waiter.signal.removeEventListener('abort', waiter.onAbort)
      waiter.resolve(delegation)
    }
  }

  private removeWaiter(id: string, waiter: DelegationWaiter): void {
    const group = this.waiters.get(id)
    if (!group) return
    group.delete(waiter)
    if (group.size === 0) this.waiters.delete(id)
  }

  private releaseInteractionOwner(delegationId: string): void {
    this.pendingInteractions.delete(delegationId)
    const release = this.interactionReleases.get(delegationId)
    if (!release) return
    this.interactionReleases.delete(delegationId)
    try { release() } catch { console.warn(`[Agent 协作] 释放子会话 owner 失败: ${delegationId}`) }
  }

  private rejectWaiters(id: string, error: Error): void {
    const group = this.waiters.get(id)
    if (!group) return
    this.waiters.delete(id)
    for (const waiter of group) {
      if (waiter.signal && waiter.onAbort) waiter.signal.removeEventListener('abort', waiter.onAbort)
      waiter.reject(error)
    }
  }
}
