/** Agent 项目记忆读写与变化订阅的 Electron 通道绑定。 */

import { ipcMain } from 'electron'
import type { WebContents } from 'electron'
import { AGENT_MEMORY_IPC_CHANNELS } from '@axon/shared'
import type { AgentMemoryChangedEvent } from '@axon/shared'
import type { AgentMemoryIpcController } from '../lib/memory/agent-memory-ipc-handlers'
import { assertMainFrame } from './assert-main-frame'

/** 注册项目记忆入口；窗口重载或销毁时释放它持有的监听资源。 */
export function registerAgentMemoryIpcHandlers(controller: AgentMemoryIpcController): void {
  const watched = new WeakSet<WebContents>()
  const watchOwner = (sender: WebContents): void => {
    if (watched.has(sender)) return
    watched.add(sender)
    const cleanup = (): void => controller.clearWatches(sender.id)
    sender.on('destroyed', cleanup)
    sender.on('render-process-gone', cleanup)
    sender.on('did-start-loading', cleanup)
  }
  ipcMain.handle(AGENT_MEMORY_IPC_CHANNELS.LIST, (event, projectId: unknown) => {
    assertMainFrame(event, 'Agent 项目记忆')
    return controller.list(projectId)
  })
  ipcMain.handle(AGENT_MEMORY_IPC_CHANNELS.READ, (event, projectId: unknown, relativePath: unknown) => {
    assertMainFrame(event, 'Agent 项目记忆')
    return controller.read(projectId, relativePath)
  })
  ipcMain.handle(AGENT_MEMORY_IPC_CHANNELS.WRITE, (event, projectId: unknown, relativePath: unknown, content: unknown) => {
    assertMainFrame(event, 'Agent 项目记忆')
    return controller.write(projectId, relativePath, content)
  })
  ipcMain.handle(AGENT_MEMORY_IPC_CHANNELS.WATCH, (event, projectId: unknown) => {
    assertMainFrame(event, 'Agent 项目记忆')
    const sender = event.sender
    watchOwner(sender)
    controller.watch(sender.id, projectId, (changedAt, relativePath) => {
      if (sender.isDestroyed()) return
      const change: AgentMemoryChangedEvent = {
        projectId: typeof projectId === 'string' ? projectId.trim() : '',
        changedAt,
        ...(relativePath ? { relativePath } : {}),
      }
      sender.send(AGENT_MEMORY_IPC_CHANNELS.CHANGED, change)
    })
  })
  ipcMain.handle(AGENT_MEMORY_IPC_CHANNELS.UNWATCH, (event, projectId: unknown) => {
    assertMainFrame(event, 'Agent 项目记忆')
    controller.unwatch(event.sender.id, projectId)
  })
}
