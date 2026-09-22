/** 窗口与快捷浮窗控制 IPC；只负责原生窗口状态，不承载业务会话逻辑。 */

import { BrowserWindow, ipcMain, screen } from 'electron'
import { DESKTOP_IPC_CHANNELS, WINDOW_IPC_CHANNELS } from '../../types'
import { getMainWindow } from '../lib/desktop/main-window-store'
import { isQuickChatWindowOwner } from '../lib/desktop/quick-chat-window-owner'
import { assertMainFrame } from './assert-main-frame'

const quickChatExpandedHeights = new Map<number, number>()

/** 注册原生窗口和快捷浮窗 handler；快捷浮窗只能操作与发送者绑定的自身窗口。 */
export function registerWindowIpcHandlers(): void {
  ipcMain.handle(DESKTOP_IPC_CHANNELS.HIDE_QUICK_CHAT, (event) => {
    assertMainFrame(event, '隐藏快捷窗口')
    if (!isQuickChatWindowOwner(event.sender.id)) throw new Error('只能隐藏自己的快捷窗口')
    const win = BrowserWindow.fromWebContents(event.sender)
    if (win && !win.isDestroyed()) {
      win.webContents.send(DESKTOP_IPC_CHANNELS.QUICK_CHAT_CANCELED)
      win.hide()
    }
  })
  /** 只允许已登记的快捷浮窗改变自身高度；保持底边位置，让上下文向上展开。 */
  ipcMain.handle(DESKTOP_IPC_CHANNELS.QUICK_CHAT_EXPANDED, (event, expanded: unknown) => {
    assertMainFrame(event, '快捷窗口尺寸调整')
    if (!isQuickChatWindowOwner(event.sender.id) || typeof expanded !== 'boolean') {
      throw new Error('快捷窗口尺寸请求无效')
    }
    const win = BrowserWindow.fromWebContents(event.sender)
    if (!win || win.isDestroyed()) return
    const bounds = win.getBounds()
    if (!expanded && bounds.height > 300) quickChatExpandedHeights.set(event.sender.id, bounds.height)
    const workArea = screen.getDisplayMatching(bounds).workArea
    const height = Math.min(expanded ? quickChatExpandedHeights.get(event.sender.id) ?? 630 : 104, workArea.height)
    const y = Math.max(workArea.y, Math.min(bounds.y + bounds.height - height, workArea.y + workArea.height - height))
    // 原生窗口动画与大消息列表收起叠加会产生明显拖尾；尺寸直接切换。
    win.setBounds({ x: bounds.x, y, width: bounds.width, height }, false)
  })
  ipcMain.handle(WINDOW_IPC_CHANNELS.MINIMIZE, () => {
    getMainWindow()?.minimize()
  })
  ipcMain.handle(WINDOW_IPC_CHANNELS.MAXIMIZE, () => {
    const win = getMainWindow()
    if (!win) return
    if (win.isMaximized()) win.unmaximize()
    else win.maximize()
  })
  ipcMain.handle(WINDOW_IPC_CHANNELS.CLOSE, () => {
    getMainWindow()?.close()
  })
  ipcMain.handle(WINDOW_IPC_CHANNELS.IS_MAXIMIZED, () => {
    return getMainWindow()?.isMaximized() ?? false
  })
}
