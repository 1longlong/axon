/** Chat renderer 控制器：协调 preload API、流事件与 JSONL 权威快照。 */

import type { Store } from 'jotai/vanilla/store'
import type {
  ChatSendInput,
  ChatSendResult,
  ChatMessage,
  BackendChatGeneration,
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

interface PendingChatSend { generationId?: string; lifecycle: number }

/** preload Chat API 的状态控制器；所有异步结果最终写入同一个 Jotai 原子。 */
export class ChatRendererController {
  private unsubscribe: (() => void) | null = null
  private channelsLoadVersion = 0
  private conversationsLoadVersion = 0
  private readonly messageLoadVersions = new Map<string, number>()
  private lifecycleVersion = 0
  private readonly ownedGenerations = new Map<string, BackendChatGeneration>()
  private readonly identityVersions = new Map<string, number>()
  private readonly lastGenerationIds = new Map<string, string>()
  private readonly historyChanges = new Map<string, Map<string, ChatMessage>>()
  private readonly pendingSends = new Map<string, PendingChatSend>()

  constructor(
    private readonly api: ChatRendererApi,
    private readonly store: Store,
  ) {}

  /** 先订阅流事件再加载列表，避免初始化窗口内漏掉 started 事件。 */
  start(): () => void {
    if (this.unsubscribe) return this.unsubscribe
    const lifecycle = ++this.lifecycleVersion
    const unsubscribeChannels = this.api.onChannelsChanged((channels) => {
      if (lifecycle !== this.lifecycleVersion) return
      // 已保存通知比在途列表更近；Chat 与 Agent 的选择器共同消费此安全渠道快照。
      this.channelsLoadVersion += 1
      this.store.set(chatStateAtom, (state) => ({ ...state, channels, channelsStatus: 'ready',
        lastError: state.lastError?.scope === 'channels' ? null : state.lastError }))
    })
    const unsubscribeIdentity = this.api.onGenerationChanged(({ phase, generation }) => {
      if (lifecycle !== this.lifecycleVersion) return
      const id = generation.conversationId
      this.identityVersions.set(id, (this.identityVersions.get(id) ?? 0) + 1)
      if (phase === 'started') {
        this.ownedGenerations.set(id, { ...generation })
        this.lastGenerationIds.set(id, generation.generationId)
        const pending = this.pendingSends.get(id)
        if (pending && !pending.generationId) pending.generationId = generation.generationId
      } else if (this.ownedGenerations.get(id)?.generationId === generation.generationId) this.ownedGenerations.delete(id)
    })
    const unsubscribe = this.api.onEvent((event) => {
      if (lifecycle !== this.lifecycleVersion) return
      const observed = this.lastGenerationIds.get(event.conversationId)
      if (event.type !== 'title' && observed && observed !== event.generationId) return
      let changedMessages = false
      this.store.set(chatStateAtom, (state) => {
        const next = reduceChatGenerationEvent(state, event)
        changedMessages = next.messagesByConversation[event.conversationId] !== state.messagesByConversation[event.conversationId]
        // 只记录 reducer 接受的已落盘消息；流草稿独立存储，不混入历史数组。
        if (changedMessages && event.type !== 'stream' && event.type !== 'title') {
          const message = event.type === 'started' ? event.userMessage : event.message
          this.historyChanges.get(event.conversationId)?.set(message.id, message)
        }
        return next
      })
      if (changedMessages && !this.historyChanges.has(event.conversationId)) void this.loadMessages(event.conversationId)
    })
    this.unsubscribe = () => {
      unsubscribe()
      unsubscribeIdentity()
      unsubscribeChannels()
      if (this.unsubscribe === cleanup) {
        this.unsubscribe = null
        this.lifecycleVersion += 1
        this.ownedGenerations.clear()
        this.lastGenerationIds.clear()
        this.historyChanges.clear()
        this.pendingSends.clear()
        this.channelsLoadVersion += 1
        this.conversationsLoadVersion += 1
        for (const [conversationId, version] of this.messageLoadVersions) {
          this.messageLoadVersions.set(conversationId, version + 1)
        }
      }
    }
    const cleanup = this.unsubscribe
    const state = this.store.get(chatStateAtom)
    const activeIds = new Set([...Object.keys(state.generationsByConversation),
      ...Object.keys(state.sendingByConversation).filter((id) => state.sendingByConversation[id])])
    for (const id of activeIds) void this.restoreOwnedGeneration(id)
    void Promise.allSettled([this.refreshChannels(), this.refreshConversations()])
    return cleanup
  }

  /** 页面重订阅/读历史时恢复原入口控制权；查询迟到不能覆盖随后观察到的新轮次。 */
  private async restoreOwnedGeneration(conversationId: string): Promise<void> {
    if (this.ownedGenerations.has(conversationId)) return
    const lifecycle = this.lifecycleVersion, version = this.identityVersions.get(conversationId) ?? 0
    const previous = this.store.get(chatStateAtom).generationsByConversation[conversationId]
    const previousSending = this.store.get(chatStateAtom).sendingByConversation[conversationId]
    try {
      const generation = await this.api.getOwnedGeneration(conversationId)
      if (lifecycle !== this.lifecycleVersion || version !== (this.identityVersions.get(conversationId) ?? 0)) return
      if (generation?.conversationId === conversationId) {
        this.ownedGenerations.set(conversationId, generation)
        this.lastGenerationIds.set(conversationId, generation.generationId)
      } else if (!generation && (previous || previousSending) && !this.pendingSends.has(conversationId)) {
        // 重订阅时终态可能已漏失；无所属运行只清除查询前的旧草稿，不清理随后开始的新轮。
        this.store.set(chatStateAtom, (state) => {
          if (state.generationsByConversation[conversationId] !== previous
            || state.sendingByConversation[conversationId] !== previousSending) return state
          const generations = { ...state.generationsByConversation }, sending = { ...state.sendingByConversation }
          delete generations[conversationId]; delete sending[conversationId]
          return { ...state, generationsByConversation: generations, sendingByConversation: sending }
        })
      }
    } catch { /* 只读恢复失败不推测控制身份；事件或后续读取可以恢复。 */ }
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

  /** 完整 JSONL 为基线，叠加读取期间新落盘消息；旧读取/失败不能覆盖较新状态。 */
  async loadMessages(conversationId: string): Promise<void> {
    const version = (this.messageLoadVersions.get(conversationId) ?? 0) + 1
    this.messageLoadVersions.set(conversationId, version)
    const changes = new Map<string, ChatMessage>()
    this.historyChanges.set(conversationId, changes)
    void this.restoreOwnedGeneration(conversationId)
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
      const ids = new Set(messages.map((message) => message.id))
      this.store.set(chatStateAtom, (state) => ({
        ...state,
        messagesByConversation: { ...state.messagesByConversation, [conversationId]: [
          ...messages.map((message) => changes.get(message.id) ?? message),
          ...[...changes.values()].filter((message) => !ids.has(message.id)),
        ] },
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
    } finally {
      if (this.historyChanges.get(conversationId) === changes) this.historyChanges.delete(conversationId)
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
    this.ownedGenerations.delete(conversationId)
    this.lastGenerationIds.delete(conversationId)
    this.historyChanges.delete(conversationId)
    this.pendingSends.delete(conversationId)
    this.identityVersions.set(conversationId, (this.identityVersions.get(conversationId) ?? 0) + 1)
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
    if (this.store.get(chatStateAtom).sendingByConversation[conversationId]) {
      return { success: false, code: 'already_active', message: '该对话正在生成' }
    }
    const pending: PendingChatSend = { lifecycle: this.lifecycleVersion }
    this.pendingSends.set(conversationId, pending)
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

    // 旧页面/旧发送的响应只返回调用方，不能发起读取或清理同会话的新生成。
    const isCurrent = (): boolean => pending.lifecycle === this.lifecycleVersion && this.pendingSends.get(conversationId) === pending
      && (!pending.generationId || this.lastGenerationIds.get(conversationId) === pending.generationId)
    if (!isCurrent()) return result
    // settled 可能漏失；完整磁盘校准仍受同一发送与页面代次约束。
    await Promise.allSettled([
      this.loadMessages(conversationId),
      this.refreshConversations(),
    ])
    if (!isCurrent()) return result
    this.pendingSends.delete(conversationId)
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

  /** 同步捕获已观察的真实生成身份；旧点击不查询最新轮次来扩大停止目标。 */
  async stop(conversationId: string): Promise<boolean> {
    const target = this.ownedGenerations.get(conversationId)
    if (!target) return false
    const lifecycle = this.lifecycleVersion
    try {
      return await this.api.stop({ ...target })
    } catch {
      if (lifecycle !== this.lifecycleVersion || this.ownedGenerations.get(conversationId)?.generationId !== target.generationId) return false
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
