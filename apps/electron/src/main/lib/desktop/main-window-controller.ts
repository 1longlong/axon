import { app, BrowserWindow, nativeImage, screen, shell } from 'electron'
import type { NativeImage } from 'electron'
import { join } from 'node:path'
import { pathToFileURL } from 'node:url'
import { DESKTOP_IPC_CHANNELS, WINDOW_IPC_CHANNELS } from '../../../types'
import type { AppSettings, DesktopAction } from '../../../types'
import { getSettings, updateSettings } from '../settings/settings-service'
import { getIsQuitting } from './app-lifecycle'
import {
  ensureWindowBoundsVisible,
  getPersistableMainWindowState,
  hideMacMainWindowAfterClose,
  normalizeWindowBoundsToVisibleArea,
  type WindowBounds,
} from './main-window-lifecycle'
import { setMainWindow as setStoredMainWindow } from './main-window-store'
import { canRecoverRenderer, RENDERER_RECOVERY_WINDOW_MS } from './renderer-process-recovery'

const DEFAULT_MAIN_WINDOW_WIDTH = 1400
const DEFAULT_MAIN_WINDOW_HEIGHT = 900
const MIN_MAIN_WINDOW_WIDTH = 1080
const MIN_MAIN_WINDOW_HEIGHT = 600

export interface MainWindowControllerOptions {
  hasTray(): boolean
  onAttentionAcknowledged(): void
}

/**
 * 管理主窗口与原生启动页；向上提供显示、隐藏和动作投递，向下封装窗口恢复与状态持久化。
 */
export class MainWindowController {
  private mainWindow: BrowserWindow | null = null
  private startupSplashWindow: BrowserWindow | null = null

  constructor(private readonly options: MainWindowControllerOptions) {}

  getMainWindow(): BrowserWindow | null {
    return this.mainWindow && !this.mainWindow.isDestroyed() ? this.mainWindow : null
  }

  /** 读取应用级图标；开发和打包环境使用同一份资源。 */
  getApplicationIcon(): NativeImage {
    const resourcesDir = app.isPackaged ? process.resourcesPath : join(__dirname, 'resources')
    return nativeImage.createFromPath(join(resourcesDir, 'axon-icon.svg'))
  }

  /** 在耗时初始化前显示不依赖 Renderer bundle 的原生启动页。 */
  createStartupSplashWindow(): void {
    if (this.startupSplashWindow && !this.startupSplashWindow.isDestroyed()) return

    const savedState = getSettings().mainWindowState
    const splash = new BrowserWindow({
      ...this.getInitialBounds(savedState),
      show: false,
      frame: false,
      resizable: false,
      skipTaskbar: true,
      backgroundColor: '#101418',
      webPreferences: {
        contextIsolation: true,
        nodeIntegration: false,
        sandbox: true,
      },
    })
    this.startupSplashWindow = splash
    splash.setMenuBarVisibility(false)
    splash.once('ready-to-show', () => {
      if (splash.isDestroyed()) return
      if (savedState?.isMaximized ?? true) splash.maximize()
      splash.show()
    })
    splash.once('closed', () => {
      if (this.startupSplashWindow === splash) this.startupSplashWindow = null
    })
    const resourcesDir = app.isPackaged ? process.resourcesPath : join(__dirname, 'resources')
    void splash.loadFile(join(resourcesDir, 'startup-splash', 'index.html')).catch((error) => {
      console.warn('[启动] 原生启动页加载失败，将继续启动主窗口:', error)
      this.dismissStartupSplash()
    })
  }

  /** 显示并聚焦主窗口；窗口已销毁时先重新创建。 */
  showAndFocus(): void {
    if (process.platform === 'darwin') {
      if (app.dock) void app.dock.show()
      app.show()
    }

    const window = this.getMainWindow()
    if (!window) {
      this.createMainWindow()
      return
    }
    this.ensureWindowOnScreen(window)
    if (window.isMinimized()) window.restore()
    window.show()
    window.focus()
  }

  /** 隐藏主窗口但保留后台进程和当前会话运行。 */
  hide(): void {
    const window = this.getMainWindow()
    if (!window) return
    this.saveMainWindowState(window)
    if (process.platform === 'darwin') hideMacMainWindowAfterClose(window, app)
    else window.hide()
  }

  /** 先恢复主窗口，再把托盘动作投递给已就绪的 Renderer。 */
  dispatchDesktopAction(action: DesktopAction): void {
    this.showAndFocus()
    const target = this.getMainWindow()
    if (!target) return

    const send = (): void => {
      if (!target.isDestroyed()) target.webContents.send(DESKTOP_IPC_CHANNELS.ACTION, action)
    }
    if (target.webContents.isLoadingMainFrame()) target.webContents.once('did-finish-load', send)
    else send()
  }

  /**
   * 创建主窗口并绑定加载恢复、导航隔离、状态保存和关闭语义。
   * 该函数是 BrowserWindow 细节的唯一生产入口。
   */
  createMainWindow(): void {
    const existing = this.getMainWindow()
    if (existing) return

    const isMac = process.platform === 'darwin'
    const isDev = !app.isPackaged
    const savedState = getSettings().mainWindowState
    const rendererPath = join(__dirname, 'renderer', 'index.html')
    const rendererEntryUrl = isDev ? 'http://127.0.0.1:5173' : pathToFileURL(rendererPath).toString()
    const window = new BrowserWindow({
      ...this.getInitialBounds(savedState),
      minWidth: MIN_MAIN_WINDOW_WIDTH,
      minHeight: MIN_MAIN_WINDOW_HEIGHT,
      show: false,
      icon: this.getApplicationIcon(),
      webPreferences: {
        preload: join(__dirname, 'preload.cjs'),
        contextIsolation: true,
        nodeIntegration: false,
      },
      ...(isMac ? {
        titleBarStyle: 'hiddenInset' as const,
        trafficLightPosition: { x: 18, y: 18 },
        vibrancy: 'under-window' as const,
        visualEffectState: 'followWindow' as const,
      } : {}),
    })
    this.mainWindow = window
    setStoredMainWindow(window)

    const loadRenderer = (): Promise<void> => isDev
      ? window.loadURL(rendererEntryUrl)
      : window.loadFile(rendererPath)

    // Renderer 失败先有限恢复，连续失败再显示可复制错误信息的本地降级页。
    let hasShownRendererFailure = false
    let rendererRecoveryAttempts: number[] = []
    const showRendererFailure = (reason: string): void => {
      if (window.isDestroyed()) return
      this.dismissStartupSplash()
      if (hasShownRendererFailure) {
        window.show()
        return
      }
      hasShownRendererFailure = true
      const escapeHtml = (value: string): string => value
        .replace(/&/g, '&amp;')
        .replace(/</g, '&lt;')
        .replace(/>/g, '&gt;')
        .replace(/"/g, '&quot;')
        .replace(/'/g, '&#39;')
      const page = `<!doctype html><html><head><meta charset="utf-8"><title>Axon 无法加载</title><style>body{font:14px -apple-system,BlinkMacSystemFont,"Segoe UI",sans-serif;padding:48px;color:#222;background:#fff}main{max-width:680px;margin:auto}h1{font-size:20px;font-weight:600}pre{white-space:pre-wrap;background:#f3f3f3;padding:16px;border-radius:8px}a{display:inline-block;margin-top:12px;padding:9px 14px;border-radius:6px;background:#222;color:#fff;text-decoration:none}</style></head><body><main><h1>Axon 无法加载主界面</h1><pre>${escapeHtml(reason)}</pre><a href="${escapeHtml(rendererEntryUrl)}">重新加载主界面</a></main></body></html>`
      void window.loadURL(`data:text/html;charset=utf-8,${encodeURIComponent(page)}`).catch((error) => {
        console.error('[启动] 降级错误页加载失败:', error)
        if (!window.isDestroyed()) window.show()
      })
    }

    window.webContents.on('did-fail-load', (_event, errorCode, errorDescription, validatedURL, isMainFrame) => {
      if (!isMainFrame || errorCode === -3) return
      console.error(`[启动] 主 Renderer 加载失败 (${errorCode}): ${errorDescription} (${validatedURL})`)
      showRendererFailure(errorDescription)
    })
    window.webContents.on('did-finish-load', () => {
      if (!hasShownRendererFailure) rendererRecoveryAttempts = []
    })
    window.webContents.on('render-process-gone', (_event, details) => {
      if (getIsQuitting() || details.reason === 'clean-exit') return

      const now = Date.now()
      rendererRecoveryAttempts = rendererRecoveryAttempts.filter(
        (attemptAt) => now - attemptAt < RENDERER_RECOVERY_WINDOW_MS,
      )
      console.error('[启动] 主 Renderer 进程异常退出:', {
        reason: details.reason,
        exitCode: details.exitCode,
        url: (() => {
          try { return window.webContents.getURL() }
          catch { return undefined }
        })(),
      })
      if (!hasShownRendererFailure && canRecoverRenderer(rendererRecoveryAttempts, now)) {
        rendererRecoveryAttempts.push(now)
        console.warn(`[启动] 尝试恢复主 Renderer（${rendererRecoveryAttempts.length}/2）`)
        void loadRenderer().catch((error) => {
          console.error('[启动] 主 Renderer 自动恢复失败:', error)
          showRendererFailure(`Renderer 进程异常退出：${details.reason}`)
        })
        return
      }
      showRendererFailure(`Renderer 进程异常退出：${details.reason}\n退出码：${details.exitCode}`)
    })

    window.once('ready-to-show', () => {
      if (savedState?.isMaximized ?? true) window.maximize()
      if (process.platform === 'darwin' && app.dock) void app.dock.show()
      this.dismissStartupSplash()
      window.show()
    })

    // 尺寸和位置密集变化只在静止 500ms 后落盘。
    let stateSaveTimer: ReturnType<typeof setTimeout> | null = null
    const flushState = (): void => {
      if (stateSaveTimer) clearTimeout(stateSaveTimer)
      stateSaveTimer = null
      this.saveMainWindowState(window)
    }
    const scheduleStateSave = (): void => {
      if (stateSaveTimer) clearTimeout(stateSaveTimer)
      stateSaveTimer = setTimeout(flushState, 500)
    }
    window.on('resize', scheduleStateSave)
    window.on('move', scheduleStateSave)
    window.on('focus', this.options.onAttentionAcknowledged)
    window.on('show', this.options.onAttentionAcknowledged)
    window.on('resize', () => {
      if (!window.isDestroyed()) window.webContents.send(WINDOW_IPC_CHANNELS.ON_RESIZE)
    })

    window.webContents.on('will-navigate', (event, url) => {
      if (url === rendererEntryUrl) {
        hasShownRendererFailure = false
        rendererRecoveryAttempts = []
        return
      }
      if (isDev && this.isDevServerNavigation(url)) return
      event.preventDefault()
      if (url.startsWith('http://') || url.startsWith('https://')) void shell.openExternal(url)
    })
    window.webContents.setWindowOpenHandler(({ url }) => {
      if (url.startsWith('http://') || url.startsWith('https://')) void shell.openExternal(url)
      return { action: 'deny' }
    })

    if (isDev) window.webContents.openDevTools()
    void loadRenderer().catch((error) => {
      console.error('[启动] 主 Renderer 初始加载失败:', error)
      showRendererFailure(error instanceof Error ? error.message : String(error))
    })

    window.on('close', (event) => {
      if (!getIsQuitting() && (process.platform === 'darwin' || this.options.hasTray())) {
        event.preventDefault()
        flushState()
        this.hide()
      }
    })
    window.on('closed', () => {
      if (stateSaveTimer) clearTimeout(stateSaveTimer)
      if (this.mainWindow === window) this.mainWindow = null
      setStoredMainWindow(null)
    })
  }

  /** 应用退出时清理仍存在的启动页引用。 */
  dispose(): void {
    this.dismissStartupSplash()
  }

  private getInitialBounds(savedState: AppSettings['mainWindowState']): Partial<WindowBounds> {
    if (!savedState) return { width: DEFAULT_MAIN_WINDOW_WIDTH, height: DEFAULT_MAIN_WINDOW_HEIGHT }
    return normalizeWindowBoundsToVisibleArea(
      savedState,
      screen.getAllDisplays(),
      screen.getPrimaryDisplay(),
      this.getBoundsOptions(),
    )
  }

  private ensureWindowOnScreen(window: BrowserWindow): void {
    const repositioned = ensureWindowBoundsVisible(
      window,
      screen.getAllDisplays(),
      screen.getPrimaryDisplay(),
      this.getBoundsOptions(),
    )
    if (repositioned) console.log('[窗口] 窗口已重新定位到主显示器可见区域')
  }

  private getBoundsOptions() {
    return {
      minWidth: MIN_MAIN_WINDOW_WIDTH,
      minHeight: MIN_MAIN_WINDOW_HEIGHT,
      fallbackWidth: DEFAULT_MAIN_WINDOW_WIDTH,
      fallbackHeight: DEFAULT_MAIN_WINDOW_HEIGHT,
    }
  }

  private saveMainWindowState(window: BrowserWindow): void {
    if (window.isDestroyed()) return
    const mainWindowState = getPersistableMainWindowState(window)
    if (mainWindowState) updateSettings({ mainWindowState })
  }

  private dismissStartupSplash(): void {
    if (this.startupSplashWindow && !this.startupSplashWindow.isDestroyed()) {
      this.startupSplashWindow.destroy()
    }
    this.startupSplashWindow = null
  }

  private isDevServerNavigation(url: string): boolean {
    try { return new URL(url).origin === 'http://127.0.0.1:5173' }
    catch { return false }
  }
}
