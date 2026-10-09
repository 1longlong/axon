import { afterEach, describe, expect, test } from 'bun:test'
import { mkdtempSync, readFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type { ChatGenerationEvent } from '@axon/shared'
import {
  AttachmentService,
  ChannelManager,
  ChatService,
  ConversationManager,
  ProviderStreamRequestError,
  createBackendPaths,
  createDocumentParser,
  initializeBackendDirectories,
} from '../index'
import type { BackendPaths, ChatStreamExecutor, ProviderStreamRequest } from '../index'
import { createFixtureCredentialCodec } from '../../test-support/credential-codec'

const directories: string[] = []
afterEach(() => {
  for (const directory of directories.splice(0)) rmSync(directory, { recursive: true, force: true })
})

function isolatedPaths(): BackendPaths {
  const directory = mkdtempSync(join(tmpdir(), 'axon-core-chat-run-'))
  directories.push(directory)
  const paths = createBackendPaths({ dataDir: join(directory, 'data'), homeDir: directory })
  initializeBackendDirectories(paths)
  return paths
}

/** 从同一显式目录重新建立后端实例，夹具凭据不读取用户安全存储。 */
function openStores(paths: BackendPaths) {
  return {
    channels: new ChannelManager({ configPath: paths.channelsPath, credentialCodec: createFixtureCredentialCodec() }),
    conversations: new ConversationManager({ indexPath: paths.conversationsIndexPath, messagesDir: paths.conversationsDir }),
    attachments: new AttachmentService({ attachmentsDir: paths.attachmentsDir }),
  }
}

/** 真实附件读取/解析交给 Chat；只替换模型流，验证公开入口的上下游组合。 */
function openChat(
  stores: ReturnType<typeof openStores>,
  stream: ChatStreamExecutor,
  events: ChatGenerationEvent[] = [],
  persistedAtBroadcast: boolean[] = [],
) {
  const parseDocument = createDocumentParser()
  return new ChatService({
    channelManager: stores.channels, conversationManager: stores.conversations, userAgent: 'Axon/test', stream,
    emit: (event) => {
      if (event.type === 'completed' || event.type === 'stopped' || event.type === 'failed') {
        // 监听器错误会被服务隔离；收集证据后在测试主链断言，不能把断言放进回调吞掉。
        persistedAtBroadcast.push(JSON.stringify(stores.conversations.getMessages(event.conversationId).at(-1))
          === JSON.stringify(event.message))
      }
      events.push(event)
    },
    readAttachmentData: (path) => {
      try { return stores.attachments.readAsBase64(path) } catch { return undefined }
    },
    extractDocumentText: async (attachment) => {
      const buffer = Buffer.from(stores.attachments.readAsBase64(attachment.localPath), 'base64')
      return parseDocument({ filename: attachment.filename, mediaType: attachment.mediaType, buffer })
    },
  })
}

async function createConversation(stores: ReturnType<typeof openStores>) {
  const channel = await stores.channels.create({
    name: '隔离渠道', provider: 'openai', baseUrl: 'https://example.test/v1', apiKey: 'fixture-secret',
    models: [{ id: 'fixture-model', name: '测试模型', enabled: true }],
  })
  // 已命名会话不启动独立标题请求，使本测试只观察消息与摘要请求链。
  return stores.conversations.create({ title: '隔离 Chat', channelId: channel.id, modelId: 'fixture-model' })
}

describe('公共 core 入口的 Chat 请求与重建', () => {
  test('自动摘要、图片和真实文本附件进入请求，重建保留原文并按覆盖 ID 选择上下文', async () => {
    expect(process.versions.electron).toBeUndefined()
    const paths = isolatedPaths()
    const stores = openStores(paths)
    const conversation = await createConversation(stores)
    // 12 条完整历史，前 4 条超阈值，后 8 条留在主请求。
    for (let index = 0; index < 12; index += 1) stores.conversations.appendMessage(conversation.id, {
      id: `seed-${index}`, role: index % 2 === 0 ? 'user' : 'assistant',
      content: [{ type: 'text', text: index < 4 ? '甲'.repeat(20_001) : `近期内容 ${index}` }],
      createdAt: index, status: 'complete',
    })
    const document = stores.attachments.save({ conversationId: conversation.id,
      filename: '说明.md', mediaType: 'text/markdown', data: Buffer.from('# 本地附件正文').toString('base64') })
    const image = stores.attachments.save({ conversationId: conversation.id,
      filename: '图片.png', mediaType: 'image/png', data: Buffer.from('fixture-image').toString('base64') })
    const calls: ProviderStreamRequest[] = []
    const events: ChatGenerationEvent[] = []
    const persistedAtBroadcast: boolean[] = []
    const chat = openChat(stores, async function* (input) {
      calls.push(input)
      if (input.chatRequest.systemPrompt?.startsWith('请把以下对话压缩')) {
        yield { type: 'text_delta', delta: '早期事实摘要' }
        yield { type: 'finish', reason: 'stop' }
        return
      }
      yield { type: 'reasoning_start', blockId: 'reason' }
      yield { type: 'reasoning_delta', blockId: 'reason', delta: '检查附件' }
      yield { type: 'reasoning_end', blockId: 'reason' }
      yield { type: 'text_delta', delta: '已读取附件' }
      yield { type: 'usage', usage: { inputTokens: 10, outputTokens: 4, totalTokens: 14 } }
      yield { type: 'finish', reason: 'stop' }
    }, events, persistedAtBroadcast)
    await chat.sendMessage({ conversationId: conversation.id, text: '继续读附件', attachments: [document, image] }, undefined, 'quick')
    expect(calls).toHaveLength(2)
    expect(calls[1]?.chatRequest.systemPrompt).toBe('以下是更早对话的摘要：\n早期事实摘要')
    expect(calls[1]?.chatRequest.messages).toHaveLength(9)
    expect(calls[1]?.chatRequest.messages.at(-1)?.content).toEqual([
      { type: 'text', text: '继续读附件' },
      { type: 'text', text: '<file name="说明.md">\n# 本地附件正文\n</file>' },
      { type: 'image', mediaType: 'image/png', data: Buffer.from('fixture-image').toString('base64') },
    ])
    expect(events.at(-1)?.type).toBe('completed')
    expect(persistedAtBroadcast).toEqual([true])
    expect(chat.isActive()).toBe(false)
    const before = stores.conversations.getMessages(conversation.id)
    expect(before).toHaveLength(14)
    expect(before[12]).toMatchObject({ inputOrigin: 'quick', attachments: [document, image] })
    expect(before[13]?.content.map((block) => block.type)).toEqual(['reasoning', 'text'])
    const rawHistory = readFileSync(join(paths.conversationsDir, `${conversation.id}.jsonl`), 'utf8')
    expect(rawHistory).toContain('甲'.repeat(20_001))
    expect(rawHistory).not.toContain('# 本地附件正文')
    expect(readFileSync(paths.channelsPath, 'utf8')).not.toContain('fixture-secret')

    const reloaded = openStores(paths)
    expect(reloaded.conversations.getMessages(conversation.id)).toEqual(before)
    expect(reloaded.conversations.get(conversation.id)?.contextSummary).toMatchObject({
      text: '早期事实摘要', coveredMessageIds: ['seed-0', 'seed-1', 'seed-2', 'seed-3'],
    })
    let nextRequest: ProviderStreamRequest | undefined
    await openChat(reloaded, async function* (input) {
      nextRequest = input
      yield { type: 'text_delta', delta: '后续回答' }
      yield { type: 'finish', reason: 'stop' }
    }, [], persistedAtBroadcast).sendMessage({ conversationId: conversation.id, text: '第二轮' })
    expect(nextRequest?.chatRequest.messages).toHaveLength(11)
    expect(nextRequest?.chatRequest.systemPrompt).toContain('早期事实摘要')
    expect(JSON.stringify(nextRequest?.chatRequest.messages)).not.toContain('甲'.repeat(20_001))
    expect(JSON.stringify(nextRequest?.chatRequest.messages)).toContain('# 本地附件正文')
    expect(openStores(paths).conversations.getMessages(conversation.id)).toHaveLength(16)
    expect(persistedAtBroadcast).toEqual([true, true])
  })

  test('停止保留局部消息，重建后的请求不把停止输出作为完整回复送回模型', async () => {
    const paths = isolatedPaths()
    const stores = openStores(paths)
    const conversation = await createConversation(stores)
    const persistedAtBroadcast: boolean[] = []
    let notifyStarted: () => void = () => {}
    const ready = new Promise<void>((resolve) => { notifyStarted = resolve })
    const chat = openChat(stores, async function* (input) {
      yield { type: 'text_delta', delta: '半段回复' }
      notifyStarted()
      await new Promise<never>((_resolve, reject) => {
        input.signal?.addEventListener('abort', () => reject(new ProviderStreamRequestError('cancelled', '生成已停止')), { once: true })
      })
    }, [], persistedAtBroadcast)
    const pending = chat.sendMessage({ conversationId: conversation.id, text: '第一个问题' })
    await ready
    expect(chat.stopGeneration(conversation.id)).toBe(true)
    await expect(pending).rejects.toMatchObject({ code: 'cancelled' })
    const reloaded = openStores(paths)
    expect(reloaded.conversations.getMessages(conversation.id).at(-1)).toMatchObject({
      content: [{ type: 'text', text: '半段回复' }], status: 'stopped',
    })
    let nextRequest: ProviderStreamRequest | undefined
    await openChat(reloaded, async function* (input) {
      nextRequest = input
      yield { type: 'text_delta', delta: '完整回复' }
      yield { type: 'finish', reason: 'stop' }
    }, [], persistedAtBroadcast).sendMessage({ conversationId: conversation.id, text: '新问题' })
    expect(nextRequest?.chatRequest.systemPrompt).toBeUndefined()
    expect(nextRequest?.chatRequest.messages.map((message) => message.role)).toEqual(['user', 'user'])
    expect(JSON.stringify(nextRequest?.chatRequest.messages)).not.toContain('半段回复')
    expect(openStores(paths).conversations.getMessages(conversation.id)).toHaveLength(4)
    expect(persistedAtBroadcast).toEqual([true, true])
  })
})
