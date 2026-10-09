/** 独立后端的固定事件与反向交互桥；不持有业务服务或授权策略。 */
import type { WebContents } from 'electron'
import { RpcFault, toWireValue } from '@axon/app-server'
import type { JsonRpcPeer } from '@axon/app-server'
import { AGENT_IPC_CHANNELS, AGENT_PROJECT_IPC_CHANNELS, AGENT_MEMORY_IPC_CHANNELS, CHAT_IPC_CHANNELS, CHANNEL_IPC_CHANNELS, SETTINGS_IPC_CHANNELS, USER_PROFILE_IPC_CHANNELS, APP_SERVER_CLIENT_METHODS, APP_SERVER_NOTIFICATIONS } from '@axon/shared'
import type { AgentGenerationEvent, AgentProject, BackendAgentRunEvent, RpcJsonObject, RpcJsonValue, RpcParams } from '@axon/shared'
import type { AppServerWindowClients } from './app-server-window-clients'
import { APP_SERVER_PAGE_DISCONNECTED } from './app-server-window-clients'
import { AGENT_TASK_IPC_CHANNELS } from '@axon/shared'

export interface AppServerEventOptions {
  clients: Pick<AppServerWindowClients, 'find' | 'matches' | 'getClientSignal'>
  /** 原生宿主自行核对自己的身份；不通过伪造 WebContents 接收配置通知。 */
  desktopSettings?: { receive(clientId: string, value: unknown): void }
  onProjectsChanged?: (clientId: string, projects: AgentProject[]) => void
  onAgentEvent?: (clientId: string, event: AgentGenerationEvent) => void
}
type Interaction = Extract<AgentGenerationEvent, { type: 'permission_request' | 'ask_user_request' }>
interface PendingInteraction {
  clientId: string
  sender: WebContents
  pageSignal: AbortSignal
  envelope: BackendAgentRunEvent
  event: Interaction
  answered: boolean
  resolve: (value: RpcJsonValue) => void
  release: () => void
}

function object(value: unknown): value is RpcJsonObject {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
}
function id(value: unknown): value is string { return typeof value === 'string' && value.trim().length > 0 }
function packet(params: RpcParams): RpcJsonObject {
  if (!object(params) || !id(params.clientId)) throw new RpcFault(-32602, '事件入口无效')
  return params
}
/** 校验跨进程路由身份；其余领域 DTO 由可信后端产生，不在桌面重复业务解析。 */
function runEnvelope(value: RpcJsonValue | undefined): BackendAgentRunEvent {
  if (!object(value) || !object(value.run) || !object(value.event) || !id(value.visibleSessionId)
    || !id(value.run.sessionId) || !id(value.run.runId) || typeof value.run.runStartedAt !== 'number' || !Number.isFinite(value.run.runStartedAt)
    || value.event.sessionId !== value.run.sessionId || value.event.runStartedAt !== value.run.runStartedAt
    || typeof value.event.type !== 'string'
    || !['run_started', 'stream', 'permission_request', 'permission_resolved', 'ask_user_request', 'ask_user_resolved', 'run_finished'].includes(value.event.type)) {
    throw new RpcFault(-32602, '运行事件身份无效')
  }
  return value as unknown as BackendAgentRunEvent
}

/** 父端先安装本桥再握手；反向请求只进入已登记原页面，答复不能自报 client/run。 */
export class AppServerEvents {
  private readonly pending = new Set<PendingInteraction>()
  private readonly unlinkClose: () => void
  private disposed = false

  constructor(peer: JsonRpcPeer, private readonly options: AppServerEventOptions) {
    peer.handleNotification(APP_SERVER_NOTIFICATIONS.AGENT_RUN, (params) => this.onRun(params))
    peer.handleNotification(APP_SERVER_NOTIFICATIONS.AGENT_QUEUE, (params) => this.forward(params, 'snapshot', AGENT_IPC_CHANNELS.QUEUE_EVENT))
    peer.handleNotification(APP_SERVER_NOTIFICATIONS.AGENT_METADATA, (params) => this.forward(params, 'event', AGENT_IPC_CHANNELS.EVENT))
    peer.handleNotification(APP_SERVER_NOTIFICATIONS.CHAT_GENERATION, (params) => this.forward(params, 'event', CHAT_IPC_CHANNELS.EVENT))
    peer.handleNotification(APP_SERVER_NOTIFICATIONS.CHAT_GENERATION_IDENTITY, (params) => this.forward(params, 'event', CHAT_IPC_CHANNELS.GENERATION_EVENT))
    peer.handleNotification(APP_SERVER_NOTIFICATIONS.SETTINGS_UPDATED, (params) => {
      const data = packet(params)
      if (!object(data.settings)) throw new RpcFault(-32602, '通知内容无效')
      if (this.disposed) return
      this.options.desktopSettings?.receive(data.clientId as string, data.settings)
      this.send(data.clientId as string, SETTINGS_IPC_CHANNELS.CHANGED, data.settings)
    })
    peer.handleNotification(APP_SERVER_NOTIFICATIONS.USER_PROFILE_UPDATED, (params) => this.forward(params, 'profile', USER_PROFILE_IPC_CHANNELS.CHANGED))
    peer.handleNotification(APP_SERVER_NOTIFICATIONS.PROJECTS_CHANGED, (params) => {
      const data = packet(params)
      if (!Array.isArray(data.projects)) throw new RpcFault(-32602, '项目通知内容无效')
      if (!this.disposed) {
        try { this.options.onProjectsChanged?.(data.clientId as string, data.projects as unknown as AgentProject[]) }
        catch { console.warn('[桌面] 原生项目投影不可用') }
        this.send(data.clientId as string, AGENT_PROJECT_IPC_CHANNELS.CHANGED, data.projects)
      }
    })
    peer.handleNotification(APP_SERVER_NOTIFICATIONS.CHANNELS_CHANGED, (params) => {
      const data = packet(params)
      if (!Array.isArray(data.channels)) throw new RpcFault(-32602, '渠道通知内容无效')
      if (!this.disposed) this.send(data.clientId as string, CHANNEL_IPC_CHANNELS.CHANGED, data.channels)
    })
    peer.handleNotification(APP_SERVER_NOTIFICATIONS.WORKSPACE_CHANGED, (params) => this.onProjectWatch(params, 'workspace'))
    peer.handleNotification(APP_SERVER_NOTIFICATIONS.MEMORY_CHANGED, (params) => this.onProjectWatch(params, 'memory'))
    peer.handleNotification(APP_SERVER_NOTIFICATIONS.PROJECT_WATCH_CLOSED, (params) => this.onProjectWatch(params, 'closed'))
    peer.handleNotification(APP_SERVER_NOTIFICATIONS.TASK_EVENT, (params) => {
      const data = packet(params)
      if (!id(data.subscriptionId) || !object(data.event)) throw new RpcFault(-32602, 'Task 通知身份无效')
      if (!this.disposed) this.send(data.clientId as string, AGENT_TASK_IPC_CHANNELS.EVENT, { subscriptionId: data.subscriptionId, event: data.event })
    })
    peer.handle(APP_SERVER_CLIENT_METHODS.AGENT_PERMISSION, (params, { signal }) => this.interact(params, signal, 'permission_request'))
    peer.handle(APP_SERVER_CLIENT_METHODS.AGENT_ASK_USER, (params, { signal }) => this.interact(params, signal, 'ask_user_request'))
    this.unlinkClose = peer.onClose(() => this.dispose())
  }

  /** 只处理固定通知，保持到达顺序；未知/过期入口丢弃，不广播或临时登记窗口。 */
  private forward(params: RpcParams, field: string, channel: string): void {
    const data = packet(params)
    if (!object(data[field])) throw new RpcFault(-32602, '通知内容无效')
    if (!this.disposed) this.send(data.clientId as string, channel, data[field])
  }
  private send(clientId: string, channel: string, value: unknown): boolean {
    const sender = this.options.clients.find(clientId)
    if (!sender) return false
    try { sender.send(channel, value); return true }
    catch { return false }
  }

  /** 只投递原页面及服务端订阅标识；面板按自己的代次消费，不把入口 ID 暴露给 UI。 */
  private onProjectWatch(params: RpcParams, kind: 'workspace' | 'memory' | 'closed'): void {
    const data = packet(params)
    if (!id(data.projectId) || !id(data.subscriptionId)) throw new RpcFault(-32602, '项目监听身份无效')
    let value: RpcJsonObject = { projectId: data.projectId, subscriptionId: data.subscriptionId }
    let channel: string
    if (kind === 'closed') {
      if (data.kind !== 'workspace' && data.kind !== 'memory' || typeof data.reason !== 'string' || !['project_changed', 'project_deleted', 'memory_disabled'].includes(data.reason)) {
        throw new RpcFault(-32602, '项目监听关闭事件无效')
      }
      value = { ...value, kind: data.kind, reason: data.reason }
      channel = AGENT_PROJECT_IPC_CHANNELS.WATCH_CLOSED
    } else {
      if (typeof data.changedAt !== 'number' || !Number.isFinite(data.changedAt)
        || kind === 'memory' && data.relativePath !== undefined && typeof data.relativePath !== 'string') {
        throw new RpcFault(-32602, '项目监听变化事件无效')
      }
      value = { ...value, changedAt: data.changedAt, ...(kind === 'memory' && data.relativePath !== undefined ? { relativePath: data.relativePath } : {}) }
      channel = kind === 'workspace' ? AGENT_PROJECT_IPC_CHANNELS.DIRECTORY_CHANGED : AGENT_MEMORY_IPC_CHANNELS.CHANGED
    }
    if (!this.disposed) this.send(data.clientId as string, channel, value)
  }

  /** 子流/子终态不冒充父轮；子交互仍在父页面显示，真实轮次只用于匹配和结算。 */
  private project(envelope: BackendAgentRunEvent): AgentGenerationEvent | undefined {
    const event = envelope.event
    if (envelope.visibleSessionId === envelope.run.sessionId) return event
    if (event.type === 'permission_request' || event.type === 'permission_resolved'
      || event.type === 'ask_user_request' || event.type === 'ask_user_resolved') {
      return { ...event, sessionId: envelope.visibleSessionId }
    }
    return undefined
  }
  private onRun(params: RpcParams): void {
    const data = packet(params), envelope = runEnvelope(data.event)
    if (this.disposed) return
    const event = envelope.event
    // 请求只能走反向 RPC，不允许普通通知再创建同一交互。
    if (event.type === 'permission_request' || event.type === 'ask_user_request') throw new RpcFault(-32602, '交互必须使用反向请求')
    this.nativeAgentEvent(data.clientId as string, event)
    for (const pending of [...this.pending]) {
      if (pending.clientId !== data.clientId || pending.envelope.run.runId !== envelope.run.runId
        || pending.envelope.run.sessionId !== envelope.run.sessionId) continue
      if (event.type === 'run_finished') this.cancel(pending, true)
      else if ((event.type === 'permission_resolved' && pending.event.type === 'permission_request'
        || event.type === 'ask_user_resolved' && pending.event.type === 'ask_user_request')
        && pending.event.request.requestId === event.requestId) this.cancel(pending, false)
    }
    const projected = this.project(envelope)
    if (envelope.run.sessionId === envelope.visibleSessionId && (event.type === 'run_started' || event.type === 'run_finished')) {
      this.send(data.clientId as string, AGENT_IPC_CHANNELS.RUN_EVENT, {
        phase: event.type === 'run_started' ? 'started' : 'finished', run: envelope.run,
      })
    }
    if (projected) this.send(data.clientId as string, AGENT_IPC_CHANNELS.EVENT, projected)
  }

  /** 保存原页面和真实请求后才展示；取消先删等待，再拒绝/取消，迟到 UI 答复不能复活。 */
  private interact(params: RpcParams, signal: AbortSignal, type: Interaction['type']): Promise<RpcJsonValue> | RpcJsonValue {
    const data = packet(params), envelope = runEnvelope(data.event), event = envelope.event
    if (event.type !== type || !object(event.request) || !id(event.request.requestId)
      || event.request.sessionId !== envelope.run.sessionId || event.request.runStartedAt !== envelope.run.runStartedAt) {
      throw new RpcFault(-32602, '交互请求身份无效')
    }
    const clientId = data.clientId as string, requestId = event.request.requestId
    const refused = { requestId, behavior: type === 'permission_request' ? 'deny' : 'cancel' }
    const sender = this.options.clients.find(clientId), pageSignal = this.options.clients.getClientSignal(clientId)
    if (this.disposed || signal.aborted || !sender || !pageSignal || pageSignal.aborted) return refused
    if ([...this.pending].some((item) => item.clientId === clientId && item.event.request.requestId === requestId)) {
      throw new RpcFault(-32602, '重复交互请求')
    }
    let resolve!: (value: RpcJsonValue) => void
    const promise = new Promise<RpcJsonValue>((accept) => { resolve = accept })
    const pending: PendingInteraction = { clientId, sender, pageSignal, envelope, event, answered: false, resolve, release: () => {} }
    const abort = (): void => this.cancel(pending, true)
    signal.addEventListener('abort', abort, { once: true })
    pageSignal.addEventListener('abort', abort, { once: true })
    pending.release = () => { signal.removeEventListener('abort', abort); pageSignal.removeEventListener('abort', abort) }
    this.pending.add(pending)
    if (!this.send(clientId, AGENT_IPC_CHANNELS.EVENT, this.project(envelope))) this.cancel(pending, true)
    else this.nativeAgentEvent(clientId, event)
    return promise
  }

  respondPermission(sender: WebContents, response: unknown): boolean { return this.respond(sender, response, 'permission_request') }
  respondAskUser(sender: WebContents, response: unknown): boolean { return this.respond(sender, response, 'ask_user_request') }

  /** registrar 先校验主 frame；只交付原请求 response，授权合法性仍由服务端 core 决定。 */
  private respond(sender: WebContents, raw: unknown, type: Interaction['type']): boolean {
    let response: RpcJsonValue
    try { response = toWireValue(raw) } catch { return false }
    if (!object(response) || !id(response.requestId)) return false
    if (type === 'permission_request') {
      if (response.behavior !== 'allow' && response.behavior !== 'deny'
        || Object.keys(response).some((key) => !['requestId', 'behavior', 'alwaysAllow', 'updatedInput'].includes(key))
        || response.alwaysAllow !== undefined && typeof response.alwaysAllow !== 'boolean'
        || response.updatedInput !== undefined && !object(response.updatedInput)) return false
    } else if (response.behavior === 'cancel') {
      if (Object.keys(response).some((key) => !['requestId', 'behavior'].includes(key))) return false
    } else if (response.behavior !== 'answer' || !object(response.answers)
      || Object.keys(response).some((key) => !['requestId', 'behavior', 'answers'].includes(key))
      || Object.entries(response.answers).some(([key, value]) => !id(key) || typeof value !== 'string')) return false
    const pending = [...this.pending].find((item) => item.sender === sender && item.event.type === type
      && item.event.request.requestId === response.requestId)
    if (!pending || pending.answered || pending.pageSignal.aborted || !this.options.clients.matches(sender, pending.clientId)) return false
    // 只确认已转交；等待后端 resolved 才关闭正式交互，不在桌面授予权限或伪造成功。
    pending.answered = true
    pending.resolve(response)
    return true
  }

  private cancel(pending: PendingInteraction, closeUi: boolean): void {
    if (!this.pending.delete(pending)) return
    pending.release()
    const requestId = pending.event.request.requestId
    pending.resolve({ requestId, behavior: pending.event.type === 'permission_request' ? 'deny' : 'cancel' })
    if (!closeUi) return
    const event: AgentGenerationEvent = pending.event.type === 'permission_request'
      ? { type: 'permission_resolved', sessionId: pending.envelope.visibleSessionId, runStartedAt: pending.envelope.run.runStartedAt,
        requestId, behavior: 'deny', reason: 'aborted' }
      : { type: 'ask_user_resolved', sessionId: pending.envelope.visibleSessionId, runStartedAt: pending.envelope.run.runStartedAt,
        requestId, reason: 'aborted' }
    this.nativeAgentEvent(pending.clientId, event)
    // 服务信号可能先于 peer.close 撤销映射；只对仍在原页面的后端断开关闭 UI。
    if (pending.pageSignal.aborted && pending.pageSignal.reason === APP_SERVER_PAGE_DISCONNECTED) {
      try { if (!pending.sender.isDestroyed()) pending.sender.send(AGENT_IPC_CHANNELS.EVENT, event) } catch { /* 页面已不可投递。 */ }
    } else if (!pending.pageSignal.aborted && this.options.clients.matches(pending.sender, pending.clientId)) {
      this.send(pending.clientId, AGENT_IPC_CHANNELS.EVENT, event)
    }
  }

  /** 原生角标只观察有效原入口；可选平台能力失败不能截断 UI 事件或审批结算。 */
  private nativeAgentEvent(clientId: string, event: AgentGenerationEvent): void {
    if (!this.options.clients.find(clientId)) return
    try { this.options.onAgentEvent?.(clientId, event) }
    catch { console.warn('[桌面] 原生运行投影不可用') }
  }

  /** 断开/装配退出撤销所有等待；固定 handler 随 peer 关闭清除，释放后不再投递。 */
  dispose(): void {
    if (this.disposed) return
    this.disposed = true
    this.unlinkClose()
    for (const pending of [...this.pending]) this.cancel(pending, true)
  }
}
