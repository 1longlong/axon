/** Chat 生成事件的纯归并逻辑；generationId 隔离迟到事件。 */

import type { ChatGenerationEvent, ChatMessage, ConversationMeta } from '@axon/shared'
import { sortChatConversations } from './chat-state-model'
import type {
  ChatRendererError,
  ChatRendererState,
  StreamingChatBlock,
  StreamingChatGeneration,
} from './chat-state-model'

function touchConversation(
  conversations: readonly ConversationMeta[],
  conversationId: string,
  updatedAt: number,
): ConversationMeta[] {
  return sortChatConversations(conversations.map((conversation) => (
    conversation.id === conversationId
      ? { ...conversation, updatedAt: Math.max(conversation.updatedAt, updatedAt) }
      : conversation
  )))
}

/** 自动标题落地：只改列表项标题，排序与更新时间不变，未知名会话直接忽略。 */
function renameConversation(
  conversations: readonly ConversationMeta[],
  conversationId: string,
  title: string,
): ConversationMeta[] {
  if (!title) return [...conversations]
  const exists = conversations.some((conversation) => conversation.id === conversationId)
  if (!exists) return [...conversations]
  return sortChatConversations(conversations.map((conversation) => (
    conversation.id === conversationId ? { ...conversation, title } : conversation
  )))
}

export function mergeConversationSnapshot(
  state: ChatRendererState,
  incoming: readonly ConversationMeta[],
): ConversationMeta[] {
  const currentById = new Map(state.conversations.map((conversation) => [conversation.id, conversation]))
  return sortChatConversations(incoming.map((conversation) => {
    const existing = currentById.get(conversation.id)
    const latestMessageAt = (state.messagesByConversation[conversation.id] ?? [])
      .reduce((latest, message) => Math.max(latest, message.createdAt), 0)
    const updatedAt = Math.max(
      conversation.updatedAt,
      existing?.updatedAt ?? 0,
      latestMessageAt,
    )
    return updatedAt === conversation.updatedAt
      ? conversation
      : { ...conversation, updatedAt }
  }))
}

export function clearGenerationError(
  error: ChatRendererError | null,
  conversationId: string,
): ChatRendererError | null {
  return error?.scope === 'generation' && error.conversationId === conversationId
    ? null
    : error
}

function upsertMessage(messages: readonly ChatMessage[], message: ChatMessage): ChatMessage[] {
  const index = messages.findIndex((item) => item.id === message.id)
  if (index < 0) return [...messages, message]
  return messages.map((item, position) => position === index ? message : item)
}

function reduceStreamBlocks(
  blocks: readonly StreamingChatBlock[],
  event: Extract<ChatGenerationEvent, { type: 'stream' }>['event'],
): StreamingChatBlock[] {
  const next = blocks.map((block) => ({ ...block }))
  if (event.type === 'text_delta') {
    if (!event.delta) return next
    const tail = next.at(-1)
    if (tail?.type === 'text') tail.text += event.delta
    else next.push({ type: 'text', text: event.delta })
  } else if (event.type === 'reasoning_start') {
    if (!next.some((block) => block.type === 'reasoning' && block.blockId === event.blockId)) {
      next.push({
        type: 'reasoning',
        blockId: event.blockId,
        text: '',
        signature: '',
        complete: false,
      })
    }
  } else if (event.type === 'reasoning_delta' || event.type === 'reasoning_signature') {
    const block = next.find((item) => item.type === 'reasoning' && item.blockId === event.blockId)
    if (block?.type === 'reasoning' && !block.complete) {
      if (event.type === 'reasoning_delta') block.text += event.delta
      else block.signature += event.signatureDelta
    }
  } else if (event.type === 'reasoning_end') {
    const block = next.find((item) => item.type === 'reasoning' && item.blockId === event.blockId)
    if (block?.type === 'reasoning') block.complete = true
  } else if (event.type === 'tool_call_start') {
    if (!next.some((block) => block.type === 'tool_call' && block.callKey === event.callKey)) {
      next.push({
        type: 'tool_call',
        callKey: event.callKey,
        callId: event.callId,
        name: event.name,
        arguments: '',
        complete: false,
      })
    }
  } else if (event.type === 'tool_call_delta') {
    const block = next.find((item) => item.type === 'tool_call' && item.callKey === event.callKey)
    if (block?.type === 'tool_call' && !block.complete) block.arguments += event.argumentsDelta
  } else if (event.type === 'tool_call_end') {
    const block = next.find((item) => item.type === 'tool_call' && item.callKey === event.callKey)
    if (block?.type === 'tool_call') block.complete = true
  }
  return next
}

/**
 * 将一条主进程事件归并到 renderer 快照；generationId 不匹配的迟到事件直接忽略。
 */
export function reduceChatGenerationEvent(
  state: ChatRendererState,
  event: ChatGenerationEvent,
): ChatRendererState {
  const conversationId = event.conversationId
  if (event.type === 'started') {
    const messages = state.messagesByConversation[conversationId] ?? []
    return {
      ...state,
      conversations: touchConversation(
        state.conversations,
        conversationId,
        event.userMessage.createdAt,
      ),
      messagesByConversation: {
        ...state.messagesByConversation,
        [conversationId]: upsertMessage(messages, event.userMessage),
      },
      generationsByConversation: {
        ...state.generationsByConversation,
        [conversationId]: {
          conversationId,
          generationId: event.generationId,
          assistantMessageId: event.assistantMessageId,
          blocks: [],
        },
      },
      sendingByConversation: { ...state.sendingByConversation, [conversationId]: true },
      lastError: clearGenerationError(state.lastError, conversationId),
    }
  }

  if (event.type === 'title') {
    // 自动标题在 settled 后到达；只影响会话列表，标签标题由 AppShell 的校准 effect 同步。
    return { ...state, conversations: renameConversation(state.conversations, conversationId, event.title) }
  }

  const active = state.generationsByConversation[conversationId]
  if (event.type === 'stream') {
    if (!active || active.generationId !== event.generationId) return state
    const generation: StreamingChatGeneration = {
      ...active,
      blocks: reduceStreamBlocks(active.blocks, event.event),
      ...(event.event.type === 'usage' ? { usage: { ...event.event.usage } } : {}),
      ...(event.event.type === 'finish' ? { finishReason: event.event.reason } : {}),
    }
    return {
      ...state,
      generationsByConversation: {
        ...state.generationsByConversation,
        [conversationId]: generation,
      },
    }
  }

  if (active && active.generationId !== event.generationId) return state
  const messages = state.messagesByConversation[conversationId] ?? []
  const generations = { ...state.generationsByConversation }
  const sending = { ...state.sendingByConversation }
  delete generations[conversationId]
  delete sending[conversationId]
  return {
    ...state,
    conversations: touchConversation(state.conversations, conversationId, event.message.createdAt),
    messagesByConversation: {
      ...state.messagesByConversation,
      [conversationId]: upsertMessage(messages, event.message),
    },
    generationsByConversation: generations,
    sendingByConversation: sending,
    lastError: event.type === 'failed'
      ? {
          scope: 'generation',
          conversationId,
          code: 'provider_failed',
          message: event.message.error ?? '生成失败',
        }
      : clearGenerationError(state.lastError, conversationId),
  }
}

