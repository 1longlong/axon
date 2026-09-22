/** Agent IPC 输入校验、窗口所有权与主进程服务编排。 */

import type {
  AgentAskUserResponse,
  AgentExitPlanResponse,
  AgentGenerationEvent,
  AgentMoveQueuedMessageInput,
  AgentPermissionMode,
  AgentPermissionResponse,
  AgentQueueSnapshot,
  AgentQueuedMessageControlInput,
  AgentSendInput,
  AgentSendResult,
  AgentSessionCreateInput,
  AgentSessionUpdateInput,
  AgentThinkingLevel,
} from '@axon/shared'
import type { AgentEventBus } from './agent-event-bus'
import type { AgentPermissionService } from './agent-permission-service'
import { AgentServiceError } from './agent-service'
import type { AgentRunContext, AgentService } from './agent-service'
import type { AgentSessionManager } from './agent-session-manager'
import { AgentQueueCoordinator } from './agent-queue-coordinator'
import type { AgentAskUserService } from './agent-ask-user-service'
import type { AgentExitPlanService } from './agent-exit-plan-service'

export interface AgentIpcControllerOptions {
  sessions: Pick<
    AgentSessionManager,
    'list' | 'get' | 'create' | 'update' | 'delete' | 'getMessages'
  >
  agent: Pick<
    AgentService,
    'stop' | 'isActive' | 'listActiveRuns' | 'setPermissionMode'
  > & Partial<Pick<AgentService, 'waitUntilIdle'>> & {
    /** IPC 只关心执行是否结束；结构化 outcome 由协作编排层消费。 */
    sendMessage: (
      input: AgentSendInput,
      context?: AgentRunContext,
    ) => Promise<unknown>
  }
  events: Pick<AgentEventBus, 'subscribe'>
  permissions?: Pick<
    AgentPermissionService,
    'subscribe' | 'bindOwner' | 'unbindOwner' | 'respond' | 'clearSessionWhitelist'
  >
  askUsers?: Pick<AgentAskUserService, 'subscribe' | 'bindOwner' | 'unbindOwner' | 'respond' | 'cancelSession'>
  exitPlans?: Pick<AgentExitPlanService, 'subscribe' | 'bindOwner' | 'unbindOwner' | 'respond' | 'cancelSession'>
  /** 创建前检查目标 runtime 可用性，不修改已有会话归属。 */
  validateCreate?: (input: AgentSessionCreateInput) => void
}

interface RunOwner {
  owner: number
  stopRequested: boolean
  /** 根会话运行令牌；子交互上浮时替换子 run token，供 renderer 防迟到。 */
  runStartedAt?: number
}

const PERMISSION_MODES: readonly AgentPermissionMode[] = [
  'default',
  'acceptEdits',
  'bypassPermissions',
  'plan',
]
const THINKING_LEVELS: readonly AgentThinkingLevel[] = ['off', 'minimal', 'low', 'medium', 'high', 'xhigh', 'max']

function invalid(): never {
  throw new AgentServiceError('invalid_input', 'Agent IPC 请求格式无效')
}

function parseId(value: unknown): string {
  if (typeof value !== 'string' || !value.trim()) return invalid()
  return value.trim()
}

/** 只接受 renderer 可编辑字段，拒绝借 IPC 注入 runtime 恢复凭据。 */
function parseSessionInput(
  value: unknown,
  allowNull: boolean,
): AgentSessionCreateInput | AgentSessionUpdateInput {
  if (value === undefined && !allowNull) return {}
  if (!value || typeof value !== 'object' || Array.isArray(value)) return invalid()
  const input = value as Record<string, unknown>
  const allowed = ['title', 'channelId', 'modelId', 'projectId', 'cwd', 'permissionMode', 'thinkingLevel', ...(!allowNull ? ['runtimeId'] : [])]
  if (Object.keys(input).some((key) => !allowed.includes(key))) return invalid()
  if (input.title !== undefined && typeof input.title !== 'string') return invalid()
  for (const key of ['channelId', 'modelId', 'projectId', 'cwd']) {
    if (
      input[key] !== undefined
      && typeof input[key] !== 'string'
      && !(allowNull && input[key] === null)
    ) return invalid()
  }
  if (
    input.permissionMode !== undefined
    && !(allowNull && input.permissionMode === null)
    && !PERMISSION_MODES.includes(input.permissionMode as AgentPermissionMode)
  ) return invalid()
  if (
    input.thinkingLevel !== undefined
    && !(allowNull && input.thinkingLevel === null)
    && !THINKING_LEVELS.includes(input.thinkingLevel as AgentThinkingLevel)
  ) return invalid()
  if (!allowNull && input.runtimeId !== undefined && input.runtimeId !== 'pi' && input.runtimeId !== 'zima') return invalid()
  return input as AgentSessionCreateInput | AgentSessionUpdateInput
}

function parseSendInput(value: unknown): AgentSendInput {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return invalid()
  const input = value as Record<string, unknown>
  if (Object.keys(input).some((key) => !['sessionId', 'text'].includes(key))) return invalid()
  if (typeof input.sessionId !== 'string' || typeof input.text !== 'string') return invalid()
  const sessionId = input.sessionId.trim()
  const text = input.text.trim()
  if (!sessionId || !text || text.length > 100_000) return invalid()
  return { sessionId, text }
}

function parsePermissionResponse(value: unknown): AgentPermissionResponse {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return invalid()
  const input = value as Record<string, unknown>
  const allowed = ['requestId', 'behavior', 'alwaysAllow', 'updatedInput']
  if (Object.keys(input).some((key) => !allowed.includes(key))) return invalid()
  if (typeof input.requestId !== 'string' || !input.requestId.trim()) return invalid()
  if (input.behavior !== 'allow' && input.behavior !== 'deny') return invalid()
  if (input.alwaysAllow !== undefined && typeof input.alwaysAllow !== 'boolean') return invalid()
  if (
    input.updatedInput !== undefined
    && (!input.updatedInput || typeof input.updatedInput !== 'object' || Array.isArray(input.updatedInput))
  ) return invalid()
  return input as unknown as AgentPermissionResponse
}

function parseQueuedMessageControl(value: unknown): AgentQueuedMessageControlInput {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return invalid()
  const input = value as Record<string, unknown>
  if (Object.keys(input).some((key) => !['sessionId', 'messageId'].includes(key))) return invalid()
  return { sessionId: parseId(input.sessionId), messageId: parseId(input.messageId) }
}

function parseMoveQueuedMessage(value: unknown): AgentMoveQueuedMessageInput {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return invalid()
  const input = value as Record<string, unknown>
  if (Object.keys(input).some((key) => !['sessionId', 'sourceId', 'targetId', 'placement'].includes(key))) return invalid()
  if (input.placement !== 'before' && input.placement !== 'after') return invalid()
  return {
    sessionId: parseId(input.sessionId),
    sourceId: parseId(input.sourceId),
    targetId: parseId(input.targetId),
    placement: input.placement,
  }
}

function parseAskUserResponse(value: unknown): AgentAskUserResponse {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return invalid()
  const input = value as Record<string, unknown>
  if (input.behavior === 'cancel') {
    if (Object.keys(input).some((key) => !['requestId', 'behavior'].includes(key))) return invalid()
    return { requestId: parseId(input.requestId), behavior: 'cancel' }
  }
  if (input.behavior !== 'answer' || Object.keys(input).some((key) => !['requestId', 'behavior', 'answers'].includes(key))) return invalid()
  if (!input.answers || typeof input.answers !== 'object' || Array.isArray(input.answers)) return invalid()
  const answers = input.answers as Record<string, unknown>
  if (Object.entries(answers).some(([key, answer]) => !key.trim() || typeof answer !== 'string')) return invalid()
  return { requestId: parseId(input.requestId), behavior: 'answer', answers: answers as Record<string, string> }
}

function parseExitPlanResponse(value: unknown): AgentExitPlanResponse {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return invalid()
  const input = value as Record<string, unknown>
  if (input.action === 'approve') {
    if (Object.keys(input).some((key) => !['requestId', 'action', 'targetMode'].includes(key))) return invalid()
    if (input.targetMode !== 'default' && input.targetMode !== 'acceptEdits' && input.targetMode !== 'bypassPermissions') return invalid()
    return { requestId: parseId(input.requestId), action: 'approve', targetMode: input.targetMode }
  }
  if (input.action === 'feedback') {
    if (Object.keys(input).some((key) => !['requestId', 'action', 'feedback'].includes(key))) return invalid()
    if (typeof input.feedback !== 'string' || !input.feedback.trim() || input.feedback.length > 10_000) return invalid()
    return { requestId: parseId(input.requestId), action: 'feedback', feedback: input.feedback.trim() }
  }
  if (input.action !== 'reject' || Object.keys(input).some((key) => !['requestId', 'action'].includes(key))) return invalid()
  return { requestId: parseId(input.requestId), action: 'reject' }
}

function failed(error: unknown): AgentSendResult {
  if (error instanceof AgentServiceError) {
    return { success: false, code: error.code, message: error.message }
  }
  return { success: false, code: 'internal_error', message: 'Agent 请求失败' }
}

export class AgentIpcController {
  private readonly owners = new Map<string, RunOwner>()
  private readonly queue = new AgentQueueCoordinator()
  private readonly queueListeners = new Set<(snapshot: AgentQueueSnapshot) => void>()
  private readonly ownershipReleaseWaiters = new Map<string, Set<() => void>>()

  constructor(private readonly options: AgentIpcControllerOptions) {}

  /** 左侧栏只列顶层会话；子会话由后续 Task 卡片按关联读取。 */
  listSessions() { return this.options.sessions.list().filter((session) => !session.parentSessionId) }

  listActiveRuns() {
    return this.options.agent.listActiveRuns().filter((run) => (
      !this.options.sessions.get(run.sessionId)?.parentSessionId
    ))
  }

  listQueuedMessages(owner: number, value: unknown) {
    const sessionId = parseId(value)
    return this.owners.get(sessionId)?.owner === owner ? this.queue.list(sessionId) : []
  }

  getSession(value: unknown) { return this.options.sessions.get(parseId(value)) ?? null }

  createSession(value: unknown) {
    const input = parseSessionInput(value, false) as AgentSessionCreateInput
    this.options.validateCreate?.(input)
    return this.options.sessions.create(input)
  }

  updateSession(id: unknown, value: unknown) {
    return this.options.sessions.update(
      parseId(id),
      parseSessionInput(value, true) as AgentSessionUpdateInput,
    )
  }

  deleteSession(value: unknown) {
    const sessionId = parseId(value)
    if (this.options.agent.isActive(sessionId)) {
      throw new AgentServiceError('already_active', '运行期间不能删除 Agent 会话')
    }
    const removed = this.options.sessions.delete(sessionId)
    this.options.permissions?.clearSessionWhitelist(sessionId)
    this.options.askUsers?.cancelSession(sessionId)
    this.options.exitPlans?.cancelSession(sessionId)
    return removed
  }

  getMessages(value: unknown) { return this.options.sessions.getMessages(parseId(value)) }

  isActive(value: unknown): boolean {
    try { return this.options.agent.isActive(parseId(value)) } catch { return false }
  }

  /**
   * 先登记 owner 和事件订阅，再串行执行当前输入及其等待队列；同一 owner 的后续
   * send 只入队并立即返回，保证 run_started 不丢失且同一会话不并发写 JSONL。
   */
  async send(
    owner: number,
    value: unknown,
    emit: (event: AgentGenerationEvent) => void,
    context: AgentRunContext = {},
  ): Promise<AgentSendResult> {
    let input: AgentSendInput
    try { input = parseSendInput(value) } catch (error) { return failed(error) }
    const sessionId = input.sessionId
    const currentOwnership = this.owners.get(sessionId)
    if (currentOwnership) {
      if (currentOwnership.owner !== owner || currentOwnership.stopRequested) {
        return failed(new AgentServiceError('already_active', '该 Agent 会话正在其他窗口运行或正在停止'))
      }
      const queuedMessage = this.queue.enqueue(input)
      if (!queuedMessage) return failed(new AgentServiceError('queue_full', '该 Agent 会话的消息队列已满'))
      this.emitQueueSnapshot(sessionId)
      return { success: true, disposition: 'queued', queuedMessage }
    }
    if (this.options.agent.isActive(sessionId)) {
      return failed(new AgentServiceError('already_active', '该 Agent 会话正在运行'))
    }

    const ownership: RunOwner = { owner, stopRequested: false }
    this.owners.set(sessionId, ownership)
    if (this.options.permissions && !this.options.permissions.bindOwner(sessionId, owner)) {
      this.owners.delete(sessionId)
      return failed(new AgentServiceError('already_active', '该 Agent 会话已属于其他窗口'))
    }
    if (this.options.askUsers && !this.options.askUsers.bindOwner(sessionId, owner)) {
      this.options.permissions?.unbindOwner(sessionId, owner)
      this.owners.delete(sessionId)
      return failed(new AgentServiceError('already_active', '该 Agent 会话的追问通道已属于其他窗口'))
    }
    if (this.options.exitPlans && !this.options.exitPlans.bindOwner(sessionId, owner)) {
      this.options.askUsers?.unbindOwner(sessionId, owner)
      this.options.permissions?.unbindOwner(sessionId, owner)
      this.owners.delete(sessionId)
      return failed(new AgentServiceError('already_active', '该 Agent 会话的计划审批通道已属于其他窗口'))
    }
    const unsubscribeRun = this.options.events.subscribe((event) => {
      if (event.sessionId !== sessionId || this.owners.get(sessionId) !== ownership) return
      // 标题走常驻元数据广播；这里跳过，避免生成恰好完成时向 owner 重复投递。
      if (event.type === 'session_title') return
      if (event.type === 'run_started') ownership.runStartedAt = event.runStartedAt
      emit(event)
    })
    const unsubscribePermission = this.options.permissions?.subscribe((event) => {
      this.emitInteractionToOwner(sessionId, ownership, event, emit)
    }) ?? (() => {})
    const unsubscribeAskUser = this.options.askUsers?.subscribe((event) => {
      this.emitInteractionToOwner(sessionId, ownership, event, emit)
    }) ?? (() => {})
    const unsubscribeExitPlan = this.options.exitPlans?.subscribe((event) => {
      this.emitInteractionToOwner(sessionId, ownership, event, emit)
    }) ?? (() => {})
    try {
      let nextInput: AgentSendInput | undefined = input
      let nextContext = context
      while (nextInput) {
        await this.options.agent.sendMessage(nextInput, nextContext)
        // 自动通知之后若用户又排入消息，后续项仍是普通 renderer 输入。
        nextContext = { source: context.source ?? 'renderer', inputOrigin: context.inputOrigin }
        // 用户停止表示放弃当前发送链；等待消息不能在停止后意外继续执行。
        if (ownership.stopRequested) {
          this.clearQueue(sessionId)
          break
        }
        const queued = this.queue.dequeue(sessionId)
        if (queued) this.emitQueueSnapshot(sessionId)
        nextInput = queued ? { sessionId: queued.sessionId, text: queued.text } : undefined
      }
      return { success: true, disposition: 'started' }
    } catch (error) {
      this.clearQueue(sessionId)
      return failed(error)
    } finally {
      unsubscribeRun()
      unsubscribePermission()
      unsubscribeAskUser()
      unsubscribeExitPlan()
      this.options.permissions?.unbindOwner(sessionId, owner)
      this.options.askUsers?.unbindOwner(sessionId, owner)
      this.options.exitPlans?.unbindOwner(sessionId, owner)
      // 身份判断防止旧请求的 finally 清掉未来重新开始的运行。
      if (this.owners.get(sessionId) === ownership) {
        this.owners.delete(sessionId)
        this.resolveOwnershipRelease(sessionId)
      }
    }
  }

  /** 后台 Task 完成后等待父会话空闲，再以隐藏 system reminder 自动续跑主 Agent。 */
  async sendBackgroundNotification(
    owner: number,
    input: AgentSendInput,
    emit: (event: AgentGenerationEvent) => void,
  ): Promise<AgentSendResult> {
    await this.waitUntilAvailable(input.sessionId)
    return await this.send(owner, input, emit, {
      source: 'background_notification',
      synthetic: true,
    })
  }

  /** 只订阅外部入口产生的运行事件，避免与 renderer 定向回送形成重复投递。 */
  subscribeExternalRuns(emit: (event: AgentGenerationEvent) => void): () => void {
    return this.options.events.subscribe((event) => {
      if ('source' in event && event.source === 'external') emit(event)
    })
  }

  /** 标题生成晚于发送 handler 返回时仍需送达 renderer，因此使用独立常驻订阅。 */
  subscribeSessionMetadata(emit: (event: AgentGenerationEvent) => void): () => void {
    return this.options.events.subscribe((event) => {
      if (event.type === 'session_title') emit(event)
    })
  }

  /** 父会话已空闲时，仍把后台子 Agent 的交互请求投影到根会话页面。 */
  subscribeDetachedChildInteractions(emit: (event: AgentGenerationEvent) => void): () => void {
    const route = (event: AgentGenerationEvent): void => {
      const session = this.options.sessions.get(event.sessionId)
      if (!session?.parentSessionId || !session.rootSessionId) return
      // 父发送链仍在时已有定向订阅负责路由，常驻订阅不能重复投递。
      if (this.owners.has(session.rootSessionId)) return
      if (event.type === 'plan_mode_changed') return
      emit({ ...event, sessionId: session.rootSessionId })
    }
    const releases = [
      this.options.permissions?.subscribe(route),
      this.options.askUsers?.subscribe(route),
      this.options.exitPlans?.subscribe(route),
    ].filter((release): release is () => void => Boolean(release))
    return () => { for (const release of releases) release() }
  }

  /** 队列每次变更都广播完整快照；监听器异常不能反向打断派发链。 */
  subscribeQueueChanges(listener: (snapshot: AgentQueueSnapshot) => void): () => void {
    this.queueListeners.add(listener)
    return () => this.queueListeners.delete(listener)
  }

  /** 队列控制只接受当前 owner，避免其他窗口修改不属于自己的待发送消息。 */
  cancelQueuedMessage(owner: number, value: unknown): boolean {
    const input = parseQueuedMessageControl(value)
    if (this.owners.get(input.sessionId)?.owner !== owner) return false
    const changed = this.queue.cancel(input)
    if (changed) this.emitQueueSnapshot(input.sessionId)
    return changed
  }

  moveQueuedMessage(owner: number, value: unknown): boolean {
    const input = parseMoveQueuedMessage(value)
    if (this.owners.get(input.sessionId)?.owner !== owner) return false
    const changed = this.queue.move(input)
    if (changed) this.emitQueueSnapshot(input.sessionId)
    return changed
  }

  /** 权限答复同时校验负载与 owner；无效、过期、跨窗口响应均返回 false。 */
  respondPermission(owner: number, value: unknown): boolean {
    try {
      return this.options.permissions?.respond(owner, parsePermissionResponse(value)) ?? false
    } catch { return false }
  }

  /** 追问回答与权限答复使用独立契约，但同样只接受当前运行窗口。 */
  respondAskUser(owner: number, value: unknown): boolean {
    try { return this.options.askUsers?.respond(owner, parseAskUserResponse(value)) ?? false }
    catch { return false }
  }

  /** 计划审批由当前 owner 发起；服务先切换运行态和会话元数据，再唤醒模型。 */
  async respondExitPlan(owner: number, value: unknown): Promise<boolean> {
    try {
      const response = parseExitPlanResponse(value)
      return await this.options.exitPlans?.respond(
        owner,
        response,
        (sessionId, mode) => this.options.agent.setPermissionMode(sessionId, mode),
      ) ?? false
    } catch { return false }
  }

  /** 只有发起运行的 renderer 可以停止，其他窗口不能越权取消。 */
  stop(owner: number, value: unknown): boolean {
    let sessionId: string
    try { sessionId = parseId(value) } catch { return false }
    const ownership = this.owners.get(sessionId)
    if (ownership?.owner !== owner) return false
    ownership.stopRequested = true
    this.clearQueue(sessionId)
    return this.options.agent.stop(sessionId)
  }

  /** renderer 销毁或重载时，取消它拥有的全部运行。 */
  cancelOwner(owner: number): number {
    const sessionIds = [...this.owners]
      .filter(([, ownership]) => ownership.owner === owner)
      .map(([sessionId]) => sessionId)
    let cancelled = 0
    for (const sessionId of sessionIds) {
      const ownership = this.owners.get(sessionId)
      if (ownership) ownership.stopRequested = true
      this.clearQueue(sessionId)
      if (this.options.agent.stop(sessionId)) cancelled += 1
    }
    return cancelled
  }

  private emitQueueSnapshot(sessionId: string): void {
    const snapshot = { sessionId, messages: this.queue.list(sessionId) }
    for (const listener of this.queueListeners) {
      try { listener(snapshot) } catch { console.warn('[Agent 队列] 监听器处理失败') }
    }
  }

  private clearQueue(sessionId: string): void {
    if (this.queue.clear(sessionId) > 0) this.emitQueueSnapshot(sessionId)
  }

  /** 同时等待 AgentService 运行与 IPC owner 链释放，避免通知混入用户正在发送的一轮。 */
  private async waitUntilAvailable(sessionId: string): Promise<void> {
    while (this.owners.has(sessionId) || this.options.agent.isActive(sessionId)) {
      if (this.owners.has(sessionId)) {
        await new Promise<void>((resolve) => {
          const waiters = this.ownershipReleaseWaiters.get(sessionId) ?? new Set<() => void>()
          waiters.add(resolve)
          this.ownershipReleaseWaiters.set(sessionId, waiters)
          if (!this.owners.has(sessionId)) this.resolveOwnershipRelease(sessionId)
        })
      } else {
        if (!this.options.agent.waitUntilIdle) {
          throw new AgentServiceError('runtime_error', 'Agent 服务不支持等待会话空闲')
        }
        await this.options.agent.waitUntilIdle(sessionId)
      }
    }
  }

  private resolveOwnershipRelease(sessionId: string): void {
    const waiters = this.ownershipReleaseWaiters.get(sessionId)
    if (!waiters) return
    this.ownershipReleaseWaiters.delete(sessionId)
    for (const resolve of waiters) resolve()
  }

  /** 子会话交互显示在根会话，但请求体保留真实 child sessionId 供响应精确落点。 */
  private emitInteractionToOwner(
    visibleSessionId: string,
    ownership: RunOwner,
    event: AgentGenerationEvent,
    emit: (event: AgentGenerationEvent) => void,
  ): void {
    if (this.owners.get(visibleSessionId) !== ownership) return
    const eventSession = this.options.sessions.get(event.sessionId)
    const routedSessionId = eventSession?.rootSessionId ?? event.sessionId
    if (routedSessionId !== visibleSessionId) return
    if (event.sessionId === visibleSessionId) {
      emit(event)
      return
    }
    // 子会话计划获批只更新子会话元数据；不能把父页面的权限模式一起改掉。
    if (event.type === 'plan_mode_changed') return
    emit({
      ...event,
      sessionId: visibleSessionId,
      runStartedAt: ownership.runStartedAt ?? event.runStartedAt,
    })
  }
}
