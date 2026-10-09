import { describe, expect, test } from 'bun:test'
import { createStore } from 'jotai/vanilla'
import { MAX_CHAT_INPUT_LENGTH } from '@axon/shared'
import type {
  ChatGenerationEvent,
  ChatGenerationIdentityEvent,
  BackendChatGeneration,
  ChatSendResult,
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
    onChannelsChanged: () => () => {},
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
    getOwnedGeneration: async () => null,
    onGenerationChanged: () => () => {},
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
  test('渠道先订阅再读取；保存通知使旧列表失效，释放后的回调不覆盖新订阅', async () => {
    const first = deferred<Channel[]>(), second = deferred<Channel[]>()
    const callbacks: Array<(channels: Channel[]) => void> = []
    const order: string[] = []
    let calls = 0, released = 0
    const store = createStore()
    const controller = new ChatRendererController(createApi({
      onChannelsChanged: (callback) => { order.push('subscribe'); callbacks.push(callback); return () => { released++ } },
      listChannels: () => { order.push('list'); return ++calls === 1 ? first.promise : second.promise },
    }), store)
    const cleanup = controller.start()
    expect(order).toEqual(['subscribe', 'list'])
    callbacks[0]!([channel('saved')])
    first.resolve([channel('stale')])
    await Promise.resolve()
    expect(store.get(chatStateAtom)).toMatchObject({ channels: [{ id: 'saved' }], channelsStatus: 'ready' })
    cleanup()
    callbacks[0]!([channel('late')])
    expect(store.get(chatStateAtom).channels[0]?.id).toBe('saved')
    const nextCleanup = controller.start()
    callbacks[0]!([channel('old-page')])
    callbacks[1]!([channel('new-page')])
    second.resolve([channel('old-query')])
    await Promise.resolve()
    expect(store.get(chatStateAtom).channels[0]?.id).toBe('new-page')
    nextCleanup()
    expect(released).toBe(2)
  })

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

  test('读取期间合并已落盘用户消息，旧列表响应不能回滚会话更新时间', async () => {
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
    // 无控制身份不能调用停止；此处用所属恢复验证真实传输失败的边界。
    const stopped = new ChatRendererController(createApi({
      getOwnedGeneration: async () => ({ conversationId: 'conversation-1', generationId: 'actual' }),
      stop: async () => { throw new Error('closed') },
    }), store)
    await stopped.loadMessages('conversation-1')
    expect(await stopped.stop('conversation-1')).toBe(false)
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

function controls(overrides: Partial<ChatRendererApi> = {}) {
  let identity: ((event: ChatGenerationIdentityEvent) => void) | undefined
  let event: ((event: ChatGenerationEvent) => void) | undefined
  const store = createStore()
  const controller = new ChatRendererController(createApi({
    onGenerationChanged: (callback) => { identity = callback; return () => {} },
    onEvent: (callback) => { event = callback; return () => {} },
    ...overrides,
  }), store)
  const cleanup = controller.start()
  const generation = (generationId: string, phase: 'started' | 'finished' = 'started'): void => {
    identity?.({ phase, generation: { conversationId: 'conversation-1', generationId } })
  }
  const started = (generationId: string, id = 'user-1'): void => {
    const base = startedEvent()
    if (base.type === 'started') event?.({ ...base, generationId, userMessage: userMessage(id) })
  }
  const completed = (generationId: string, id = 'assistant-1'): void => {
    event?.({ type: 'completed', conversationId: 'conversation-1', generationId, message: assistantMessage(id) })
  }
  return { store, controller, cleanup, generation, started, completed,
    emit: (value: ChatGenerationEvent) => event?.(value) }
}

describe('Chat 精确控制与并行历史', () => {
  test('预检已有真实身份可停止；旧点击/结束不影响新轮，未知身份不查询或停止', async () => {
    const calls: BackendChatGeneration[] = [], stopped = deferred<boolean>()
    let queries = 0
    const f = controls({ stop: (target) => { calls.push(target); return calls.length === 1 ? stopped.promise : Promise.resolve(true) },
      getOwnedGeneration: async () => { queries += 1; return null } })
    expect(await f.controller.stop('conversation-1')).toBe(false)
    expect(queries).toBe(0)
    f.generation('old')
    const oldClick = f.controller.stop('conversation-1')
    f.generation('new'); f.generation('old', 'finished')
    expect(await f.controller.stop('conversation-1')).toBe(true)
    stopped.resolve(true)
    expect(await oldClick).toBe(true)
    expect(calls.map((item) => item.generationId)).toEqual(['old', 'new'])
    f.cleanup(); f.generation('late')
    expect(await f.controller.stop('conversation-1')).toBe(false)
    expect(calls).toHaveLength(2)
  })

  test('所属恢复迟到不能覆盖新身份；观察者、删除后或释放后恢复不授予控制权', async () => {
    for (const mode of ['new', 'observer', 'dispose', 'delete']) {
      const queried = deferred<BackendChatGeneration | null>(), calls: BackendChatGeneration[] = []
      const f = controls({ getOwnedGeneration: () => queried.promise, stop: async (target) => { calls.push(target); return true } })
      await f.controller.loadMessages('conversation-1')
      if (mode === 'new') f.generation('new')
      if (mode === 'dispose') f.cleanup()
      if (mode === 'delete') await f.controller.deleteConversation('conversation-1')
      queried.resolve(mode === 'observer' ? null : { conversationId: 'conversation-1', generationId: 'old' })
      await Promise.resolve()
      expect(await f.controller.stop('conversation-1')).toBe(mode === 'new')
      expect(calls.map((item) => item.generationId)).toEqual(mode === 'new' ? ['new'] : [])
      f.cleanup()
    }
  })

  test('完整快照合并读取期间的用户/终态，保留附件；流草稿不混入历史，旧流不能撤销新轮', async () => {
    const history = deferred<ChatMessage[]>()
    const f = controls({ getMessages: () => history.promise })
    const loading = f.controller.loadMessages('conversation-1')
    f.generation('g1'); f.started('g1'); f.completed('g1')
    f.generation('g2'); f.started('g2', 'user-2')
    f.emit({ type: 'stream', conversationId: 'conversation-1', generationId: 'g2', event: { type: 'text_delta', delta: '草稿' } })
    f.completed('g1', 'stale')
    const original = { ...userMessage('original'), attachments: [{ id: 'file', filename: 'x.txt', mediaType: 'text/plain', localPath: 'conversation-1/x.txt', size: 1, createdAt: 1 }] }
    history.resolve([original, userMessage(), { ...assistantMessage(), content: [{ type: 'text', text: '旧值' }] }])
    await loading
    expect(f.store.get(chatStateAtom).messagesByConversation['conversation-1']).toEqual([original, userMessage(), assistantMessage(), userMessage('user-2')])
    expect(f.store.get(chatStateAtom).generationsByConversation['conversation-1']?.blocks).toEqual([{ type: 'text', text: '草稿' }])
    f.cleanup()
  })

  test('旧发送返回及刷新收尾不能清掉新生成，也不能覆盖它的错误', async () => {
    const first = deferred<ChatSendResult>(), second = deferred<ChatSendResult>()
    let sends = 0
    const f = controls({ send: () => ++sends === 1 ? first.promise : second.promise })
    const oldSend = f.controller.send({ conversationId: 'conversation-1', text: '旧' })
    f.generation('old'); f.started('old'); f.completed('old'); f.generation('old', 'finished')
    const newSend = f.controller.send({ conversationId: 'conversation-1', text: '新' })
    f.generation('new'); f.started('new', 'user-new')
    first.resolve({ success: false, code: 'provider_failed', message: '旧错误' })
    await oldSend
    expect(f.store.get(chatStateAtom).generationsByConversation['conversation-1']?.generationId).toBe('new')
    expect(f.store.get(chatStateAtom).sendingByConversation['conversation-1']).toBe(true)
    expect(f.store.get(chatStateAtom).lastError).toBeNull()
    f.completed('new', 'assistant-new'); f.generation('new', 'finished')
    second.resolve({ success: true, message: assistantMessage('assistant-new') })
    await newSend
    f.cleanup()
  })

  test('释放使旧事件、发送响应和历史读取失效；再次订阅可清掉漏失终态的旧草稿', async () => {
    const result = deferred<ChatSendResult>(), history = deferred<ChatMessage[]>()
    let reads = 0
    const f = controls({ send: () => result.promise, getMessages: () => { reads += 1; return history.promise } })
    const sending = f.controller.send({ conversationId: 'conversation-1', text: '输入' })
    f.generation('g1'); f.started('g1')
    f.cleanup()
    const snapshot = f.store.get(chatStateAtom)
    f.completed('g1'); f.generation('late')
    result.resolve({ success: false, code: 'provider_failed', message: '旧错误' })
    history.resolve([assistantMessage()])
    await sending; await Promise.resolve()
    expect(f.store.get(chatStateAtom)).toBe(snapshot)
    expect(reads).toBe(1)
    const release = f.controller.start()
    await Promise.resolve()
    expect(f.store.get(chatStateAtom).generationsByConversation['conversation-1']).toBeUndefined()
    expect(f.store.get(chatStateAtom).sendingByConversation['conversation-1']).toBeUndefined()
    release()
  })

  test('旧发送已进入历史校准时，新轮开始仍不会被旧刷新收尾清掉；失败读取保留实时消息', async () => {
    const reply = deferred<ChatSendResult>(), history = deferred<ChatMessage[]>(), entered = deferred<void>()
    let reading = 0
    const f = controls({ send: () => reply.promise, getMessages: () => { if (++reading === 2) entered.resolve(); return history.promise } })
    const oldSend = f.controller.send({ conversationId: 'conversation-1', text: '旧' })
    f.generation('old'); f.started('old'); f.completed('old'); f.generation('old', 'finished')
    reply.resolve({ success: true, message: assistantMessage() })
    await entered.promise
    f.generation('new'); f.started('new', 'new-user')
    history.resolve([userMessage(), assistantMessage()])
    await oldSend
    expect(f.store.get(chatStateAtom).sendingByConversation['conversation-1']).toBe(true)
    expect(f.store.get(chatStateAtom).generationsByConversation['conversation-1']?.generationId).toBe('new')
    expect(f.store.get(chatStateAtom).messagesByConversation['conversation-1']?.at(-1)?.id).toBe('new-user')
    f.cleanup()
    const failed = controls({ getMessages: async () => { throw new Error('secret') } })
    failed.generation('current'); failed.started('current', 'live-user')
    await Promise.resolve()
    expect(failed.store.get(chatStateAtom).messagesByConversation['conversation-1']).toEqual([userMessage('live-user')])
    expect(failed.store.get(chatStateAtom).messageStatusByConversation['conversation-1']).toBe('error')
    failed.cleanup()
  })

  test('预检尚无用户消息时重新订阅，恢复所属停止身份；无所属运行则清除遗留发送状态', async () => {
    for (const exists of [true, false]) {
      const store = createStore()
      store.set(chatStateAtom, { ...createInitialChatRendererState(), sendingByConversation: { 'conversation-1': true } })
      const target = { conversationId: 'conversation-1', generationId: 'preflight' }
      const calls: BackendChatGeneration[] = []
      const controller = new ChatRendererController(createApi({ getOwnedGeneration: async () => exists ? target : null,
        stop: async (value) => { calls.push(value); return true } }), store)
      const cleanup = controller.start()
      await Promise.resolve()
      expect(await controller.stop('conversation-1')).toBe(exists)
      expect(calls).toEqual(exists ? [target] : [])
      expect(store.get(chatStateAtom).sendingByConversation['conversation-1']).toBe(exists ? true : undefined)
      cleanup()
    }
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
