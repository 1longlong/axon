import { describe, expect, test } from 'bun:test'
import { isQuickChatSend, isQuickChatWindowOwner, registerQuickChatWindowOwner, unregisterQuickChatWindowOwner } from './quick-chat-window-owner'

describe('快捷会话 renderer 所有权', () => {
  test('只允许浮窗向自身绑定的会话发送', () => {
    registerQuickChatWindowOwner(101, {
      id: 'binding-1',
      accelerator: 'CommandOrControl+Shift+1',
      sessionType: 'chat',
      sessionId: 'conversation-1',
    })
    expect(isQuickChatWindowOwner(101)).toBe(true)
    expect(isQuickChatSend(101, 'chat', 'conversation-1')).toBe(true)
    expect(() => isQuickChatSend(101, 'chat', 'conversation-2')).toThrow('不能向其他会话发送')
    expect(isQuickChatSend(102, 'chat', 'conversation-1')).toBe(false)
    unregisterQuickChatWindowOwner(101)
    expect(isQuickChatWindowOwner(101)).toBe(false)
  })
})
