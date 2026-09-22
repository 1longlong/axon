import { describe, expect, test } from 'bun:test'
import { MAX_CHAT_INPUT_LENGTH } from '@axon/shared'
import { getChatInputAvailability } from './chat-input'

describe('Chat 输入发送规则', () => {
  test('修剪正文并允许已选模型的空闲会话发送', () => {
    expect(getChatInputAvailability('  你好  ', { hasModel: true, sending: false })).toEqual({
      canSend: true,
      text: '你好',
    })
  })

  test('拒绝空白、超长、未选模型和生成中输入', () => {
    expect(getChatInputAvailability('  ', { hasModel: true, sending: false }).reason).toBe('empty')
    expect(getChatInputAvailability('x'.repeat(MAX_CHAT_INPUT_LENGTH + 1), {
      hasModel: true,
      sending: false,
    }).reason).toBe('too_long')
    expect(getChatInputAvailability('你好', { hasModel: false, sending: false }).reason).toBe('model_required')
    expect(getChatInputAvailability('你好', { hasModel: true, sending: true }).reason).toBe('sending')
  })
})
