/** Agent 固定 IPC 代理；业务和授权仅由独立后端处理，不创建桌面服务实例。 */
import type { IpcMainInvokeEvent, WebContents } from 'electron'
import { AppServerHistoryClient, toWireValue } from '@axon/app-server'
import { AGENT_IPC_CHANNELS as channels, AGENT_ATTACHMENT_IPC_CHANNELS, APP_SERVER_METHODS as methods } from '@axon/shared'
import type { RpcJsonValue } from '@axon/shared'
import { holdQuickChatNativeDialog } from '../lib/desktop/quick-chat-window-owner'
import type { AppServerProcess } from '../lib/desktop/app-server-process'
import type { AppServerWindowClients } from '../lib/desktop/app-server-window-clients'
import type { AppServerEvents } from '../lib/desktop/app-server-events'
import { isQuickChatSend } from '../lib/desktop/quick-chat-window-owner'
import { assertMainFrame } from './assert-main-frame'

export interface AppServerAgentIpcRegistrar {
  handle(channel: string, listener: (event: IpcMainInvokeEvent, ...args: unknown[]) => unknown): void
  removeHandler(channel: string): void
}
export interface AppServerAgentIpcOptions {
  backend: Pick<AppServerProcess, 'request' | 'readyPeer'>
  clients: Pick<AppServerWindowClients, 'get' | 'getClientSignal'>
  interactions: Pick<AppServerEvents, 'respondPermission' | 'respondAskUser'>
  pickAttachments?: (sender: WebContents) => Promise<string[]>
}
type BusinessMethod = Parameters<AppServerProcess['request']>[1]
function parseId(value: unknown): string {
  if (typeof value !== 'string' || !value.trim()) throw new Error('Agent 标识参数无效')
  return value.trim()
}
function stopTarget(value: unknown): RpcJsonValue {
  if (!value || typeof value !== 'object' || Array.isArray(value)
    || Object.keys(value).some((key) => key !== 'sessionId' && key !== 'runId')) throw new Error('停止目标必须包含真实轮次')
  const target = value as { sessionId?: unknown; runId?: unknown }
  return { sessionId: parseId(target.sessionId), runId: parseId(target.runId) }
}

/** 来源校验先于登记/传输；固定方法无法调用私有宿主 RPC，释放撤销本代理等待及通道。 */
export function registerAppServerAgentIpcHandlers(ipc: AppServerAgentIpcRegistrar, options: AppServerAgentIpcOptions): () => void {
  const registered: string[] = []
  const lifetime = new AbortController()
  const handle = (channel: string, minArgs: number, maxArgs: number,
    action: (sender: WebContents, ...args: unknown[]) => unknown): void => {
    ipc.handle(channel, (event, ...args) => {
      assertMainFrame(event, 'Agent')
      lifetime.signal.throwIfAborted()
      if (args.length < minArgs || args.length > maxArgs) throw new Error('Agent IPC 参数数量无效')
      return action(event.sender, ...args)
    })
    registered.push(channel)
  }
  /** 编码后获取可信页面身份；页面取消信号只作为请求选项，不进入 JSON 或业务输入。 */
  const call = async (sender: WebContents, method: BusinessMethod, input?: unknown, long = false): Promise<RpcJsonValue> => {
    const value = input === undefined ? undefined : toWireValue(input)
    const client = await options.clients.get(sender)
    const signal = options.clients.getClientSignal(client.clientId)
    if (!signal || signal.aborted) throw new Error('客户端页面已失效')
    const stop = AbortSignal.any([signal, lifetime.signal])
    stop.throwIfAborted()
    return options.backend.request(client.clientId, method, value, { signal: stop, ...(long ? { timeoutMs: 0 } : {}) })
  }
  /** 原生选择和 File 路径桥捕获原身份，等待后不能用 get 重新登记到重载页面。 */
  const attachmentOwner = async (sender: WebContents, draftId: string) => {
    const client = await options.clients.get(sender), page = options.clients.getClientSignal(client.clientId)
    if (!page || page.aborted) throw new Error('附件页面已失效')
    const signal = AbortSignal.any([page, lifetime.signal])
    signal.throwIfAborted()
    const draft = await options.backend.request(client.clientId, methods.AGENT_ATTACHMENT_COMMAND, { action: 'getDraft', draftId }, { signal })
    if (!draft || typeof draft !== 'object' || Array.isArray(draft) || typeof draft.sessionId !== 'string' || draft.status !== 'draft') {
      throw new Error('附件草稿已失效或已经发送')
    }
    isQuickChatSend(sender.id, 'agent', draft.sessionId)
    const check = (): void => {
      signal.throwIfAborted()
      if (sender.isDestroyed() || options.clients.getClientSignal(client.clientId) !== page) throw new Error('附件的原页面已失效')
    }
    check()
    return { clientId: client.clientId, signal, check }
  }
  let disposed = false
  /** 代理释放不注销共享页面或停止已接纳业务；那些资源由窗口/后端生命周期收束。 */
  const dispose = (): void => {
    if (disposed) return
    disposed = true
    lifetime.abort()
    for (const channel of registered) ipc.removeHandler(channel)
  }
  try {
    handle(channels.LIST_SESSIONS, 0, 0, (sender) => call(sender, methods.AGENT_LIST_SESSIONS))
    handle(channels.LIST_ACTIVE_RUNS, 0, 0, (sender) => call(sender, methods.AGENT_LIST_ACTIVE_RUNS))
    handle(channels.GET_OWNED_RUN, 1, 1, (sender, value) => call(sender, methods.AGENT_GET_RUN, parseId(value)))
    handle(channels.GET_SESSION, 1, 1, (sender, value) => call(sender, methods.AGENT_GET_SESSION, parseId(value)))
    handle(AGENT_ATTACHMENT_IPC_CHANNELS.COMMAND, 1, 1, (sender, value) => {
      // 快捷入口创建草稿也必须对应其绑定会话，后续命令由后端复核草稿 owner。
      if (value && typeof value === 'object' && !Array.isArray(value)) {
        const input = value as { action?: unknown; sessionId?: unknown; source?: { kind?: unknown; sessionId?: unknown } }
        if (input.action === 'createDraft' || input.action === 'getImageCapability' || input.action === 'listSkills') isQuickChatSend(sender.id, 'agent', input.sessionId)
        if (input.action === 'readImage' && input.source?.kind === 'history') isQuickChatSend(sender.id, 'agent', input.source.sessionId)
      }
      return call(sender, methods.AGENT_ATTACHMENT_COMMAND, value, true)
    })
    handle(AGENT_ATTACHMENT_IPC_CHANNELS.PICK, 1, 1, async (sender, value) => {
      const draftId = parseId(value)
      if (!options.pickAttachments) throw new Error('附件选择方式不可用')
      const owner = await attachmentOwner(sender, draftId)
      const releaseDialog = holdQuickChatNativeDialog(sender.id)
      let paths: string[]
      try { paths = await options.pickAttachments(sender) } finally { releaseDialog() }
      owner.check()
      if (paths.length === 0) return null
      return options.backend.request(owner.clientId, methods.AGENT_ATTACHMENT_REGISTER_LOCAL, { draftId, paths }, { signal: owner.signal, timeoutMs: 0 })
    })
    handle(AGENT_ATTACHMENT_IPC_CHANNELS.ADD_NATIVE_FILES, 2, 2, async (sender, value, paths) => {
      // 此路径列表只由 preload 对真实 File 调用 webUtils 得到；页面没有该原始 IPC 方法。
      const draftId = parseId(value), owner = await attachmentOwner(sender, draftId)
      if (!Array.isArray(paths) || paths.length === 0 || paths.length > 10 || paths.some((path) => typeof path !== 'string')) {
        throw new Error('附件文件来源无效')
      }
      owner.check()
      return options.backend.request(owner.clientId, methods.AGENT_ATTACHMENT_REGISTER_LOCAL, toWireValue({ draftId, paths }), { signal: owner.signal, timeoutMs: 0 })
    })
    handle(channels.CREATE_SESSION, 0, 1, (sender, input = {}) => call(sender, methods.AGENT_CREATE_SESSION, input, true))
    handle(channels.UPDATE_SESSION, 2, 2, (sender, value, update) => call(sender, methods.AGENT_UPDATE_SESSION, { sessionId: parseId(value), update }))
    handle(channels.DELETE_SESSION, 1, 1, (sender, value) => call(sender, methods.AGENT_DELETE_SESSION, parseId(value)))
    handle(channels.GET_REASONING_CAPABILITY, 1, 1, async (sender, value) => {
      const capability = await call(sender, methods.AGENT_GET_REASONING_CAPABILITY, parseId(value), true)
      return capability === null ? undefined : capability
    })
    handle(channels.CHECK_ENVIRONMENT, 0, 1, (sender, input = {}) => call(sender, methods.AGENT_CHECK_ENVIRONMENT, input, true))
    handle(channels.IS_ACTIVE, 1, 1, (sender, value) => call(sender, methods.AGENT_IS_ACTIVE, parseId(value)))
    handle(channels.GET_MESSAGES, 1, 1, async (sender, value) => {
      const sessionId = parseId(value), client = await options.clients.get(sender)
      const signal = options.clients.getClientSignal(client.clientId)
      if (!signal || signal.aborted) throw new Error('客户端页面已失效')
      // 服务端登记先订阅事件；只读完整应用历史，不传路径或 Runtime artifact，不交付半份数组。
      return new AppServerHistoryClient(options.backend.readyPeer(), client.clientId).read({ kind: 'agent', sessionId }, AbortSignal.any([signal, lifetime.signal]))
    })
    handle(channels.SEND, 1, 1, (sender, input) => {
      const sessionId = input && typeof input === 'object' && !Array.isArray(input)
        ? (input as { sessionId?: unknown }).sessionId : undefined
      isQuickChatSend(sender.id, 'agent', sessionId)
      // 后端依据登记 kind 记录来源；长轮次不套普通 RPC 超时，不自动重发未知交付。
      return call(sender, methods.AGENT_SEND, input, true)
    })
    handle(channels.STOP, 1, 1, (sender, value) => call(sender, methods.AGENT_STOP, stopTarget(value)))
    handle(channels.PAUSE, 1, 1, (sender, value) => {
      const target = stopTarget(value)
      isQuickChatSend(sender.id, 'agent', (target as { sessionId: string }).sessionId)
      return call(sender, methods.AGENT_PAUSE, target, true)
    })
    handle(channels.GET_PAUSE, 1, 1, (sender, value) => call(sender, methods.AGENT_GET_PAUSE, parseId(value)))
    handle(channels.CONTINUE, 1, 1, (sender, value) => {
      if (!value || typeof value !== 'object' || Array.isArray(value)
        || Object.keys(value).some((key) => key !== 'sessionId' && key !== 'pauseId')) throw new Error('继续目标无效')
      const input = value as { sessionId?: unknown; pauseId?: unknown }
      const target = { sessionId: parseId(input.sessionId), pauseId: parseId(input.pauseId) }
      isQuickChatSend(sender.id, 'agent', target.sessionId)
      return call(sender, methods.AGENT_CONTINUE, target, true)
    })
    handle(channels.LIST_QUEUED_MESSAGES, 1, 1, (sender, value) => call(sender, methods.AGENT_LIST_QUEUE, parseId(value)))
    handle(channels.CANCEL_QUEUED_MESSAGE, 1, 1, (sender, input) => call(sender, methods.AGENT_CANCEL_QUEUE, input))
    handle(channels.MOVE_QUEUED_MESSAGE, 1, 1, (sender, input) => call(sender, methods.AGENT_MOVE_QUEUE, input))
    // 答复不调用 get，不为旧页面/迟到请求新建身份；核心的真实目标已经由反向请求捕获。
    handle(channels.PERMISSION_RESPOND, 1, 1, (sender, response) => options.interactions.respondPermission(sender, response))
    handle(channels.ASK_USER_RESPOND, 1, 1, (sender, response) => options.interactions.respondAskUser(sender, response))
  } catch (error) { dispose(); throw error }
  return dispose
}
