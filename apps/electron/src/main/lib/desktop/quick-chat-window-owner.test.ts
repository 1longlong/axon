import { describe, expect, test } from 'bun:test'
import { holdQuickChatNativeDialog, isQuickChatNativeDialogOpen, isQuickChatSend, isQuickChatWindowOwner, registerQuickChatWindowOwner, unregisterQuickChatWindowOwner } from './quick-chat-window-owner'

describe('快捷会话 renderer 所有权', () => {
  test('原生 picker 豁免只针对真实 owner，可重入且释放幂等', () => {
    holdQuickChatNativeDialog(999)(); expect(isQuickChatNativeDialogOpen(999)).toBe(false)
    registerQuickChatWindowOwner(103, { id: 'binding', accelerator: 'Ctrl+1', sessionType: 'agent', sessionId: 'session' })
    const first = holdQuickChatNativeDialog(103), second = holdQuickChatNativeDialog(103)
    expect(isQuickChatNativeDialogOpen(103)).toBe(true)
    first(); first(); expect(isQuickChatNativeDialogOpen(103)).toBe(true)
    second(); expect(isQuickChatNativeDialogOpen(103)).toBe(false)
    const late = holdQuickChatNativeDialog(103)
    unregisterQuickChatWindowOwner(103); late()
    expect(isQuickChatNativeDialogOpen(103)).toBe(false)
  })
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
