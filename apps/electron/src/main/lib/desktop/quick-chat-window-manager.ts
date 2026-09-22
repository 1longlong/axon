import { app, BrowserWindow, nativeImage, shell } from 'electron'
import { join } from 'node:path'
import { DESKTOP_IPC_CHANNELS } from '../../../types'
import type { QuickChatShortcutBinding } from '../../../types'
import { getIsQuitting } from './app-lifecycle'
import { registerQuickChatWindowOwner, unregisterQuickChatWindowOwner } from './quick-chat-window-owner'

const COMPACT_HEIGHT = 104

/** 管理全局快捷键浮窗；同一会话复用窗口，失焦只隐藏，退出时统一销毁。 */
export class QuickChatWindowManager {
  private readonly windows = new Map<string, BrowserWindow>()

  show(binding: QuickChatShortcutBinding, title: string): void {
    const key = `${binding.sessionType}:${binding.sessionId}`
    const existing = this.windows.get(key)
    if (existing && !existing.isDestroyed()) {
      const bounds = existing.getBounds()
      if (bounds.height !== COMPACT_HEIGHT) {
        existing.setBounds({ ...bounds, y: bounds.y + bounds.height - COMPACT_HEIGHT, height: COMPACT_HEIGHT })
      }
      if (existing.isMinimized()) existing.restore()
      existing.webContents.send(DESKTOP_IPC_CHANNELS.QUICK_CHAT_OPENED)
      existing.show()
      existing.focus()
      return
    }

    const resourcesDir = app.isPackaged ? process.resourcesPath : join(__dirname, 'resources')
    const window = new BrowserWindow({
      width: 860,
      height: COMPACT_HEIGHT,
      minWidth: 800,
      minHeight: COMPACT_HEIGHT,
      show: false,
      frame: false,
      transparent: true,
      hasShadow: true,
      skipTaskbar: true,
      maximizable: false,
      minimizable: false,
      fullscreenable: false,
      alwaysOnTop: true,
      autoHideMenuBar: true,
      title: `Axon · ${title}`,
      icon: nativeImage.createFromPath(join(resourcesDir, 'axon-icon.svg')),
      webPreferences: {
        preload: join(__dirname, 'preload.cjs'),
        contextIsolation: true,
        nodeIntegration: false,
      },
    })
    this.windows.set(key, window)
    registerQuickChatWindowOwner(window.webContents.id, binding)
    window.setMenuBarVisibility(false)
    if (process.platform === 'darwin') window.setVisibleOnAllWorkspaces(true, { visibleOnFullScreen: true })

    // 浮窗隐藏后继续保留运行所有权，下一次唤起可直接看到同一会话进度。
    const cancelAndHide = (): void => {
      if (getIsQuitting() || window.isDestroyed()) return
      window.webContents.send(DESKTOP_IPC_CHANNELS.QUICK_CHAT_CANCELED)
      window.hide()
    }
    window.on('blur', () => {
      if (window.isVisible()) cancelAndHide()
    })
    window.on('close', (event) => {
      if (getIsQuitting()) return
      event.preventDefault()
      cancelAndHide()
    })
    window.on('closed', () => {
      unregisterQuickChatWindowOwner(window.webContents.id)
      if (this.windows.get(key) === window) this.windows.delete(key)
    })
    window.once('ready-to-show', () => {
      if (!window.isDestroyed()) {
        window.show()
        window.focus()
      }
    })
    window.webContents.on('will-navigate', (event, url) => {
      if (!app.isPackaged && this.isDevServerNavigation(url)) return
      event.preventDefault()
      if (url.startsWith('http://') || url.startsWith('https://')) void shell.openExternal(url)
    })
    window.webContents.setWindowOpenHandler(({ url }) => {
      if (url.startsWith('http://') || url.startsWith('https://')) void shell.openExternal(url)
      return { action: 'deny' }
    })

    const query = { quick: '1', sessionType: binding.sessionType, sessionId: binding.sessionId }
    const rendererPath = join(__dirname, 'renderer', 'index.html')
    const load = app.isPackaged
      ? window.loadFile(rendererPath, { query })
      : window.loadURL(`http://127.0.0.1:5173/?${new URLSearchParams(query).toString()}`)
    void load.catch((error) => {
      console.error('[快捷会话] 浮窗加载失败:', error)
      if (!window.isDestroyed()) window.destroy()
    })
  }

  /** 应用退出时销毁全部浮窗并释放 renderer owner 绑定。 */
  dispose(): void {
    for (const window of this.windows.values()) {
      if (!window.isDestroyed()) window.destroy()
    }
    this.windows.clear()
  }

  private isDevServerNavigation(url: string): boolean {
    try { return new URL(url).origin === 'http://127.0.0.1:5173' }
    catch { return false }
  }
}
