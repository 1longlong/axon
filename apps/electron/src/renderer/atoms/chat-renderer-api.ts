/** preload 暴露给 Chat renderer 控制器的 API 契约。 */

import type {
  ChatGenerationEvent,
  ChatMessage,
  ChatSendInput,
  ChatSendResult,
  Channel,
  ConversationCreateInput,
  ConversationMeta,
  ConversationUpdateInput,
} from '@axon/shared'

export interface ChatRendererApi {
  listChannels(): Promise<Channel[]>
  listConversations(): Promise<ConversationMeta[]>
  createConversation(input?: ConversationCreateInput): Promise<ConversationMeta>
  updateConversation(id: string, input: ConversationUpdateInput): Promise<ConversationMeta>
  deleteConversation(id: string): Promise<ConversationMeta>
  getMessages(id: string): Promise<ChatMessage[]>
  send(input: ChatSendInput): Promise<ChatSendResult>
  stop(conversationId: string): Promise<boolean>
  onEvent(callback: (event: ChatGenerationEvent) => void): () => void
}

