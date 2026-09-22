/** Agent 会话、交互和生成流的 Electron 通道绑定。 */

import { ipcMain } from 'electron'
import type { IpcMainInvokeEvent, WebContents } from 'electron'
import { AGENT_IPC_CHANNELS } from '@axon/shared'
import type {
  AgentGenerationEvent,
  AgentProviderAdapter,
  AgentQueueSnapshot,
  AgentRuntimeId,
} from '@axon/shared'
import type { AgentIpcController } from '../lib/agent/agent-ipc-handlers'
import { checkAgentEnvironment } from '../lib/agent/agent-environment-service'
import { getAgentProviderAdapter } from '../lib/agent/agent-service-instance'
import type { ChannelManager } from '../lib/channel/channel-manager'
import { getChannelManager } from '../lib/channel/channel-manager-instance'
import { getMainWindow } from '../lib/desktop/main-window-store'
import { isQuickChatSend } from '../lib/desktop/quick-chat-window-owner'
import { assertMainFrame } from './assert-main-frame'

export interface AgentIpcRegistrationOptions {
  resolveProjectCwd?: (projectId: string) => string
  channelManager?: ChannelManager
  resolveAdapter?: (runtimeId: AgentRuntimeId) => AgentProviderAdapter
}

/** 注册 Agent 主链；交互运行定向回送，外部运行和元数据变化广播给主窗口。 */
export function registerAgentIpcHandlers(
  controller: AgentIpcController,
  options: AgentIpcRegistrationOptions = {},
): void {
  // 外部任务没有 renderer owner，必须走常驻订阅；只广播 external 可避免交互事件重复。
  controller.subscribeExternalRuns((agentEvent) => {
    const window = getMainWindow()
    if (window && !window.isDestroyed()) window.webContents.send(AGENT_IPC_CHANNELS.EVENT, agentEvent)
  })
  controller.subscribeSessionMetadata((agentEvent) => {
    const window = getMainWindow()
    if (window && !window.isDestroyed()) window.webContents.send(AGENT_IPC_CHANNELS.EVENT, agentEvent)
  })
  controller.subscribeDetachedChildInteractions((agentEvent) => {
    const window = getMainWindow()
    if (window && !window.isDestroyed()) window.webContents.send(AGENT_IPC_CHANNELS.EVENT, agentEvent)
  })
  controller.subscribeQueueChanges((snapshot: AgentQueueSnapshot) => {
    const window = getMainWindow()
    if (window && !window.isDestroyed()) window.webContents.send(AGENT_IPC_CHANNELS.QUEUE_EVENT, snapshot)
  })
  const watched = new WeakSet<WebContents>()
  const watchOwner = (sender: WebContents): void => {
    if (watched.has(sender)) return
    watched.add(sender)
    const cancel = (): void => { controller.cancelOwner(sender.id) }
    sender.on('destroyed', cancel)
    sender.on('render-process-gone', cancel)
    sender.on('did-start-loading', cancel)
  }
  const handle = (
    channel: string,
    handler: (event: IpcMainInvokeEvent, ...args: unknown[]) => unknown,
  ): void => {
    ipcMain.handle(channel, (event, ...args: unknown[]) => {
      assertMainFrame(event, 'Agent')
      return handler(event, ...args)
    })
  }

  handle(AGENT_IPC_CHANNELS.LIST_SESSIONS, () => controller.listSessions())
  handle(AGENT_IPC_CHANNELS.GET_REASONING_CAPABILITY, (_event, sessionId) => {
    if (typeof sessionId !== 'string' || !sessionId.trim()) throw new Error('模型能力查询参数无效')
    const session = controller.getSession(sessionId)
    if (!session?.channelId || !session.modelId) return undefined
    const channel = (options.channelManager ?? getChannelManager()).get(session.channelId)
    if (!channel?.enabled || !channel.models.some((model) => model.id === session.modelId && model.enabled)) {
      return undefined
    }
    const runtime = (options.resolveAdapter ?? getAgentProviderAdapter)(session.runtimeId)
    return runtime.getReasoningCapability?.({ provider: channel.provider, model: session.modelId })
  })
  handle(AGENT_IPC_CHANNELS.LIST_ACTIVE_RUNS, () => controller.listActiveRuns())
  handle(AGENT_IPC_CHANNELS.CHECK_ENVIRONMENT, (_event, input) => {
    const candidate = input && typeof input === 'object' && !Array.isArray(input)
      ? input as { projectId?: unknown }
      : {}
    if (
      Object.keys(candidate).some((key) => key !== 'projectId')
      || (candidate.projectId !== undefined && typeof candidate.projectId !== 'string')
    ) throw new Error('Agent 环境检查参数无效')
    const cwd = typeof candidate.projectId === 'string' && candidate.projectId.trim()
      ? options.resolveProjectCwd?.(candidate.projectId.trim())
      : undefined
    if (candidate.projectId && !cwd) throw new Error('Agent 项目工作区无法解析')
    return checkAgentEnvironment(cwd ? { cwd } : {})
  })
  handle(AGENT_IPC_CHANNELS.GET_SESSION, (_event, id) => controller.getSession(id))
  handle(AGENT_IPC_CHANNELS.CREATE_SESSION, (_event, input) => controller.createSession(input))
  handle(AGENT_IPC_CHANNELS.UPDATE_SESSION, (_event, id, input) => controller.updateSession(id, input))
  handle(AGENT_IPC_CHANNELS.DELETE_SESSION, (_event, id) => controller.deleteSession(id))
  handle(AGENT_IPC_CHANNELS.GET_MESSAGES, (_event, id) => controller.getMessages(id))
  handle(AGENT_IPC_CHANNELS.IS_ACTIVE, (_event, id) => controller.isActive(id))
  handle(AGENT_IPC_CHANNELS.LIST_QUEUED_MESSAGES, (event, id) => controller.listQueuedMessages(event.sender.id, id))
  handle(AGENT_IPC_CHANNELS.CANCEL_QUEUED_MESSAGE, (event, input) => controller.cancelQueuedMessage(event.sender.id, input))
  handle(AGENT_IPC_CHANNELS.MOVE_QUEUED_MESSAGE, (event, input) => controller.moveQueuedMessage(event.sender.id, input))
  handle(AGENT_IPC_CHANNELS.PERMISSION_RESPOND, (event, response) => controller.respondPermission(event.sender.id, response))
  handle(AGENT_IPC_CHANNELS.ASK_USER_RESPOND, (event, response) => controller.respondAskUser(event.sender.id, response))
  handle(AGENT_IPC_CHANNELS.EXIT_PLAN_MODE_RESPOND, (event, response) => controller.respondExitPlan(event.sender.id, response))
  handle(AGENT_IPC_CHANNELS.SEND, (event, input) => {
    const sender = event.sender
    watchOwner(sender)
    const quick = isQuickChatSend(sender.id, 'agent', (input as { sessionId?: unknown } | null)?.sessionId)
    return controller.send(sender.id, input, (agentEvent: AgentGenerationEvent) => {
      if (!sender.isDestroyed()) sender.send(AGENT_IPC_CHANNELS.EVENT, agentEvent)
    }, quick ? { inputOrigin: 'quick' } : {})
  })
  handle(AGENT_IPC_CHANNELS.STOP, (event, id) => controller.stop(event.sender.id, id))
}
