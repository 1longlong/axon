/** 主进程 IPC 装配入口；具体通道绑定按领域位于 `main/ipc/`。 */

import { AGENT_IPC_CHANNELS } from '@axon/shared'
import { AgentIpcController } from './lib/agent/agent-ipc-handlers'
import {
  getAgentCollaborationService,
  getAgentEventBus,
  getAgentService,
  validateAgentRuntimeCreate,
} from './lib/agent/agent-service-instance'
import { getAgentSessionManager } from './lib/agent/agent-session-manager-instance'
import { getAgentPermissionService } from './lib/agent/agent-permission-service'
import { getAgentAskUserService } from './lib/agent/agent-ask-user-service'
import { getAgentExitPlanService } from './lib/agent/agent-exit-plan-service'
import { getAttachmentService } from './lib/chat/attachment-service-instance'
import { ChatIpcController } from './lib/chat/chat-ipc-handlers'
import { getChannelManager } from './lib/channel/channel-manager-instance'
import { getChatService } from './lib/chat/chat-service-instance'
import { getConversationManager } from './lib/chat/conversation-manager-instance'
import type { QuickChatShortcutService } from './lib/desktop/quick-chat-shortcut-service'
import { getMainWindow } from './lib/desktop/main-window-store'
import { AgentProjectIpcController } from './lib/project/agent-project-ipc-handlers'
import { getAgentProjectManager } from './lib/project/agent-project-manager-instance'
import { getWorkspaceWatcher } from './lib/project/workspace-watcher-instance'
import { McpProjectIpcController } from './lib/mcp/mcp-project-ipc-handlers'
import { getMcpProjectConfigManager } from './lib/mcp/mcp-project-config-manager-instance'
import { getMcpToolProvider } from './lib/mcp/mcp-tool-provider-instance'
import { AgentMemoryIpcController } from './lib/memory/agent-memory-ipc-handlers'
import { getAgentMemoryService } from './lib/memory/agent-memory-service-instance'
import { getAgentMemoryWatcher } from './lib/memory/agent-memory-watcher-instance'
import { buildBackgroundTaskNotificationPrompt } from './lib/collaboration/agent-collaboration-tools'
import { AgentTaskIpcController } from './lib/collaboration/agent-task-ipc-handlers'
import { getAgentDelegationManager } from './lib/collaboration/agent-delegation-manager-instance'
import { refreshTrayContextMenu } from './tray'
import { registerAgentIpcHandlers } from './ipc/agent-ipc-handlers'
import { registerAgentMemoryIpcHandlers } from './ipc/agent-memory-ipc-handlers'
import { registerAgentSkillIpcHandlers } from './ipc/agent-skill-ipc-handlers'
import { pickAgentProjectRoot, registerAgentProjectIpcHandlers } from './ipc/agent-project-ipc-handlers'
import { registerAgentTaskIpcHandlers } from './ipc/agent-task-ipc-handlers'
import { registerAttachmentIpcHandlers } from './ipc/attachment-ipc-handlers'
import { registerChannelIpcHandlers } from './ipc/channel-ipc-handlers'
import { registerChatIpcHandlers } from './ipc/chat-ipc-handlers'
import { registerMcpProjectIpcHandlers } from './ipc/mcp-project-ipc-handlers'
import { registerSettingsIpcHandlers } from './ipc/settings-ipc-handlers'
import { registerWindowIpcHandlers } from './ipc/window-ipc-handlers'
import { agentSkillSettingsController } from './lib/project/agent-skill-settings-controller-instance'

/** 装配全部领域 registrar；跨领域后台续跑在 controller 都创建后绑定。 */
export function registerIpcHandlers(shortcuts?: QuickChatShortcutService): void {
  registerChannelIpcHandlers(getChannelManager())
  registerAttachmentIpcHandlers(getAttachmentService())
  registerChatIpcHandlers(new ChatIpcController({
    conversations: getConversationManager(),
    chat: getChatService(),
    attachments: getAttachmentService(),
  }))

  const projectManager = getAgentProjectManager()
  const agentController = new AgentIpcController({
    sessions: getAgentSessionManager(),
    agent: getAgentService(),
    events: getAgentEventBus(),
    permissions: getAgentPermissionService(),
    askUsers: getAgentAskUserService(),
    exitPlans: getAgentExitPlanService(),
    validateCreate: validateAgentRuntimeCreate,
  })
  // 后台子任务结束时由当前主窗口承接隐藏续跑；无窗口时保留任务结果供稍后查询。
  getAgentCollaborationService().setBackgroundCompletionHandler(async (delegation) => {
    const window = getMainWindow()
    if (!window || window.webContents.isDestroyed()) throw new Error('主窗口不可用')
    const result = await agentController.sendBackgroundNotification(
      window.webContents.id,
      {
        sessionId: delegation.rootSessionId,
        text: buildBackgroundTaskNotificationPrompt(delegation),
      },
      (agentEvent) => {
        if (!window.webContents.isDestroyed()) window.webContents.send(AGENT_IPC_CHANNELS.EVENT, agentEvent)
      },
    )
    if (!result.success) throw new Error(result.message)
  })
  registerAgentIpcHandlers(agentController, {
    resolveProjectCwd: (projectId) => projectManager.resolveProjectCwd(projectId),
  })
  registerAgentTaskIpcHandlers(new AgentTaskIpcController({
    sessions: getAgentSessionManager(),
    tasks: getAgentDelegationManager(),
    events: getAgentEventBus(),
  }))
  registerAgentProjectIpcHandlers(new AgentProjectIpcController({
    projects: projectManager,
    sessions: getAgentSessionManager(),
    watcher: getWorkspaceWatcher(),
  }), {
    pickLocalWorkspace: pickAgentProjectRoot,
    onProjectsChanged: refreshTrayContextMenu,
  })
  registerMcpProjectIpcHandlers(new McpProjectIpcController({
    configs: getMcpProjectConfigManager(),
    tools: getMcpToolProvider(),
    projects: projectManager,
  }))
  registerAgentMemoryIpcHandlers(new AgentMemoryIpcController({
    memory: getAgentMemoryService(),
    projects: projectManager,
    watcher: getAgentMemoryWatcher(),
  }))
  registerAgentSkillIpcHandlers(agentSkillSettingsController)

  registerSettingsIpcHandlers(shortcuts)
  registerWindowIpcHandlers()
}
