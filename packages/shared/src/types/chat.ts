/** Chat 会话与本地消息的跨进程契约。 */

import type { FileAttachment } from './attachment'

export const DEFAULT_CONVERSATION_TITLE = '新对话'
export const MAX_CONVERSATION_TITLE_LENGTH = 120
export const MAX_CHAT_CONTENT_BLOCKS = 1024
export const MAX_CHAT_INPUT_LENGTH = 1_000_000
export const MAX_SYSTEM_PROMPT_LENGTH = 200_000

export interface ChatTextBlock {
  type: 'text'
  text: string
}

export interface ChatReasoningBlock {
  type: 'reasoning'
  text: string
  /** 供应商返回的不透明签名；只允许原样保存和回传。 */
  signature?: string
}

export interface ChatToolCallBlock {
  type: 'tool_call'
  callId: string
  name: string
  /** 已完整累计的 JSON 对象字符串。 */
  arguments: string
}

export interface ChatToolResultBlock {
  type: 'tool_result'
  callId: string
  name: string
  output: string
  isError?: boolean
}

export type ChatContentBlock =
  | ChatTextBlock
  | ChatReasoningBlock
  | ChatToolCallBlock
  | ChatToolResultBlock

export type ChatMessageStatus = 'complete' | 'stopped' | 'error'

export type ChatFinishReason =
  | 'stop'
  | 'length'
  | 'tool_use'
  | 'content_filter'
  | 'error'
  | 'other'

export interface ChatTokenUsage {
  inputTokens?: number
  outputTokens?: number
  reasoningTokens?: number
  cacheReadTokens?: number
  cacheWriteTokens?: number
  totalTokens?: number
}

/** 一行 JSONL 对应一条完整或已明确终止的消息。 */
export interface ChatMessage {
  id: string
  role: 'user' | 'assistant'
  /** 仅用户消息：从快捷浮窗提交时标记来源；不进入模型协议。 */
  inputOrigin?: 'quick'
  content: readonly ChatContentBlock[]
  createdAt: number
  status: ChatMessageStatus
  modelId?: string
  finishReason?: ChatFinishReason
  usage?: ChatTokenUsage
  /** 仅保存面向用户的稳定错误说明，不保存供应商响应正文。 */
  error?: string
  /** 用户消息内嵌的附件元数据；二进制在附件目录，由会话删除级联清理。 */
  attachments?: readonly FileAttachment[]
}

/** 对话列表使用的轻量索引项，不内嵌消息正文。 */
export interface ConversationMeta {
  id: string
  title: string
  channelId?: string
  modelId?: string
  createdAt: number
  updatedAt: number
  contextSummary?: ContextSummary
}

export interface ContextSummary {
  text: string
  coveredMessageIds: string[]
  updatedAt: number
}

export interface ConversationCreateInput {
  title?: string
  channelId?: string
  modelId?: string
}

export interface ConversationUpdateInput {
  title?: string
  /** null 表示清除已选择渠道。 */
  channelId?: string | null
  /** null 表示清除已选择模型。 */
  modelId?: string | null
  contextSummary?: ContextSummary | null
}

export interface RecentChatMessages {
  messages: ChatMessage[]
  total: number
  hasMore: boolean
}

/** renderer 提交给主进程的最小 Chat 生成参数。 */
export interface ChatSendInput {
  conversationId: string
  text: string
  /** 可选的附件元数据；二进制必须先经 axon:attachments:save 落盘。 */
  attachments?: FileAttachment[]
  maxOutputTokens?: number
  temperature?: number
}

export type ChatErrorCode =
  | 'invalid_input'
  | 'conversation_not_found'
  | 'channel_required'
  | 'model_required'
  | 'channel_unavailable'
  | 'model_unavailable'
  | 'already_active'
  | 'cancelled'
  | 'provider_failed'
  | 'persistence_failed'
  | 'internal_error'

export type ChatSendResult =
  | { success: true; message: ChatMessage }
  | { success: false; code: ChatErrorCode; message: string }

/** ChatService 向未来 IPC 层转发的供应商无关流事件。 */
export type ChatStreamEvent =
  | { type: 'text_delta'; delta: string }
  | { type: 'reasoning_start'; blockId: string }
  | { type: 'reasoning_delta'; blockId: string; delta: string }
  | { type: 'reasoning_signature'; blockId: string; signatureDelta: string }
  | { type: 'reasoning_end'; blockId: string }
  | { type: 'tool_call_start'; callKey: string; callId: string; name: string }
  | { type: 'tool_call_delta'; callKey: string; argumentsDelta: string }
  | { type: 'tool_call_end'; callKey: string }
  | { type: 'usage'; usage: ChatTokenUsage }
  | { type: 'finish'; reason: ChatFinishReason; providerReason?: string }

export interface ChatGenerationStartedEvent {
  type: 'started'
  conversationId: string
  generationId: string
  assistantMessageId: string
  userMessage: ChatMessage
}

export interface ChatGenerationStreamEvent {
  type: 'stream'
  conversationId: string
  generationId: string
  event: ChatStreamEvent
}

export interface ChatGenerationSettledEvent {
  type: 'completed' | 'stopped' | 'failed'
  conversationId: string
  generationId: string
  message: ChatMessage
}

/** 自动生成的会话标题；在完整生成结束后尽力产生，失败不通知。 */
export interface ChatGenerationTitleEvent {
  type: 'title'
  conversationId: string
  title: string
}

/** 生成事件：单个 generationId 的生命周期固定为 started → stream* → settled；title 在 settled 后尽力产生一次。 */
export type ChatGenerationEvent =
  | ChatGenerationStartedEvent
  | ChatGenerationStreamEvent
  | ChatGenerationSettledEvent
  | ChatGenerationTitleEvent

export const CHAT_IPC_CHANNELS = {
  LIST_CONVERSATIONS: 'axon:chat:conversations:list',
  GET_CONVERSATION: 'axon:chat:conversations:get',
  CREATE_CONVERSATION: 'axon:chat:conversations:create',
  UPDATE_CONVERSATION: 'axon:chat:conversations:update',
  DELETE_CONVERSATION: 'axon:chat:conversations:delete',
  GET_MESSAGES: 'axon:chat:messages:list',
  SEND: 'axon:chat:send',
  STOP: 'axon:chat:stop',
  EVENT: 'axon:chat:event',
} as const
