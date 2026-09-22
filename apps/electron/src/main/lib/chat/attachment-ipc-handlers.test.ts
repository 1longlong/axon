import { describe, expect, test } from 'bun:test'
import type { FileAttachment } from '@axon/shared'
import { AttachmentServiceError } from './attachment-service'
import { createAttachmentIpcHandlers } from './attachment-ipc-handlers'

const validInput = {
  conversationId: 'conversation-1',
  filename: '截图.png',
  mediaType: 'image/png',
  data: 'aGVsbG8=',
}

const savedAttachment: FileAttachment = {
  id: 'attachment-1',
  filename: '截图.png',
  mediaType: 'image/png',
  localPath: 'conversation-1/attachment-1.png',
  size: 5,
  createdAt: 1_000,
}

describe('附件 IPC 边界', () => {
  test('保存成功返回安全元数据', () => {
    const captured: unknown[] = []
    const handlers = createAttachmentIpcHandlers({
      save: (input) => {
        captured.push(input)
        return savedAttachment
      },
    })
    expect(handlers.save(validInput)).toEqual({ success: true, attachment: savedAttachment })
    expect(captured).toEqual([validInput])
  })

  test('拒绝非对象负载、未知字段与非字符串字段，且不调用服务', () => {
    let called = 0
    const handlers = createAttachmentIpcHandlers({
      save: (input) => {
        called += 1
        return savedAttachment
      },
    })
    for (const payload of [
      null,
      'text',
      [],
      { ...validInput, extra: 1 },
      { conversationId: 1, filename: 'a', mediaType: 't/t', data: 'x' },
      { conversationId: 'c', filename: 'a', mediaType: 't/t' },
    ]) {
      expect(handlers.save(payload)).toMatchObject({ success: false, code: 'invalid_input' })
    }
    expect(called).toBe(0)
  })

  test('领域错误转稳定结果，未知异常脱敏为 internal_error', () => {
    const tooLarge = createAttachmentIpcHandlers({
      save: () => { throw new AttachmentServiceError('too_large', '附件超过大小上限') },
    })
    expect(tooLarge.save(validInput)).toEqual({
      success: false,
      code: 'too_large',
      message: '附件超过大小上限',
    })

    const broken = createAttachmentIpcHandlers({
      save: () => { throw new Error('secret filesystem detail') },
    })
    const result = broken.save(validInput)
    expect(result).toMatchObject({ success: false, code: 'internal_error' })
    expect(JSON.stringify(result)).not.toContain('secret filesystem detail')
  })
})
