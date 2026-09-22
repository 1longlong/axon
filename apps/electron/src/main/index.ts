import { app, dialog, globalShortcut, Menu } from 'electron'
import { join } from 'node:path'
import type { QuickChatShortcutBinding } from '../types'
import { registerIpcHandlers } from './ipc'
import { createApplicationMenu } from './menu'
import { createTray, destroyTray, hasTray } from './tray'
import { getAgentAskUserService } from './lib/agent/agent-ask-user-service'
import {
  disposeAgentRuntimeAdapters,
  getAgentEventBus,
  getAgentService,
  stopAllAgentRuns,
} from './lib/agent/agent-service-instance'
import { getAgentExitPlanService } from './lib/agent/agent-exit-plan-service'
import { getAgentPermissionService } from './lib/agent/agent-permission-service'
import { getAgentSessionManager } from './lib/agent/agent-session-manager-instance'
import { stopAllChatGenerations } from './lib/chat/chat-service-instance'
import { getConversationManager } from './lib/chat/conversation-manager-instance'
import { getAgentDelegationManager } from './lib/collaboration/agent-delegation-manager-instance'
import { setQuitting } from './lib/desktop/app-lifecycle'
import { DockAgentFeedbackController } from './lib/desktop/dock-agent-feedback'
import { MainWindowController } from './lib/desktop/main-window-controller'
import { QuickChatShortcutService } from './lib/desktop/quick-chat-shortcut-service'
import { QuickChatWindowManager } from './lib/desktop/quick-chat-window-manager'
import { disposeMcpToolProvider } from './lib/mcp/mcp-tool-provider-instance'
import { getAgentProjectManager } from './lib/project/agent-project-manager-instance'
import { getSettings } from './lib/settings/settings-service'

// Dev 与正式版使用独立 userData；worktree 可再用显式实例名隔离 Chromium 锁。
if (!app.isPackaged) {
  const instance = process.env.AXON_DEV_INSTANCE?.replace(/[^a-zA-Z0-9_-]/g, '')
  if (instance) app.setName(`Axon-${instance}`)
  app.setPath('userData', join(app.getPath('appData'), instance ? `@axon/electron-dev-${instance}` : '@axon/electron-dev'))
}

let dockFeedback: DockAgentFeedbackController | null = null
let disposeDockFeedbackSubscriptions: (() => void) | null = null
let quickChatShortcutService: QuickChatShortcutService | null = null

const mainWindows = new MainWindowController({
  hasTray,
  onAttentionAcknowledged: () => dockFeedback?.acknowledgeAttention(),
})
const quickChatWindows = new QuickChatWindowManager()

// 单实例失败时由已有进程的 second-instance 事件负责恢复主窗口。
if (!app.requestSingleInstanceLock()) {
  console.warn(
    '[启动] 已有 Axon 进程持有单实例锁，本次启动将退出。\n'
      + '  如果窗口未出现，可能旧进程已卡死。请运行 `killall Axon`（开发模式 `killall Electron`）后重试。',
  )
  app.quit()
} else {
  app.on('second-instance', () => mainWindows.showAndFocus())
}

// dev 脚本重启可能先关闭输出管道，EPIPE 不应使桌面进程崩溃。
process.stdout?.on?.('error', (error: NodeJS.ErrnoException) => {
  if (error.code !== 'EPIPE') throw error
})
process.stderr?.on?.('error', (error: NodeJS.ErrnoException) => {
  if (error.code !== 'EPIPE') throw error
})

/**
 * 启动应用服务并按依赖顺序建立 IPC、快捷键、Dock、托盘和主窗口。
 * 非关键桌面能力失败时被隔离，主窗口仍应尽量创建。
 */
async function bootstrap(): Promise<void> {
  mainWindows.createStartupSplashWindow()
  Menu.setApplicationMenu(createApplicationMenu())

  // 子任务状态须在 IPC 开放前收敛，避免 renderer 读到伪运行态。
  safeRun('Agent 子任务状态收敛', () => {
    const interrupted = getAgentDelegationManager().markRunningDelegationsAsInterrupted()
    if (interrupted.length > 0) console.warn(`[Agent 协作] 已中断 ${interrupted.length} 个遗留子任务`)
  })

  const resolveShortcutSession = (binding: QuickChatShortcutBinding) => {
    if (binding.sessionType === 'chat') return getConversationManager().get(binding.sessionId)
    const session = getAgentSessionManager().get(binding.sessionId)
    return session?.parentSessionId ? undefined : session
  }
  quickChatShortcutService = new QuickChatShortcutService(
    globalShortcut,
    (binding) => {
      try { return !!resolveShortcutSession(binding) }
      catch { return false }
    },
    (binding) => {
      const session = resolveShortcutSession(binding)
      if (session) quickChatWindows.show(binding, session.title)
    },
  )

  // IPC 与快捷键设置共享同一注册器实例，保证更新事务可提交或回滚。
  registerIpcHandlers(quickChatShortcutService)
  safeRun('全局快捷键恢复', () => quickChatShortcutService?.restore(getSettings().quickChatShortcuts))
  setupDockFeedback()

  // 非 macOS 只有托盘成功后才允许关闭主窗口转为后台驻留。
  safeRun('系统托盘', () => {
    createTray({
      isMainWindowVisible: () => mainWindows.getMainWindow()?.isVisible() ?? false,
      showMainWindow: () => mainWindows.showAndFocus(),
      hideMainWindow: () => mainWindows.hide(),
      listProjects: () => getAgentProjectManager().list().map(({ id, name }) => ({ id, name })),
      dispatchAction: (action) => mainWindows.dispatchDesktopAction(action),
      quit: () => app.quit(),
    })
  })

  if (process.platform === 'darwin' && app.dock) {
    const applicationIcon = mainWindows.getApplicationIcon()
    if (!applicationIcon.isEmpty()) app.dock.setIcon(applicationIcon)
    await app.dock.show()
  }

  mainWindows.createMainWindow()
  app.on('activate', () => mainWindows.showAndFocus())
}

/** 订阅权威 Agent 生命周期并投影到 macOS Dock；其他平台直接跳过。 */
function setupDockFeedback(): void {
  if (process.platform !== 'darwin' || !app.dock || dockFeedback) return
  const dock = app.dock
  dockFeedback = new DockAgentFeedbackController({
    dock: {
      setBadge: (text) => dock.setBadge(text),
      requestAttention: () => dock.bounce('informational'),
      cancelAttention: (id) => dock.cancelBounce(id),
    },
    isForeground: () => {
      const window = mainWindows.getMainWindow()
      return !!window && window.isVisible() && window.isFocused()
    },
  })
  dockFeedback.initialize(getAgentService().listActiveRuns())
  const subscriptions = [
    getAgentEventBus().subscribe((event) => dockFeedback?.handleEvent(event)),
    getAgentPermissionService().subscribe((event) => dockFeedback?.handleEvent(event)),
    getAgentAskUserService().subscribe((event) => dockFeedback?.handleEvent(event)),
    getAgentExitPlanService().subscribe((event) => dockFeedback?.handleEvent(event)),
  ]
  disposeDockFeedbackSubscriptions = () => {
    for (const unsubscribe of subscriptions) unsubscribe()
  }
}

/** 同步启动钩子隔离；可选桌面能力失败只记录日志，不截断启动链。 */
function safeRun(name: string, run: () => void): void {
  try { run() }
  catch (error) { console.error(`[启动] ${name} 失败（已隔离）:`, error) }
}

/** 顶层启动兜底；展示诊断后仍尝试开放 IPC 并创建降级窗口。 */
function handleBootstrapFailure(error: unknown): void {
  console.error('[启动] bootstrap 致命错误，进入降级模式:', error)
  try {
    const message = error instanceof Error ? (error.stack ?? error.message) : String(error)
    dialog.showErrorBox(
      'Axon 启动遇到错误',
      `部分功能可能不可用：\n\n${message}\n\n`
        + `日志位置：${app.getPath('logs')}\n\n`
        + '常见原因与排查：\n'
        + '1. 旧版 Axon 进程未退出（终端运行 killall Axon 后重试）\n'
        + '2. ~/.axon/ 配置损坏（重命名 ~/.axon 后重启）\n\n'
        + '如需协助请到 GitHub Issues 反馈。',
    )
  } catch {
    // 原生 dialog 也不可用时只保留 stderr 日志。
  }
  try {
    safeRun('registerIpcHandlers', registerIpcHandlers)
    mainWindows.createMainWindow()
  } catch (fallbackError) {
    console.error('[启动] 降级窗口创建也失败:', fallbackError)
  }
}

app.whenReady().then(bootstrap).catch(handleBootstrapFailure)

app.on('window-all-closed', () => {
  if (process.platform !== 'darwin' && !hasTray()) app.quit()
})

app.on('before-quit', () => {
  // 先切换退出语义，再销毁窗口，避免 close handler 把退出改成隐藏。
  setQuitting()
  quickChatWindows.dispose()
  quickChatShortcutService?.dispose()
  quickChatShortcutService = null
  stopAllChatGenerations()
  stopAllAgentRuns()
  disposeAgentRuntimeAdapters()
  disposeMcpToolProvider()
  disposeDockFeedbackSubscriptions?.()
  disposeDockFeedbackSubscriptions = null
  dockFeedback?.dispose()
  dockFeedback = null
  mainWindows.dispose()
  destroyTray()
})
