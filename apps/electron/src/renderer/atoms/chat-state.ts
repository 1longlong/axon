/** Chat renderer 状态公共入口；实现按模型、事件、API 与控制器分层。 */

export type { ChatRendererApi } from './chat-renderer-api'
export { ChatRendererController } from './chat-renderer-controller'
export { reduceChatGenerationEvent } from './chat-event-reducer'
export {
  MAX_PERSISTED_DRAFTS,
  chatChannelsAtom,
  chatConversationsAtom,
  chatDraftsAtom,
  chatGenerationsAtom,
  chatMessagesByConversationAtom,
  chatStateAtom,
  createInitialChatRendererState,
  pruneChatDrafts,
  sanitizePersistedChatDrafts,
} from './chat-state-model'
export type {
  ChatLoadStatus,
  ChatRendererError,
  ChatRendererState,
  StreamingChatBlock,
  StreamingChatGeneration,
  StreamingReasoningBlock,
  StreamingTextBlock,
  StreamingToolCallBlock,
} from './chat-state-model'

