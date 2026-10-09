/** 桌面冒烟共用独立后端与固定 IPC；默认真实入口，专用模型夹具显式替换测试 child。 */
import { app } from 'electron'
import type { BrowserWindow, WebContents } from 'electron'
import { resolve } from 'node:path'
import { APP_SERVER_METHODS as methods } from '@axon/shared'
import { registerIpcHandlers } from '../src/main/ipc'
import { AppServerProcess } from '../src/main/lib/desktop/app-server-process'
import type { AppServerProcessOptions } from '../src/main/lib/desktop/app-server-process'
import { createDesktopAppServerLaunch } from '../src/main/lib/desktop/app-server-launch'
import { AppServerWindowClients } from '../src/main/lib/desktop/app-server-window-clients'
import { AppServerEvents } from '../src/main/lib/desktop/app-server-events'
import { AppServerDesktopSettings } from '../src/main/lib/desktop/app-server-desktop-settings'
import { AppServerSettingsTransaction } from '../src/main/lib/desktop/app-server-settings-transaction'
import { QuickChatShortcutService } from '../src/main/lib/desktop/quick-chat-shortcut-service'
import { createFixtureCredentialCodec } from '../../../packages/core/test-support/credential-codec'
import type { JsonRpcPeer } from '@axon/app-server'
import type { DesktopIpcOptions } from '../src/main/ipc'

export interface DesktopSmokeBackendOptions {
  directory: string
  mainWindow: BrowserWindow
  confirmChannelTarget?: AppServerProcessOptions['confirmChannelTarget']
  quickWindowKind?: (sender: WebContents) => boolean
  shortcuts?: QuickChatShortcutService
  /** 专用中立 Runtime 夹具只替换测试入口；默认仍是生产 app-server。 */
  entry?: string
  zimaPython?: string
  configurePeer?: (peer: JsonRpcPeer) => void
  pickLocalWorkspace?: DesktopIpcOptions['pickLocalWorkspace']
}

export interface DesktopSmokeBackend {
  backend: AppServerProcess
  clients: AppServerWindowClients
  desktopSettings: AppServerDesktopSettings
  close(): Promise<void>
}

/** 先安装父桥并握手，再绑定全部生产代理；替换入口只服务隔离测试，不进入正式启动。 */
export async function startDesktopSmokeBackend(options: DesktopSmokeBackendOptions): Promise<DesktopSmokeBackend> {
  let clients!: AppServerWindowClients, events: AppServerEvents | undefined
  const backend = new AppServerProcess({
    launch: { ...createDesktopAppServerLaunch({ executable: process.execPath, packaged: false,
      mainDirectory: resolve('dist'), resourcesDirectory: process.resourcesPath,
      dataDir: resolve(options.directory, 'backend'), homeDir: resolve(options.directory),
      applicationVersion: app.getVersion(), environment: { ...process.env, AXON_ZIMA_PYTHON: options.zimaPython } }),
      ...(options.entry ? { entryArgs: [options.entry] } : {}) },
    // 固定测试密钥不触碰用户 Keychain；真实生产安全存储另由生产启动冒烟验证。
    credentialCodec: createFixtureCredentialCodec(), confirmChannelTarget: options.confirmChannelTarget,
    configurePeer: (peer) => {
      events = new AppServerEvents(peer, { clients, desktopSettings: settings })
      options.configurePeer?.(peer)
    },
    stopTimeoutMs: 10_000,
  })
  clients = new AppServerWindowClients({ backend, kindOf: (sender) => {
    if (sender === options.mainWindow.webContents) return 'main'
    return options.quickWindowKind?.(sender) ? 'quick' : undefined
  } })
  const settings = new AppServerDesktopSettings({ backend })
  // 没有快捷键场景时拒绝实际系统注册；本夹具不声称验证原生快捷键占用。
  const ownShortcuts = options.shortcuts ? undefined : new QuickChatShortcutService(
    { register: () => false, unregister: () => {} }, () => true, () => {},
  )
  const transaction = new AppServerSettingsTransaction({ shortcuts: options.shortcuts ?? ownShortcuts!,
    readSettings: () => settings.readSettings() })
  let disposeIpc: (() => void) | undefined, closing: Promise<void> | undefined
  /** 页面由调用方销毁/重载；撤入口后等待自有 child 实际退出，不在父端重建存储。 */
  const close = (): Promise<void> => closing ??= (async () => {
    transaction.dispose()
    ownShortcuts?.dispose()
    events?.dispose()
    clients.dispose()
    disposeIpc?.()
    try { await settings.dispose() } finally { await backend.stop() }
  })()
  try {
    await backend.start()
    if (!backend.pid || backend.pid === process.pid) throw new Error('冒烟未启动独立后端进程')
    const seed = await backend.registerClient('external')
    try { await backend.request(seed.clientId, methods.UPDATE_SETTINGS, { themeMode: 'light' }) }
    finally { await backend.detachClient(seed.clientId) }
    await settings.readSettings()
    disposeIpc = registerIpcHandlers({ backend, clients, interactions: events!, transaction,
      pickLocalWorkspace: options.pickLocalWorkspace })
    return { backend, clients, desktopSettings: settings, close }
  } catch (error) { await close(); throw error }
}
