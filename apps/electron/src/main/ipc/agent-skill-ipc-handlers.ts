/** Agent Skills 设置的 Electron IPC 绑定。 */

import { ipcMain } from 'electron'
import { AGENT_SKILL_IPC_CHANNELS } from '@axon/shared'
import type { AgentSkillSettingsController } from '../lib/project/agent-skill-settings-controller'
import { assertMainFrame } from './assert-main-frame'

/** 只允许主 frame 查询摘要或提交期望集合；文件操作仍封装在 controller/service 内。 */
export function registerAgentSkillIpcHandlers(controller: AgentSkillSettingsController): void {
  ipcMain.handle(AGENT_SKILL_IPC_CHANNELS.GET_SETTINGS, (event) => {
    assertMainFrame(event, 'Agent Skills 设置')
    return controller.getSnapshot()
  })
  ipcMain.handle(AGENT_SKILL_IPC_CHANNELS.APPLY_SETTINGS, (event, catalogIds: unknown) => {
    assertMainFrame(event, 'Agent Skills 设置')
    return controller.apply(catalogIds)
  })
}
