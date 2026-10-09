/** Chat 命令/定向流与附件保存；上下文、Provider、历史和停止继续由 core 管理。 */
import { ChatServiceError } from '@axon/core'
import { APP_SERVER_METHODS as methods, APP_SERVER_NOTIFICATIONS } from '@axon/shared'
import type { ChatGenerationEvent, ChatGenerationIdentityEvent, RpcJsonObject } from '@axon/shared'
import { RpcConnectionError, RpcFault } from './json-rpc-peer'
import type { JsonRpcPeer } from './json-rpc-peer'
import type { AppServerCommandContext, ResolveAppServerClient } from './rpc-command-context'
import { toWireValue } from './wire-value'

export class ChatRpcRouter {
  /** 固定命令白名单，统一连接身份校验；input 由现有领域 controller 再解析。 */
  constructor(private readonly peer: JsonRpcPeer, resolve: ResolveAppServerClient) {
    const handle = (method: string, fields: readonly string[], action: (
      context: AppServerCommandContext,
    ) => unknown | Promise<unknown>): void => {
      peer.handle(method, async (params, { signal }) => {
        const context = resolve(params, fields)
        signal.throwIfAborted()
        try { return toWireValue(await action(context)) }
        catch (error) {
          if (error instanceof ChatServiceError) throw new RpcFault(-32021, 'Chat 命令失败', { code: error.code })
          throw error
        }
      })
    }
    handle(methods.CHAT_LIST_CONVERSATIONS, [], ({ backend }) => backend.chatRuns.listConversations())
    handle(methods.CHAT_GET_CONVERSATION, ['input'], ({ backend, input }) => backend.chatRuns.getConversation(input))
    handle(methods.CHAT_CREATE_CONVERSATION, ['input'], ({ backend, input }) => backend.chatRuns.createConversation(input))
    handle(methods.CHAT_UPDATE_CONVERSATION, ['input'], ({ backend, input }) => {
      if (!input || typeof input !== 'object' || Array.isArray(input)
        || Object.keys(input).some((key) => !['conversationId', 'update'].includes(key))) throw new RpcFault(-32602, 'Chat 更新参数无效')
      return backend.chatRuns.updateConversation(input.conversationId, input.update)
    })
    handle(methods.CHAT_DELETE_CONVERSATION, ['input'], ({ backend, input }) => backend.chatRuns.deleteConversation(input))
    handle(methods.CHAT_SEND, ['input'], (context) => context.backend.chatRuns.send(
      context.client.clientId, context.input, (event) => this.notify(context, event),
      context.client.kind === 'quick' ? 'quick' : undefined,
      (event) => this.notifyIdentity(context, event),
    ))
    handle(methods.CHAT_GET_GENERATION, ['input'], ({ backend, client, input }) => {
      if (typeof input !== 'string' || !input.trim()) throw new RpcFault(-32602, 'Chat 会话标识无效')
      return backend.chatRuns.getOwnedGeneration(client.clientId, input.trim()) ?? null
    })
    handle(methods.CHAT_STOP, ['input'], ({ backend, client, input }) => backend.chatRuns.stopGeneration(client.clientId, input))
    handle(methods.ATTACHMENT_SAVE, ['input'], ({ backend, input }) => backend.attachmentController.save(input))
  }

  /** 真实 generationId 与已落盘消息直接编码；晚到标题保留原入口，断开不改投或重发。 */
  private notify(context: AppServerCommandContext, event: ChatGenerationEvent): void {
    if (this.peer.closed || !context.backend.clients.has(context.client.clientId)) return
    try {
      this.peer.notify(APP_SERVER_NOTIFICATIONS.CHAT_GENERATION,
        toWireValue({ clientId: context.client.clientId, event }) as RpcJsonObject)
    } catch { this.peer.close(new RpcConnectionError('protocol', 'Chat 事件无法传输')) }
  }

  /** 预检到结束均向原入口投递控制身份，不写消息历史或广播给观察者。 */
  private notifyIdentity(context: AppServerCommandContext, event: ChatGenerationIdentityEvent): void {
    if (this.peer.closed || !context.backend.clients.has(context.client.clientId)) return
    try { this.peer.notify(APP_SERVER_NOTIFICATIONS.CHAT_GENERATION_IDENTITY,
      toWireValue({ clientId: context.client.clientId, event }) as RpcJsonObject) }
    catch { this.peer.close(new RpcConnectionError('protocol', 'Chat 身份无法传输')) }
  }
}
