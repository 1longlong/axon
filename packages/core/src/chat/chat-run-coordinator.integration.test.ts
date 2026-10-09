import { afterEach, describe, expect, test } from 'bun:test'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type { AgentProviderAdapter, ChatGenerationEvent, ChatGenerationIdentityEvent } from '@axon/shared'
import { createBackend, createBackendPaths } from '../index'
import type { AxonBackend, BackendOptions, ChatStreamExecutor, ProviderStreamRequest } from '../index'
import { createFixtureCredentialCodec } from '../../test-support/credential-codec'

const directories: string[] = []
const backends: AxonBackend[] = []
afterEach(() => {
  for (const backend of backends.splice(0)) backend.dispose()
  for (const directory of directories.splice(0)) rmSync(directory, { recursive: true, force: true })
})

function deferred<T>() {
  let resolve: (value: T) => void = () => {}
  const promise = new Promise<T>((finish) => { resolve = finish })
  return { promise, resolve }
}

/** 使用真实工厂与 JSONL；只替换 Provider 传输，Chat 不进入 Agent adapter。 */
async function open(stream: ChatStreamExecutor, options: Partial<BackendOptions> = {}) {
  const directory = mkdtempSync(join(tmpdir(), 'axon-chat-coordinator-'))
  directories.push(directory)
  const adapter: AgentProviderAdapter = {
    query: async function* () { throw new Error('Chat 不应调用 Agent adapter') },
    abort: () => {}, dispose: () => {}, drain: async () => {},
  }
  const backend = createBackend({ paths: createBackendPaths({ dataDir: join(directory, 'data'), homeDir: directory }),
    applicationVersion: '0.1.3', credentialCodec: createFixtureCredentialCodec(),
    resolveAdapter: () => adapter, providerStream: stream, ...options,
  })
  backends.push(backend)
  const channel = await backend.channels.create({ name: '隔离渠道', provider: 'openai', baseUrl: 'https://example.test/v1',
    apiKey: 'fixture-secret', models: [{ id: 'fixture-model', name: '夹具模型', enabled: true }] })
  const conversation = backend.conversations.create({ title: '命名会话', channelId: channel.id, modelId: 'fixture-model' })
  const owner = backend.clients.register()
  const other = backend.clients.register()
  return { backend, conversation, owner, other }
}

describe('真实后端 Chat 协调与共享历史', () => {
  test('控制身份先于凭据等待；精确停止预检发出结束身份，不产生消息历史，正常生成同样闭合', async () => {
    const codec = createFixtureCredentialCodec(), ready = deferred<void>(), decrypt = deferred<void>()
    const events: ChatGenerationEvent[] = [], identities: ChatGenerationIdentityEvent[] = []
    let requests = 0
    const { backend, conversation, owner } = await open(async function* () {
      requests += 1
      yield { type: 'text_delta', delta: '正常回答' }
      yield { type: 'finish', reason: 'stop' }
    }, { credentialCodec: { ...codec, decrypt: async (value) => { ready.resolve(); await decrypt.promise; return await codec.decrypt(value) } } })
    const sending = backend.chatRuns.send(owner, { conversationId: conversation.id, text: '预检取消' }, (event) => events.push(event),
      undefined, (event) => identities.push(event))
    await ready.promise
    expect(identities).toHaveLength(1)
    expect(identities[0]?.phase).toBe('started')
    expect(identities[0]?.generation).toEqual(backend.chatRuns.getOwnedGeneration(owner, conversation.id)!)
    expect(events).toEqual([])
    expect(backend.chatRuns.stopGeneration(owner, identities[0]!.generation)).toBe(true)
    expect(await sending).toMatchObject({ success: false, code: 'cancelled' })
    expect(identities).toEqual([identities[0]!, { ...identities[0]!, phase: 'finished' }])
    expect(backend.conversations.getMessages(conversation.id)).toEqual([])
    expect(requests).toBe(0)
    decrypt.resolve()
    const order: string[] = []
    expect(await backend.chatRuns.send(owner, { conversationId: conversation.id, text: '正常输入' },
      (event) => { if (event.type !== 'stream') order.push(event.type) }, undefined,
      (event) => { identities.push(event); order.push(`identity:${event.phase}`) })).toMatchObject({ success: true })
    expect(order).toEqual(['identity:started', 'started', 'completed', 'identity:finished'])
    expect(identities[2]?.generation.generationId).not.toBe(identities[0]?.generation.generationId)
    expect(backend.conversations.getMessages(conversation.id)).toHaveLength(2)
    expect(await backend.chatRuns.send(owner, { conversationId: conversation.id, text: '身份投递时立即停止' }, () => {}, undefined,
      (event) => { if (event.phase === 'started') backend.chatRuns.stopGeneration(owner, event.generation) }))
      .toMatchObject({ success: false, code: 'cancelled' })
    expect(requests).toBe(1)
    expect(backend.conversations.getMessages(conversation.id)).toHaveLength(2)
  })

  test('两个入口共享 JSONL，快捷来源与附件保留，未登记或自报身份在落盘前拒绝', async () => {
    const requests: ProviderStreamRequest[] = []
    const { backend, conversation, owner, other } = await open(async function* (input) {
      requests.push(input)
      yield { type: 'text_delta', delta: '回答' }
      yield { type: 'finish', reason: 'stop' }
    })
    backend.settings.update({ agentSystemPrompt: '只属于 Agent 的系统规则' })
    const input = { conversationId: conversation.id, text: '输入' }
    expect(await backend.chatRuns.send('未登记', input, () => {})).toMatchObject({ success: false, code: 'invalid_input' })
    expect(await backend.chatRuns.send(owner, { ...input, owner: other }, () => {})).toMatchObject({ success: false, code: 'invalid_input' })
    expect(backend.conversations.getMessages(conversation.id)).toEqual([])
    expect(backend.attachmentController.save({ conversationId: conversation.id, filename: '说明.md', mediaType: 'text/markdown',
      data: '不可接受', owner })).toMatchObject({ success: false, code: 'invalid_input' })
    const saved = backend.attachmentController.save({ conversationId: conversation.id, filename: '说明.md', mediaType: 'text/markdown',
      data: Buffer.from('附件正文').toString('base64') })
    expect(saved.success).toBe(true)
    if (!saved.success) throw new Error(saved.message)
    const attachment = saved.attachment
    const firstEvents: ChatGenerationEvent[] = []
    const secondEvents: ChatGenerationEvent[] = []
    expect(await backend.chatRuns.send(owner, { ...input, text: '快捷输入', attachments: [attachment] },
      (event) => { firstEvents.push(event) }, 'quick')).toMatchObject({ success: true })
    const firstCount = firstEvents.length
    expect(await backend.chatRuns.send(other, { ...input, text: '桌面输入' }, (event) => { secondEvents.push(event) }))
      .toMatchObject({ success: true })
    expect(firstEvents).toHaveLength(firstCount)
    expect(secondEvents[0]?.type).toBe('started')
    const history = backend.conversations.getMessages(conversation.id)
    expect(history).toHaveLength(4)
    expect(history[0]).toMatchObject({ inputOrigin: 'quick', attachments: [attachment] })
    expect(history[2]).not.toHaveProperty('inputOrigin')
    expect(requests).toHaveLength(2)
    expect(requests[1]!.chatRequest.messages).toHaveLength(3)
    expect(JSON.stringify(requests[1]!.chatRequest.messages)).toContain('附件正文')
    expect(requests.every((request) => request.chatRequest.systemPrompt === undefined)).toBe(true)
    backend.dispose()
    expect(await backend.chatRuns.send(owner, input, () => {})).toMatchObject({ success: false, code: 'invalid_input' })
    expect(backend.conversations.getMessages(conversation.id)).toEqual(history)
  })

  test('凭据等待期可精确停止和断开；迟到解密不写半轮消息，新身份随后能正常发送', async () => {
    const codec = createFixtureCredentialCodec()
    const decryptReady = deferred<void>()
    const finishDecrypt = deferred<void>()
    let requests = 0
    const { backend, conversation, owner, other } = await open(async function* () {
      requests += 1
      yield { type: 'text_delta', delta: '新轮回复' }
      yield { type: 'finish', reason: 'stop' }
    }, { credentialCodec: { ...codec, decrypt: async (value) => {
      decryptReady.resolve()
      await finishDecrypt.promise
      return await codec.decrypt(value)
    } } })
    const send = backend.chatRuns.send(owner, { conversationId: conversation.id, text: '不能迟到发送' }, () => {})
    await decryptReady.promise
    const run = backend.chatRuns.getOwnedGeneration(owner, conversation.id)!
    expect(run).toEqual(backend.chat.getActiveGeneration(conversation.id)!)
    expect(backend.chatRuns.stopGeneration(other, run)).toBe(false)
    expect(backend.chatRuns.stopGeneration(owner, { ...run, generationId: '旧轮' })).toBe(false)
    expect(backend.chatRuns.stopGeneration(owner, { conversationId: conversation.id })).toBe(false)
    expect(await backend.chatRuns.send(other, { conversationId: conversation.id, text: '不能抢占' }, () => {}))
      .toMatchObject({ success: false, code: 'already_active' })
    backend.clients.detach(owner)
    expect(await send).toMatchObject({ success: false, code: 'cancelled' })
    finishDecrypt.resolve()
    await Promise.resolve()
    expect(requests).toBe(0)
    expect(backend.conversations.getMessages(conversation.id)).toEqual([])
    const reloaded = backend.clients.register()
    expect(await backend.chatRuns.send(reloaded, { conversationId: conversation.id, text: '新页面输入' }, () => {}))
      .toMatchObject({ success: true })
    expect(requests).toBe(1)
    expect(backend.chatRuns.stopGeneration(owner, run)).toBe(false)
    expect(backend.conversations.getMessages(conversation.id)).toHaveLength(2)
  })

  test('断开后忽略不配合取消的传输数据，只保存已接收局部正文，不再投递旧窗口', async () => {
    const ready = deferred<void>()
    const finish = deferred<void>()
    const requests: ProviderStreamRequest[] = []
    const { backend, conversation, owner, other } = await open(async function* (input) {
      requests.push(input)
      if (requests.length === 1) {
        yield { type: 'text_delta', delta: '已接收' }
        ready.resolve()
        await finish.promise
        yield { type: 'text_delta', delta: '取消后迟到' }
      } else yield { type: 'text_delta', delta: '下一轮回复' }
      yield { type: 'finish', reason: 'stop' }
    })
    const received: ChatGenerationEvent[] = []
    const send = backend.chatRuns.send(owner, { conversationId: conversation.id, text: '第一轮' }, (event) => { received.push(event) })
    await ready.promise
    const before = received.length
    backend.clients.detach(owner)
    finish.resolve()
    expect(await send).toMatchObject({ success: false, code: 'cancelled' })
    expect(received).toHaveLength(before)
    expect(backend.conversations.getMessages(conversation.id).at(-1)).toMatchObject({
      status: 'stopped', content: [{ type: 'text', text: '已接收' }],
    })
    expect(JSON.stringify(backend.conversations.getMessages(conversation.id))).not.toContain('取消后迟到')
    expect(await backend.chatRuns.send(other, { conversationId: conversation.id, text: '第二轮' }, () => {})).toMatchObject({ success: true })
    expect(JSON.stringify(requests[1]!.chatRequest.messages)).not.toContain('已接收')
    expect(backend.chatRuns.getOwnedGeneration(other, conversation.id)).toBeUndefined()
  })

  test('旧 generationId 不停止新轮，真正停止保留唯一 stopped 终态', async () => {
    const ready = deferred<void>()
    const finish = deferred<void>()
    let count = 0
    const { backend, conversation, owner, other } = await open(async function* () {
      count += 1
      if (count === 2) { ready.resolve(); await finish.promise }
      yield { type: 'text_delta', delta: '回复' }
      yield { type: 'finish', reason: 'stop' }
    })
    let firstId: string | undefined
    await backend.chatRuns.send(owner, { conversationId: conversation.id, text: '第一轮' }, (event) => {
      if (event.type === 'started') firstId = event.generationId
    })
    const events: ChatGenerationEvent[] = []
    const send = backend.chatRuns.send(owner, { conversationId: conversation.id, text: '第二轮' }, (event) => { events.push(event) })
    await ready.promise
    const current = backend.chatRuns.getOwnedGeneration(owner, conversation.id)!
    expect(current.generationId).not.toBe(firstId)
    expect(backend.chatRuns.stopGeneration(owner, { ...current, generationId: firstId })).toBe(false)
    expect(backend.chatRuns.stopGeneration(other, current)).toBe(false)
    expect(backend.chatRuns.stopGeneration(owner, current)).toBe(true)
    finish.resolve()
    expect(await send).toMatchObject({ success: false, code: 'cancelled' })
    expect(events.filter((event) => event.type === 'stopped')).toHaveLength(1)
    expect(events.filter((event) => event.type === 'completed')).toHaveLength(0)
    expect(backend.conversations.getMessages(conversation.id)).toHaveLength(4)
  })

  test('标题晚于发送链返回仍能投递，标题事件前索引已保存', async () => {
    const titleReady = deferred<void>()
    const finishTitle = deferred<void>()
    const titleDelivered = deferred<void>()
    const { backend, conversation, owner } = await open(async function* (input) {
      if (input.chatRequest.systemPrompt) {
        titleReady.resolve()
        await finishTitle.promise
        yield { type: 'text_delta', delta: '自动标题' }
      } else yield { type: 'text_delta', delta: '普通回复' }
      yield { type: 'finish', reason: 'stop' }
    })
    backend.conversations.update(conversation.id, { title: '新对话' })
    let titleAtEvent: string | undefined
    expect(await backend.chatRuns.send(owner, { conversationId: conversation.id, text: '请解释' }, (event) => {
      if (event.type === 'title') {
        titleAtEvent = backend.conversations.get(conversation.id)?.title
        titleDelivered.resolve()
      }
    })).toMatchObject({ success: true })
    await titleReady.promise
    expect(backend.chatRuns.getOwnedGeneration(owner, conversation.id)).toBeUndefined()
    finishTitle.resolve()
    await titleDelivered.promise
    expect(titleAtEvent).toBe('自动标题')
    expect(backend.conversations.getMessages(conversation.id)).toHaveLength(2)
  })
})
