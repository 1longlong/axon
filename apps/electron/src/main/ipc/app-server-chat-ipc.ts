/** Chat/附件的固定桌面代理；业务、Provider 和持久化只在独立后端执行。 */
import type { IpcMainInvokeEvent, WebContents } from 'electron'
import { AppServerHistoryClient, toWireValue } from '@axon/app-server'
import { CHAT_IPC_CHANNELS as channels, ATTACHMENTS_IPC_CHANNELS, APP_SERVER_METHODS as methods } from '@axon/shared'
import type { RpcJsonValue } from '@axon/shared'
import type { AppServerProcess } from '../lib/desktop/app-server-process'
import type { AppServerWindowClients } from '../lib/desktop/app-server-window-clients'
import { isQuickChatSend } from '../lib/desktop/quick-chat-window-owner'
import { assertMainFrame } from './assert-main-frame'

export interface AppServerChatIpcRegistrar {
  handle(channel: string, listener: (event: IpcMainInvokeEvent, ...args: unknown[]) => unknown): void
  removeHandler(channel: string): void
}
export interface AppServerChatIpcOptions {
  backend: Pick<AppServerProcess, 'request' | 'readyPeer'>
  clients: Pick<AppServerWindowClients, 'get' | 'getClientSignal'>
}
type BusinessMethod = Parameters<AppServerProcess['request']>[1]
function parseId(value: unknown): string {
  if (typeof value !== 'string' || !value.trim()) throw new Error('Chat 标识参数无效')
  return value.trim()
}
function stopTarget(value: unknown): RpcJsonValue {
  if (!value || typeof value !== 'object' || Array.isArray(value)
    || Object.keys(value).some((key) => key !== 'conversationId' && key !== 'generationId')) throw new Error('停止目标必须包含真实生成标识')
  const target = value as { conversationId?: unknown; generationId?: unknown }
  return { conversationId: parseId(target.conversationId), generationId: parseId(target.generationId) }
}

/** 校验原生来源后转发白名单方法；释放只取消代理等待，不重投或猜测业务回滚。 */
export function registerAppServerChatIpcHandlers(ipc: AppServerChatIpcRegistrar, options: AppServerChatIpcOptions): () => void {
  const registered: string[] = []
  const lifetime = new AbortController()
  const handle = (channel: string, minArgs: number, maxArgs: number,
    action: (sender: WebContents, ...args: unknown[]) => unknown): void => {
    ipc.handle(channel, (event, ...args) => {
      assertMainFrame(event, 'Chat/附件')
      lifetime.signal.throwIfAborted()
      if (args.length < minArgs || args.length > maxArgs) throw new Error('Chat IPC 参数数量无效')
      return action(event.sender, ...args)
    })
    registered.push(channel)
  }
  /** JSON 编码先于登记；窗口和代理信号只作为传输选项，不允许输入自报客户端身份。 */
  const call = async (sender: WebContents, method: BusinessMethod, input?: unknown, long = false): Promise<RpcJsonValue> => {
    const value = input === undefined ? undefined : toWireValue(input)
    const client = await options.clients.get(sender)
    const signal = options.clients.getClientSignal(client.clientId)
    if (!signal || signal.aborted) throw new Error('客户端页面已失效')
    const stop = AbortSignal.any([signal, lifetime.signal])
    stop.throwIfAborted()
    return options.backend.request(client.clientId, method, value, { signal: stop, ...(long ? { timeoutMs: 0 } : {}) })
  }
  let disposed = false
  const dispose = (): void => {
    if (disposed) return
    disposed = true
    lifetime.abort()
    for (const channel of registered) ipc.removeHandler(channel)
  }
  try {
    handle(channels.LIST_CONVERSATIONS, 0, 0, (sender) => call(sender, methods.CHAT_LIST_CONVERSATIONS))
    handle(channels.GET_CONVERSATION, 1, 1, (sender, id) => call(sender, methods.CHAT_GET_CONVERSATION, parseId(id)))
    handle(channels.GET_OWNED_GENERATION, 1, 1, (sender, id) => call(sender, methods.CHAT_GET_GENERATION, parseId(id)))
    handle(channels.CREATE_CONVERSATION, 0, 1, (sender, input = {}) => call(sender, methods.CHAT_CREATE_CONVERSATION, input))
    handle(channels.UPDATE_CONVERSATION, 2, 2, (sender, id, update) => call(sender, methods.CHAT_UPDATE_CONVERSATION, { conversationId: parseId(id), update }))
    handle(channels.DELETE_CONVERSATION, 1, 1, (sender, id) => call(sender, methods.CHAT_DELETE_CONVERSATION, parseId(id)))
    handle(channels.GET_MESSAGES, 1, 1, async (sender, id) => {
      const conversationId = parseId(id), client = await options.clients.get(sender)
      const signal = options.clients.getClientSignal(client.clientId)
      if (!signal || signal.aborted) throw new Error('客户端页面已失效')
      // 完整应用历史包含原文与附件元数据；分页失败不能被包装成成功的短历史。
      return new AppServerHistoryClient(options.backend.readyPeer(), client.clientId).read(
        { kind: 'chat', conversationId }, AbortSignal.any([signal, lifetime.signal]),
      )
    })
    handle(channels.SEND, 1, 1, (sender, input) => {
      const id = input && typeof input === 'object' && !Array.isArray(input)
        ? (input as { conversationId?: unknown }).conversationId : undefined
      isQuickChatSend(sender.id, 'chat', id)
      // 来源由后端登记 kind 决定；长生成关闭通用 RPC 超时，交付未知时不重发。
      return call(sender, methods.CHAT_SEND, input, true)
    })
    handle(channels.STOP, 1, 1, (sender, input) => call(sender, methods.CHAT_STOP, stopTarget(input)))
    // 保持附件 DTO/base64 与现行大小限制；不开放读取路径、删除或任意宿主方法。
    handle(ATTACHMENTS_IPC_CHANNELS.SAVE, 1, 1, (sender, input) => call(sender, methods.ATTACHMENT_SAVE, input, true))
  } catch (error) { dispose(); throw error }
  return dispose
}
