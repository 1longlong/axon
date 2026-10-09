import { app, dialog, globalShortcut, Menu } from 'electron'
import { join } from 'node:path'
import type { QuickChatShortcutBinding } from '@axon/shared'
import { registerIpcHandlers } from './ipc'
import { createApplicationMenu } from './menu'
import { createTray, destroyTray, hasTray, refreshTrayContextMenu } from './tray'
import type { TrayProjectMenuItem } from './lib/desktop/tray-menu-model'
import { getIsQuitting, setQuitting } from './lib/desktop/app-lifecycle'
import { getDesktopBackendPaths } from './lib/desktop/backend-paths'
import { DockAgentFeedbackController } from './lib/desktop/dock-agent-feedback'
import { MainWindowController } from './lib/desktop/main-window-controller'
import { QuickChatShortcutService } from './lib/desktop/quick-chat-shortcut-service'
import { QuickChatWindowManager } from './lib/desktop/quick-chat-window-manager'
import { isQuickChatWindowOwner } from './lib/desktop/quick-chat-window-owner'
import { AppServerProcess } from './lib/desktop/app-server-process'
import { createDesktopAppServerLaunch } from './lib/desktop/app-server-launch'
import { AppServerWindowClients } from './lib/desktop/app-server-window-clients'
import { AppServerEvents } from './lib/desktop/app-server-events'
import { AppServerDesktopSettings } from './lib/desktop/app-server-desktop-settings'
import { AppServerSettingsTransaction } from './lib/desktop/app-server-settings-transaction'
import { createAppServerChannelTargetConfirmation } from './lib/desktop/app-server-channel-target'
import { showChannelTargetConfirmation } from './lib/desktop/native-backend-dialogs'
import { createElectronCredentialCodec } from './lib/channel/electron-channel-credential-codec'

// 开发与正式版隔离 Chromium 锁；业务目录另由可信启动参数交给子进程。
if (!app.isPackaged) {
  const instance = process.env.AXON_DEV_INSTANCE?.replace(/[^a-zA-Z0-9_-]/g, '')
  if (instance) app.setName('Axon-' + instance)
  app.setPath('userData', join(app.getPath('appData'), instance ? '@axon/electron-dev-' + instance : '@axon/electron-dev'))
}

let backend: AppServerProcess | undefined
let clients: AppServerWindowClients | undefined
let events: AppServerEvents | undefined
let desktopSettings: AppServerDesktopSettings | undefined
let settingsTransaction: AppServerSettingsTransaction | undefined
let disposeIpc: (() => void) | undefined
let dockFeedback: DockAgentFeedbackController | undefined
let shortcuts: QuickChatShortcutService | undefined
let trayProjects: TrayProjectMenuItem[] = []
let desktopReady = false
let quitFinished = false
let quitting: Promise<void> | undefined

const mainWindows = new MainWindowController({
  hasTray, onAttentionAcknowledged: () => dockFeedback?.acknowledgeAttention(),
  getWindowState: () => {
    if (!desktopSettings) throw new Error('桌面后端尚未初始化')
    return desktopSettings.settings.mainWindowState
  },
  saveWindowState: (state) => {
    if (!desktopSettings) throw new Error('桌面后端尚未初始化')
    return desktopSettings.saveWindowState(state)
  },
})
const quickChatWindows = new QuickChatWindowManager()

/** 唤起只消费就绪桌面；第二实例不能在后端握手前创建会读取设置的正式窗口。 */
function showMainWindow(): void {
  if (getIsQuitting()) return
  if (desktopReady) mainWindows.showAndFocus()
  else if (app.isReady()) mainWindows.createStartupSplashWindow()
}

if (!app.requestSingleInstanceLock()) app.quit()
else app.on('second-instance', showMainWindow)
for (const stream of [process.stdout, process.stderr]) {
  stream.on('error', (error: NodeJS.ErrnoException) => { if (error.code !== 'EPIPE') throw error })
}

/** 查询真实会话后复核仍是当前快捷键；迟到查询和退出不能唤起旧绑定。 */
async function openShortcut(binding: QuickChatShortcutBinding): Promise<void> {
  try {
    const title = await desktopSettings!.getShortcutTitle(binding)
    if (title !== undefined && !getIsQuitting() && backend?.state === 'ready' && shortcuts?.isCurrent(binding)) {
      quickChatWindows.show(binding, title)
    }
  } catch { console.warn('[快捷键] 后端会话查询不可用') }
}

/** 后端开始接收 UI 请求前建立 Dock 投影；页面失效单独撤销所属角标，不接管运行。 */
function setupDockFeedback(): void {
  if (process.platform !== 'darwin' || !app.dock) return
  const dock = app.dock
  dockFeedback = new DockAgentFeedbackController({
    dock: { setBadge: (text) => dock.setBadge(text), requestAttention: () => dock.bounce('informational'), cancelAttention: (id) => dock.cancelBounce(id) },
    isForeground: () => { const window = mainWindows.getMainWindow(); return !!window?.isVisible() && window.isFocused() },
  })
}

/** 一个父进程只装配一个后端：先私有桥/握手，再可信设置，最后固定 IPC 和原生窗口。 */
async function bootstrap(): Promise<void> {
  if (getIsQuitting()) return
  mainWindows.createStartupSplashWindow()
  Menu.setApplicationMenu(createApplicationMenu())
  safeRun('Dock', setupDockFeedback)
  const paths = getDesktopBackendPaths()
  backend = new AppServerProcess({
    launch: createDesktopAppServerLaunch({ executable: process.execPath, packaged: app.isPackaged, mainDirectory: __dirname,
      resourcesDirectory: process.resourcesPath, dataDir: paths.dataDir, homeDir: paths.homeDir,
      applicationVersion: app.getVersion(), environment: process.env }),
    credentialCodec: createElectronCredentialCodec(),
    confirmChannelTarget: (id, url, signal) => createAppServerChannelTargetConfirmation({ clients: clients!, show: showChannelTargetConfirmation })(id, url, signal),
    configurePeer: (peer) => {
      events = new AppServerEvents(peer, { clients: clients!, desktopSettings,
        onAgentEvent: (id, event) => dockFeedback?.handleEvent(event, id),
        onProjectsChanged: (id, projects) => {
          if (!desktopSettings?.ownsClient(id)) return
          trayProjects = projects.map(({ id, name }) => ({ id, name }))
          safeRun('托盘项目更新', refreshTrayContextMenu)
        },
      })
    },
    onState: (state) => {
      if (state !== 'unavailable') return
      safeRun('设置事务释放', () => settingsTransaction?.dispose())
      safeRun('快捷键释放', () => shortcuts?.dispose())
      safeRun('Dock 释放', () => dockFeedback?.dispose())
      console.warn('[应用服务] 后端连接不可用；不会回退或重发请求')
    },
  })
  clients = new AppServerWindowClients({ backend,
    kindOf: (sender) => sender === mainWindows.getMainWindow()?.webContents ? 'main' : isQuickChatWindowOwner(sender.id) ? 'quick' : undefined,
    onDetached: (id) => dockFeedback?.detachClient(id),
  })
  desktopSettings = new AppServerDesktopSettings({ backend })
  await backend.start()
  const settings = await desktopSettings.readSettings()
  trayProjects = (await desktopSettings.listProjects()).map(({ id, name }) => ({ id, name }))
  dockFeedback?.initialize(await desktopSettings.listActiveRuns())
  if (getIsQuitting()) return

  // 会话存在性由后端预检/保存复核；原生注册器只处理系统占用和已提交绑定。
  shortcuts = new QuickChatShortcutService(globalShortcut, () => true, (binding) => { void openShortcut(binding) })
  settingsTransaction = new AppServerSettingsTransaction({ shortcuts, readSettings: () => desktopSettings!.readSettings() })
  for (const binding of settings.quickChatShortcuts) {
    if (getIsQuitting()) return
    try { await desktopSettings.validateShortcut(binding); shortcuts.restore([binding]) }
    catch { console.warn('[快捷键] 绑定恢复失败，已跳过该项') }
  }
  if (getIsQuitting()) return
  if (backend.state !== 'ready') throw new Error('后端连接不可用')
  disposeIpc = registerIpcHandlers({ backend, clients, interactions: events!, transaction: settingsTransaction })
  safeRun('系统托盘', () => {
    createTray({ isMainWindowVisible: () => mainWindows.getMainWindow()?.isVisible() ?? false,
      showMainWindow, hideMainWindow: () => mainWindows.hide(), listProjects: () => trayProjects,
      dispatchAction: (action) => { if (!getIsQuitting()) mainWindows.dispatchDesktopAction(action) }, quit: () => app.quit() })
  })
  if (process.platform === 'darwin' && app.dock) {
    const icon = mainWindows.getApplicationIcon()
    if (!icon.isEmpty()) app.dock.setIcon(icon)
    await app.dock.show()
  }
  if (getIsQuitting()) return
  desktopReady = true
  mainWindows.createMainWindow()
  app.on('activate', showMainWindow)
}

/** 可选原生能力的失败不影响业务请求；日志不回显后端配置或凭据。 */
function safeRun(name: string, action: () => void): void {
  try { action() } catch { console.warn('[桌面] ' + name + ' 不可用') }
}

/** 启动失败显示固定诊断并退出；不重新装配业务或创建能写盘的降级后端。 */
function handleBootstrapFailure(): void {
  if (getIsQuitting()) return
  console.error('[启动] 独立后端或桌面初始化失败')
  mainWindows.dispose()
  dialog.showErrorBox('Axon 启动失败', '独立后端或桌面初始化失败。请重新启动 Axon；不会切换到其他后端或重新发送消息。')
  app.quit()
}

/** 先禁止新入口和原生键，再 flush 窗口补丁，最后收束唯一子进程；业务 drain 由子端负责。 */
async function shutdown(): Promise<void> {
  setQuitting(); desktopReady = false
  // 单个原生资源释放失败不能跳过窗口保存或唯一后端的停止。
  safeRun('设置事务释放', () => settingsTransaction?.dispose())
  safeRun('快捷键释放', () => shortcuts?.dispose())
  safeRun('快捷窗口释放', () => quickChatWindows.dispose())
  try { await mainWindows.flushWindowState() }
  finally {
    // 先停止页面的防抖生产者，再撤销 IPC；避免退出时仍有页面调用已删除通道。
    safeRun('主窗口释放', () => mainWindows.dispose())
    safeRun('事件释放', () => events?.dispose())
    safeRun('页面身份释放', () => clients?.dispose())
    safeRun('IPC 释放', () => disposeIpc?.())
    try { await desktopSettings?.dispose() }
    finally {
      try { await backend?.stop() }
      finally {
        safeRun('Dock 释放', () => dockFeedback?.dispose())
        safeRun('托盘释放', destroyTray)
      }
    }
  }
}

app.whenReady().then(bootstrap).catch(handleBootstrapFailure)
app.on('window-all-closed', () => { if (process.platform !== 'darwin' && !hasTray()) app.quit() })
app.on('before-quit', (event) => {
  if (quitFinished) return
  event.preventDefault()
  quitting ??= shutdown().catch(() => { console.warn('[退出] 后端退出未完全确认') }).finally(() => {
    quitFinished = true
    app.quit()
  })
})
