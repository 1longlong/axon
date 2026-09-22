import { afterEach, beforeEach, describe, expect, test } from 'bun:test'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { ProviderStreamRequestError } from '@axon/core'
import type { ProviderStreamEvent, ProviderStreamRequest } from '@axon/core'
import { MAX_REQUEST_IMAGE_SIZE } from '@axon/shared'
import type { ChatGenerationEvent, ResolvedChannel } from '@axon/shared'
import { ChatService, ChatServiceError } from './chat-service'
import type { ChatStreamExecutor } from './chat-service'
import { ConversationManager } from './conversation-manager'

let directory: string
let conversations: ConversationManager
let nowValue: number
let idValue: number

beforeEach(() => {
  directory = mkdtempSync(join(tmpdir(), 'axon-chat-service-'))
  nowValue = 1_000
  idValue = 1
  conversations = new ConversationManager({
    indexPath: join(directory, 'conversations.json'),
    messagesDir: join(directory, 'conversations'),
    createId: () => `conversation-${idValue++}`,
    now: () => nowValue,
  })
})

afterEach(() => {
  rmSync(directory, { recursive: true, force: true })
})

function resolvedChannel(overrides: Partial<ResolvedChannel> = {}): ResolvedChannel {
  return {
    id: 'channel-1',
    name: '测试渠道',
    provider: 'openai',
    baseUrl: 'https://api.openai.com/v1',
    apiKey: 'synthetic-secret',
    models: [{ id: 'model-1', name: '模型一', enabled: true }],
    enabled: true,
    createdAt: 1,
    updatedAt: 1,
    ...overrides,
  }
}

function createConversation(channelId = 'channel-1', modelId = 'model-1'): string {
  return conversations.create({ channelId, modelId }).id
}

function createService(
  stream: ChatStreamExecutor,
  events: ChatGenerationEvent[] = [],
  channel: ResolvedChannel = resolvedChannel(),
): ChatService {
  return new ChatService({
    channelManager: { resolve: () => ({ ...channel, models: channel.models.map((item) => ({ ...item })) }) },
    conversationManager: conversations,
    userAgent: 'Axon/0.1.0',
    stream,
    emit: (event) => events.push(event),
    createId: () => `chat-${idValue++}`,
    now: () => nowValue++,
  })
}

async function* eventsStream(events: readonly ProviderStreamEvent[]): AsyncGenerator<ProviderStreamEvent> {
  for (const event of events) yield event
}

describe('ChatService 流式主链', () => {
  test('使用会话摘要压缩 Provider 历史，但不改变 JSONL 消息', async () => {
    const conversationId = createConversation()
    const first = conversations.appendMessage(conversationId, {
      id: 'old-1', role: 'user', content: [{ type: 'text', text: '旧问题' }], createdAt: 1, status: 'complete',
    })
    conversations.appendMessage(conversationId, {
      id: 'old-2', role: 'assistant', content: [{ type: 'text', text: '旧回答' }], createdAt: 2, status: 'complete',
    })
    conversations.update(conversationId, {
      contextSummary: { text: '旧对话讨论了项目背景。', coveredMessageIds: [first.id, 'old-2'], updatedAt: 3 },
    })
    const calls: ProviderStreamRequest[] = []
    const service = createService((input) => {
      // 标题请求短路为空流，保持本测试聚焦摘要压缩。
      if (input.chatRequest.systemPrompt?.startsWith('请为这段对话生成')) return eventsStream([])
      calls.push(input)
      return eventsStream([{ type: 'text_delta', delta: '收到' }, { type: 'finish', reason: 'stop' }])
    })

    await service.sendMessage({ conversationId, text: '继续' })

    const request = calls[0]
    expect(request?.chatRequest.messages).toEqual([{ role: 'user', content: [{ type: 'text', text: '继续' }] }])
    expect(request?.chatRequest.systemPrompt).toContain('旧对话讨论了项目背景。')
    expect(conversations.getMessages(conversationId).map((message) => message.id)).toEqual(['old-1', 'old-2', expect.any(String), expect.any(String)])
  })

  test('用户消息预落盘，以可信历史调用 Provider，再保存完整助手消息', async () => {
    const conversationId = createConversation()
    const emitted: ChatGenerationEvent[] = []
    const calls: ProviderStreamRequest[] = []
    const service = createService((input) => {
      if (input.chatRequest.systemPrompt?.startsWith('请为这段对话生成')) return eventsStream([])
      calls.push(input)
      return eventsStream([
        { type: 'text_delta', delta: '你' },
        { type: 'text_delta', delta: '好' },
        { type: 'usage', usage: { inputTokens: 3, outputTokens: 2, totalTokens: 5 } },
        { type: 'finish', reason: 'stop', providerReason: 'stop' },
      ])
    }, emitted)

    const assistant = await service.sendMessage({
      conversationId,
      text: '  你好  ',
      maxOutputTokens: 200,
      temperature: 0.5,
    })

    const request = calls[0]
    expect(request).toMatchObject({
      provider: 'openai',
      baseUrl: 'https://api.openai.com/v1',
      apiKey: 'synthetic-secret',
      userAgent: 'Axon/0.1.0',
      chatRequest: {
        modelId: 'model-1',
        maxOutputTokens: 200,
        temperature: 0.5,
        messages: [{ role: 'user', content: [{ type: 'text', text: '你好' }] }],
      },
    })
    expect(request?.signal).toBeInstanceOf(AbortSignal)
    expect(assistant).toMatchObject({
      role: 'assistant',
      content: [{ type: 'text', text: '你好' }],
      status: 'complete',
      finishReason: 'stop',
      usage: { totalTokens: 5 },
    })
    expect(conversations.getMessages(conversationId).map((item) => item.role)).toEqual([
      'user',
      'assistant',
    ])
    expect(emitted.map((event) => event.type)).toEqual([
      'started',
      'stream',
      'stream',
      'stream',
      'stream',
      'completed',
    ])
    expect(service.isActive(conversationId)).toBe(false)
  })

  test('按事件顺序累计推理、正文和完整工具调用', async () => {
    const conversationId = createConversation()
    const service = createService(() => eventsStream([
      { type: 'reasoning_start', blockId: 'reason-1' },
      { type: 'reasoning_delta', blockId: 'reason-1', delta: '先思考' },
      { type: 'reasoning_signature', blockId: 'reason-1', signatureDelta: ' opaque ' },
      { type: 'reasoning_end', blockId: 'reason-1' },
      { type: 'text_delta', delta: '正在查询' },
      { type: 'tool_call_start', callKey: 'tool-1', callId: 'call-1', name: 'get_weather' },
      { type: 'tool_call_delta', callKey: 'tool-1', argumentsDelta: '{"city":' },
      { type: 'tool_call_delta', callKey: 'tool-1', argumentsDelta: '"上海"}' },
      { type: 'tool_call_end', callKey: 'tool-1' },
      { type: 'finish', reason: 'tool_use' },
    ]))

    const message = await service.sendMessage({ conversationId, text: '天气' })
    expect(message.content).toEqual([
      { type: 'reasoning', text: '先思考', signature: ' opaque ' },
      { type: 'text', text: '正在查询' },
      { type: 'tool_call', callId: 'call-1', name: 'get_weather', arguments: '{"city":"上海"}' },
    ])
  })

  test('后续请求排除停止和失败的助手局部输出', async () => {
    const conversationId = createConversation()
    conversations.appendMessage(conversationId, {
      id: 'old-user', role: 'user', content: [{ type: 'text', text: '旧问题' }], createdAt: 1, status: 'complete',
    })
    conversations.appendMessage(conversationId, {
      id: 'old-stopped', role: 'assistant', content: [{ type: 'text', text: '半句' }], createdAt: 2, status: 'stopped', modelId: 'model-1', finishReason: 'other',
    })
    const calls: ProviderStreamRequest[] = []
    const service = createService((input) => {
      if (input.chatRequest.systemPrompt?.startsWith('请为这段对话生成')) return eventsStream([])
      calls.push(input)
      return eventsStream([{ type: 'text_delta', delta: '新回答' }, { type: 'finish', reason: 'stop' }])
    })

    await service.sendMessage({ conversationId, text: '新问题' })
    expect(calls[0]?.chatRequest.messages).toEqual([
      { role: 'user', content: [{ type: 'text', text: '旧问题' }] },
      { role: 'user', content: [{ type: 'text', text: '新问题' }] },
    ])
  })

  test('内容过滤可形成无正文但可恢复的完整终态', async () => {
    const conversationId = createConversation()
    const service = createService(() => eventsStream([
      { type: 'finish', reason: 'content_filter', providerReason: 'SAFETY' },
    ]))
    expect(await service.sendMessage({ conversationId, text: '受限内容' })).toMatchObject({
      content: [],
      status: 'complete',
      finishReason: 'content_filter',
    })
  })
})

describe('ChatService 终止与失败边界', () => {
  test('停止生成会取消下游请求并落盘已有局部正文', async () => {
    const conversationId = createConversation()
    const emitted: ChatGenerationEvent[] = []
    let streamStarted: (() => void) | undefined
    const ready = new Promise<void>((resolve) => { streamStarted = resolve })
    const service = createService(async function* (input) {
      yield { type: 'text_delta', delta: '局部' }
      streamStarted?.()
      await new Promise<never>((_resolve, reject) => {
        input.signal?.addEventListener('abort', () => {
          reject(new ProviderStreamRequestError('cancelled', 'Provider 请求已取消'))
        }, { once: true })
      })
    }, emitted)

    const pending = service.sendMessage({ conversationId, text: '停止测试' })
    await ready
    expect(service.isActive(conversationId)).toBe(true)
    expect(service.stopGeneration(conversationId)).toBe(true)
    expect(service.stopGeneration(conversationId)).toBe(false)
    expect(service.stopGeneration('missing')).toBe(false)
    await expect(pending).rejects.toMatchObject({ code: 'cancelled' })

    expect(conversations.getMessages(conversationId).at(-1)).toMatchObject({
      role: 'assistant',
      content: [{ type: 'text', text: '局部' }],
      status: 'stopped',
    })
    expect(emitted.at(-1)?.type).toBe('stopped')
    expect(service.isActive()).toBe(false)
  })

  test('首个增量前停止也能保存空的 stopped 助手终态', async () => {
    const conversationId = createConversation()
    let streamStarted: (() => void) | undefined
    const ready = new Promise<void>((resolve) => { streamStarted = resolve })
    const service = createService(async function* (input) {
      streamStarted?.()
      await new Promise<never>((_resolve, reject) => {
        input.signal?.addEventListener('abort', () => reject(new Error('cancelled')), { once: true })
      })
    })
    const pending = service.sendMessage({ conversationId, text: '立即停止' })
    await ready
    service.stopGeneration(conversationId)
    await expect(pending).rejects.toMatchObject({ code: 'cancelled' })
    expect(conversations.getMessages(conversationId).at(-1)).toMatchObject({
      content: [],
      status: 'stopped',
    })
  })

  test('Provider 异常不泄露原始错误，并落盘 failed 终态', async () => {
    const conversationId = createConversation()
    const emitted: ChatGenerationEvent[] = []
    const service = createService(async function* () {
      yield { type: 'text_delta', delta: '局部回答' }
      throw new Error('secret upstream response')
    }, emitted)

    await expect(service.sendMessage({ conversationId, text: '失败测试' })).rejects.toEqual(
      expect.objectContaining({ code: 'provider_failed', message: '生成失败' }),
    )
    const failed = conversations.getMessages(conversationId).at(-1)
    expect(failed).toMatchObject({ status: 'error', error: '生成失败' })
    expect(JSON.stringify(failed)).not.toContain('secret upstream response')
    expect(emitted.at(-1)?.type).toBe('failed')
  })

  test('同一会话拒绝并发，stopAllGenerations 可停止不同会话', async () => {
    const firstId = createConversation()
    const secondId = createConversation()
    let startedCount = 0
    let bothStarted: (() => void) | undefined
    const ready = new Promise<void>((resolve) => { bothStarted = resolve })
    const service = createService(async function* (input) {
      startedCount += 1
      if (startedCount === 2) bothStarted?.()
      await new Promise<never>((_resolve, reject) => {
        input.signal?.addEventListener('abort', () => reject(new Error('cancelled')), { once: true })
      })
    })

    const first = service.sendMessage({ conversationId: firstId, text: '一' })
    await expect(service.sendMessage({ conversationId: firstId, text: '重复' })).rejects.toMatchObject({
      code: 'already_active',
    })
    const second = service.sendMessage({ conversationId: secondId, text: '二' })
    const settled = Promise.allSettled([first, second])
    await ready
    expect(service.stopAllGenerations()).toBe(2)
    const results = await settled
    expect(results).toEqual([
      expect.objectContaining({ status: 'rejected', reason: expect.objectContaining({ code: 'cancelled' }) }),
      expect.objectContaining({ status: 'rejected', reason: expect.objectContaining({ code: 'cancelled' }) }),
    ])
    expect(service.stopAllGenerations()).toBe(0)
  })

  test('事件消费者异常不会中断生成和持久化', async () => {
    const conversationId = createConversation()
    const service = new ChatService({
      channelManager: { resolve: () => resolvedChannel() },
      conversationManager: conversations,
      userAgent: 'Axon/0.1.0',
      stream: () => eventsStream([{ type: 'text_delta', delta: '完成' }, { type: 'finish', reason: 'stop' }]),
      emit: () => { throw new Error('renderer closed') },
      createId: () => `chat-${idValue++}`,
      now: () => nowValue++,
    })
    expect(await service.sendMessage({ conversationId, text: '测试' })).toMatchObject({
      status: 'complete',
    })
  })
})

describe('ChatService 配置与输入校验', () => {
  test('在落盘或联网前拒绝缺失渠道、模型、停用渠道和停用模型', async () => {
    let streamCalls = 0
    const stream = (): AsyncIterable<ProviderStreamEvent> => {
      streamCalls += 1
      return eventsStream([])
    }
    const noChannel = conversations.create().id
    const noModel = conversations.create({ channelId: 'channel-1' }).id
    const disabledChannelId = createConversation()
    const disabledModelId = createConversation()

    await expect(createService(stream).sendMessage({ conversationId: 'missing', text: 'x' })).rejects.toMatchObject({ code: 'conversation_not_found' })
    await expect(createService(stream).sendMessage({ conversationId: noChannel, text: 'x' })).rejects.toMatchObject({ code: 'channel_required' })
    await expect(createService(stream).sendMessage({ conversationId: noModel, text: 'x' })).rejects.toMatchObject({ code: 'model_required' })
    await expect(createService(stream, [], resolvedChannel({ enabled: false })).sendMessage({ conversationId: disabledChannelId, text: 'x' })).rejects.toMatchObject({ code: 'channel_unavailable' })
    await expect(createService(stream, [], resolvedChannel({ models: [{ id: 'model-1', name: '模型一', enabled: false }] })).sendMessage({ conversationId: disabledModelId, text: 'x' })).rejects.toMatchObject({ code: 'model_unavailable' })
    expect(streamCalls).toBe(0)
    expect(conversations.getMessages(noChannel)).toEqual([])
  })

  test('校验正文、输出上限和 temperature，并隐藏渠道解析错误', async () => {
    const conversationId = createConversation()
    const stream = (): AsyncIterable<ProviderStreamEvent> => eventsStream([])
    const service = createService(stream)
    for (const input of [
      { conversationId, text: ' ' },
      { conversationId, text: 'x', maxOutputTokens: 0 },
      { conversationId, text: 'x', temperature: 3 },
    ]) {
      await expect(service.sendMessage(input)).rejects.toBeInstanceOf(ChatServiceError)
    }
    const broken = new ChatService({
      channelManager: { resolve: () => { throw new Error('secret credential failure') } },
      conversationManager: conversations,
      userAgent: 'Axon/0.1.0',
      stream,
    })
    await expect(broken.sendMessage({ conversationId, text: 'x' })).rejects.toEqual(
      expect.objectContaining({ code: 'channel_unavailable', message: '渠道不可用或凭据无法读取' }),
    )
  })

  test('非法流顺序转换为稳定失败，不持久化未闭合工具参数', async () => {
    const conversationId = createConversation()
    const service = createService(() => eventsStream([
      { type: 'tool_call_start', callKey: 'tool-1', callId: 'call-1', name: 'broken_tool' },
      { type: 'tool_call_delta', callKey: 'tool-1', argumentsDelta: '{' },
      { type: 'finish', reason: 'tool_use' },
    ]))
    await expect(service.sendMessage({ conversationId, text: 'x' })).rejects.toMatchObject({
      code: 'provider_failed',
    })
    expect(conversations.getMessages(conversationId).at(-1)).toMatchObject({
      status: 'error',
      content: [],
    })
  })
})

describe('ChatService 自动摘要边界', () => {
  const SUMMARY_PROMPT_PREFIX = '请把以下对话压缩'

  /** 构造可触发摘要阈值的大型会话：前 candidateCount 条为超长候选，其余为普通完整消息。 */
  function seedSummaryConversation(count: number, candidateCount: number, textLength = 20_000): { conversationId: string; candidateIds: string[] } {
    const conversationId = createConversation()
    const candidateIds: string[] = []
    for (let index = 1; index <= count; index += 1) {
      const isCandidate = index <= candidateCount
      if (isCandidate) candidateIds.push(`seed-${index}`)
      conversations.appendMessage(conversationId, {
        id: `seed-${index}`,
        role: index % 2 === 1 ? 'user' : 'assistant',
        content: [{ type: 'text', text: isCandidate ? `旧对话第${index}条：${'甲'.repeat(textLength)}` : `普通消息${index}` }],
        createdAt: index,
        status: 'complete',
      })
    }
    return { conversationId, candidateIds }
  }

  test('达到阈值时自动摘要：主请求排除旧消息并合并摘要，摘要请求不写入 JSONL', async () => {
    const { conversationId, candidateIds } = seedSummaryConversation(12, 4)
    const calls: ProviderStreamRequest[] = []
    const service = createService(async function* (input) {
      if (input.chatRequest.systemPrompt?.startsWith('请为这段对话生成')) return
      calls.push(input)
      if (input.chatRequest.systemPrompt?.startsWith(SUMMARY_PROMPT_PREFIX)) {
        yield { type: 'text_delta', delta: '旧对话讨论了背景。' }
        yield { type: 'finish', reason: 'stop' }
        return
      }
      yield { type: 'text_delta', delta: '收到' }
      yield { type: 'finish', reason: 'stop' }
    })

    const assistant = await service.sendMessage({ conversationId, text: '继续' })

    expect(calls).toHaveLength(2)
    const [summary, main] = calls
    // 摘要请求：单条 user 消息只承载候选旧文本，不含本轮新输入。
    const firstSummaryBlock = summary?.chatRequest.messages[0]?.content[0]
    const summarySource = firstSummaryBlock?.type === 'text' ? firstSummaryBlock.text : ''
    expect(summarySource).toContain('旧对话第4条：')
    expect(summarySource).not.toContain('普通消息5')
    expect(summarySource).not.toContain('继续')
    expect(summary?.chatRequest.maxOutputTokens).toBe(2_000)
    // 摘要与主生成共享同一取消信号，用户停止能同时中断两者。
    expect(summary?.signal).toBeInstanceOf(AbortSignal)
    expect(summary?.signal).toBe(main?.signal)
    // 主请求：排除被覆盖消息，摘要合并进 system 区域。
    expect(main?.chatRequest.systemPrompt).toBe('以下是更早对话的摘要：\n旧对话讨论了背景。')
    expect(main?.chatRequest.messages).toHaveLength(9)
    expect(JSON.stringify(main?.chatRequest.messages)).not.toContain('旧对话第1条：')
    expect(JSON.stringify(main?.chatRequest.messages)).toContain('普通消息12')
    expect(JSON.stringify(assistant.content)).toContain('收到')

    // 摘要只进会话索引；消息 JSONL 仍是种子消息 + 本轮两条。
    expect(conversations.get(conversationId)?.contextSummary).toMatchObject({
      text: '旧对话讨论了背景。',
      coveredMessageIds: candidateIds,
    })
    const persisted = conversations.getMessages(conversationId)
    expect(persisted).toHaveLength(14)
    expect(JSON.stringify(persisted)).not.toContain('旧对话讨论了背景。')
  })

  test('摘要请求失败或输出为空时回退完整历史，不写摘要元数据', async () => {
    const failing = seedSummaryConversation(12, 4)
    const failingCalls: ProviderStreamRequest[] = []
    const failingService = createService(async function* (input) {
      if (input.chatRequest.systemPrompt?.startsWith('请为这段对话生成')) return
      failingCalls.push(input)
      if (input.chatRequest.systemPrompt?.startsWith(SUMMARY_PROMPT_PREFIX)) {
        throw new ProviderStreamRequestError('network', '模拟摘要网络失败')
      }
      yield { type: 'text_delta', delta: '回答' }
      yield { type: 'finish', reason: 'stop' }
    })

    await failingService.sendMessage({ conversationId: failing.conversationId, text: '继续一' })

    expect(failingCalls).toHaveLength(2)
    expect(failingCalls[1]?.chatRequest.systemPrompt).toBeUndefined()
    expect(failingCalls[1]?.chatRequest.messages).toHaveLength(13)
    expect(conversations.get(failing.conversationId)?.contextSummary).toBeUndefined()
    // 摘要失败被吞掉，错误细节既不抛给调用方也不落盘。
    expect(JSON.stringify(conversations.getMessages(failing.conversationId))).not.toContain('模拟摘要网络失败')

    const empty = seedSummaryConversation(12, 4)
    const emptyCalls: ProviderStreamRequest[] = []
    const emptyService = createService(async function* (input) {
      if (input.chatRequest.systemPrompt?.startsWith('请为这段对话生成')) return
      emptyCalls.push(input)
      if (input.chatRequest.systemPrompt?.startsWith(SUMMARY_PROMPT_PREFIX)) {
        yield { type: 'finish', reason: 'stop' }
        return
      }
      yield { type: 'text_delta', delta: '回答' }
      yield { type: 'finish', reason: 'stop' }
    })

    await emptyService.sendMessage({ conversationId: empty.conversationId, text: '继续二' })

    expect(emptyCalls).toHaveLength(2)
    expect(emptyCalls[1]?.chatRequest.systemPrompt).toBeUndefined()
    expect(emptyCalls[1]?.chatRequest.messages).toHaveLength(13)
    expect(conversations.get(empty.conversationId)?.contextSummary).toBeUndefined()
  })

  test('未达消息数、文本阈值或已有摘要时不发起摘要请求', async () => {
    const calls: ProviderStreamRequest[] = []
    const service = createService((input) => {
      if (input.chatRequest.systemPrompt?.startsWith('请为这段对话生成')) return eventsStream([])
      calls.push(input)
      return eventsStream([{ type: 'text_delta', delta: '回答' }, { type: 'finish', reason: 'stop' }])
    })

    // 11 条消息且候选文本超过 80k：消息数量不足，不摘要。
    const tooFew = seedSummaryConversation(11, 3, 30_000)
    await service.sendMessage({ conversationId: tooFew.conversationId, text: '问题一' })
    expect(calls).toHaveLength(1)
    expect(conversations.get(tooFew.conversationId)?.contextSummary).toBeUndefined()

    // 12 条消息但候选文本不足 80k：不摘要。
    const tooShort = seedSummaryConversation(12, 4, 10_000)
    await service.sendMessage({ conversationId: tooShort.conversationId, text: '问题二' })
    expect(calls).toHaveLength(2)
    expect(conversations.get(tooShort.conversationId)?.contextSummary).toBeUndefined()

    // 已有摘要元数据：不重复摘要，主请求继续使用既有摘要。
    const summarized = seedSummaryConversation(12, 4)
    conversations.update(summarized.conversationId, {
      contextSummary: { text: '已存在摘要', coveredMessageIds: ['seed-1'], updatedAt: 1 },
    })
    await service.sendMessage({ conversationId: summarized.conversationId, text: '问题三' })
    expect(calls).toHaveLength(3)
    expect(calls[2]?.chatRequest.systemPrompt).toBe('以下是更早对话的摘要：\n已存在摘要')
    expect(calls[2]?.chatRequest.messages).toHaveLength(12)
    expect(JSON.stringify(calls[2]?.chatRequest.messages)).not.toContain('旧对话第1条：')
    expect(conversations.get(summarized.conversationId)?.contextSummary?.text).toBe('已存在摘要')
  })

  test('摘要阶段共享取消信号：同会话并发生成被拒，停止后用户消息与空 stopped 终态落盘', async () => {
    const { conversationId } = seedSummaryConversation(12, 4)
    let summaryStarted: (() => void) | undefined
    const ready = new Promise<void>((resolve) => { summaryStarted = resolve })
    const service = createService(async function* (input) {
      if (input.chatRequest.systemPrompt?.startsWith(SUMMARY_PROMPT_PREFIX)) {
        summaryStarted?.()
        await new Promise<never>((_resolve, reject) => {
          input.signal?.addEventListener('abort', () => reject(new ProviderStreamRequestError('cancelled', 'Provider 请求已取消')), { once: true })
        })
      }
      // 停止发生在摘要阶段时，主请求拿到的是已取消的信号，真实执行器会立即拒绝。
      if (input.signal?.aborted) throw new ProviderStreamRequestError('cancelled', 'Provider 请求已取消')
      yield { type: 'text_delta', delta: '不该到达' }
      yield { type: 'finish', reason: 'stop' }
    })

    const pending = service.sendMessage({ conversationId, text: '停止测试' })
    await ready
    // 摘要属于同一生成：同会话并发生成被拒，停止仍能命中。
    await expect(service.sendMessage({ conversationId, text: '并发' })).rejects.toMatchObject({ code: 'already_active' })
    expect(service.stopGeneration(conversationId)).toBe(true)
    await expect(pending).rejects.toMatchObject({ code: 'cancelled' })

    const persisted = conversations.getMessages(conversationId)
    expect(persisted).toHaveLength(14)
    expect(persisted.at(-2)).toMatchObject({ role: 'user', content: [{ type: 'text', text: '停止测试' }] })
    expect(persisted.at(-1)).toMatchObject({ role: 'assistant', status: 'stopped', content: [] })
    expect(conversations.get(conversationId)?.contextSummary).toBeUndefined()
    expect(service.isActive(conversationId)).toBe(false)
  })
})

describe('ChatService 附件透传', () => {
  const validAttachment = {
    id: 'att-1',
    filename: '截图.png',
    mediaType: 'image/png',
    localPath: 'conversation-x/att-1.png',
    size: 2048,
    createdAt: 900,
  }

  test('附件元数据写入用户消息 JSONL，但不进入 Provider 历史', async () => {
    const conversationId = createConversation()
    let request: ProviderStreamRequest | undefined
    const service = createService((input) => {
      if (input.chatRequest.systemPrompt?.startsWith('请为这段对话生成')) return eventsStream([])
      request = input
      return eventsStream([{ type: 'text_delta', delta: '收到' }, { type: 'finish', reason: 'stop' }])
    })

    const localPath = `${conversationId}/att-1.png`
    await service.sendMessage({
      conversationId,
      text: '看图',
      attachments: [{ ...validAttachment, localPath }],
    })

    const persisted = conversations.getMessages(conversationId)
    expect(persisted[0]?.attachments).toEqual([{ ...validAttachment, localPath }])
    // 无附件读取依赖时，图片不进请求但降级为可见提示，不静默丢弃。
    expect(request?.chatRequest.messages[0]?.content).toEqual([
      { type: 'text', text: '看图' },
      { type: 'text', text: '（图片附件 截图.png 未能随消息发送）' },
    ])
  })

  test('非法附件输入在用户消息落盘前拒绝，不发起网络请求', async () => {
    const conversationId = createConversation()
    let streamCalls = 0
    const service = createService(() => {
      streamCalls += 1
      return eventsStream([])
    })

    const tooMany = Array.from({ length: 11 }, (_, index) => ({
      ...validAttachment,
      id: `att-${index}`,
    }))
    for (const attachments of [
      [],
      tooMany,
      [{ ...validAttachment, size: -1 }],
      [{ ...validAttachment, id: '' }],
      [{ ...validAttachment, localPath: '../outside.bin' }],
    ]) {
      await expect(service.sendMessage({ conversationId, text: 'x', attachments })).rejects.toMatchObject({
        code: 'invalid_input',
      })
    }
    expect(streamCalls).toBe(0)
    expect(conversations.getMessages(conversationId)).toEqual([])
  })
})

describe('ChatService 图片附件进入请求', () => {
  function imageAttachment(overrides: Record<string, unknown> = {}): {
    id: string; filename: string; mediaType: string; localPath: string; size: number; createdAt: number
  } {
    return {
      id: 'att-img',
      filename: '截图.png',
      mediaType: 'image/png',
      localPath: 'conversation-1/att-img.png',
      size: 2048,
      createdAt: 900,
      ...overrides,
    }
  }

  test('可读且未超限的图片编码为图片块进入 Provider 历史', async () => {
    const conversationId = createConversation()
    let request: ProviderStreamRequest | undefined
    const service = new ChatService({
      channelManager: { resolve: () => resolvedChannel() },
      conversationManager: conversations,
      userAgent: 'Axon/0.1.0',
      stream: (input) => {
        if (input.chatRequest.systemPrompt?.startsWith('请为这段对话生成')) return eventsStream([])
        request = input
        return eventsStream([{ type: 'text_delta', delta: '看到图了' }, { type: 'finish', reason: 'stop' }])
      },
      readAttachmentData: (localPath) => (localPath.endsWith('att-img.png') ? 'aW1nLWRhdGE=' : undefined),
      createId: () => `chat-${idValue++}`,
      now: () => nowValue++,
    })

    await service.sendMessage({ conversationId, text: '看图', attachments: [imageAttachment()] })

    expect(request?.chatRequest.messages[0]?.content).toEqual([
      { type: 'text', text: '看图' },
      { type: 'image', mediaType: 'image/png', data: 'aW1nLWRhdGE=' },
    ])
    // 历史消息每轮重读：第二轮的第一条用户消息仍带图片块。
    await service.sendMessage({ conversationId, text: '再看看' })
    const secondFirst = request?.chatRequest.messages[0]?.content
    expect(JSON.stringify(secondFirst)).toContain('aW1nLWRhdGE=')
  })

  test('读取失败或超大图片降级为文本提示，非图片附件跳过', async () => {
    const conversationId = createConversation()
    let request: ProviderStreamRequest | undefined
    const service = createService((input) => {
      if (input.chatRequest.systemPrompt?.startsWith('请为这段对话生成')) return eventsStream([])
      request = input
      return eventsStream([{ type: 'text_delta', delta: '收到' }, { type: 'finish', reason: 'stop' }])
    })

    await service.sendMessage({
      conversationId,
      text: '看附件',
      attachments: [
        imageAttachment({ id: 'att-missing', localPath: 'conversation-1/missing.png' }),
        imageAttachment({ id: 'att-huge', localPath: 'conversation-1/huge.png', size: MAX_REQUEST_IMAGE_SIZE + 1, filename: '大图.png' }),
        imageAttachment({ id: 'att-doc', localPath: 'conversation-1/doc.pdf', mediaType: 'application/pdf', filename: '文档.pdf' }),
      ],
    })

    const content = request?.chatRequest.messages[0]?.content
    // F3e 起文档附件也进入请求：无解析依赖时按提示降级，不再静默跳过。
    expect(content).toEqual([
      { type: 'text', text: '看附件' },
      { type: 'text', text: '（图片附件 截图.png 未能随消息发送）' },
      { type: 'text', text: '（图片附件 大图.png 未能随消息发送）' },
      { type: 'text', text: '（文档附件 文档.pdf 未能随消息发送）' },
    ])
  })
})

describe('ChatService 文档附件进入请求', () => {
  function documentAttachment(overrides: Record<string, unknown> = {}): {
    id: string; filename: string; mediaType: string; localPath: string; size: number; createdAt: number
  } {
    return {
      id: 'att-doc',
      filename: '说明.md',
      mediaType: 'text/markdown',
      localPath: 'conversation-1/att-doc.md',
      size: 128,
      createdAt: 900,
      ...overrides,
    }
  }

  test('文档附件以 file 块注入历史，解析失败降级为提示', async () => {
    const conversationId = createConversation()
    let request: ProviderStreamRequest | undefined
    const service = createService((input) => {
      if (input.chatRequest.systemPrompt?.startsWith('请为这段对话生成')) return eventsStream([])
      request = input
      return eventsStream([{ type: 'text_delta', delta: '收到' }, { type: 'finish', reason: 'stop' }])
    })
    const serviceWithParser = new ChatService({
      channelManager: { resolve: () => resolvedChannel() },
      conversationManager: conversations,
      userAgent: 'Axon/0.1.0',
      stream: (input) => {
        if (input.chatRequest.systemPrompt?.startsWith('请为这段对话生成')) return eventsStream([])
        request = input
        return eventsStream([{ type: 'text_delta', delta: '已读' }, { type: 'finish', reason: 'stop' }])
      },
      extractDocumentText: async (attachment) => attachment.filename.endsWith('.md') ? '# 文档正文' : undefined,
      createId: () => `chat-${idValue++}`,
      now: () => nowValue++,
    })

    await serviceWithParser.sendMessage({
      conversationId,
      text: '读文档',
      attachments: [documentAttachment(), documentAttachment({ id: 'att-fail', filename: '丢失.pdf', localPath: 'conversation-1/lost.pdf' })],
    })

    expect(request?.chatRequest.messages[0]?.content).toEqual([
      { type: 'text', text: '读文档' },
      { type: 'text', text: '<file name="说明.md">\n# 文档正文\n</file>' },
      { type: 'text', text: '（文档附件 丢失.pdf 未能随消息发送）' },
    ])

    // 无解析依赖时同样按提示降级，不中断主生成。
    await service.sendMessage({ conversationId, text: '再读', attachments: [documentAttachment({ id: 'att-none' })] })
    expect(JSON.stringify(request?.chatRequest.messages.at(-1)?.content)).toContain('未能随消息发送')
  })
})

describe('ChatService 自动标题', () => {
  const TITLE_PROMPT_PREFIX = '请为这段对话生成一个不超过 20 个字'

  async function waitForCondition(check: () => boolean, timeoutMs = 1_000): Promise<void> {
    const started = Date.now()
    while (!check()) {
      if (Date.now() - started > timeoutMs) throw new Error('等待标题生成超时')
      await new Promise((resolve) => setTimeout(resolve, 5))
    }
  }

  test('首轮完整生成后自动生成标题：清洗引号空白并广播 title 事件', async () => {
    const conversationId = createConversation()
    const emitted: ChatGenerationEvent[] = []
    const calls: ProviderStreamRequest[] = []
    const service = createService(async function* (input) {
      calls.push(input)
      if (input.chatRequest.systemPrompt?.startsWith(TITLE_PROMPT_PREFIX)) {
        yield { type: 'text_delta', delta: ' 「Axiom 天气问答」\n' }
        yield { type: 'finish', reason: 'stop' }
        return
      }
      yield { type: 'text_delta', delta: '今天晴' }
      yield { type: 'finish', reason: 'stop' }
    }, emitted)

    const assistant = await service.sendMessage({ conversationId, text: '今天天气怎么样' })
    expect(assistant.status).toBe('complete')
    await waitForCondition(() => conversations.get(conversationId)?.title === 'Axiom 天气问答')

    expect(calls).toHaveLength(2)
    const titleRequest = calls[1]
    expect(titleRequest?.chatRequest.systemPrompt).toContain('不超过 20 个字')
    expect(titleRequest?.chatRequest.maxOutputTokens).toBe(64)
    expect(JSON.stringify(titleRequest?.chatRequest.messages)).toContain('今天天气怎么样')
    expect(JSON.stringify(titleRequest?.chatRequest.messages)).toContain('今天晴')
    expect(emitted.at(-1)).toMatchObject({ type: 'title', conversationId, title: 'Axiom 天气问答' })

    // 已有标题后不再生成：第二轮只有一个主请求。
    const before = calls.length
    await service.sendMessage({ conversationId, text: '再问一次' })
    await new Promise((resolve) => setTimeout(resolve, 20))
    expect(calls.length).toBe(before + 1)
  })

  test('标题请求失败静默放弃，不影响已完成的生成结果', async () => {
    const conversationId = createConversation()
    const emitted: ChatGenerationEvent[] = []
    const service = createService(async function* (input) {
      if (input.chatRequest.systemPrompt?.startsWith(TITLE_PROMPT_PREFIX)) {
        throw new Error('secret title failure')
      }
      yield { type: 'text_delta', delta: '回答' }
      yield { type: 'finish', reason: 'stop' }
    }, emitted)

    const assistant = await service.sendMessage({ conversationId, text: '问题' })
    expect(assistant.status).toBe('complete')
    await new Promise((resolve) => setTimeout(resolve, 20))
    expect(conversations.get(conversationId)?.title).toBe('新对话')
    expect(emitted.some((event) => event.type === 'title')).toBe(false)
    // 失败细节不进入事件流。
    expect(JSON.stringify(emitted)).not.toContain('secret title failure')
  })

  test('标题生成期间用户手动改名时让位，不覆盖用户命名', async () => {
    const conversationId = createConversation()
    const service = createService(async function* (input) {
      if (input.chatRequest.systemPrompt?.startsWith(TITLE_PROMPT_PREFIX)) {
        // 模拟标题生成期间用户完成手动重命名。
        conversations.update(conversationId, { title: '用户手动命名' })
        yield { type: 'text_delta', delta: '自动标题' }
        yield { type: 'finish', reason: 'stop' }
        return
      }
      yield { type: 'text_delta', delta: '回答' }
      yield { type: 'finish', reason: 'stop' }
    })

    await service.sendMessage({ conversationId, text: '问题' })
    await waitForCondition(() => conversations.get(conversationId)?.title === '用户手动命名')
    await new Promise((resolve) => setTimeout(resolve, 20))
    expect(conversations.get(conversationId)?.title).toBe('用户手动命名')
  })
})
