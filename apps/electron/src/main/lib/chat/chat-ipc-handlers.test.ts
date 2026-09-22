import { afterEach, beforeEach, describe, expect, test } from 'bun:test'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type { ChatGenerationEvent, ChatMessage, ChatSendInput } from '@axon/shared'
import { ChatIpcController } from './chat-ipc-handlers'
import type { ChatIpcControllerOptions } from './chat-ipc-handlers'
import { ChatServiceError } from './chat-service'
import { ConversationManager } from './conversation-manager'

let directory: string
let conversations: ConversationManager
let nextId: number

beforeEach(() => {
  directory = mkdtempSync(join(tmpdir(), 'axon-chat-ipc-'))
  nextId = 1
  conversations = new ConversationManager({
    indexPath: join(directory, 'conversations.json'),
    messagesDir: join(directory, 'conversations'),
    createId: () => `conversation-${nextId++}`,
    now: () => 1_000 + nextId,
  })
})

afterEach(() => {
  rmSync(directory, { recursive: true, force: true })
})

function assistant(id = 'assistant-1'): ChatMessage {
  return {
    id,
    role: 'assistant',
    content: [{ type: 'text', text: '完成' }],
    createdAt: 2_000,
    status: 'complete',
    modelId: 'model-1',
    finishReason: 'stop',
  }
}

function passiveChat(overrides: Partial<ChatIpcControllerOptions['chat']> = {}): ChatIpcControllerOptions['chat'] {
  return {
    sendMessage: async () => assistant(),
    stopGeneration: () => false,
    isActive: () => false,
    ...overrides,
  }
}

describe('ChatIpcController CRUD 与负载边界', () => {
  test('会话 CRUD 和消息读取只经过安全 DTO', () => {
    const controller = new ChatIpcController({ conversations, chat: passiveChat() })
    const created = controller.createConversation({
      title: '测试会话',
      channelId: 'channel-1',
      modelId: 'model-1',
    })
    expect(controller.listConversations()).toEqual([created])
    expect(controller.getConversation(created.id)).toEqual(created)
    expect(controller.getConversation('missing')).toBeNull()
    expect(controller.getMessages(created.id)).toEqual([])

    const updated = controller.updateConversation(created.id, {
      title: '新标题',
      channelId: null,
    })
    expect(updated).toMatchObject({ title: '新标题', modelId: 'model-1' })
    expect(updated).not.toHaveProperty('channelId')
    expect(controller.deleteConversation(created.id).id).toBe(created.id)
    expect(controller.listConversations()).toEqual([])
  })

  test('拒绝未知字段、错误类型、空 ID 和生成中的删除', async () => {
    const created = conversations.create()
    const active = new ChatIpcController({
      conversations,
      chat: passiveChat({ isActive: (id) => id === created.id }),
    })
    for (const value of [null, [], { hidden: true }, { channelId: null }, { title: 1 }]) {
      expect(() => active.createConversation(value)).toThrow(
        expect.objectContaining({ code: 'invalid_input' }),
      )
    }
    for (const id of [null, {}, '', ' ']) {
      expect(() => active.getConversation(id)).toThrow(
        expect.objectContaining({ code: 'invalid_input' }),
      )
    }
    expect(() => active.updateConversation(created.id, { unknown: true })).toThrow(
      expect.objectContaining({ code: 'invalid_input' }),
    )
    expect(await active.send(1, {
      conversationId: created.id,
      text: '你好',
      systemPrompt: 'Chat 不接受 Agent 系统提示词',
    }, () => {})).toMatchObject({ success: false, code: 'invalid_input' })
    expect(() => active.deleteConversation(created.id)).toThrow(
      expect.objectContaining({ code: 'already_active' }),
    )
  })
})

describe('ChatIpcController 生成所有权', () => {
  test('把流事件交给当前调用者，并返回稳定成功结果', async () => {
    const created = conversations.create({ channelId: 'channel-1', modelId: 'model-1' })
    const received: ChatGenerationEvent[] = []
    const message = assistant()
    const chat = passiveChat({
      sendMessage: async (input, emit) => {
        expect(input.conversationId).toBe(created.id)
        emit?.({
          type: 'completed',
          conversationId: created.id,
          generationId: 'generation-1',
          message,
        })
        return message
      },
    })
    const result = await new ChatIpcController({ conversations, chat }).send(
      7,
      { conversationId: created.id, text: '你好' },
      (event) => received.push(event),
    )
    expect(result).toEqual({ success: true, message })
    expect(received).toEqual([
      expect.objectContaining({ type: 'completed', conversationId: created.id }),
    ])
  })

  test('只有 owner 能停止生成，renderer 清理会取消其全部请求', async () => {
    const firstId = conversations.create().id
    const secondId = conversations.create().id
    const resolvers = new Map<string, (message: ChatMessage) => void>()
    const active = new Set<string>()
    const stopped: string[] = []
    const chat = passiveChat({
      sendMessage: async (input: ChatSendInput) => {
        active.add(input.conversationId)
        try {
          return await new Promise<ChatMessage>((resolve) => {
            resolvers.set(input.conversationId, resolve)
          })
        } finally {
          active.delete(input.conversationId)
        }
      },
      stopGeneration: (id) => {
        if (!active.has(id) || stopped.includes(id)) return false
        stopped.push(id)
        return true
      },
      isActive: (id) => id === undefined ? active.size > 0 : active.has(id),
    })
    const controller = new ChatIpcController({ conversations, chat })
    const first = controller.send(7, { conversationId: firstId, text: '一' }, () => {})
    const second = controller.send(7, { conversationId: secondId, text: '二' }, () => {})

    expect(controller.stop(8, firstId)).toBe(false)
    expect(controller.stop(7, firstId)).toBe(true)
    expect(controller.stop(7, firstId)).toBe(false)
    expect(controller.cancelOwner(8)).toBe(0)
    expect(controller.cancelOwner(7)).toBe(1)
    expect(stopped).toEqual([firstId, secondId])

    resolvers.get(firstId)?.(assistant('assistant-first'))
    resolvers.get(secondId)?.(assistant('assistant-second'))
    expect((await first).success).toBe(true)
    expect((await second).success).toBe(true)
    expect(controller.stop(7, firstId)).toBe(false)
  })

  test('同一对话不能被第二个 renderer 接管，错误结果不泄露未知异常', async () => {
    const created = conversations.create()
    let resolvePending: ((message: ChatMessage) => void) | undefined
    const chat = passiveChat({
      sendMessage: async () => new Promise<ChatMessage>((resolve) => { resolvePending = resolve }),
      isActive: () => false,
    })
    const controller = new ChatIpcController({ conversations, chat })
    const pending = controller.send(1, { conversationId: created.id, text: '一' }, () => {})
    expect(await controller.send(2, { conversationId: created.id, text: '二' }, () => {})).toMatchObject({
      success: false,
      code: 'already_active',
    })
    resolvePending?.(assistant())
    await pending

    const unknown = new ChatIpcController({
      conversations,
      chat: passiveChat({ sendMessage: async () => { throw new Error('secret detail') } }),
    })
    expect(await unknown.send(1, { conversationId: created.id, text: 'x' }, () => {})).toEqual({
      success: false,
      code: 'internal_error',
      message: 'Chat 请求失败',
    })
    expect(await unknown.send(1, { conversationId: created.id, text: 1 }, () => {})).toEqual({
      success: false,
      code: 'invalid_input',
      message: 'Chat IPC 请求格式无效',
    })
  })

  test('保留 ChatService 的稳定业务错误码', async () => {
    const created = conversations.create()
    const controller = new ChatIpcController({
      conversations,
      chat: passiveChat({
        sendMessage: async () => {
          throw new ChatServiceError('channel_required', '请先为对话选择渠道')
        },
      }),
    })
    expect(await controller.send(1, { conversationId: created.id, text: 'x' }, () => {})).toEqual({
      success: false,
      code: 'channel_required',
      message: '请先为对话选择渠道',
    })
  })
})

describe('ChatIpcController 附件边界', () => {
  const validAttachment = {
    id: 'att-1',
    filename: '截图.png',
    mediaType: 'image/png',
    localPath: 'conversation-1/att-1.png',
    size: 2048,
    createdAt: 900,
  }

  test('send 透传附件元数据，非数组附件被拒绝', async () => {
    let captured: ChatSendInput | undefined
    const chat: ChatIpcControllerOptions['chat'] = {
      ...passiveChat(),
      sendMessage: async (input) => {
        captured = input
        return assistant()
      },
    }
    const controller = new ChatIpcController({ conversations, chat })
    const created = controller.createConversation({})

    const result = await controller.send(
      1,
      { conversationId: created.id, text: '看图', attachments: [validAttachment] },
      () => {},
    )
    expect(result).toEqual({ success: true, message: assistant() })
    expect(captured?.attachments).toEqual([validAttachment])

    // IPC 层只拒绝非数组；成员结构与数量的深层校验属于 ChatService（另行测试）。
    const bad = await controller.send(1, { conversationId: created.id, text: 'x', attachments: 'nope' }, () => {})
    expect(bad).toMatchObject({ success: false, code: 'invalid_input' })
  })

  test('删除会话级联清理附件目录，清理失败不阻塞删除结果', () => {
    const cleaned: string[] = []
    let failCleanup = false
    const controller = new ChatIpcController({
      conversations,
      chat: passiveChat(),
      attachments: {
        deleteConversationAttachments: (conversationId: string) => {
          if (failCleanup) throw new Error('disk busy')
          cleaned.push(conversationId)
        },
      },
    })

    const first = controller.createConversation({})
    controller.deleteConversation(first.id)
    expect(cleaned).toEqual([first.id])

    // 级联清理失败只记录警告；会话删除已经完成，不能回滚。
    failCleanup = true
    const second = controller.createConversation({})
    expect(controller.deleteConversation(second.id).id).toBe(second.id)
    expect(controller.listConversations()).toEqual([])
  })
})
