import { afterEach, describe, expect, test } from 'bun:test'
import { existsSync, mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { PassThrough } from 'node:stream'
import { createBackend, createBackendPaths, createCredentialCodec } from '@axon/core'
import type { AxonBackend, BackendOptions, ChatStreamExecutor, ProviderStreamRequest } from '@axon/core'
import { APP_SERVER_METHODS as methods, APP_SERVER_NOTIFICATIONS as notices, APP_SERVER_RPC_OPTIONS } from '@axon/shared'
import type { AppServerClient, AppServerChatGenerationEvent, AppServerChatGenerationIdentityEvent, ConversationMeta, AttachmentSaveResult, RpcJsonObject, RpcJsonValue } from '@axon/shared'
import { AppServerConnection, JsonRpcPeer } from './index'
import { toWireValue } from './wire-value'
import { createFixtureCredentialCodec } from '../../core/test-support/credential-codec'

const cleanups: Array<() => void> = []
afterEach(() => { for (const cleanup of cleanups.splice(0).reverse()) cleanup() })

/** 实际 Chat/附件/存储走协议，只注入 Provider 夹具；不调用 Agent SDK 或正式目录。 */
async function open(stream: ChatStreamExecutor = async function* () {
  yield { type: 'text_delta', delta: '回答' }
  yield { type: 'finish', reason: 'stop' }
}, codec: BackendOptions['credentialCodec'] = createCredentialCodec()) {
  const directory = mkdtempSync(join(tmpdir(), 'axon-chat-rpc-'))
  const upstream = new PassThrough()
  const downstream = new PassThrough()
  const parent = new JsonRpcPeer(downstream, upstream, { ...APP_SERVER_RPC_OPTIONS, requestTimeoutMs: 2_000 })
  const child = new JsonRpcPeer(upstream, downstream, { ...APP_SERVER_RPC_OPTIONS, requestTimeoutMs: 2_000 })
  let backend: AxonBackend
  const connection = new AppServerConnection({ peer: child, bootstrap: () => {
    backend = createBackend({ paths: createBackendPaths({ dataDir: join(directory, 'data'), homeDir: directory }),
      applicationVersion: '0.1.3', credentialCodec: codec,
      resolveAdapter: () => ({ async *query() { throw new Error('Chat 不得调用 Agent adapter') }, abort() {}, dispose() {}, async drain() {} }),
      providerStream: stream,
    })
    return { backend, applicationVersion: '0.1.3', capabilities: {
      runtimes: [], credentialStorage: codec.storageKind, channelTargetConfirmation: false,
    } }
  } })
  cleanups.push(() => { connection.close(); parent.close(); upstream.destroy(); downstream.destroy(); rmSync(directory, { recursive: true, force: true }) })
  await parent.request(methods.INITIALIZE, { protocolVersion: 1, client: { name: 'axon-test', version: '0.1.3' },
    hostCapabilities: { credentialStorage: codec.storageKind, channelTargetConfirmation: false } })
  const main = await parent.request(methods.REGISTER_CLIENT, { kind: 'main' }) as unknown as AppServerClient
  const quick = await parent.request(methods.REGISTER_CLIENT, { kind: 'quick' }) as unknown as AppServerClient
  const channel = await backend!.channels.create({ name: '隔离渠道', provider: 'openai', apiKey: codec.isSecure ? 'fixture-secret' : '',
    baseUrl: 'https://example.test/v1', models: [{ id: 'fixture-model', name: '模型', enabled: true }] })
  const packets: AppServerChatGenerationEvent[] = []
  const identities: AppServerChatGenerationIdentityEvent[] = []
  parent.handleNotification(notices.CHAT_GENERATION_IDENTITY, (params) => { identities.push(params as unknown as AppServerChatGenerationIdentityEvent) })
  const persisted: boolean[] = []
  let onEvent = (_packet: AppServerChatGenerationEvent): void => {}
  parent.handleNotification(notices.CHAT_GENERATION, (params) => {
    const packet = params as unknown as AppServerChatGenerationEvent
    packets.push(packet)
    const event = packet.event
    if (event.type === 'started' || ['completed', 'stopped', 'failed'].includes(event.type)) {
      const id = event.type === 'started' ? event.userMessage.id : 'message' in event ? event.message.id : undefined
      persisted.push(backend!.conversations.getMessages(event.conversationId).some((message) => message.id === id))
    }
    onEvent(packet)
  })
  const request = (method: string, input?: RpcJsonValue, client = main, signal?: AbortSignal) => parent.request(method,
    { clientId: client.clientId, ...(input === undefined ? {} : { input }) }, { timeoutMs: 0, signal })
  const create = async (title = '固定标题') => await request(methods.CHAT_CREATE_CONVERSATION, {
    title, channelId: channel.id, modelId: 'fixture-model',
  }) as unknown as ConversationMeta
  return { parent, child, backend: backend!, main, quick, request, create, packets, persisted, identities,
    listen(listener: typeof onEvent) { onEvent = listener } }
}

describe('Chat 应用协议', () => {
  test('真实控制身份定向原入口且不进入历史，预检失败也闭合，不广播观察者', async () => {
    const f = await open(), conversation = await f.create()
    expect(await f.request(methods.CHAT_SEND, { conversationId: conversation.id, text: 'hi' }, f.quick)).toMatchObject({ success: true })
    expect(f.identities).toHaveLength(2)
    const first = f.identities[0]!
    expect(first).toMatchObject({ clientId: f.quick.clientId, event: { phase: 'started', generation: { conversationId: conversation.id } } })
    expect(f.identities[1]).toEqual({ ...first, event: { ...first.event, phase: 'finished' } })
    expect(f.packets.find((packet) => packet.event.type === 'started')?.event).toMatchObject({ generationId: first.event.generation.generationId })
    expect(f.backend.conversations.getMessages(conversation.id)).toHaveLength(2)
    const unconfigured = await f.request(methods.CHAT_CREATE_CONVERSATION, { title: '无渠道' }) as unknown as ConversationMeta
    expect(await f.request(methods.CHAT_SEND, { conversationId: unconfigured.id, text: '不会落盘' })).toMatchObject({ success: false })
    expect(f.identities.slice(2).map((packet) => [packet.clientId, packet.event.phase])).toEqual([[f.main.clientId, 'started'], [f.main.clientId, 'finished']])
    expect(f.backend.conversations.getMessages(unconfigured.id)).toEqual([])
  })

  test('CRUD 与连接归属；拒绝额外 owner/提示词/摘要修改，不产生半轮历史', async () => {
    const f = await open()
    const conversation = await f.create()
    expect(await f.request(methods.CHAT_LIST_CONVERSATIONS)).toEqual(toWireValue([conversation]))
    expect(await f.request(methods.CHAT_GET_CONVERSATION, conversation.id)).toEqual(toWireValue(conversation))
    expect(await f.request(methods.CHAT_UPDATE_CONVERSATION, { conversationId: conversation.id, update: { title: '修改标题' } }))
      .toMatchObject({ title: '修改标题' })
    await expect(f.parent.request(methods.CHAT_GET_CONVERSATION, { clientId: f.main.clientId, input: conversation.id, owner: f.quick.clientId }))
      .rejects.toMatchObject({ code: -32602 })
    const foreign = f.backend.clients.register()
    await expect(f.parent.request(methods.CHAT_LIST_CONVERSATIONS, { clientId: foreign })).rejects.toMatchObject({ code: -32004 })
    await expect(f.request(methods.CHAT_UPDATE_CONVERSATION, { conversationId: conversation.id, update: { contextSummary: null } }))
      .rejects.toMatchObject({ code: -32021, data: { code: 'invalid_input' } })
    expect(await f.request(methods.CHAT_SEND, { conversationId: conversation.id, text: '伪造', systemPrompt: '提示词' }))
      .toMatchObject({ success: false, code: 'invalid_input' })
    expect(f.backend.conversations.getMessages(conversation.id)).toEqual([])
    expect(await f.request(methods.CHAT_DELETE_CONVERSATION, conversation.id)).toMatchObject({ id: conversation.id })
    expect(await f.request(methods.CHAT_GET_CONVERSATION, conversation.id)).toBeNull()
  })

  test('主/快捷共享历史、来源与 Provider 上下文；完整消息先保存再通知，Chat 不使用 Agent 提示词', async () => {
    const requests: ProviderStreamRequest[] = []
    const f = await open(async function* (request) {
      requests.push(request)
      yield { type: 'reasoning_start', blockId: 'thinking' }
      yield { type: 'reasoning_delta', blockId: 'thinking', delta: '思考' }
      yield { type: 'reasoning_end', blockId: 'thinking' }
      yield { type: 'text_delta', delta: '回复' }
      yield { type: 'finish', reason: 'stop' }
    })
    const conversation = await f.create()
    f.backend.settings.update({ agentSystemPrompt: '只供 Agent 使用' })
    expect(await f.request(methods.CHAT_SEND, { conversationId: conversation.id, text: '快捷输入' }, f.quick)).toMatchObject({ success: true })
    expect(await f.request(methods.CHAT_SEND, { conversationId: conversation.id, text: '主入口输入' })).toMatchObject({ success: true })
    expect(requests).toHaveLength(2)
    expect(requests[1]!.chatRequest.messages).toHaveLength(3)
    expect(requests.every((request) => request.chatRequest.systemPrompt === undefined)).toBe(true)
    const history = f.backend.conversations.getMessages(conversation.id)
    expect(history).toHaveLength(4)
    expect(history[0]).toMatchObject({ inputOrigin: 'quick' })
    expect(history[2]).not.toHaveProperty('inputOrigin')
    expect(f.persisted).toEqual([true, true, true, true])
    const starts = f.packets.filter((packet) => packet.event.type === 'started')
    expect(starts.map((packet) => packet.clientId)).toEqual([f.quick.clientId, f.main.clientId])
    const ids = starts.map((packet) => 'generationId' in packet.event ? packet.event.generationId : '')
    expect(ids[0]).not.toBe(ids[1])
    expect(f.packets.filter((packet) => packet.event.type === 'stream' && packet.event.event.type === 'reasoning_delta')).toHaveLength(2)
  })

  test('协议保存/读取实际附件，摘要只覆盖模型上下文，原始历史与附件均保留', async () => {
    const requests: ProviderStreamRequest[] = []
    const f = await open(async function* (request) { requests.push(request); yield { type: 'text_delta', delta: '回复' }; yield { type: 'finish', reason: 'stop' } })
    const conversation = await f.create()
    const saved = await f.request(methods.ATTACHMENT_SAVE, { conversationId: conversation.id, filename: '说明.md', mediaType: 'text/markdown',
      data: Buffer.from('附件正文').toString('base64') }) as unknown as AttachmentSaveResult
    if (!saved.success) throw new Error(saved.message)
    expect(existsSync(join(f.backend.paths.attachmentsDir, saved.attachment.localPath))).toBe(true)
    await f.request(methods.CHAT_SEND, { conversationId: conversation.id, text: '第一轮', attachments: toWireValue([saved.attachment]) })
    const oldHistory = f.backend.conversations.getMessages(conversation.id)
    f.backend.conversations.update(conversation.id, { contextSummary: { text: '历史摘要',
      coveredMessageIds: oldHistory.map((message) => message.id), updatedAt: Date.now() } })
    await f.request(methods.CHAT_SEND, { conversationId: conversation.id, text: '继续' })
    expect(JSON.stringify(requests[0]!.chatRequest.messages)).toContain('附件正文')
    expect(requests[1]!.chatRequest.systemPrompt).toContain('历史摘要')
    expect(requests[1]!.chatRequest.messages).toHaveLength(1)
    expect(f.backend.conversations.getMessages(conversation.id).slice(0, 2)).toEqual(oldHistory)
    await f.request(methods.CHAT_DELETE_CONVERSATION, conversation.id)
    expect(existsSync(join(f.backend.paths.attachmentsDir, saved.attachment.localPath))).toBe(false)
  })

  test('大附件经应用参数分段保存，坏字段/base64/路径被 controller 拒绝', async () => {
    const f = await open()
    const conversation = await f.create()
    const data = Buffer.alloc(2 * 1024 * 1024, 0x61)
    const saved = await f.request(methods.ATTACHMENT_SAVE, { conversationId: conversation.id, filename: 'large.bin', mediaType: 'application/octet-stream',
      data: data.toString('base64') }) as unknown as AttachmentSaveResult
    if (!saved.success) throw new Error(saved.message)
    expect(saved.attachment.size).toBe(data.length)
    expect(f.backend.attachments.readAsBase64(saved.attachment.localPath)).toBe(data.toString('base64'))
    expect(await f.request(methods.ATTACHMENT_SAVE, { conversationId: conversation.id, filename: 'bad.bin', mediaType: 'application/octet-stream',
      data: 'bad-base64', owner: f.quick.clientId })).toMatchObject({ success: false, code: 'invalid_input' })
    expect(await f.request(methods.ATTACHMENT_SAVE, { conversationId: conversation.id, filename: 'bad.bin', mediaType: 'application/octet-stream',
      data: 'bad-base64' })).toMatchObject({ success: false, code: 'invalid_input' })
    expect(await f.request(methods.ATTACHMENT_SAVE, { conversationId: '../outside', filename: 'bad.bin', mediaType: 'application/octet-stream',
      data: '' })).toMatchObject({ success: false })
  })

  test('生成等待期间可查真实轮次/停止，跨入口和旧轮拒绝；取消后迟到数据不保存', async () => {
    const ready = Promise.withResolvers<void>()
    const gate = Promise.withResolvers<void>()
    const f = await open(async function* () {
      yield { type: 'text_delta', delta: '已接收' }
      ready.resolve()
      await gate.promise
      yield { type: 'text_delta', delta: '迟到数据' }
      yield { type: 'finish', reason: 'stop' }
    })
    const conversation = await f.create()
    const running = f.request(methods.CHAT_SEND, { conversationId: conversation.id, text: '生成' })
    await ready.promise
    const target = await f.request(methods.CHAT_GET_GENERATION, conversation.id) as RpcJsonObject
    expect(await f.request(methods.CHAT_GET_GENERATION, conversation.id, f.quick)).toBeNull()
    expect(await f.request(methods.CHAT_SEND, { conversationId: conversation.id, text: '抢占' }, f.quick)).toMatchObject({ code: 'already_active' })
    expect(await f.request(methods.CHAT_STOP, target, f.quick)).toBe(false)
    expect(await f.request(methods.CHAT_STOP, { ...target, generationId: 'old' })).toBe(false)
    expect(await f.request(methods.CHAT_STOP, target)).toBe(true)
    gate.resolve()
    expect(await running).toMatchObject({ success: false, code: 'cancelled' })
    const history = f.backend.conversations.getMessages(conversation.id)
    expect(history).toHaveLength(2)
    expect(history[1]).toMatchObject({ status: 'stopped', content: [{ type: 'text', text: '已接收' }] })
    expect(JSON.stringify(history)).not.toContain('迟到数据')
    expect(f.packets.filter((packet) => packet.event.type === 'stopped')).toHaveLength(1)
    expect(await f.request(methods.CHAT_GET_GENERATION, conversation.id)).toBeNull()
  })

  test('凭据预检期间注销入口，迟到解密不联网/不保存半轮；新入口能正常发送', async () => {
    const codec = createFixtureCredentialCodec()
    const ready = Promise.withResolvers<void>()
    const gate = Promise.withResolvers<void>()
    let calls = 0
    const f = await open(async function* () { calls += 1; yield { type: 'text_delta', delta: '回复' }; yield { type: 'finish', reason: 'stop' } }, {
      ...codec, decrypt: async (value) => { ready.resolve(); await gate.promise; return codec.decrypt(value) },
    })
    const conversation = await f.create()
    const running = f.request(methods.CHAT_SEND, { conversationId: conversation.id, text: '不能迟到' })
    await ready.promise
    expect(await f.request(methods.CHAT_GET_GENERATION, conversation.id)).toHaveProperty('generationId')
    await f.parent.request(methods.DETACH_CLIENT, { clientId: f.main.clientId })
    expect(await running).toMatchObject({ success: false, code: 'cancelled' })
    gate.resolve()
    expect(calls).toBe(0)
    expect(f.backend.conversations.getMessages(conversation.id)).toEqual([])
    await f.request(methods.CHAT_SEND, { conversationId: conversation.id, text: '新入口' }, f.quick)
    expect(calls).toBe(1)
  })

  test('取消发送 RPC 不重投 prompt，不代替精确停止；原运行仅执行一次', async () => {
    const ready = Promise.withResolvers<void>()
    const gate = Promise.withResolvers<void>()
    let calls = 0
    const f = await open(async function* () { calls += 1; ready.resolve(); await gate.promise; yield { type: 'finish', reason: 'stop' } })
    const conversation = await f.create()
    const controller = new AbortController()
    const running = f.request(methods.CHAT_SEND, { conversationId: conversation.id, text: '仅一次' }, f.main, controller.signal)
    const rejected = running.catch((error: unknown) => error)
    await ready.promise
    controller.abort()
    expect(await rejected).toMatchObject({ code: 'canceled' })
    const run = await f.request(methods.CHAT_GET_GENERATION, conversation.id) as RpcJsonObject
    const settled = Promise.withResolvers<void>()
    f.listen((packet) => { if (packet.event.type === 'stopped') settled.resolve() })
    expect(await f.request(methods.CHAT_STOP, run)).toBe(true)
    gate.resolve()
    await settled.promise
    expect(calls).toBe(1)
    expect(f.backend.conversations.getMessages(conversation.id).filter((message) => message.role === 'user')).toHaveLength(1)
  })

  test('晚到标题沿用原入口且索引先保存；已注销入口不收到迟到通知', async () => {
    for (const detach of [false, true]) {
      const titleReady = Promise.withResolvers<void>()
      const gate = Promise.withResolvers<void>()
      const delivered = Promise.withResolvers<void>()
      const f = await open(async function* (request) {
        if (request.chatRequest.systemPrompt) { titleReady.resolve(); await gate.promise; yield { type: 'text_delta', delta: '自动标题' } }
        else yield { type: 'text_delta', delta: '回答' }
        yield { type: 'finish', reason: 'stop' }
      })
      const conversation = await f.create('新对话')
      f.listen((packet) => { if (packet.event.type === 'title') {
        expect(packet.clientId).toBe(f.main.clientId)
        expect(f.backend.conversations.get(conversation.id)?.title).toBe('自动标题')
        delivered.resolve()
      } })
      await f.request(methods.CHAT_SEND, { conversationId: conversation.id, text: '请求标题' })
      await titleReady.promise
      const before = f.packets.length
      if (detach) await f.parent.request(methods.DETACH_CLIENT, { clientId: f.main.clientId })
      gate.resolve()
      if (!detach) await delivered.promise
      else { await Bun.sleep(0); expect(f.packets).toHaveLength(before) }
      expect(f.packets.some((packet) => packet.clientId === f.quick.clientId)).toBe(false)
    }
  })

  test('Provider 异常返回稳定错误结果与唯一 failed 事件，不泄漏原始异常', async () => {
    const f = await open(async function* () { throw new Error('sk-secret raw-body') })
    const conversation = await f.create()
    const result = await f.request(methods.CHAT_SEND, { conversationId: conversation.id, text: '失败' })
    expect(result).toMatchObject({ success: false, code: 'provider_failed' })
    expect(f.packets.filter((packet) => packet.event.type === 'failed')).toHaveLength(1)
    expect(JSON.stringify([result, f.packets])).not.toContain('sk-secret')
    expect(f.backend.conversations.getMessages(conversation.id).at(-1)?.status).toBe('error')
  })
})
