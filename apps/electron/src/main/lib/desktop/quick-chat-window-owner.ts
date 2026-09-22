import type { QuickChatShortcutBinding } from '../../../types'

const owners = new Map<number, Pick<QuickChatShortcutBinding, 'sessionType' | 'sessionId'>>()

/** 主进程记录浮窗真实 webContents 身份；消息来源不能由 renderer 自行声明。 */
export function registerQuickChatWindowOwner(webContentsId: number, binding: QuickChatShortcutBinding): void {
  owners.set(webContentsId, { sessionType: binding.sessionType, sessionId: binding.sessionId })
}

export function unregisterQuickChatWindowOwner(webContentsId: number): void {
  owners.delete(webContentsId)
}

export function isQuickChatWindowOwner(webContentsId: number): boolean {
  return owners.has(webContentsId)
}

/** 浮窗只可向自身绑定的会话发送，普通主窗口返回 false。 */
export function isQuickChatSend(webContentsId: number, sessionType: 'chat' | 'agent', sessionId: unknown): boolean {
  const owner = owners.get(webContentsId)
  if (!owner) return false
  if (owner.sessionType !== sessionType || owner.sessionId !== sessionId) throw new Error('快捷浮窗不能向其他会话发送消息')
  return true
}
