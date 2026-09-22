/** 子 Agent 任务快照与详情的 Electron 通道绑定。 */

import { ipcMain } from 'electron'
import type { IpcMainInvokeEvent } from 'electron'
import { AGENT_TASK_IPC_CHANNELS } from '@axon/shared'
import type { AgentTaskEvent } from '@axon/shared'
import type { AgentTaskIpcController } from '../lib/collaboration/agent-task-ipc-handlers'
import { getMainWindow } from '../lib/desktop/main-window-store'
import { assertMainFrame } from './assert-main-frame'

/** 注册根会话内任务投影；完整子会话消息仍从会话 JSONL 读取。 */
export function registerAgentTaskIpcHandlers(controller: AgentTaskIpcController): void {
  controller.subscribe((taskEvent: AgentTaskEvent) => {
    const window = getMainWindow()
    if (window && !window.isDestroyed()) window.webContents.send(AGENT_TASK_IPC_CHANNELS.EVENT, taskEvent)
  })
  const handle = (
    channel: string,
    handler: (event: IpcMainInvokeEvent, ...args: unknown[]) => unknown,
  ): void => {
    ipcMain.handle(channel, (event, ...args: unknown[]) => {
      assertMainFrame(event, 'Agent 子任务')
      return handler(event, ...args)
    })
  }
  handle(AGENT_TASK_IPC_CHANNELS.LIST, (_event, rootSessionId) => controller.list(rootSessionId))
  handle(AGENT_TASK_IPC_CHANNELS.GET, (_event, rootSessionId, taskId) => controller.get(rootSessionId, taskId))
  handle(AGENT_TASK_IPC_CHANNELS.GET_MESSAGES, (_event, rootSessionId, taskId) => (
    controller.getMessages(rootSessionId, taskId)
  ))
}
