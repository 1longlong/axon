/** 窗口与快捷浮窗控制 IPC；只负责原生窗口状态，不承载业务会话逻辑。 */

import { BrowserWindow, ipcMain } from 'electron'
import { DESKTOP_IPC_CHANNELS, WINDOW_IPC_CHANNELS } from '../../types'
import type { QuickChatDragInput } from '../../types'
import { getMainWindow } from '../lib/desktop/main-window-store'
import { isQuickChatWindowOwner } from '../lib/desktop/quick-chat-window-owner'
import { moveQuickChatWindow, setQuickChatWindowExpanded } from '../lib/desktop/quick-chat-window-layout'
import { assertMainFrame } from './assert-main-frame'

/** 注册原生窗口和快捷浮窗 handler；快捷浮窗只能操作与发送者绑定的自身窗口。 */
export function registerWindowIpcHandlers(): void {
  const quickChatDrags = new Map<number, { offsetX: number; offsetY: number }>()
  ipcMain.handle(DESKTOP_IPC_CHANNELS.HIDE_QUICK_CHAT, (event) => {
    assertMainFrame(event, '隐藏快捷窗口')
    if (!isQuickChatWindowOwner(event.sender.id)) throw new Error('只能隐藏自己的快捷窗口')
    quickChatDrags.delete(event.sender.id)
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
    // 原生窗口动画与大消息列表收起叠加会产生明显拖尾；尺寸直接切换。
    setQuickChatWindowExpanded(win, expanded)
  })
  /** 紧凑浮窗用阈值手势兼顾整框拖动和输入点击；主进程只接受已登记浮窗的屏幕坐标。 */
  ipcMain.on(DESKTOP_IPC_CHANNELS.QUICK_CHAT_DRAG, (event, input: QuickChatDragInput) => {
    assertMainFrame(event, '拖动快捷窗口')
    if (!isQuickChatWindowOwner(event.sender.id) || !isQuickChatDragInput(input)) return
    const win = BrowserWindow.fromWebContents(event.sender)
    if (!win || win.isDestroyed()) return
    if (input.phase === 'end') {
      quickChatDrags.delete(event.sender.id)
      return
    }
    if (input.phase === 'start') {
      const bounds = win.getBounds()
      quickChatDrags.set(event.sender.id, {
        offsetX: bounds.x - input.screenX,
        offsetY: bounds.y - input.screenY,
      })
      return
    }
    const drag = quickChatDrags.get(event.sender.id)
    if (drag) moveQuickChatWindow(win, input.screenX + drag.offsetX, input.screenY + drag.offsetY)
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

function isQuickChatDragInput(value: unknown): value is QuickChatDragInput {
  if (!value || typeof value !== 'object') return false
  const input = value as Partial<QuickChatDragInput>
  return (input.phase === 'start' || input.phase === 'move' || input.phase === 'end')
    && Number.isFinite(input.screenX)
    && Number.isFinite(input.screenY)
    && Math.abs(input.screenX ?? 0) <= 1_000_000
    && Math.abs(input.screenY ?? 0) <= 1_000_000
}
