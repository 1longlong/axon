import { describe, expect, test } from 'bun:test'
import { createStore } from 'jotai/vanilla'
import { MAX_CHAT_INPUT_LENGTH } from '@axon/shared'
import type {
  ChatGenerationEvent,
  ChatMessage,
  Channel,
  ConversationMeta,
} from '@axon/shared'
import {
  ChatRendererController,
  chatDraftsAtom,
  chatStateAtom,
  createInitialChatRendererState,
  pruneChatDrafts,
  reduceChatGenerationEvent,
  sanitizePersistedChatDrafts,
} from './chat-state'
import type { ChatRendererState } from './chat-state'
import type { ChatRendererApi } from './chat-state'

function conversation(id = 'conversation-1', updatedAt = 1): ConversationMeta {
  return {
    id,
    title: id,
    channelId: 'channel-1',
    modelId: 'model-1',
    createdAt: 1,
    updatedAt,
  }
}

function channel(id = 'channel-1'): Channel {
  return {
    id,
    name: id,
    provider: 'openai',
    baseUrl: 'https://api.example.com/v1',
    models: [{ id: 'model-1', name: '模型一', enabled: true }],
    enabled: true,
    hasApiKey: true,
    createdAt: 1,
    updatedAt: 1,
  }
}

function userMessage(id = 'user-1'): ChatMessage {
  return {
    id,
    role: 'user',
    content: [{ type: 'text', text: '你好' }],
    createdAt: 10,
    status: 'complete',
  }
}

function assistantMessage(id = 'assistant-1', text = '完成'): ChatMessage {
  return {
    id,
    role: 'assistant',
    content: [{ type: 'text', text }],
    createdAt: 20,
    status: 'complete',
    modelId: 'model-1',
    finishReason: 'stop',
  }
}

function startedEvent(): ChatGenerationEvent {
  return {
    type: 'started',
    conversationId: 'conversation-1',
    generationId: 'generation-1',
    assistantMessageId: 'assistant-1',
    userMessage: userMessage(),
  }
}

function createApi(overrides: Partial<ChatRendererApi> = {}): ChatRendererApi {
  return {
    listChannels: async () => [],
    listConversations: async () => [],
    createConversation: async () => conversation(),
    updateConversation: async (id, input) => ({
      ...conversation(id),
      ...(input.title === undefined ? {} : { title: input.title }),
    }),
    deleteConversation: async (id) => conversation(id),
    getMessages: async () => [],
    send: async () => ({ success: true, message: assistantMessage() }),
    stop: async () => false,
    onEvent: () => () => {},
    ...overrides,
  }
}

interface Deferred<T> {
  promise: Promise<T>
  resolve(value: T): void
}

function deferred<T>(): Deferred<T> {
  let resolvePromise: ((value: T) => void) | undefined
  const promise = new Promise<T>((resolve) => { resolvePromise = resolve })
  return { promise, resolve: (value) => resolvePromise?.(value) }
}

describe('Chat renderer 流事件 reducer', () => {
  test('按原顺序累计推理、正文、工具参数和用量，再用持久化终态替换草稿', () => {
    let state = {
      ...createInitialChatRendererState(),
      conversations: [conversation()],
    }
    state = reduceChatGenerationEvent(state, startedEvent())
    const streams: ChatGenerationEvent[] = [
      { type: 'stream', conversationId: 'conversation-1', generationId: 'generation-1', event: { type: 'reasoning_start', blockId: 'reason-1' } },
      { type: 'stream', conversationId: 'conversation-1', generationId: 'generation-1', event: { type: 'reasoning_delta', blockId: 'reason-1', delta: '思考' } },
      { type: 'stream', conversationId: 'conversation-1', generationId: 'generation-1', event: { type: 'reasoning_signature', blockId: 'reason-1', signatureDelta: ' opaque ' } },
      { type: 'stream', conversationId: 'conversation-1', generationId: 'generation-1', event: { type: 'reasoning_end', blockId: 'reason-1' } },
      { type: 'stream', conversationId: 'conversation-1', generationId: 'generation-1', event: { type: 'text_delta', delta: '正在' } },
      { type: 'stream', conversationId: 'conversation-1', generationId: 'generation-1', event: { type: 'text_delta', delta: '查询' } },
      { type: 'stream', conversationId: 'conversation-1', generationId: 'generation-1', event: { type: 'tool_call_start', callKey: 'tool-1', callId: 'call-1', name: 'get_weather' } },
      { type: 'stream', conversationId: 'conversation-1', generationId: 'generation-1', event: { type: 'tool_call_delta', callKey: 'tool-1', argumentsDelta: '{"city":"上海"}' } },
      { type: 'stream', conversationId: 'conversation-1', generationId: 'generation-1', event: { type: 'tool_call_end', callKey: 'tool-1' } },
      { type: 'stream', conversationId: 'conversation-1', generationId: 'generation-1', event: { type: 'usage', usage: { totalTokens: 8 } } },
      { type: 'stream', conversationId: 'conversation-1', generationId: 'generation-1', event: { type: 'finish', reason: 'tool_use' } },
    ]
    for (const event of streams) state = reduceChatGenerationEvent(state, event)

    expect(state.generationsByConversation['conversation-1']).toEqual({
      conversationId: 'conversation-1',
      generationId: 'generation-1',
      assistantMessageId: 'assistant-1',
      blocks: [
        { type: 'reasoning', blockId: 'reason-1', text: '思考', signature: ' opaque ', complete: true },
        { type: 'text', text: '正在查询' },
        { type: 'tool_call', callKey: 'tool-1', callId: 'call-1', name: 'get_weather', arguments: '{"city":"上海"}', complete: true },
      ],
      usage: { totalTokens: 8 },
      finishReason: 'tool_use',
    })

    const finalMessage = assistantMessage()
    state = reduceChatGenerationEvent(state, {
      type: 'completed',
      conversationId: 'conversation-1',
      generationId: 'generation-1',
      message: finalMessage,
    })
    expect(state.messagesByConversation['conversation-1']).toEqual([userMessage(), finalMessage])
    expect(state.generationsByConversation).toEqual({})
    expect(state.sendingByConversation).toEqual({})
  })

  test('忽略旧 generation 的流和终态，订阅稍晚时仍接受没有本地草稿的终态', () => {
    const active = reduceChatGenerationEvent(createInitialChatRendererState(), startedEvent())
    const staleStream = reduceChatGenerationEvent(active, {
      type: 'stream',
      conversationId: 'conversation-1',
      generationId: 'generation-old',
      event: { type: 'text_delta', delta: '旧内容' },
    })
    expect(staleStream).toBe(active)
    expect(reduceChatGenerationEvent(active, {
      type: 'failed',
      conversationId: 'conversation-1',
      generationId: 'generation-old',
      message: { ...assistantMessage(), status: 'error', finishReason: 'error', error: '旧错误' },
    })).toBe(active)

    const late = reduceChatGenerationEvent(createInitialChatRendererState(), {
      type: 'completed',
      conversationId: 'conversation-1',
      generationId: 'generation-1',
      message: assistantMessage(),
    })
    expect(late.messagesByConversation['conversation-1']).toEqual([assistantMessage()])
  })

  test('title 事件更新会话标题，未知会话与空标题被忽略', () => {
    // 生产中会话列表来自 IPC 快照；测试同样以含会话的状态为基底。
    const base: ChatRendererState = {
      ...createInitialChatRendererState(),
      conversations: [conversation()],
    }
    const renamed = reduceChatGenerationEvent(base, {
      type: 'title',
      conversationId: 'conversation-1',
      title: '天气问答',
    })
    expect(renamed.conversations.find((item) => item.id === 'conversation-1')?.title).toBe('天气问答')

    const unknown = reduceChatGenerationEvent(base, {
      type: 'title',
      conversationId: 'conversation-404',
      title: '不存在',
    })
    expect(unknown.conversations).toEqual(base.conversations)

    const empty = reduceChatGenerationEvent(base, { type: 'title', conversationId: 'conversation-1', title: '' })
    expect(empty).toEqual(base)
  })
})

describe('ChatRendererController preload 编排', () => {
  test('渠道读取只接受最新响应，失败时写入稳定状态', async () => {
    const first = deferred<Channel[]>()
    const second = deferred<Channel[]>()
    let calls = 0
    const store = createStore()
    const controller = new ChatRendererController(createApi({
      listChannels: () => (++calls === 1 ? first.promise : second.promise),
    }), store)
    const stale = controller.refreshChannels()
    const latest = controller.refreshChannels()
    second.resolve([channel('latest')])
    await latest
    first.resolve([channel('stale')])
    await stale
    expect(store.get(chatStateAtom)).toMatchObject({
      channels: [{ id: 'latest' }],
      channelsStatus: 'ready',
    })

    const failing = new ChatRendererController(createApi({
      listChannels: async () => { throw new Error('secret') },
    }), store)
    await failing.refreshChannels()
    expect(store.get(chatStateAtom).lastError).toEqual({
      scope: 'channels',
      message: '加载渠道列表失败',
    })
  })

  test('初始化先订阅事件再加载并排序会话，清理后可重新启动', async () => {
    const order: string[] = []
    let subscribeCount = 0
    let unsubscribeCount = 0
    const store = createStore()
    const controller = new ChatRendererController(createApi({
      onEvent: () => {
        order.push('subscribe')
        subscribeCount += 1
        return () => { unsubscribeCount += 1 }
      },
      listConversations: async () => {
        order.push('list')
        return [conversation('older', 1), conversation('newer', 2)]
      },
    }), store)

    const cleanup = controller.start()
    await Promise.resolve()
    expect(order.slice(0, 2)).toEqual(['subscribe', 'list'])
    expect(store.get(chatStateAtom).conversations.map((item) => item.id)).toEqual(['newer', 'older'])
    cleanup()
    controller.start()()
    expect(subscribeCount).toBe(2)
    expect(unsubscribeCount).toBe(2)
  })

  test('同一会话的慢消息响应不能覆盖较新的 JSONL 快照', async () => {
    const first = deferred<ChatMessage[]>()
    const second = deferred<ChatMessage[]>()
    let calls = 0
    const store = createStore()
    const controller = new ChatRendererController(createApi({
      getMessages: () => (++calls === 1 ? first.promise : second.promise),
    }), store)
    const oldLoad = controller.loadMessages('conversation-1')
    const newLoad = controller.loadMessages('conversation-1')
    second.resolve([assistantMessage('new', '新快照')])
    await newLoad
    first.resolve([assistantMessage('old', '旧快照')])
    await oldLoad

    expect(store.get(chatStateAtom).messagesByConversation['conversation-1']).toEqual([
      assistantMessage('new', '新快照'),
    ])
    expect(store.get(chatStateAtom).messageStatusByConversation['conversation-1']).toBe('ready')
  })

  test('流事件使旧消息读取失效，旧列表响应不能回滚会话更新时间', async () => {
    const list = deferred<ConversationMeta[]>()
    const messages = deferred<ChatMessage[]>()
    let messageCalls = 0
    let listener: ((event: ChatGenerationEvent) => void) | undefined
    const store = createStore()
    store.set(chatStateAtom, {
      ...createInitialChatRendererState(),
      lastError: {
        scope: 'messages',
        conversationId: 'conversation-other',
        message: '其他会话加载失败',
      },
    })
    const controller = new ChatRendererController(createApi({
      onEvent: (callback) => { listener = callback; return () => {} },
      listConversations: () => list.promise,
      getMessages: () => (++messageCalls === 1 ? messages.promise : Promise.resolve([userMessage()])),
    }), store)
    const cleanup = controller.start()
    const staleMessages = controller.loadMessages('conversation-1')
    listener?.(startedEvent())
    messages.resolve([])
    list.resolve([conversation('conversation-1', 1)])
    await staleMessages
    await Promise.resolve()

    const state = store.get(chatStateAtom)
    expect(state.messagesByConversation['conversation-1']).toEqual([userMessage()])
    expect(state.conversations[0]?.updatedAt).toBe(userMessage().createdAt)
    expect(state.lastError?.conversationId).toBe('conversation-other')
    cleanup()
  })

  test('发送时即时归并事件，结束后以主进程消息与会话列表校准', async () => {
    const storedUser = userMessage()
    const storedAssistant = assistantMessage()
    const storedMessages = [storedUser, storedAssistant]
    let listener: ((event: ChatGenerationEvent) => void) | undefined
    let sendObserved = false
    const store = createStore()
    const api = createApi({
      onEvent: (callback) => { listener = callback; return () => { listener = undefined } },
      listConversations: async () => [conversation('conversation-1', 20)],
      getMessages: async () => storedMessages,
      send: async () => {
        sendObserved = true
        listener?.(startedEvent())
        listener?.({
          type: 'stream',
          conversationId: 'conversation-1',
          generationId: 'generation-1',
          event: { type: 'text_delta', delta: '临时增量' },
        })
        listener?.({
          type: 'completed',
          conversationId: 'conversation-1',
          generationId: 'generation-1',
          message: storedAssistant,
        })
        return { success: true, message: storedAssistant }
      },
    })
    const controller = new ChatRendererController(api, store)
    const cleanup = controller.start()
    const result = await controller.send({ conversationId: 'conversation-1', text: '你好' })

    expect(sendObserved).toBe(true)
    expect(result.success).toBe(true)
    expect(store.get(chatStateAtom)).toMatchObject({
      conversationsStatus: 'ready',
      messagesByConversation: { 'conversation-1': storedMessages },
      generationsByConversation: {},
      sendingByConversation: {},
      lastError: null,
    })
    cleanup()
  })

  test('发送传输异常转为稳定错误，停止异常返回 false 并更新状态', async () => {
    const store = createStore()
    const controller = new ChatRendererController(createApi({
      send: async () => { throw new Error('secret transport detail') },
      stop: async () => { throw new Error('closed') },
    }), store)
    const result = await controller.send({ conversationId: 'conversation-1', text: '你好' })
    expect(result).toEqual({
      success: false,
      code: 'internal_error',
      message: '无法连接主进程 Chat 服务',
    })
    expect(store.get(chatStateAtom).lastError).toMatchObject({
      scope: 'generation',
      code: 'internal_error',
    })
    expect(JSON.stringify(store.get(chatStateAtom))).not.toContain('secret transport detail')
    expect(await controller.stop('conversation-1')).toBe(false)
    expect(store.get(chatStateAtom).lastError?.message).toBe('停止生成失败')
  })

  test('创建、更新与删除同步维护会话和消息快照', async () => {
    const store = createStore()
    const controller = new ChatRendererController(createApi(), store)
    const created = await controller.createConversation({ title: '新会话' })
    store.set(chatDraftsAtom, { [created.id]: '未发送草稿' })
    expect(store.get(chatStateAtom).messagesByConversation[created.id]).toEqual([])
    await controller.updateConversation(created.id, { title: '已更新' })
    expect(store.get(chatStateAtom).conversations[0]?.title).toBe('已更新')
    await controller.deleteConversation(created.id)
    expect(store.get(chatStateAtom).conversations).toEqual([])
    expect(store.get(chatStateAtom).messagesByConversation).toEqual({})
    expect(store.get(chatDraftsAtom)).toEqual({})
  })

  test('删除会话使在途消息读取失效，迟到响应不能复活消息', async () => {
    const pending = deferred<ChatMessage[]>()
    const store = createStore()
    const controller = new ChatRendererController(createApi({ getMessages: () => pending.promise }), store)
    const loading = controller.loadMessages('conversation-1')
    await controller.deleteConversation('conversation-1')
    pending.resolve([userMessage()])
    await loading
    expect(store.get(chatStateAtom).messagesByConversation['conversation-1']).toBeUndefined()
  })
})

describe('Chat 输入草稿持久化', () => {
  test('清洗恢复快照：只接受字符串键值，截断超长并限制条数', () => {
    expect(sanitizePersistedChatDrafts(null)).toEqual({})
    expect(sanitizePersistedChatDrafts('text')).toEqual({})
    expect(sanitizePersistedChatDrafts({ ' ': '内容' })).toEqual({})
    expect(sanitizePersistedChatDrafts({ 'conversation-1': 123 })).toEqual({})
    const long = sanitizePersistedChatDrafts({ 'conversation-1': '字'.repeat(MAX_CHAT_INPUT_LENGTH + 10) })
    expect(long['conversation-1']).toHaveLength(MAX_CHAT_INPUT_LENGTH)

    const many: Record<string, string> = {}
    for (let index = 0; index < 150; index += 1) many[`conversation-${index}`] = `草稿${index}`
    const limited = sanitizePersistedChatDrafts(many)
    expect(Object.keys(limited)).toHaveLength(100)
    // 保留的是较新的条目（切片保留尾部）。
    expect(limited['conversation-149']).toBe('草稿149')
    expect(limited['conversation-0']).toBeUndefined()
  })

  test('修剪草稿：只保留存在的会话，未变化时返回原引用', () => {
    const drafts = { 'conversation-1': '一', 'conversation-2': '二', 'conversation-deleted': '三' }
    const pruned = pruneChatDrafts(drafts, ['conversation-1', 'conversation-2'])
    expect(pruned).toEqual({ 'conversation-1': '一', 'conversation-2': '二' })
    // 无需修剪时保持引用稳定，避免触发不必要的持久化。
    expect(pruneChatDrafts(drafts, ['conversation-1', 'conversation-2', 'conversation-deleted'])).toBe(drafts)
  })
})
