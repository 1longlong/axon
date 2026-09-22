/** Chat renderer 的状态形状、草稿规则与 Jotai atoms。 */

import { atom } from 'jotai'
import { MAX_CHAT_INPUT_LENGTH } from '@axon/shared'
import type {
  ChatFinishReason,
  ChatMessage,
  ChatTokenUsage,
  Channel,
  ConversationMeta,
} from '@axon/shared'

export type ChatLoadStatus = 'idle' | 'loading' | 'ready' | 'error'

export interface StreamingTextBlock {
  type: 'text'
  text: string
}

export interface StreamingReasoningBlock {
  type: 'reasoning'
  blockId: string
  text: string
  signature: string
  complete: boolean
}

export interface StreamingToolCallBlock {
  type: 'tool_call'
  callKey: string
  callId: string
  name: string
  arguments: string
  complete: boolean
}

export type StreamingChatBlock =
  | StreamingTextBlock
  | StreamingReasoningBlock
  | StreamingToolCallBlock

export interface StreamingChatGeneration {
  conversationId: string
  generationId: string
  assistantMessageId: string
  blocks: StreamingChatBlock[]
  usage?: ChatTokenUsage
  finishReason?: ChatFinishReason
}

export interface ChatRendererError {
  scope: 'channels' | 'conversations' | 'messages' | 'generation'
  message: string
  code?: string
  conversationId?: string
}

export interface ChatRendererState {
  channels: Channel[]
  channelsStatus: ChatLoadStatus
  conversations: ConversationMeta[]
  conversationsStatus: ChatLoadStatus
  messagesByConversation: Record<string, ChatMessage[]>
  messageStatusByConversation: Record<string, ChatLoadStatus>
  generationsByConversation: Record<string, StreamingChatGeneration>
  sendingByConversation: Record<string, boolean>
  lastError: ChatRendererError | null
}

export function createInitialChatRendererState(): ChatRendererState {
  return {
    channels: [],
    channelsStatus: 'idle',
    conversations: [],
    conversationsStatus: 'idle',
    messagesByConversation: {},
    messageStatusByConversation: {},
    generationsByConversation: {},
    sendingByConversation: {},
    lastError: null,
  }
}

export const chatStateAtom = atom<ChatRendererState>(createInitialChatRendererState())
export const chatChannelsAtom = atom((get) => get(chatStateAtom).channels)
export const chatConversationsAtom = atom((get) => get(chatStateAtom).conversations)
export const chatMessagesByConversationAtom = atom((get) => get(chatStateAtom).messagesByConversation)
export const chatGenerationsAtom = atom((get) => get(chatStateAtom).generationsByConversation)

/** 输入草稿按会话隔离；切换会话不会丢失，应用重启后不恢复。 */
export const chatDraftsAtom = atom<Record<string, string>>({})

/** 持久化草稿的条数上限；超出的旧草稿按插入顺序丢弃，防止 settings.json 无限膨胀。 */
export const MAX_PERSISTED_DRAFTS = 100

/**
 * 清洗磁盘恢复的草稿快照。settings.json 属于用户可编辑文件，
 * 只接受字符串键值对，单条草稿按输入长度上限截断，条数超限时保留较新的条目。
 */
export function sanitizePersistedChatDrafts(value: unknown): Record<string, string> {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return {}
  const entries = Object.entries(value as Record<string, unknown>)
    .filter((entry): entry is [string, string] => {
      const [key, draft] = entry
      return key.trim().length > 0 && typeof draft === 'string'
    })
    .map(([key, draft]) => [key, draft.slice(0, MAX_CHAT_INPUT_LENGTH)] as const)
  return Object.fromEntries(entries.slice(-MAX_PERSISTED_DRAFTS))
}

/** 会话列表就绪后修剪草稿，只保留仍然存在的会话。 */
export function pruneChatDrafts(
  drafts: Record<string, string>,
  conversationIds: readonly string[],
): Record<string, string> {
  const known = new Set(conversationIds)
  const pruned = Object.fromEntries(Object.entries(drafts).filter(([key]) => known.has(key)))
  return Object.keys(pruned).length === Object.keys(drafts).length ? drafts : pruned
}

export function sortChatConversations(
  conversations: readonly ConversationMeta[],
): ConversationMeta[] {
  return [...conversations].sort((left, right) => right.updatedAt - left.updatedAt)
}

export function upsertChatConversation(
  conversations: readonly ConversationMeta[],
  conversation: ConversationMeta,
): ConversationMeta[] {
  return sortChatConversations([
    ...conversations.filter((item) => item.id !== conversation.id),
    conversation,
  ])
}

