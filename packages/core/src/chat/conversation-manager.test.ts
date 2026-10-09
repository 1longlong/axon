import { afterEach, beforeEach, describe, expect, test } from 'bun:test'
import {
  existsSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  statSync,
  truncateSync,
  writeFileSync,
} from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type { ChatMessage, ConversationMeta } from '@axon/shared'
import { ConversationManager, ConversationManagerError } from './conversation-manager'

let directory: string
let indexPath: string
let messagesDir: string
let nowValue: number
let nextId: number

beforeEach(() => {
  directory = mkdtempSync(join(tmpdir(), 'axon-conversations-'))
  indexPath = join(directory, 'conversations.json')
  messagesDir = join(directory, 'conversations')
  nowValue = 1_000
  nextId = 1
})

afterEach(() => {
  rmSync(directory, { recursive: true, force: true })
})

function manager(): ConversationManager {
  return new ConversationManager({
    indexPath,
    messagesDir,
    createId: () => `conversation-${nextId++}`,
    now: () => nowValue,
  })
}

function userMessage(id: string, text = '你好'): ChatMessage {
  return {
    id,
    role: 'user',
    content: [{ type: 'text', text }],
    createdAt: nowValue,
    status: 'complete',
  }
}

function assistantMessage(id: string): ChatMessage {
  return {
    id,
    role: 'assistant',
    content: [
      { type: 'reasoning', text: '先查询', signature: ' opaque-signature ' },
      { type: 'text', text: '我来查询。' },
      {
        type: 'tool_call',
        callId: 'call-weather',
        name: 'get_weather',
        arguments: '{ "city": "上海" }',
      },
    ],
    createdAt: nowValue,
    status: 'complete',
    modelId: 'model-test',
    finishReason: 'tool_use',
    usage: { inputTokens: 12, outputTokens: 7, totalTokens: 19 },
  }
}

describe('ConversationManager 会话索引', () => {
  test('创建、排序、更新、清除选择并在重建管理器后恢复', () => {
    const firstManager = manager()
    const first = firstManager.create({
      title: ' 第一段对话 ',
      channelId: 'channel-1',
      modelId: 'model-1',
    })
    nowValue = 2_000
    const second = firstManager.create()
    expect(second.title).toBe('新对话')
    expect(firstManager.list().map((item) => item.id)).toEqual([second.id, first.id])

    nowValue = 3_000
    const updated = firstManager.update(first.id, {
      title: '更新标题',
      channelId: null,
      modelId: null,
    })
    expect(updated).toEqual({
      id: first.id,
      title: '更新标题',
      createdAt: 1_000,
      updatedAt: 3_000,
    })
    expect(manager().list().map((item) => item.id)).toEqual([first.id, second.id])
  })

  test('索引返回副本，调用方修改不会污染内存或磁盘', () => {
    const conversations = manager()
    const created = conversations.create({ title: '原标题' })
    const listed = conversations.list()
    listed[0]!.title = '外部修改'
    expect(conversations.get(created.id)?.title).toBe('原标题')
  })

  test('清洗坏索引项与重复 ID，并从原子备份恢复损坏主文件', () => {
    const valid: ConversationMeta = {
      id: 'conversation-valid',
      title: '有效会话',
      createdAt: 100,
      updatedAt: 200,
    }
    writeFileSync(indexPath, JSON.stringify({
      version: 0,
      conversations: [valid, { ...valid }, { id: '../escape' }],
    }))
    expect(manager().list()).toEqual([valid])
    expect(JSON.parse(readFileSync(indexPath, 'utf-8'))).toEqual({
      version: 1,
      conversations: [valid],
    })

    const conversations = manager()
    nowValue = 300
    conversations.update(valid.id, { title: '有备份的新标题' })
    writeFileSync(indexPath, '{broken', 'utf-8')
    expect(manager().get(valid.id)?.title).toBe('有效会话')
  })
})

describe('ConversationManager 消息 JSONL', () => {
  test('原子追加完整内容块、更新会话时间并跨实例恢复', () => {
    const conversations = manager()
    const conversation = conversations.create({ title: '天气' })
    const first = conversations.appendMessage(conversation.id, userMessage('message-1'))
    nowValue = 2_000
    const second = conversations.appendMessage(conversation.id, assistantMessage('message-2'))

    expect(first.content).toEqual([{ type: 'text', text: '你好' }])
    expect(second.content).toContainEqual({
      type: 'reasoning',
      text: '先查询',
      signature: ' opaque-signature ',
    })
    expect(second.content).toContainEqual({
      type: 'tool_call',
      callId: 'call-weather',
      name: 'get_weather',
      arguments: '{"city":"上海"}',
    })
    expect(conversations.get(conversation.id)?.updatedAt).toBe(2_000)

    const path = join(messagesDir, `${conversation.id}.jsonl`)
    expect(readFileSync(path, 'utf-8').trim().split('\n')).toHaveLength(2)
    expect(existsSync(`${path}.tmp`)).toBe(false)
    if (process.platform !== 'win32') expect(statSync(path).mode & 0o777).toBe(0o600)
    expect(manager().getMessages(conversation.id)).toHaveLength(2)
  })

  test('最近消息分页、全量替换和返回副本相互隔离', () => {
    const conversations = manager()
    const conversation = conversations.create()
    conversations.appendMessage(conversation.id, userMessage('message-1', '一'))
    conversations.appendMessage(conversation.id, userMessage('message-2', '二'))
    conversations.appendMessage(conversation.id, userMessage('message-3', '三'))

    expect(conversations.getRecentMessages(conversation.id, 2)).toMatchObject({
      total: 3,
      hasMore: true,
      messages: [
        expect.objectContaining({ id: 'message-2' }),
        expect.objectContaining({ id: 'message-3' }),
      ],
    })
    const replaced = conversations.replaceMessages(
      conversation.id,
      [userMessage('message-4', '四')],
    )
    const block = replaced[0]!.content[0]
    if (block?.type === 'text') block.text = '外部修改'
    expect(conversations.getMessages(conversation.id)[0]!.content[0]).toEqual({
      type: 'text',
      text: '四',
    })
  })

  test('逐行隔离损坏和重复消息，保留原件后修复主文件', () => {
    const conversations = manager()
    const conversation = conversations.create()
    conversations.appendMessage(conversation.id, userMessage('message-1', '一'))
    conversations.appendMessage(conversation.id, userMessage('message-2', '二'))
    const path = join(messagesDir, `${conversation.id}.jsonl`)
    const [first, second] = readFileSync(path, 'utf-8').trim().split('\n')
    const damaged = `${first}\n{broken\n${second}\n${first}\n`
    writeFileSync(path, damaged, 'utf-8')

    expect(conversations.getMessages(conversation.id).map((item) => item.id)).toEqual([
      'message-1',
      'message-2',
    ])
    expect(readFileSync(`${path}.corrupt`, 'utf-8')).toBe(damaged)
    expect(readFileSync(path, 'utf-8').trim().split('\n')).toHaveLength(2)
  })

  test('拒绝重复、错误角色/参数、路径穿越、未知会话和过大文件', () => {
    const conversations = manager()
    const conversation = conversations.create()
    conversations.appendMessage(conversation.id, userMessage('message-1'))
    expect(() => conversations.appendMessage(
      conversation.id,
      userMessage('message-1'),
    )).toThrow(expect.objectContaining({ code: 'duplicate' }))

    const invalidTool = assistantMessage('message-invalid')
    invalidTool.content = [{
      type: 'tool_call',
      callId: 'call-1',
      name: 'get_weather',
      arguments: '[]',
    }]
    expect(() => conversations.appendMessage(conversation.id, invalidTool)).toThrow(
      expect.objectContaining({ code: 'invalid_input' }),
    )
    expect(() => conversations.getMessages('../escape')).toThrow(
      expect.objectContaining({ code: 'invalid_input' }),
    )
    expect(() => conversations.getMessages('conversation-missing')).toThrow(
      expect.objectContaining({ code: 'not_found' }),
    )

    const path = join(messagesDir, `${conversation.id}.jsonl`)
    truncateSync(path, 128 * 1024 * 1024 + 1)
    expect(() => conversations.getMessages(conversation.id)).toThrow(
      expect.objectContaining({ code: 'too_large' }),
    )
  })

  test('删除会话同时移除索引、消息文件和损坏副本', () => {
    const conversations = manager()
    const conversation = conversations.create({ title: '待删除' })
    conversations.appendMessage(conversation.id, userMessage('message-1'))
    const path = join(messagesDir, `${conversation.id}.jsonl`)
    writeFileSync(`${path}.corrupt`, 'backup')

    expect(conversations.delete(conversation.id).title).toBe('待删除')
    expect(conversations.get(conversation.id)).toBeUndefined()
    expect(existsSync(path)).toBe(false)
    expect(existsSync(`${path}.corrupt`)).toBe(false)
    expect(() => conversations.delete(conversation.id)).toThrow(
      expect.objectContaining({ code: 'not_found' }),
    )
  })

  test('错误消息必须使用稳定说明，用户消息不能携带生成字段', () => {
    const conversations = manager()
    const conversation = conversations.create()
    const missingError = assistantMessage('message-error')
    missingError.status = 'error'
    expect(() => conversations.appendMessage(conversation.id, missingError)).toThrow(
      ConversationManagerError,
    )

    const invalidUser = userMessage('message-user')
    invalidUser.usage = { totalTokens: 1 }
    expect(() => conversations.appendMessage(conversation.id, invalidUser)).toThrow(
      expect.objectContaining({ code: 'invalid_input' }),
    )
  })

  test('允许尚未收到增量的助手以停止或失败终态落盘', () => {
    const conversations = manager()
    const conversation = conversations.create()
    const stopped = conversations.appendMessage(conversation.id, {
      id: 'message-stopped',
      role: 'assistant',
      content: [],
      createdAt: nowValue,
      status: 'stopped',
      modelId: 'model-test',
      finishReason: 'other',
    })
    const failed = conversations.appendMessage(conversation.id, {
      id: 'message-failed',
      role: 'assistant',
      content: [],
      createdAt: nowValue,
      status: 'error',
      modelId: 'model-test',
      finishReason: 'error',
      error: '生成失败',
    })

    expect(stopped.content).toEqual([])
    expect(failed.error).toBe('生成失败')
  })

  test('允许内容过滤终态不含正文，其他完整助手消息仍必须有内容', () => {
    const conversations = manager()
    const conversation = conversations.create()
    expect(conversations.appendMessage(conversation.id, {
      id: 'message-filtered',
      role: 'assistant',
      content: [],
      createdAt: nowValue,
      status: 'complete',
      modelId: 'model-test',
      finishReason: 'content_filter',
    }).finishReason).toBe('content_filter')
    expect(() => conversations.appendMessage(conversation.id, {
      id: 'message-empty',
      role: 'assistant',
      content: [],
      createdAt: nowValue,
      status: 'complete',
      modelId: 'model-test',
      finishReason: 'stop',
    })).toThrow(expect.objectContaining({ code: 'invalid_input' }))
  })
})

describe('ConversationManager 消息附件', () => {
  const validAttachment = {
    id: 'attachment-1',
    filename: '报告.png',
    mediaType: 'image/png',
    localPath: 'conversation-1/attachment-1.png',
    size: 1024,
    createdAt: 900,
  }

  test('用户消息内嵌附件元数据并随 JSONL 持久化与重载', () => {
    const conversations = manager()
    const conversation = conversations.create()
    conversations.appendMessage(conversation.id, {
      ...userMessage('message-att'),
      attachments: [validAttachment],
    })
    // 新实例从磁盘重载后附件元数据完整保留。
    const reloaded = manager()
    expect(reloaded.getMessages(conversation.id)[0]?.attachments).toEqual([validAttachment])
  })

  test('拒绝 assistant 附件、空列表、超量附件与非法元数据', () => {
    const conversations = manager()
    const conversation = conversations.create()
    expect(() => conversations.appendMessage(conversation.id, {
      id: 'assistant-att',
      role: 'assistant',
      content: [{ type: 'text', text: '回答' }],
      createdAt: nowValue,
      status: 'complete',
      modelId: 'model-1',
      finishReason: 'stop',
      attachments: [validAttachment],
    })).toThrow(expect.objectContaining({ code: 'invalid_input' }))

    expect(() => conversations.appendMessage(conversation.id, {
      ...userMessage('message-empty-att'),
      attachments: [],
    })).toThrow(expect.objectContaining({ code: 'invalid_input' }))

    const tooMany = Array.from({ length: 11 }, (_, index) => ({
      ...validAttachment,
      id: `attachment-${index}`,
    }))
    expect(() => conversations.appendMessage(conversation.id, {
      ...userMessage('message-many-att'),
      attachments: tooMany,
    })).toThrow(expect.objectContaining({ code: 'invalid_input' }))

    for (const localPath of ['/etc/passwd', '../outside.bin', 'conversation-1/../../x.bin', 'C:\\x.bin']) {
      expect(() => conversations.appendMessage(conversation.id, {
        ...userMessage('message-path-att'),
        attachments: [{ ...validAttachment, localPath }],
      })).toThrow(expect.objectContaining({ code: 'invalid_input' }))
    }
    expect(conversations.getMessages(conversation.id)).toEqual([])
  })
})
