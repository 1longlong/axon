/** Chat renderer 控制器：协调 preload API、流事件与 JSONL 权威快照。 */

import type { Store } from 'jotai/vanilla/store'
import type {
  ChatSendInput,
  ChatSendResult,
  ConversationCreateInput,
  ConversationMeta,
  ConversationUpdateInput,
} from '@axon/shared'
import type { ChatRendererApi } from './chat-renderer-api'
import {
  clearGenerationError,
  mergeConversationSnapshot,
  reduceChatGenerationEvent,
} from './chat-event-reducer'
import {
  chatDraftsAtom,
  chatStateAtom,
  upsertChatConversation,
} from './chat-state-model'

/** preload Chat API 的状态控制器；所有异步结果最终写入同一个 Jotai 原子。 */
export class ChatRendererController {
  private unsubscribe: (() => void) | null = null
  private channelsLoadVersion = 0
  private conversationsLoadVersion = 0
  private readonly messageLoadVersions = new Map<string, number>()

  constructor(
    private readonly api: ChatRendererApi,
    private readonly store: Store,
  ) {}

  /** 先订阅流事件再加载列表，避免初始化窗口内漏掉 started 事件。 */
  start(): () => void {
    if (this.unsubscribe) return this.unsubscribe
    const unsubscribe = this.api.onEvent((event) => {
      // started/settled 对应一次真实落盘：让旧读取失效，并主动拉取新的 JSONL 快照。
      if (event.type !== 'stream') {
        this.messageLoadVersions.set(
          event.conversationId,
          (this.messageLoadVersions.get(event.conversationId) ?? 0) + 1,
        )
      }
      this.store.set(chatStateAtom, (state) => reduceChatGenerationEvent(state, event))
      if (event.type !== 'stream') void this.loadMessages(event.conversationId)
    })
    this.unsubscribe = () => {
      unsubscribe()
      if (this.unsubscribe === cleanup) {
        this.unsubscribe = null
        this.channelsLoadVersion += 1
        this.conversationsLoadVersion += 1
        for (const [conversationId, version] of this.messageLoadVersions) {
          this.messageLoadVersions.set(conversationId, version + 1)
        }
      }
    }
    const cleanup = this.unsubscribe
    void Promise.allSettled([this.refreshChannels(), this.refreshConversations()])
    return cleanup
  }

  /** 从渠道 IPC 取得安全 DTO，供 Chat 壳层筛选可用渠道与模型。 */
  async refreshChannels(): Promise<void> {
    const version = ++this.channelsLoadVersion
    this.store.set(chatStateAtom, (state) => ({ ...state, channelsStatus: 'loading' }))
    try {
      const channels = await this.api.listChannels()
      if (version !== this.channelsLoadVersion) return
      this.store.set(chatStateAtom, (state) => ({
        ...state,
        channels,
        channelsStatus: 'ready',
        lastError: state.lastError?.scope === 'channels' ? null : state.lastError,
      }))
    } catch {
      if (version !== this.channelsLoadVersion) return
      this.store.set(chatStateAtom, (state) => ({
        ...state,
        channelsStatus: 'error',
        lastError: { scope: 'channels', message: '加载渠道列表失败' },
      }))
    }
  }

  /** 使用递增版本丢弃旧列表请求，防止慢响应覆盖较新的 CRUD 结果。 */
  async refreshConversations(): Promise<void> {
    const version = ++this.conversationsLoadVersion
    this.store.set(chatStateAtom, (state) => ({
      ...state,
      conversationsStatus: 'loading',
    }))
    try {
      const conversations = await this.api.listConversations()
      if (version !== this.conversationsLoadVersion) return
      this.store.set(chatStateAtom, (state) => ({
        ...state,
        conversations: mergeConversationSnapshot(state, conversations),
        conversationsStatus: 'ready',
        lastError: state.lastError?.scope === 'conversations' ? null : state.lastError,
      }))
    } catch {
      if (version !== this.conversationsLoadVersion) return
      this.store.set(chatStateAtom, (state) => ({
        ...state,
        conversationsStatus: 'error',
        lastError: { scope: 'conversations', message: '加载会话列表失败' },
      }))
    }
  }

  /** 每个会话独立防止乱序覆盖，并以主进程 JSONL 返回值替换本地消息快照。 */
  async loadMessages(conversationId: string): Promise<void> {
    const version = (this.messageLoadVersions.get(conversationId) ?? 0) + 1
    this.messageLoadVersions.set(conversationId, version)
    this.store.set(chatStateAtom, (state) => ({
      ...state,
      messageStatusByConversation: {
        ...state.messageStatusByConversation,
        [conversationId]: 'loading',
      },
    }))
    try {
      const messages = await this.api.getMessages(conversationId)
      if (this.messageLoadVersions.get(conversationId) !== version) return
      this.store.set(chatStateAtom, (state) => ({
        ...state,
        messagesByConversation: { ...state.messagesByConversation, [conversationId]: messages },
        messageStatusByConversation: {
          ...state.messageStatusByConversation,
          [conversationId]: 'ready',
        },
        lastError: state.lastError?.scope === 'messages'
          && state.lastError.conversationId === conversationId
          ? null
          : state.lastError,
      }))
    } catch {
      if (this.messageLoadVersions.get(conversationId) !== version) return
      this.store.set(chatStateAtom, (state) => ({
        ...state,
        messageStatusByConversation: {
          ...state.messageStatusByConversation,
          [conversationId]: 'error',
        },
        lastError: { scope: 'messages', conversationId, message: '加载对话消息失败' },
      }))
    }
  }

  async createConversation(input: ConversationCreateInput = {}): Promise<ConversationMeta> {
    const conversation = await this.api.createConversation(input)
    this.store.set(chatStateAtom, (state) => ({
      ...state,
      conversations: upsertChatConversation(state.conversations, conversation),
      messagesByConversation: { ...state.messagesByConversation, [conversation.id]: [] },
      messageStatusByConversation: {
        ...state.messageStatusByConversation,
        [conversation.id]: 'ready',
      },
    }))
    return conversation
  }

  async updateConversation(
    conversationId: string,
    input: ConversationUpdateInput,
  ): Promise<ConversationMeta> {
    const conversation = await this.api.updateConversation(conversationId, input)
    this.store.set(chatStateAtom, (state) => ({
      ...state,
      conversations: upsertChatConversation(state.conversations, conversation),
    }))
    return conversation
  }

  async deleteConversation(conversationId: string): Promise<ConversationMeta> {
    const conversation = await this.api.deleteConversation(conversationId)
    this.messageLoadVersions.set(
      conversationId,
      (this.messageLoadVersions.get(conversationId) ?? 0) + 1,
    )
    this.store.set(chatStateAtom, (state) => {
      const messages = { ...state.messagesByConversation }
      const statuses = { ...state.messageStatusByConversation }
      const generations = { ...state.generationsByConversation }
      const sending = { ...state.sendingByConversation }
      delete messages[conversationId]
      delete statuses[conversationId]
      delete generations[conversationId]
      delete sending[conversationId]
      return {
        ...state,
        conversations: state.conversations.filter((item) => item.id !== conversationId),
        messagesByConversation: messages,
        messageStatusByConversation: statuses,
        generationsByConversation: generations,
        sendingByConversation: sending,
        lastError: state.lastError?.conversationId === conversationId ? null : state.lastError,
      }
    })
    this.store.set(chatDraftsAtom, (drafts) => {
      if (!(conversationId in drafts)) return drafts
      const next = { ...drafts }
      delete next[conversationId]
      return next
    })
    return conversation
  }

  /**
   * 发送期间事件负责即时展示；命令结束后重新读取 JSONL，修复漏帧或 renderer 重载差异。
   */
  async send(input: ChatSendInput): Promise<ChatSendResult> {
    const conversationId = input.conversationId
    this.store.set(chatStateAtom, (state) => ({
      ...state,
      sendingByConversation: { ...state.sendingByConversation, [conversationId]: true },
      lastError: clearGenerationError(state.lastError, conversationId),
    }))
    let result: ChatSendResult
    try {
      result = await this.api.send(input)
    } catch {
      result = { success: false, code: 'internal_error', message: '无法连接主进程 Chat 服务' }
    }

    // settled 事件可能因重载漏失，磁盘快照是最终真相；两个刷新互不依赖。
    await Promise.allSettled([
      this.loadMessages(conversationId),
      this.refreshConversations(),
    ])
    this.store.set(chatStateAtom, (state) => {
      const sending = { ...state.sendingByConversation }
      const generations = { ...state.generationsByConversation }
      delete sending[conversationId]
      delete generations[conversationId]
      return {
        ...state,
        sendingByConversation: sending,
        generationsByConversation: generations,
        lastError: !result.success && result.code !== 'cancelled'
          ? {
              scope: 'generation',
              conversationId,
              code: result.code,
              message: result.message,
            }
          : state.lastError,
      }
    })
    return result
  }

  async stop(conversationId: string): Promise<boolean> {
    try {
      return await this.api.stop(conversationId)
    } catch {
      this.store.set(chatStateAtom, (state) => ({
        ...state,
        lastError: {
          scope: 'generation',
          conversationId,
          message: '停止生成失败',
        },
      }))
      return false
    }
  }
}

