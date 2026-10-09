/** 桌面 IPC 装配只绑定固定代理；业务服务和持久化统一在独立后端。 */
import { ipcMain } from 'electron'
import type { AppServerProcess } from './lib/desktop/app-server-process'
import type { AppServerWindowClients } from './lib/desktop/app-server-window-clients'
import type { AppServerEvents } from './lib/desktop/app-server-events'
import type { AppServerSettingsTransaction } from './lib/desktop/app-server-settings-transaction'
import { pickAgentProjectRoot } from './lib/desktop/native-backend-dialogs'
import { registerAppServerAgentIpcHandlers } from './ipc/app-server-agent-ipc'
import { registerAppServerChatIpcHandlers } from './ipc/app-server-chat-ipc'
import { registerAppServerChannelIpcHandlers } from './ipc/app-server-channel-ipc'
import { registerAppServerSettingsIpcHandlers } from './ipc/app-server-settings-ipc'
import { registerAppServerProjectIpcHandlers } from './ipc/app-server-project-ipc'
import { registerAppServerMcpIpcHandlers } from './ipc/app-server-mcp-ipc'
import { registerAppServerSkillIpcHandlers } from './ipc/app-server-skill-ipc'
import { registerAppServerTaskIpcHandlers } from './ipc/app-server-task-ipc'
import { registerWindowIpcHandlers } from './ipc/window-ipc-handlers'
import type { AgentWorkspaceDirectorySelection } from '@axon/shared'
import type { WebContents } from 'electron'

export interface DesktopIpcOptions {
  backend: AppServerProcess
  clients: AppServerWindowClients
  interactions: AppServerEvents
  transaction: AppServerSettingsTransaction
  pickLocalWorkspace?: (sender: WebContents) => Promise<AgentWorkspaceDirectorySelection>
}

/** 握手成功后一次装配所有领域；部分绑定失败先撤销本次注册，不启动第二套业务后端。 */
export function registerIpcHandlers(options: DesktopIpcOptions): () => void {
  const releases: Array<() => void> = []
  let disposed = false
  const dispose = (): void => {
    if (disposed) return
    disposed = true
    for (const release of releases.reverse()) {
      try { release() } catch { console.warn('[IPC] 单项释放失败，继续清理其他入口') }
    }
  }
  try {
    releases.push(registerAppServerChannelIpcHandlers(ipcMain, options))
    releases.push(registerAppServerChatIpcHandlers(ipcMain, options))
    releases.push(registerAppServerAgentIpcHandlers(ipcMain, options))
    releases.push(registerAppServerProjectIpcHandlers(ipcMain, { ...options, pickLocalWorkspace: options.pickLocalWorkspace ?? pickAgentProjectRoot }))
    releases.push(registerAppServerMcpIpcHandlers(ipcMain, options))
    releases.push(registerAppServerSkillIpcHandlers(ipcMain, options))
    releases.push(registerAppServerTaskIpcHandlers(ipcMain, options))
    releases.push(registerAppServerSettingsIpcHandlers(ipcMain, options))
    releases.push(registerWindowIpcHandlers())
  } catch (error) { dispose(); throw error }
  return dispose
}
