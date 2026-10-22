/** Agent 输入校验、客户端所有权、队列与业务运行协调。 */

import { waitWithSignal } from '../async/wait-with-signal'
import { randomUUID } from 'node:crypto'
import { AsyncWorkTracker } from '../async/async-work-tracker'
import { AgentSessionFactory } from './agent-session-factory'
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
  AgentUserInputPolicy,
  BackendOwnedRun,
  BackendClientId,
  BackendAgentRunEvent,
  BackendRunControlInput,
  AgentDelegation,
  AgentWorkflowResult,
  BackendAgentWorkflowEvent,
  AgentPauseSnapshot,
  AgentPauseChangedEvent,
  AgentCompletionPayload,
  SDKResultMessage,
  SDKMessage,
  SDKUserMessage,
} from '@axon/shared'
import type { AgentEventBus } from './agent-event-bus'
import type { AgentPermissionService } from '../security/agent-permission-service'
import { AgentServiceError } from './agent-service'
import type { AgentContinueExecutionInput, AgentRunContext, AgentService } from './agent-service'
import type { AgentSessionManager } from './agent-session-manager'
import { AgentQueueCoordinator } from './agent-queue-coordinator'
import type { AgentAskUserService } from '../security/agent-ask-user-service'
import { buildBackgroundTaskNotificationPrompt } from '../collaboration/agent-collaboration-tools'
import { AgentWorkflowCoordinator } from './agent-workflow-coordinator'
import { AgentAttachmentError } from './agent-attachment-service'
import { parseAgentInputParts, validateAgentInputPartReferences } from '@axon/shared'
import type { AgentAttachmentService } from './agent-attachment-service'
import type { AgentAttachmentLease } from './agent-attachment-lease'

/** 工作流令牌只由可信协调层附加，不属于用户输入或 Runtime 上下文。 */
interface CoordinatorRunContext extends AgentRunContext {
  workflowId?: string
}

export interface AgentRunCoordinatorOptions {
  attachments?: Pick<AgentAttachmentService, 'takeDraft'>
  clients: Pick<BackendClientRegistry, 'has' | 'getSignal' | 'subscribeDetached'>
  sessions: Pick<
    AgentSessionManager,
    'list' | 'get' | 'create' | 'update' | 'delete' | 'getMessages' | 'appendMessage'
  >
  agent: Pick<
    AgentService,
    'stop' | 'isActive' | 'listActiveRuns' | 'getActiveRun'
  > & Partial<Pick<AgentService, 'waitUntilIdle' | 'continueMessage' | 'getActiveTurnId' | 'validateAttachmentInput'>> & {
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
  /** 上层装配已解析的业务配置；普通 RPC 只能先经过本层输入校验。 */
  prepareCreate?: (input: AgentSessionCreateInput) => AgentSessionCreateInput
  sessionFactory?: AgentSessionFactory
  resolveCreationWorkspace?: (projectId: string) => string
  /** 断开时收束具体子任务，不能借父会话停止误伤另一个入口新建的任务。 */
  cancelChild?: (childSessionId: string) => void
  cancelWorkflowDescendants?: (rootSessionId: string) => void
  waitForWorkflowDescendants?: (rootSessionId: string) => Promise<void>
  isWorkflowRootBusy?: (rootSessionId: string) => boolean
}

interface RunOwner {
  owner: BackendClientId
  emit: (event: AgentGenerationEvent) => void
  stopRequested: boolean
  workflowId?: string
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
const APPROVAL_POLICIES: readonly AgentApprovalPolicy[] = ['onRequest', 'never']
const USER_INPUT_POLICIES: readonly AgentUserInputPolicy[] = ['ask', 'reject']
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

/** 原轮次跟随最近实际输入的消息 UUID；工具回传与继续标记不创建新轮次。 */
function currentTurnId(messages: readonly SDKMessage[]): string | undefined {
  const user = messages.findLast((message) => message.type === 'user'
    && (message as SDKUserMessage).message?.content?.some((block) => block.type === 'text')) as SDKUserMessage | undefined
  return typeof user?.uuid === 'string' ? user.uuid : undefined
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
    'sandboxMode', 'approvalPolicy', 'approvalReviewer', 'thinkingLevel', 'userInputPolicy',
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
    input.userInputPolicy !== undefined
    && !(allowNull && input.userInputPolicy === null)
    && !USER_INPUT_POLICIES.includes(input.userInputPolicy as AgentUserInputPolicy)
  ) return invalid()
  if (
    input.thinkingLevel !== undefined
    && !(allowNull && input.thinkingLevel === null)
    && !THINKING_LEVELS.includes(input.thinkingLevel as AgentThinkingLevel)
  ) return invalid()
  if (!allowNull && input.runtimeId !== undefined && input.runtimeId !== 'pi' && input.runtimeId !== 'zima') return invalid()
  return input as AgentSessionCreateInput | AgentSessionUpdateInput
}

/** 输入边界不修剪正文；队列、AgentService 和 JSONL 均消费同一份原始用户任务。 */
function parseSendInput(value: unknown): AgentSendInput {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return invalid()
  const input = value as Record<string, unknown>
  if (Object.keys(input).some((key) => !['sessionId', 'text', 'inputParts', 'attachmentDraftId', 'imageModelConsent'].includes(key))) return invalid()
  if (typeof input.sessionId !== 'string' || typeof input.text !== 'string') return invalid()
  const sessionId = input.sessionId.trim()
  const text = input.text
  const attachmentDraftId = input.attachmentDraftId === undefined ? undefined : parseId(input.attachmentDraftId)
  let imageModelConsent: AgentSendInput['imageModelConsent']
  if (input.imageModelConsent !== undefined) {
    if (!input.imageModelConsent || typeof input.imageModelConsent !== 'object' || Array.isArray(input.imageModelConsent)
      || Object.keys(input.imageModelConsent).some((key) => key !== 'channelId' && key !== 'modelId')) return invalid()
    const consent = input.imageModelConsent as Record<string, unknown>
    imageModelConsent = { channelId: parseId(consent.channelId), modelId: parseId(consent.modelId) }
  }
  if (!sessionId || (!text.trim() && !attachmentDraftId) || text.includes('\0') || text.length > 100_000) return invalid()
  let inputParts: AgentSendInput['inputParts']
  try { inputParts = parseAgentInputParts(input.inputParts, text) } catch { return invalid() }
  return { sessionId, text, ...(inputParts ? { inputParts } : {}), ...(attachmentDraftId ? { attachmentDraftId } : {}), ...(imageModelConsent ? { imageModelConsent } : {}) }
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
  if (error instanceof AgentAttachmentError) return { success: false, code: 'invalid_input', message: error.message }
  if (error instanceof AgentServiceError) {
    return { success: false, code: error.code, message: error.message }
  }
  return { success: false, code: 'internal_error', message: 'Agent 请求失败' }
}

export class AgentRunCoordinator {
  private readonly work = new AsyncWorkTracker()
  private readonly workflows: AgentWorkflowCoordinator
  private readonly owners = new Map<string, RunOwner>()
  private readonly childRoutes = new Map<string, ChildRoute>()
  private readonly interactionSubscriptions: (() => void)[]
  private readonly runListeners = new Map<BackendClientId, Set<(event: BackendAgentRunEvent) => void>>()
  private readonly runRoutes = new Map<string, RunDeliveryRoute>()
  private readonly unsubscribeRuns: () => void
  private readonly queue = new AgentQueueCoordinator()
  private readonly queuedContexts = new Map<string, CoordinatorRunContext>()
  private readonly attachmentCleanupFailures: unknown[] = []
  private readonly queueListeners = new Set<(snapshot: AgentQueueSnapshot) => void>()
  private readonly ownershipReleaseWaiters = new Map<string, Set<() => void>>()
  private readonly pauses = new Map<string, AgentPauseSnapshot>()
  private readonly pauseListeners = new Set<(event: AgentPauseChangedEvent) => void>()
  private readonly unsubscribeClients: () => void
  private readonly disposeController = new AbortController()
  private disposed = false
  private readonly sessionFactory: AgentSessionFactory

  /** 将客户端断开接到运行停止和交互收束；transport 只需注销身份，不执行业务清理。 */
  constructor(private readonly options: AgentRunCoordinatorOptions) {
    this.sessionFactory = options.sessionFactory ?? new AgentSessionFactory({ sessions: options.sessions, validateCreate: options.validateCreate })
    this.workflows = new AgentWorkflowCoordinator({ clients: options.clients, getSession: (id) => options.sessions.get(id),
      busy: (id) => this.pauses.has(id) || this.owners.has(id) || options.agent.isActive(id) || Boolean(options.isWorkflowRootBusy?.(id)),
      send: (owner, input, workflowId) => this.send(owner, input, () => {}, { source: 'external', workflowId }),
      stop: (owner, id) => { this.stopOwnedChain(owner, id) },
      cancelDescendants: options.cancelWorkflowDescendants, waitForDescendants: options.waitForWorkflowDescendants,
    })
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
    // 暂停保留子结果，但不允许交付器替用户立即启动主轮；根等待仍收束真实交付 Promise。
    if (this.pauseBlocksBackground(delegation.parentSessionId)) return
    const result = await this.sendBackgroundNotification(route.origin.owner, {
      sessionId: delegation.parentSessionId, text: buildBackgroundTaskNotificationPrompt(delegation),
    }, route.origin.emit, route.origin.workflowId)
    if (this.pauseBlocksBackground(delegation.parentSessionId)) return
    if (!result.success && this.options.clients.has(route.origin.owner)) {
      console.warn(`[Agent 协作] 后台续跑未启动: ${delegation.id}`, result.message)
      // 交付器记录根失败；打印日志不能把未启动的续跑变成已完成工作。
      throw new AgentServiceError(result.code === 'internal_error' ? 'runtime_error' : result.code, '后台结果续跑未启动')
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

  /** 非交互应用入口保留整个工作流归属，既有 send 仍是普通桌面单轮命令。 */
  executeWorkflow(owner: BackendClientId, value: unknown, signal?: AbortSignal): Promise<AgentWorkflowResult> {
    return this.workflows.execute(owner, parseSendInput(value), signal)
  }
  getOwnedWorkflow(owner: BackendClientId, value: unknown) { return this.workflows.getOwned(owner, parseId(value)) ?? null }
  subscribeWorkflowEvents(owner: BackendClientId, listener: (event: BackendAgentWorkflowEvent) => void): () => void {
    return this.workflows.subscribe(owner, listener)
  }
  cancelWorkflow(owner: BackendClientId, value: unknown): boolean {
    if (!value || typeof value !== 'object' || Array.isArray(value)) return invalid()
    const input = value as Record<string, unknown>
    if (Object.keys(input).some((key) => !['sessionId', 'workflowId'].includes(key))) return invalid()
    return this.workflows.cancel(owner, { sessionId: parseId(input.sessionId), workflowId: parseId(input.workflowId) })
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

  /** 读取公开暂停快照；在途状态不冒充已落盘且已收束的暂停凭据。 */
  getPause(owner: BackendClientId, value: unknown): AgentPauseSnapshot | null {
    if (this.disposed || !this.options.clients.has(owner)) return null
    const sessionId = parseId(value)
    const pending = this.pauses.get(sessionId)
    if (pending) return { ...pending }
    if (this.workflows.active(sessionId) || this.owners.has(sessionId) || this.options.agent.isActive(sessionId)
      || this.options.isWorkflowRootBusy?.(sessionId)) return null
    return this.readStoredPause(sessionId)
  }

  /** 已登记观察入口只收到会话失效通知；实际暂停状态/继续凭据仍由 getPause 核验。 */
  subscribePauseChanges(listener: (event: AgentPauseChangedEvent) => void): () => void {
    if (this.disposed) throw new AgentServiceError('invalid_input', '运行协调服务已释放')
    this.pauseListeners.add(listener)
    return () => { this.pauseListeners.delete(listener) }
  }

  private emitPauseChanged(sessionId: string): void {
    if (this.disposed) return
    for (const listener of this.pauseListeners) {
      try { listener({ sessionId }) } catch { console.warn('[Agent 暂停] 状态通知失败') }
    }
  }

  /** 精确暂停原 owner 的根轮；封口后等待主发送 finally 和本根子任务/交付，不全局 drain。 */
  pauseRun(owner: BackendClientId, value: unknown): Promise<AgentPauseSnapshot> {
    return this.work.run(() => this.executePause(owner, value))
  }

  /** 先封口，再取消和等待；只有原轮终态及本根交付均确认后才落盘暂停 marker。 */
  private async executePause(owner: BackendClientId, value: unknown): Promise<AgentPauseSnapshot> {
    const { target } = parseRunTarget(value)
    const run = this.getOwnedRun(owner, target.sessionId)
    const session = this.options.sessions.get(target.sessionId)
    if (!run || run.runId !== target.runId || !session || session.parentSessionId
      || session.creationOrigin === 'exec' || session.creationOrigin === 'loop' || this.workflows.active(target.sessionId)) {
      throw new AgentServiceError('invalid_input', '只能暂停当前客户端的普通根会话轮次')
    }
    if (this.pauses.has(target.sessionId)) throw new AgentServiceError('already_active', '会话正在暂停')
    let workspacePath: string | undefined
    let workspaceUnavailable = false
    try { workspacePath = session.projectId ? this.options.resolveCreationWorkspace?.(session.projectId) : undefined }
    catch { workspaceUnavailable = true }
    const turnId = this.options.agent.getActiveTurnId?.(run.sessionId)
      ?? currentTurnId(this.options.sessions.getMessages(run.sessionId))
    if (!turnId) throw new AgentServiceError('invalid_input', '当前执行缺少原轮次输入记录')
    const pause: AgentPauseSnapshot = { ...run, turnId, pauseId: randomUUID(), state: 'pausing' }
    this.pauses.set(target.sessionId, pause)
    this.emitPauseChanged(target.sessionId)
    let completion: AgentCompletionPayload | undefined
    const unsubscribe = this.options.events.subscribe((event) => {
      if (event.type === 'run_finished' && event.sessionId === run.sessionId && event.runStartedAt === run.runStartedAt) {
        completion = event.completion
      }
    })
    try {
      // 两个取消动作都尝试；某个失败不跳过实际等待，且不能发布可继续状态。
      const failures: unknown[] = []
      for (const stop of [() => this.stopOwnedChain(owner, run.sessionId),
        () => this.options.cancelWorkflowDescendants?.(run.sessionId)]) {
        try { stop() } catch (error) { failures.push(error) }
      }
      await this.waitUntilAvailable(run.sessionId, this.disposeController.signal)
      try { await this.options.waitForWorkflowDescendants?.(run.sessionId) } catch (error) { failures.push(error) }
      if (failures.length) throw new AgentServiceError('runtime_error', '暂停执行清理失败，未生成继续凭据')
      if (this.disposed || !this.options.clients.has(owner)) {
        throw new AgentServiceError('invalid_input', '暂停客户端已断开')
      }
      if (this.options.isWorkflowRootBusy?.(run.sessionId)) {
        throw new AgentServiceError('runtime_error', '本根子任务尚未收束，无法继续')
      }
      // 工作区失效不能阻止取消旧执行，但不能继续使用无法确认的原目录。
      try {
        if (workspaceUnavailable || (workspacePath && this.options.resolveCreationWorkspace?.(session.projectId!) !== workspacePath)) {
          throw new Error('工作区已改变')
        }
      } catch { throw new AgentServiceError('workspace_unavailable', '暂停期间项目工作区不可用或已改变') }
      if (!completion?.persisted || !completion.stoppedByUser || completion.terminalReason !== 'stopped') {
        throw new AgentServiceError('runtime_error', '原轮未形成已保存的停止终态，无法继续')
      }
      const result = this.options.sessions.getMessages(run.sessionId).findLast((message) => message.type === 'result'
        && !(message as SDKResultMessage).isSyntheticCompactionResult) as SDKResultMessage | undefined
      if (!result?.uuid || result.stopped_by_user !== true || result.terminal_reason !== 'stopped') {
        throw new AgentServiceError('persistence_error', '暂停终态无法确认')
      }
      // 只在真实主/子清理完成后追加 marker；重启不会把未完成的 pausing 当作 paused。
      try {
        this.options.sessions.appendMessage(run.sessionId, {
          type: 'system', subtype: 'axon_paused', uuid: pause.pauseId, pause_id: pause.pauseId,
          turn_id: pause.turnId,
          run_id: run.runId, run_started_at: run.runStartedAt, stopped_result_uuid: result.uuid,
          project_id: session.projectId ?? null, workspace_path: workspacePath ?? null,
        })
      } catch { throw new AgentServiceError('persistence_error', '暂停状态无法保存') }
      return { ...pause, state: 'paused' }
    } finally {
      unsubscribe()
      if (this.pauses.get(run.sessionId) === pause) this.pauses.delete(run.sessionId)
      this.emitPauseChanged(run.sessionId)
    }
  }

  /** 明确继续已落盘暂停；跨入口仅接收这次显式命令，旧事件不改投新客户端。 */
  continueRun(owner: BackendClientId, value: unknown, context: CoordinatorRunContext = {}): Promise<AgentSendResult> {
    if (!value || typeof value !== 'object' || Array.isArray(value)) return Promise.resolve(failed(new AgentServiceError('invalid_input', '继续请求无效')))
    const input = value as Record<string, unknown>
    if (Object.keys(input).some((key) => !['sessionId', 'pauseId'].includes(key))) return Promise.resolve(failed(new AgentServiceError('invalid_input', '继续请求无效')))
    try {
      const sessionId = parseId(input.sessionId), pauseId = parseId(input.pauseId)
      const pause = this.getPause(owner, sessionId)
      if (!pause || pause.state !== 'paused' || pause.pauseId !== pauseId) {
        return Promise.resolve(failed(new AgentServiceError('invalid_input', '暂停凭据已失效或尚未收束')))
      }
      if (!this.options.agent.continueMessage) throw new AgentServiceError('runtime_error', '当前执行入口不支持继续')
      // 单独的可信参数启动继续，普通发送无法自报；同步占有 owner 阻止重复消费。
      return this.work.run(() => this.executeSend(owner, undefined, () => {}, context,
        { sessionId, pauseId, turnId: pause.turnId }))
    } catch (error) { return Promise.resolve(failed(error)) }
  }

  /** 只有最近真实停止终态后的宿主 marker 有效；新输入/终态和项目改绑使旧凭据失效。 */
  private readStoredPause(sessionId: string): AgentPauseSnapshot | null {
    const session = this.options.sessions.get(sessionId)
    if (!session || session.parentSessionId || session.creationOrigin === 'exec' || session.creationOrigin === 'loop') return null
    const messages = this.options.sessions.getMessages(sessionId)
    for (let index = messages.length - 1; index >= 0; index--) {
      const message = messages[index]!
      if (message.type === 'system' && message.subtype === 'axon_paused') {
        const prior = messages.slice(0, index).findLast((item) => item.type === 'result'
          && !(item as SDKResultMessage).isSyntheticCompactionResult) as SDKResultMessage | undefined
        if (typeof message.pause_id !== 'string' || message.pause_id !== message.uuid
          || typeof message.run_id !== 'string' || typeof message.run_started_at !== 'number'
          || typeof message.turn_id !== 'string' || message.turn_id !== currentTurnId(messages.slice(0, index))
          || !Number.isFinite(message.run_started_at) || (message.project_id ?? null) !== (session.projectId ?? null)
          || !prior?.uuid || prior.uuid !== message.stopped_result_uuid
          || prior.stopped_by_user !== true || prior.terminal_reason !== 'stopped') return null
        if (message.workspace_path !== null && message.workspace_path !== undefined) {
          try {
            if (!session.projectId || typeof message.workspace_path !== 'string'
              || this.options.resolveCreationWorkspace?.(session.projectId) !== message.workspace_path) return null
          } catch { return null }
        }
        return { sessionId, turnId: message.turn_id, pauseId: message.pause_id, runId: message.run_id,
          runStartedAt: message.run_started_at, state: 'paused' }
      }
      if (message.type === 'system' && message.subtype === 'axon_continued') return null
      if (message.type === 'result' && !(message as SDKResultMessage).isSyntheticCompactionResult) return null
      if (message.type === 'user' || message.type === 'assistant') return null
    }
    return null
  }

  private pauseBlocksBackground(sessionId: string): boolean {
    return this.pauses.has(sessionId) || this.readStoredPause(sessionId) !== null
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
  listSessions() { return this.options.sessions.list().filter((session) => !session.parentSessionId && session.creationOrigin !== 'loop') }

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
    return this.work.run(async () => {
      if (this.disposed) throw new AgentServiceError('invalid_input', '运行协调服务已释放')
      const input = parseSessionInput(value, false) as AgentSessionCreateInput
      const config = this.options.prepareCreate?.(input) ?? input
      return this.sessionFactory.create(config, signal ? AbortSignal.any([signal, this.disposeController.signal]) : this.disposeController.signal)
    })
  }

  updateSession(id: unknown, value: unknown) {
    if (this.pauses.has(parseId(id))) throw new AgentServiceError('already_active', '会话正在暂停')
    if (this.workflows.active(parseId(id))) throw new AgentServiceError('already_active', '工作流期间不能修改会话配置')
    const session = this.options.sessions.update(
      parseId(id),
      parseSessionInput(value, true) as AgentSessionUpdateInput,
    )
    this.emitPauseChanged(session.id)
    return session
  }

  deleteSession(value: unknown) {
    const sessionId = parseId(value)
    if (this.pauses.has(sessionId) || this.options.agent.isActive(sessionId) || this.workflows.active(sessionId)) {
      throw new AgentServiceError('already_active', '运行期间不能删除 Agent 会话')
    }
    const removed = this.options.sessions.delete(sessionId)
    this.emitPauseChanged(sessionId)
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
    context: CoordinatorRunContext = {},
  ): Promise<AgentSendResult> {
    return this.work.run(() => this.executeSend(owner, value, emit, context))
  }

  /** 等待整条发送/排队链的 finally 释放 owner，而非只等待模型本轮空闲。 */
  private async executeSend(
    owner: BackendClientId,
    value: unknown,
    emit: (event: AgentGenerationEvent) => void,
    context: CoordinatorRunContext,
    continuation?: AgentContinueExecutionInput,
  ): Promise<AgentSendResult> {
    let input: AgentSendInput
    try { input = continuation ? { sessionId: parseId(continuation.sessionId), text: '' } : parseSendInput(value) }
    catch (error) { return failed(error) }
    if (this.disposed || !this.options.clients.has(owner)) {
      return failed(new AgentServiceError('invalid_input', '运行客户端未登记或已断开'))
    }
    const sessionId = input.sessionId
    const storedPause = context.synthetic || continuation ? this.readStoredPause(sessionId) : null
    if (this.pauses.has(sessionId) || (context.synthetic && storedPause)
      || (continuation && (!storedPause || storedPause.pauseId !== continuation.pauseId || storedPause.turnId !== continuation.turnId))) {
      return failed(new AgentServiceError('already_active', '会话正在暂停或等待用户继续'))
    }
    if (!this.workflows.permitsSend(owner, sessionId, context.workflowId)) {
      return failed(new AgentServiceError('already_active', '会话由非交互工作流占用或已停止'))
    }
    const currentOwnership = this.owners.get(sessionId)
    if (currentOwnership) {
      if (continuation) return failed(new AgentServiceError('already_active', '该会话已接纳继续请求'))
      if (currentOwnership.owner !== owner || currentOwnership.stopRequested) {
        return failed(new AgentServiceError('already_active', '该 Agent 会话正在其他客户端运行或正在停止'))
      }
      let attachmentLease: AgentAttachmentLease | undefined
      try {
        attachmentLease = this.takeAttachments(owner, input, context)
        const prepared = attachmentLease?.prepare()
        try { validateAgentInputPartReferences(input.inputParts, prepared?.attachments ?? []) }
        catch (error) { throw new AgentServiceError('invalid_input', error instanceof Error ? error.message : 'Skill 引用无效') }
        if (prepared?.images?.length) {
          if (!this.options.agent.validateAttachmentInput) throw new AgentServiceError('invalid_input', '当前宿主没有提供图片模型校验')
          await this.options.agent.validateAttachmentInput(input, prepared, this.options.clients.getSignal(owner))
          // 异步模型目录校验不能向已经结束或被停止的旧发送链追加输入。
          if (this.disposed || !this.options.clients.has(owner) || this.owners.get(sessionId) !== currentOwnership || currentOwnership.stopRequested) {
            throw new AgentServiceError('already_active', '原执行状态已变化，请重新发送此消息')
          }
        }
        const queuedMessage = this.queue.enqueue(input, prepared?.attachments)
        if (!queuedMessage) {
          attachmentLease?.settle()
          return failed(new AgentServiceError('queue_full', '该 Agent 会话的消息队列已满'))
        }
        this.queuedContexts.set(queuedMessage.id, { ...context, ...(attachmentLease ? { attachmentLease } : {}) })
        this.emitQueueSnapshot(sessionId)
        return { success: true, disposition: 'queued', queuedMessage }
      } catch (error) { attachmentLease?.settle(); return failed(error) }
    }
    if (this.options.agent.isActive(sessionId)) {
      return failed(new AgentServiceError('already_active', '该 Agent 会话正在运行'))
    }

    try {
      const attachmentLease = this.takeAttachments(owner, input, context)
      if (attachmentLease) context = { ...context, attachmentLease }
    } catch (error) { return failed(error) }

    const ownership: RunOwner = { owner, emit, stopRequested: false, workflowId: context.workflowId }
    this.owners.set(sessionId, ownership)
    if (this.options.permissions && !this.options.permissions.bindOwner(sessionId, owner)) {
      this.owners.delete(sessionId)
      context.attachmentLease?.settle()
      return failed(new AgentServiceError('already_active', '该 Agent 会话已属于其他客户端'))
    }
    if (this.options.askUsers && !this.options.askUsers.bindOwner(sessionId, owner)) {
      this.options.permissions?.unbindOwner(sessionId, owner)
      this.owners.delete(sessionId)
      context.attachmentLease?.settle()
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
    // 新发送已占有 owner，旧暂停快照立即失效；失败释放后再让入口重读。
    this.emitPauseChanged(sessionId)
    const unsubscribePermission = this.options.permissions?.subscribe((event) => {
      this.emitInteractionToOwner(sessionId, ownership, event, emit)
    }) ?? (() => {})
    const unsubscribeAskUser = this.options.askUsers?.subscribe((event) => {
      this.emitInteractionToOwner(sessionId, ownership, event, emit)
    }) ?? (() => {})
    try {
      let nextInput: AgentSendInput | undefined = input
      let nextContext = context
      let nextContinuation = continuation
      while (nextInput) {
        try {
          if (nextContinuation) await this.options.agent.continueMessage!(nextContinuation, nextContext)
          else await this.options.agent.sendMessage(nextInput, nextContext)
        } finally { nextContext.attachmentLease?.settle() }
        nextContinuation = undefined
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
        nextInput = queued ? { sessionId: queued.sessionId, text: queued.text,
          ...(queued.inputParts ? { inputParts: queued.inputParts } : {}),
          ...(queued.attachmentDraftId ? { attachmentDraftId: queued.attachmentDraftId } : {}),
          ...(queued.imageModelConsent ? { imageModelConsent: queued.imageModelConsent } : {}) } : undefined
      }
      return { success: true, disposition: 'started' }
    } catch (error) {
      this.clearQueue(sessionId)
      return failed(error)
    } finally {
      context.attachmentLease?.settle()
      unsubscribeRun()
      unsubscribePermission()
      unsubscribeAskUser()
      this.options.permissions?.unbindOwner(sessionId, owner)
      this.options.askUsers?.unbindOwner(sessionId, owner)
      // 身份判断防止旧请求的 finally 清掉未来重新开始的运行。
      if (this.owners.get(sessionId) === ownership) {
        this.owners.delete(sessionId)
        this.resolveOwnershipRelease(sessionId)
        this.emitPauseChanged(sessionId)
      }
    }
  }

  /** 草稿只由可信发送链解析；内部续跑不能伪装成附件用户输入。 */
  private takeAttachments(owner: string, input: AgentSendInput, context: CoordinatorRunContext) {
    if (!input.attachmentDraftId) return undefined
    if (context.synthetic || context.workflowId || context.attachmentLease || !this.options.attachments) {
      throw new AgentServiceError('invalid_input', '当前输入入口不支持附件')
    }
    return this.options.attachments.takeDraft(owner, input.sessionId, input.attachmentDraftId)
  }

  /** 后台 Task 完成后等待父会话空闲，再以隐藏 system reminder 自动续跑主 Agent。 */
  sendBackgroundNotification(
    owner: BackendClientId,
    input: AgentSendInput,
    emit: (event: AgentGenerationEvent) => void,
    workflowId?: string,
  ): Promise<AgentSendResult> {
    return this.work.run(() => this.executeBackgroundNotification(owner, input, emit, workflowId))
  }

  /** 记录后台空闲等待直到取消清理结束，退出后不会迟到启动合成续跑。 */
  private async executeBackgroundNotification(
    owner: BackendClientId,
    input: AgentSendInput,
    emit: (event: AgentGenerationEvent) => void,
    workflowId?: string,
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
      workflowId,
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
      const lease = this.queuedContexts.get(input.messageId)?.attachmentLease
      this.queuedContexts.delete(input.messageId)
      try { lease?.cancel() } finally { this.emitQueueSnapshot(input.sessionId) }
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
    const workflow = this.workflows.getOwned(owner, sessionId)
    if (workflow) return this.workflows.cancel(owner, workflow)
    return this.stopOwnedChain(owner, sessionId)
  }

  /** 工作流取消已先封口并停子树；这里只停止原 owner 的实际主链，避免递归取消。 */
  private stopOwnedChain(owner: BackendClientId, sessionId: string): boolean {
    const ownership = this.owners.get(sessionId)
    if (ownership?.owner !== owner) return false
    ownership.stopRequested = true
    this.clearQueue(sessionId)
    return this.options.agent.stop(sessionId)
  }

  /** 客户端断开时，取消它拥有的全部运行。 */
  cancelOwner(owner: BackendClientId): number {
    this.workflows.cancelOwner(owner)
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
    if (!this.options.sessionFactory) this.sessionFactory.dispose()
    this.workflows.dispose()
    this.disposeController.abort()
    this.unsubscribeClients()
    this.unsubscribeRuns()
    for (const release of this.interactionSubscriptions) release()
    this.runListeners.clear()
    this.pauseListeners.clear()
    this.runRoutes.clear()
    const failures: unknown[] = []
    for (const owner of new Set([...this.owners.values(), ...[...this.childRoutes.values()].map((route) => route.origin)]
      .map((run) => run.owner))) {
      try { this.cancelOwner(owner) } catch (error) { failures.push(error) }
    }
    if (failures.length) throw new AggregateError(failures, '运行协调资源清理失败')
  }

  /** 入口释放后等待发送、建会话预检和后台等待完成；真实 adapter 清理由下层负责。 */
  async drain(): Promise<void> {
    await Promise.all([this.work.drain(), this.workflows.drain(),
      ...(this.options.sessionFactory ? [] : [this.sessionFactory.drain()])])
    if (this.attachmentCleanupFailures.length) throw new AggregateError(this.attachmentCleanupFailures, '排队附件清理失败')
  }

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
    this.workflows.observe(route.owner, envelope)
    for (const listener of this.runListeners.get(route.owner) ?? []) {
      try { listener(envelope) } catch { console.warn('[Agent 运行] 客户端事件处理失败') }
    }
  }

  private clearQueue(sessionId: string): void {
    const failures: unknown[] = []
    for (const message of this.queue.list(sessionId)) {
      try { this.queuedContexts.get(message.id)?.attachmentLease?.cancel() } catch (error) { failures.push(error) }
      this.queuedContexts.delete(message.id)
    }
    if (this.queue.clear(sessionId) > 0) this.emitQueueSnapshot(sessionId)
    if (failures.length) {
      this.attachmentCleanupFailures.push(...failures)
      console.warn('[Agent 附件] 排队副本清理失败，已保留异常目录；停止流程继续收束')
    }
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
