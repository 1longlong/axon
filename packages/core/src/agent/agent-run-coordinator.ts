/** Agent 输入校验、客户端所有权、队列与业务运行协调。 */

import { waitWithSignal } from '../async/wait-with-signal'
import { AsyncWorkTracker } from '../async/async-work-tracker'
import type { BackendClientRegistry } from '../backend-client-registry'
import type {
  AgentAskUserResponse,
  AgentApprovalPolicy,
  AgentApprovalReviewer,
  AgentGenerationEvent,
  AgentMoveQueuedMessageInput,
  AgentPermissionResponse,
  AgentQueueSnapshot,
  AgentQueuedMessageControlInput,
  AgentSendInput,
  AgentSendResult,
  AgentSessionCreateInput,
  AgentSessionUpdateInput,
  AgentSandboxMode,
  AgentThinkingLevel,
  BackendOwnedRun,
  BackendClientId,
  BackendAgentRunEvent,
  BackendRunControlInput,
  AgentDelegation,
} from '@axon/shared'
import type { AgentEventBus } from './agent-event-bus'
import type { AgentPermissionService } from '../security/agent-permission-service'
import { AgentServiceError } from './agent-service'
import type { AgentRunContext, AgentService } from './agent-service'
import type { AgentSessionManager } from './agent-session-manager'
import { AgentQueueCoordinator } from './agent-queue-coordinator'
import type { AgentAskUserService } from '../security/agent-ask-user-service'
import { buildBackgroundTaskNotificationPrompt } from '../collaboration/agent-collaboration-tools'

export interface AgentRunCoordinatorOptions {
  clients: Pick<BackendClientRegistry, 'has' | 'getSignal' | 'subscribeDetached'>
  sessions: Pick<
    AgentSessionManager,
    'list' | 'get' | 'create' | 'update' | 'delete' | 'getMessages'
  >
  agent: Pick<
    AgentService,
    'stop' | 'isActive' | 'listActiveRuns' | 'getActiveRun'
  > & Partial<Pick<AgentService, 'waitUntilIdle'>> & {
    /** 协调层只关心执行是否结束；结构化 outcome 由协作编排层消费。 */
    sendMessage: (
      input: AgentSendInput,
      context?: AgentRunContext,
    ) => Promise<unknown>
  }
  events: Pick<AgentEventBus, 'subscribe'>
  permissions?: Pick<
    AgentPermissionService,
    'subscribe' | 'bindOwner' | 'unbindOwner' | 'respond' | 'matchesRequest' | 'clearSessionWhitelist' | 'cancelOwner'
  >
  askUsers?: Pick<AgentAskUserService, 'subscribe' | 'bindOwner' | 'unbindOwner' | 'respond' | 'matchesRequest' | 'cancelSession' | 'cancelOwner'>
  /** 创建前检查目标 runtime 可用性，不修改已有会话归属。 */
  validateCreate?: (input: AgentSessionCreateInput) => void | Promise<void>
  /** 断开时收束具体子任务，不能借父会话停止误伤另一个入口新建的任务。 */
  cancelChild?: (childSessionId: string) => void
}

interface RunOwner {
  owner: BackendClientId
  emit: (event: AgentGenerationEvent) => void
  stopRequested: boolean
  /** 根会话运行令牌；子交互上浮时替换子 run token，供 renderer 防迟到。 */
  runStartedAt?: number
}

interface ChildRoute {
  parentSessionId: string
  origin: RunOwner
}

interface RunDeliveryRoute {
  owner: BackendClientId
  visibleSessionId: string
}

const SANDBOX_MODES: readonly AgentSandboxMode[] = ['readOnly', 'workspaceWrite']
const APPROVAL_POLICIES: readonly AgentApprovalPolicy[] = ['onRequest']
// autoReview 进入中立契约，但在独立审查 Agent 落地前不接受 renderer 开启。
const APPROVAL_REVIEWERS: readonly AgentApprovalReviewer[] = ['user']
const THINKING_LEVELS: readonly AgentThinkingLevel[] = ['off', 'minimal', 'low', 'medium', 'high', 'xhigh', 'max']

function invalid(): never {
  throw new AgentServiceError('invalid_input', 'Agent 请求格式无效')
}

function parseId(value: unknown): string {
  if (typeof value !== 'string' || !value.trim()) return invalid()
  return value.trim()
}

/** 停止与交互答复必须显式携带轮次；额外字段不能自报身份或执行上下文。 */
function parseRunTarget(value: unknown, withResponse = false): { target: BackendRunControlInput; response?: unknown } {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return invalid()
  const input = value as Record<string, unknown>
  const allowed = withResponse ? ['sessionId', 'runId', 'response'] : ['sessionId', 'runId']
  if (Object.keys(input).some((key) => !allowed.includes(key))) return invalid()
  return { target: { sessionId: parseId(input.sessionId), runId: parseId(input.runId) },
    ...(withResponse ? { response: input.response } : {}) }
}

/** 只接受客户端可编辑字段，拒绝借请求 注入 runtime 恢复凭据。 */
function parseSessionInput(
  value: unknown,
  allowNull: boolean,
): AgentSessionCreateInput | AgentSessionUpdateInput {
  if (value === undefined && !allowNull) return {}
  if (!value || typeof value !== 'object' || Array.isArray(value)) return invalid()
  const input = value as Record<string, unknown>
  const allowed = [
    'title', 'channelId', 'modelId', 'projectId', 'cwd',
    'sandboxMode', 'approvalPolicy', 'approvalReviewer', 'thinkingLevel',
    ...(!allowNull ? ['runtimeId'] : []),
  ]
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
    input.sandboxMode !== undefined
    && !(allowNull && input.sandboxMode === null)
    && !SANDBOX_MODES.includes(input.sandboxMode as AgentSandboxMode)
  ) return invalid()
  if (
    input.approvalPolicy !== undefined
    && !(allowNull && input.approvalPolicy === null)
    && !APPROVAL_POLICIES.includes(input.approvalPolicy as AgentApprovalPolicy)
  ) return invalid()
  if (
    input.approvalReviewer !== undefined
    && !(allowNull && input.approvalReviewer === null)
    && !APPROVAL_REVIEWERS.includes(input.approvalReviewer as AgentApprovalReviewer)
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

function failed(error: unknown): AgentSendResult {
  if (error instanceof AgentServiceError) {
    return { success: false, code: error.code, message: error.message }
  }
  return { success: false, code: 'internal_error', message: 'Agent 请求失败' }
}

export class AgentRunCoordinator {
  private readonly work = new AsyncWorkTracker()
  private readonly owners = new Map<string, RunOwner>()
  private readonly childRoutes = new Map<string, ChildRoute>()
  private readonly interactionSubscriptions: (() => void)[]
  private readonly runListeners = new Map<BackendClientId, Set<(event: BackendAgentRunEvent) => void>>()
  private readonly runRoutes = new Map<string, RunDeliveryRoute>()
  private readonly unsubscribeRuns: () => void
  private readonly queue = new AgentQueueCoordinator()
  private readonly queuedContexts = new Map<string, AgentRunContext>()
  private readonly queueListeners = new Set<(snapshot: AgentQueueSnapshot) => void>()
  private readonly ownershipReleaseWaiters = new Map<string, Set<() => void>>()
  private readonly unsubscribeClients: () => void
  private readonly disposeController = new AbortController()
  private disposed = false

  /** 将客户端断开接到运行停止和交互收束；transport 只需注销身份，不执行业务清理。 */
  constructor(private readonly options: AgentRunCoordinatorOptions) {
    this.unsubscribeClients = options.clients.subscribeDetached((id) => this.cancelOwner(id))
    this.unsubscribeRuns = options.events.subscribe((event, run) => this.emitIdentifiedEvent(event, run))
    const route = (event: AgentGenerationEvent): void => {
      this.emitIdentifiedEvent(event, options.agent.getActiveRun(event.sessionId))
      const child = this.childRoutes.get(event.sessionId)
      if (!child || !options.clients.has(child.origin.owner)) return
      child.origin.emit({ ...event, sessionId: child.parentSessionId,
        runStartedAt: child.origin.runStartedAt ?? event.runStartedAt })
    }
    this.interactionSubscriptions = [options.permissions?.subscribe(route), options.askUsers?.subscribe(route)]
      .filter((release): release is () => void => Boolean(release))
  }

  /** 派生时捕获可信父入口；父轮结束或其他入口接管不能改变该子任务的交付对象。 */
  bindChildInteractionOwner(parentSessionId: string, childSessionId: string): () => void {
    const origin = this.owners.get(parentSessionId)
    if (!origin || origin.stopRequested || !this.options.clients.has(origin.owner)) {
      throw new AgentServiceError('invalid_input', '子任务没有可用的发起客户端')
    }
    if (!this.options.permissions?.bindOwner(childSessionId, origin.owner)) {
      throw new AgentServiceError('already_active', '子任务审批入口绑定失败')
    }
    if (!this.options.askUsers?.bindOwner(childSessionId, origin.owner)) {
      this.options.permissions.unbindOwner(childSessionId, origin.owner)
      throw new AgentServiceError('already_active', '子任务追问入口绑定失败')
    }
    const route: ChildRoute = { parentSessionId, origin: { ...origin } }
    this.childRoutes.set(childSessionId, route)
    return () => {
      if (this.childRoutes.get(childSessionId) !== route) return
      this.options.permissions?.unbindOwner(childSessionId, origin.owner)
      this.options.askUsers?.unbindOwner(childSessionId, origin.owner)
      this.childRoutes.delete(childSessionId)
    }
  }

  /** 终态已落盘后用派生时的入口续跑；断开只取消投递，不改写已保存的结果。 */
  async notifyBackgroundCompletion(delegation: AgentDelegation): Promise<void> {
    const route = this.childRoutes.get(delegation.childSessionId)
    if (!route || !this.options.clients.has(route.origin.owner)) return
    const result = await this.sendBackgroundNotification(route.origin.owner, {
      sessionId: delegation.parentSessionId, text: buildBackgroundTaskNotificationPrompt(delegation),
    }, route.origin.emit)
    if (!result.success && this.options.clients.has(route.origin.owner)) {
      console.warn(`[Agent 协作] 后台续跑未启动: ${delegation.id}`, result.message)
    }
  }

  /** 返回真实主/子执行身份，包含预检期；投影到父页面不改变子轮控制目标。 */
  getOwnedRun(owner: BackendClientId, sessionId: string): BackendOwnedRun | undefined {
    const root = this.owners.get(sessionId)
    const child = this.childRoutes.get(sessionId)
    const actualOwner = child?.origin.owner ?? root?.owner
    return !this.disposed && this.options.clients.has(owner) && actualOwner === owner && !root?.stopRequested
      ? this.options.agent.getActiveRun(sessionId) : undefined
  }

  /** 新后端入口订阅实际轮次包；关闭入口立即移除订阅，慢/失败消费者不打断业务。 */
  subscribeRunEvents(owner: BackendClientId, listener: (event: BackendAgentRunEvent) => void): () => void {
    if (this.disposed || !this.options.clients.has(owner)) throw new AgentServiceError('invalid_input', '运行客户端未登记或已断开')
    const listeners = this.runListeners.get(owner) ?? new Set<(event: BackendAgentRunEvent) => void>()
    listeners.add(listener)
    this.runListeners.set(owner, listeners)
    return () => {
      listeners.delete(listener)
      if (listeners.size === 0 && this.runListeners.get(owner) === listeners) this.runListeners.delete(owner)
    }
  }

  /** 精确停止当前主/子轮；旧轮或页面父 ID 不能停止实际子执行。 */
  stopRun(owner: BackendClientId, value: unknown): boolean {
    try {
      const { target } = parseRunTarget(value)
      const run = this.getOwnedRun(owner, target.sessionId)
      if (!run || run.runId !== target.runId) return false
      if (this.childRoutes.has(target.sessionId)) {
        if (this.options.cancelChild) { this.options.cancelChild(target.sessionId); return true }
        return this.options.agent.stop(target.sessionId)
      }
      return this.stop(owner, target.sessionId)
    } catch { return false }
  }

  /** 同时核对客户端、真实会话/轮次和 pending request，再交给审批服务授予权限。 */
  respondRunPermission(owner: BackendClientId, value: unknown): boolean {
    try {
      const { target, response: raw } = parseRunTarget(value, true)
      const response = parsePermissionResponse(raw)
      const run = this.getOwnedRun(owner, target.sessionId)
      if (!run || run.runId !== target.runId || !this.options.permissions?.matchesRequest(
        owner, response.requestId, target.sessionId, run.runStartedAt,
      )) return false
      return this.options.permissions.respond(owner, response)
    } catch { return false }
  }

  /** 追问与审批使用同一精确轮次边界，过期答案不能进入下一轮工具结果。 */
  respondRunAskUser(owner: BackendClientId, value: unknown): boolean {
    try {
      const { target, response: raw } = parseRunTarget(value, true)
      const response = parseAskUserResponse(raw)
      const run = this.getOwnedRun(owner, target.sessionId)
      if (!run || run.runId !== target.runId || !this.options.askUsers?.matchesRequest(
        owner, response.requestId, target.sessionId, run.runStartedAt,
      )) return false
      return this.options.askUsers.respond(owner, response)
    } catch { return false }
  }

  /** 左侧栏只列顶层会话；子会话由后续 Task 卡片按关联读取。 */
  listSessions() { return this.options.sessions.list().filter((session) => !session.parentSessionId) }

  listActiveRuns() {
    return this.options.agent.listActiveRuns().filter((run) => (
      !this.options.sessions.get(run.sessionId)?.parentSessionId
    ))
  }

  listQueuedMessages(owner: BackendClientId, value: unknown) {
    const sessionId = parseId(value)
    return this.options.clients.has(owner) && this.owners.get(sessionId)?.owner === owner ? this.queue.list(sessionId) : []
  }

  getSession(value: unknown) { return this.options.sessions.get(parseId(value)) ?? null }

  /** 等待 runtime/凭据校验通过才建立会话，失败不能产生无效持久化记录。 */
  createSession(value: unknown, signal?: AbortSignal) {
    return this.work.run(() => this.executeCreateSession(value, signal))
  }

  /** 预检跨过退出时不落索引；取消发送等待后，drain 仍等待原预检真实结束。 */
  private async executeCreateSession(value: unknown, signal?: AbortSignal) {
    const input = parseSessionInput(value, false) as AgentSessionCreateInput
    if (this.disposed) throw new AgentServiceError('invalid_input', '运行协调服务已释放')
    signal?.throwIfAborted()
    await this.options.validateCreate?.(input)
    // 异步凭据/runtime 预检返回后复核入口取消，不能创建迟到的会话记录。
    signal?.throwIfAborted()
    if (this.disposed) throw new AgentServiceError('invalid_input', '运行协调服务已释放')
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
  send(
    owner: BackendClientId,
    value: unknown,
    emit: (event: AgentGenerationEvent) => void,
    context: AgentRunContext = {},
  ): Promise<AgentSendResult> {
    return this.work.run(() => this.executeSend(owner, value, emit, context))
  }

  /** 等待整条发送/排队链的 finally 释放 owner，而非只等待模型本轮空闲。 */
  private async executeSend(
    owner: BackendClientId,
    value: unknown,
    emit: (event: AgentGenerationEvent) => void,
    context: AgentRunContext,
  ): Promise<AgentSendResult> {
    let input: AgentSendInput
    try { input = parseSendInput(value) } catch (error) { return failed(error) }
    if (this.disposed || !this.options.clients.has(owner)) {
      return failed(new AgentServiceError('invalid_input', '运行客户端未登记或已断开'))
    }
    const sessionId = input.sessionId
    const currentOwnership = this.owners.get(sessionId)
    if (currentOwnership) {
      if (currentOwnership.owner !== owner || currentOwnership.stopRequested) {
        return failed(new AgentServiceError('already_active', '该 Agent 会话正在其他客户端运行或正在停止'))
      }
      const queuedMessage = this.queue.enqueue(input)
      if (!queuedMessage) return failed(new AgentServiceError('queue_full', '该 Agent 会话的消息队列已满'))
      this.queuedContexts.set(queuedMessage.id, { ...context })
      this.emitQueueSnapshot(sessionId)
      return { success: true, disposition: 'queued', queuedMessage }
    }
    if (this.options.agent.isActive(sessionId)) {
      return failed(new AgentServiceError('already_active', '该 Agent 会话正在运行'))
    }

    const ownership: RunOwner = { owner, emit, stopRequested: false }
    this.owners.set(sessionId, ownership)
    if (this.options.permissions && !this.options.permissions.bindOwner(sessionId, owner)) {
      this.owners.delete(sessionId)
      return failed(new AgentServiceError('already_active', '该 Agent 会话已属于其他客户端'))
    }
    if (this.options.askUsers && !this.options.askUsers.bindOwner(sessionId, owner)) {
      this.options.permissions?.unbindOwner(sessionId, owner)
      this.owners.delete(sessionId)
      return failed(new AgentServiceError('already_active', '该 Agent 会话的追问通道已属于其他客户端'))
    }
    const unsubscribeRun = this.options.events.subscribe((event) => {
      if (event.sessionId !== sessionId || this.owners.get(sessionId) !== ownership) return
      // 标题走常驻元数据广播；这里跳过，避免生成恰好完成时向 owner 重复投递。
      if (event.type === 'session_title') return
      if (event.type === 'run_started') {
        ownership.runStartedAt = event.runStartedAt
      }
      emit(event)
    })
    const unsubscribePermission = this.options.permissions?.subscribe((event) => {
      this.emitInteractionToOwner(sessionId, ownership, event, emit)
    }) ?? (() => {})
    const unsubscribeAskUser = this.options.askUsers?.subscribe((event) => {
      this.emitInteractionToOwner(sessionId, ownership, event, emit)
    }) ?? (() => {})
    try {
      let nextInput: AgentSendInput | undefined = input
      let nextContext = context
      while (nextInput) {
        await this.options.agent.sendMessage(nextInput, nextContext)
        // 用户停止表示放弃当前发送链；等待消息不能在停止后意外继续执行。
        if (ownership.stopRequested) {
          this.clearQueue(sessionId)
          break
        }
        const queued = this.queue.dequeue(sessionId)
        if (queued) {
          // 每条输入保留自己的来源/合成标记，不能继承上一条后台通知的身份。
          nextContext = this.queuedContexts.get(queued.id)!
          this.queuedContexts.delete(queued.id)
          this.emitQueueSnapshot(sessionId)
        }
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
      this.options.permissions?.unbindOwner(sessionId, owner)
      this.options.askUsers?.unbindOwner(sessionId, owner)
      // 身份判断防止旧请求的 finally 清掉未来重新开始的运行。
      if (this.owners.get(sessionId) === ownership) {
        this.owners.delete(sessionId)
        this.resolveOwnershipRelease(sessionId)
      }
    }
  }

  /** 后台 Task 完成后等待父会话空闲，再以隐藏 system reminder 自动续跑主 Agent。 */
  sendBackgroundNotification(
    owner: BackendClientId,
    input: AgentSendInput,
    emit: (event: AgentGenerationEvent) => void,
  ): Promise<AgentSendResult> {
    return this.work.run(() => this.executeBackgroundNotification(owner, input, emit))
  }

  /** 记录后台空闲等待直到取消清理结束，退出后不会迟到启动合成续跑。 */
  private async executeBackgroundNotification(
    owner: BackendClientId,
    input: AgentSendInput,
    emit: (event: AgentGenerationEvent) => void,
  ): Promise<AgentSendResult> {
    const clientSignal = this.options.clients.getSignal(owner)
    if (!clientSignal || this.disposed) return failed(new AgentServiceError('invalid_input', '运行客户端未登记或已断开'))
    const signal = AbortSignal.any([clientSignal, this.disposeController.signal])
    try { await this.waitUntilAvailable(input.sessionId, signal) }
    catch (error) {
      return signal.aborted ? failed(new AgentServiceError('invalid_input', '后台通知已取消')) : failed(error)
    }
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
      if (this.childRoutes.has(event.sessionId)) return
      // 父发送链仍在时已有定向订阅负责路由，常驻订阅不能重复投递。
      if (this.owners.has(session.rootSessionId)) return
      emit({ ...event, sessionId: session.rootSessionId })
    }
    const releases = [
      this.options.permissions?.subscribe(route),
      this.options.askUsers?.subscribe(route),
    ].filter((release): release is () => void => Boolean(release))
    return () => { for (const release of releases) release() }
  }

  /** 队列每次变更都广播完整快照；监听器异常不能反向打断派发链。 */
  subscribeQueueChanges(listener: (snapshot: AgentQueueSnapshot) => void): () => void {
    this.queueListeners.add(listener)
    return () => this.queueListeners.delete(listener)
  }

  /** 协议队列只交给当前 owner；清空/停止快照也需送达，不靠是否存在活跃 run 判断。 */
  subscribeClientQueueChanges(owner: BackendClientId, listener: (snapshot: AgentQueueSnapshot) => void): () => void {
    return this.subscribeQueueChanges((snapshot) => {
      if (this.options.clients.has(owner) && this.owners.get(snapshot.sessionId)?.owner === owner) listener(snapshot)
    })
  }

  /** 队列控制只接受当前 owner，避免其他客户端修改不属于自己的待发送消息。 */
  cancelQueuedMessage(owner: BackendClientId, value: unknown): boolean {
    const input = parseQueuedMessageControl(value)
    if (!this.options.clients.has(owner) || this.owners.get(input.sessionId)?.owner !== owner) return false
    const changed = this.queue.cancel(input)
    if (changed) {
      this.queuedContexts.delete(input.messageId)
      this.emitQueueSnapshot(input.sessionId)
    }
    return changed
  }

  moveQueuedMessage(owner: BackendClientId, value: unknown): boolean {
    const input = parseMoveQueuedMessage(value)
    if (!this.options.clients.has(owner) || this.owners.get(input.sessionId)?.owner !== owner) return false
    const changed = this.queue.move(input)
    if (changed) this.emitQueueSnapshot(input.sessionId)
    return changed
  }

  /** 权限答复同时校验负载与 owner；无效、过期、跨窗口响应均返回 false。 */
  respondPermission(owner: BackendClientId, value: unknown): boolean {
    if (!this.options.clients.has(owner)) return false
    try {
      return this.options.permissions?.respond(owner, parsePermissionResponse(value)) ?? false
    } catch { return false }
  }

  /** 追问回答与权限答复使用独立契约，但同样只接受当前运行客户端。 */
  respondAskUser(owner: BackendClientId, value: unknown): boolean {
    if (!this.options.clients.has(owner)) return false
    try { return this.options.askUsers?.respond(owner, parseAskUserResponse(value)) ?? false }
    catch { return false }
  }

  /** 只有发起运行的 renderer 可以停止，其他客户端不能越权取消。 */
  stop(owner: BackendClientId, value: unknown): boolean {
    if (!this.options.clients.has(owner)) return false
    let sessionId: string
    try { sessionId = parseId(value) } catch { return false }
    const ownership = this.owners.get(sessionId)
    if (ownership?.owner !== owner) return false
    ownership.stopRequested = true
    this.clearQueue(sessionId)
    return this.options.agent.stop(sessionId)
  }

  /** 客户端断开时，取消它拥有的全部运行。 */
  cancelOwner(owner: BackendClientId): number {
    this.runListeners.delete(owner)
    for (const [runId, route] of this.runRoutes) {
      if (route.owner === owner) this.runRoutes.delete(runId)
    }
    const failures: unknown[] = []
    for (const cleanup of [() => this.options.permissions?.cancelOwner(owner), () => this.options.askUsers?.cancelOwner(owner)]) {
      try { cleanup() } catch (error) { failures.push(error) }
    }
    for (const [sessionId, route] of [...this.childRoutes]) {
      if (route.origin.owner !== owner) continue
      try {
        if (this.options.cancelChild) this.options.cancelChild(sessionId)
        else this.options.agent.stop(sessionId)
      } catch (error) { failures.push(error) }
      this.childRoutes.delete(sessionId)
    }
    const sessionIds = [...this.owners]
      .filter(([, ownership]) => ownership.owner === owner)
      .map(([sessionId]) => sessionId)
    let cancelled = 0
    for (const sessionId of sessionIds) {
      const ownership = this.owners.get(sessionId)
      if (ownership) ownership.stopRequested = true
      this.clearQueue(sessionId)
      try { if (this.options.agent.stop(sessionId)) cancelled += 1 }
      catch (error) { failures.push(error) }
    }
    if (failures.length) throw new AggregateError(failures, '客户端运行清理失败')
    return cancelled
  }

  /** 同步停止已登记的发送链并注销断开订阅；完整运行等待由后端生命周期层负责。 */
  dispose(): void {
    if (this.disposed) return
    this.disposed = true
    this.disposeController.abort()
    this.unsubscribeClients()
    this.unsubscribeRuns()
    for (const release of this.interactionSubscriptions) release()
    this.runListeners.clear()
    this.runRoutes.clear()
    const failures: unknown[] = []
    for (const owner of new Set([...this.owners.values(), ...[...this.childRoutes.values()].map((route) => route.origin)]
      .map((run) => run.owner))) {
      try { this.cancelOwner(owner) } catch (error) { failures.push(error) }
    }
    if (failures.length) throw new AggregateError(failures, '运行协调资源清理失败')
  }

  /** 入口释放后等待发送、建会话预检和后台等待完成；真实 adapter 清理由下层负责。 */
  drain(): Promise<void> { return this.work.drain() }

  private emitQueueSnapshot(sessionId: string): void {
    const snapshot = { sessionId, messages: this.queue.list(sessionId) }
    for (const listener of this.queueListeners) {
      try { listener(snapshot) } catch { console.warn('[Agent 队列] 监听器处理失败') }
    }
  }

  /** 实际执行身份与页面归属分开编码；不为缺失身份的事件猜测 runId。 */
  private emitIdentifiedEvent(event: AgentGenerationEvent, run: BackendOwnedRun | undefined): void {
    if (this.disposed || event.type === 'session_title' || !run || run.sessionId !== event.sessionId
      || run.runStartedAt !== event.runStartedAt) return
    const child = this.childRoutes.get(event.sessionId)
    const root = this.owners.get(event.sessionId)
    const currentOwner = child?.origin.owner ?? root?.owner
    let route = this.runRoutes.get(run.runId)
    if (event.type === 'run_started') {
      if (!currentOwner || this.options.agent.getActiveRun(event.sessionId)?.runId !== run.runId) return
      route = { owner: currentOwner, visibleSessionId: child?.parentSessionId ?? event.sessionId }
      this.runRoutes.set(run.runId, route)
    }
    // 子任务取消会先释放交互绑定；终态仍交给开始时登记的入口，不能改投当前父 owner。
    if (event.type === 'run_finished') this.runRoutes.delete(run.runId)
    // 用户消息落盘失败可能没有开始事件，完成包仍携带执行层明确提供的身份。
    if (!route && event.type === 'run_finished' && currentOwner) {
      route = { owner: currentOwner, visibleSessionId: child?.parentSessionId ?? event.sessionId }
    }
    if (!route || !this.options.clients.has(route.owner)) return
    const envelope: BackendAgentRunEvent = {
      run: { ...run }, visibleSessionId: route.visibleSessionId, event,
    }
    for (const listener of this.runListeners.get(route.owner) ?? []) {
      try { listener(envelope) } catch { console.warn('[Agent 运行] 客户端事件处理失败') }
    }
  }

  private clearQueue(sessionId: string): void {
    for (const message of this.queue.list(sessionId)) this.queuedContexts.delete(message.id)
    if (this.queue.clear(sessionId) > 0) this.emitQueueSnapshot(sessionId)
  }

  /** 同时等待 AgentService 运行与 owner 链释放；断开时移除等待者，不能迟到启动通知。 */
  private async waitUntilAvailable(sessionId: string, signal: AbortSignal): Promise<void> {
    while (this.owners.has(sessionId) || this.options.agent.isActive(sessionId)) {
      signal.throwIfAborted()
      if (this.owners.has(sessionId)) {
        let release = (): void => {}
        const idle = new Promise<void>((resolve) => {
          release = resolve
          const waiters = this.ownershipReleaseWaiters.get(sessionId) ?? new Set<() => void>()
          waiters.add(resolve)
          this.ownershipReleaseWaiters.set(sessionId, waiters)
          if (!this.owners.has(sessionId)) this.resolveOwnershipRelease(sessionId)
        })
        try { await waitWithSignal(idle, signal) }
        finally {
          const waiters = this.ownershipReleaseWaiters.get(sessionId)
          waiters?.delete(release)
          if (waiters?.size === 0) this.ownershipReleaseWaiters.delete(sessionId)
        }
      } else {
        if (!this.options.agent.waitUntilIdle) {
          throw new AgentServiceError('runtime_error', 'Agent 服务不支持等待会话空闲')
        }
        await waitWithSignal(this.options.agent.waitUntilIdle(sessionId), signal)
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
    // 新路径的子交互由固定 origin 定向投递，不借当前父轮转发或重复广播。
    if (this.childRoutes.has(event.sessionId)) return
    const eventSession = this.options.sessions.get(event.sessionId)
    const routedSessionId = eventSession?.rootSessionId ?? event.sessionId
    if (routedSessionId !== visibleSessionId) return
    if (event.sessionId === visibleSessionId) {
      emit(event)
      return
    }
    emit({
      ...event,
      sessionId: visibleSessionId,
      runStartedAt: ownership.runStartedAt ?? event.runStartedAt,
    })
  }
}
