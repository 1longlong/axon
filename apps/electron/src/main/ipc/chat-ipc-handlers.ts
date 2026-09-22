/** Chat 会话与生成流的 Electron 通道绑定。 */

import { ipcMain } from 'electron'
import type { IpcMainInvokeEvent, WebContents } from 'electron'
import { CHAT_IPC_CHANNELS } from '@axon/shared'
import type { ChatGenerationEvent } from '@axon/shared'
import type { ChatIpcController } from '../lib/chat/chat-ipc-handlers'
import { isQuickChatSend } from '../lib/desktop/quick-chat-window-owner'
import { assertMainFrame } from './assert-main-frame'

/** 注册 Chat CRUD、生成和停止；生成事件只回送给本次请求所属 renderer。 */
export function registerChatIpcHandlers(controller: ChatIpcController): void {
  const watched = new WeakSet<WebContents>()
  const watchOwner = (sender: WebContents): void => {
    if (watched.has(sender)) return
    watched.add(sender)
    const cancel = (): void => { controller.cancelOwner(sender.id) }
    sender.on('destroyed', cancel)
    sender.on('render-process-gone', cancel)
    sender.on('did-start-loading', cancel)
  }
  const handle = (
    channel: string,
    handler: (event: IpcMainInvokeEvent, ...args: unknown[]) => unknown,
  ): void => {
    ipcMain.handle(channel, (event, ...args: unknown[]) => {
      assertMainFrame(event, 'Chat')
      return handler(event, ...args)
    })
  }

  handle(CHAT_IPC_CHANNELS.LIST_CONVERSATIONS, () => controller.listConversations())
  handle(CHAT_IPC_CHANNELS.GET_CONVERSATION, (_event, id) => controller.getConversation(id))
  handle(CHAT_IPC_CHANNELS.CREATE_CONVERSATION, (_event, input) => controller.createConversation(input))
  handle(CHAT_IPC_CHANNELS.UPDATE_CONVERSATION, (_event, id, input) => controller.updateConversation(id, input))
  handle(CHAT_IPC_CHANNELS.DELETE_CONVERSATION, (_event, id) => controller.deleteConversation(id))
  handle(CHAT_IPC_CHANNELS.GET_MESSAGES, (_event, id) => controller.getMessages(id))
  handle(CHAT_IPC_CHANNELS.SEND, (event, input) => {
    const sender = event.sender
    watchOwner(sender)
    const quick = isQuickChatSend(sender.id, 'chat', (input as { conversationId?: unknown } | null)?.conversationId)
    return controller.send(sender.id, input, (chatEvent: ChatGenerationEvent) => {
      if (!sender.isDestroyed()) sender.send(CHAT_IPC_CHANNELS.EVENT, chatEvent)
    }, quick ? 'quick' : undefined)
  })
  handle(CHAT_IPC_CHANNELS.STOP, (event, id) => controller.stop(event.sender.id, id))
}
