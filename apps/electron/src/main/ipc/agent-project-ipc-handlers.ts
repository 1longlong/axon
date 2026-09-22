/** Agent 项目、工作区选择和文件面板的 Electron 通道绑定。 */

import { BrowserWindow, dialog, ipcMain } from 'electron'
import type { IpcMainInvokeEvent, WebContents } from 'electron'
import { basename } from 'node:path'
import { AGENT_PROJECT_IPC_CHANNELS } from '@axon/shared'
import type { AgentWorkspaceDirectoryChangedEvent, AgentWorkspaceDirectorySelection } from '@axon/shared'
import type { AgentProjectIpcController } from '../lib/project/agent-project-ipc-handlers'
import { assertMainFrame } from './assert-main-frame'

export interface AgentProjectIpcRegistrationOptions {
  pickLocalWorkspace?: (sender: WebContents) => Promise<AgentWorkspaceDirectorySelection>
  onProjectsChanged?: () => void
}

/** 只把用户在原生对话框明确选中的目录返回 renderer。 */
export async function pickAgentProjectRoot(sender: WebContents): Promise<AgentWorkspaceDirectorySelection> {
  const window = BrowserWindow.fromWebContents(sender)
  if (!window || window.isDestroyed()) throw new Error('Agent 窗口不可用')
  const result = await dialog.showOpenDialog(window, {
    title: '选择 Agent 本地项目目录',
    properties: ['openDirectory', 'createDirectory'],
  })
  if (result.canceled || !result.filePaths[0]) return { canceled: true }
  const path = result.filePaths[0]
  return { canceled: false, path, suggestedName: basename(path) || '本地项目' }
}

/** 注册项目 CRUD 与工作区文件能力；窗口结束时释放其目录监听。 */
export function registerAgentProjectIpcHandlers(
  controller: AgentProjectIpcController,
  options: AgentProjectIpcRegistrationOptions = {},
): void {
  const watched = new WeakSet<WebContents>()
  const watchOwner = (sender: WebContents): void => {
    if (watched.has(sender)) return
    watched.add(sender)
    const cleanup = (): void => controller.clearDirectoryWatches(sender.id)
    sender.on('destroyed', cleanup)
    sender.on('render-process-gone', cleanup)
    sender.on('did-start-loading', cleanup)
  }
  const handle = (
    channel: string,
    handler: (event: IpcMainInvokeEvent, ...args: unknown[]) => unknown,
  ): void => {
    ipcMain.handle(channel, (event, ...args: unknown[]) => {
      assertMainFrame(event, 'Agent 项目')
      return handler(event, ...args)
    })
  }
  handle(AGENT_PROJECT_IPC_CHANNELS.LIST, () => controller.list())
  handle(AGENT_PROJECT_IPC_CHANNELS.GET, (_event, id) => controller.get(id))
  handle(AGENT_PROJECT_IPC_CHANNELS.CREATE, (_event, input) => {
    const project = controller.create(input)
    options.onProjectsChanged?.()
    return project
  })
  handle(AGENT_PROJECT_IPC_CHANNELS.UPDATE, (_event, id, input) => {
    const project = controller.update(id, input)
    options.onProjectsChanged?.()
    return project
  })
  handle(AGENT_PROJECT_IPC_CHANNELS.DELETE, (_event, id) => {
    const project = controller.delete(id)
    options.onProjectsChanged?.()
    return project
  })
  handle(AGENT_PROJECT_IPC_CHANNELS.PICK_LOCAL_WORKSPACE, async (event) => {
    if (!options.pickLocalWorkspace) throw new Error('目录选择器不可用')
    return options.pickLocalWorkspace(event.sender)
  })
  handle(AGENT_PROJECT_IPC_CHANNELS.LIST_DIRECTORY, (_event, id) => controller.listDirectory(id))
  handle(AGENT_PROJECT_IPC_CHANNELS.READ_FILE, (_event, id, relativePath) => controller.readFile(id, relativePath))
  handle(AGENT_PROJECT_IPC_CHANNELS.READ_DIFF, (_event, id, relativePath) => controller.readDiff(id, relativePath))
  handle(AGENT_PROJECT_IPC_CHANNELS.WATCH_DIRECTORY, (event, id) => {
    const sender = event.sender
    watchOwner(sender)
    controller.watchDirectory(sender.id, id, (changedAt) => {
      if (sender.isDestroyed()) return
      const change: AgentWorkspaceDirectoryChangedEvent = {
        projectId: typeof id === 'string' ? id.trim() : '',
        changedAt,
      }
      sender.send(AGENT_PROJECT_IPC_CHANNELS.DIRECTORY_CHANGED, change)
    })
  })
  handle(AGENT_PROJECT_IPC_CHANNELS.UNWATCH_DIRECTORY, (event, id) => controller.unwatchDirectory(event.sender.id, id))
}
