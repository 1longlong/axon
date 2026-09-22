/**
 * Preload 脚本
 *
 * 通过 contextBridge 安全地将 API 暴露给渲染进程
 * 使用上下文隔离确保安全性
 *
 * 这是 IPC 四层契约的第三层（preload bridge）：
 * 通道常量来自 src/types，handler 在 src/main/ipc.ts，
 * 渲染进程通过 window.axon 调用。
 */

import { contextBridge, ipcRenderer } from 'electron'
import type { IpcRendererEvent } from 'electron'
import {
  AGENT_IPC_CHANNELS,
  AGENT_MEMORY_IPC_CHANNELS,
  AGENT_PROJECT_IPC_CHANNELS,
  AGENT_TASK_IPC_CHANNELS,
  AGENT_SKILL_IPC_CHANNELS,
  ATTACHMENTS_IPC_CHANNELS,
  CHANNEL_IPC_CHANNELS,
  CHAT_IPC_CHANNELS,
  MCP_IPC_CHANNELS,
} from '@axon/shared'
import type {
  AgentActiveRun,
  AgentAskUserResponse,
  AgentExitPlanResponse,
  AgentGenerationEvent,
  AgentEnvironmentCheckInput,
  AgentEnvironmentCheckResult,
  AgentPermissionResponse,
  AgentReasoningCapability,
  AgentQueueSnapshot,
  AgentQueuedMessage,
  AgentQueuedMessageControlInput,
  AgentMoveQueuedMessageInput,
  AgentSendInput,
  AgentSendResult,
  AgentSessionCreateInput,
  AgentSessionMeta,
  AgentSessionUpdateInput,
  AgentDelegation,
  AgentTaskEvent,
  AgentProject,
  AgentProjectCreateInput,
  AgentProjectUpdateInput,
  AgentMemoryChangedEvent,
  AgentMemoryFile,
  AgentMemorySummary,
  AgentSkillSettingsSnapshot,
  AgentWorkspaceDirectorySelection,
  AgentWorkspaceDirectoryListing,
  AgentWorkspaceDirectoryChangedEvent,
  AgentWorkspaceFilePreview,
  AgentWorkspaceFileDiff,
  AttachmentSaveInput,
  AttachmentSaveResult,
  Channel,
  ChannelCreateInput,
  ChannelUpdateInput,
  ChannelNetworkInput,
  ChannelNetworkResult,
  ChatGenerationEvent,
  ChatMessage,
  ChatSendInput,
  ChatSendResult,
  ConversationCreateInput,
  ConversationMeta,
  ConversationUpdateInput,
  SDKMessage,
  McpProjectConfig,
  McpServerConfig,
  McpConnectionTestResult,
  BuiltinMcpPresetSummary,
  MaterializedMcpPreset,
} from '@axon/shared'
import { DESKTOP_IPC_CHANNELS, SETTINGS_IPC_CHANNELS, USER_PROFILE_IPC_CHANNELS, WINDOW_IPC_CHANNELS } from '../types'
import type { AppSettings, DesktopAction, UserProfile } from '../types'

const desktopActionListeners = new Set<(action: DesktopAction) => void>()
const pendingDesktopActions: DesktopAction[] = []

/** Renderer 尚未挂载时先缓存托盘动作，防止 did-finish-load 与 React effect 之间丢消息。 */
ipcRenderer.on(DESKTOP_IPC_CHANNELS.ACTION, (_event, action: DesktopAction) => {
  if (desktopActionListeners.size === 0) {
    pendingDesktopActions.push(action)
    return
  }
  for (const listener of desktopActionListeners) listener(action)
})

const api = {
  desktop: {
    setQuickChatExpanded: (expanded: boolean): Promise<void> =>
      ipcRenderer.invoke(DESKTOP_IPC_CHANNELS.QUICK_CHAT_EXPANDED, expanded),
    hideQuickChat: (): Promise<void> => ipcRenderer.invoke(DESKTOP_IPC_CHANNELS.HIDE_QUICK_CHAT),
    onQuickChatOpened: (callback: () => void): (() => void) => {
      const listener = (): void => callback()
      ipcRenderer.on(DESKTOP_IPC_CHANNELS.QUICK_CHAT_OPENED, listener)
      return () => ipcRenderer.removeListener(DESKTOP_IPC_CHANNELS.QUICK_CHAT_OPENED, listener)
    },
    onQuickChatCanceled: (callback: () => void): (() => void) => {
      const listener = (): void => callback()
      ipcRenderer.on(DESKTOP_IPC_CHANNELS.QUICK_CHAT_CANCELED, listener)
      return () => ipcRenderer.removeListener(DESKTOP_IPC_CHANNELS.QUICK_CHAT_CANCELED, listener)
    },
    /** 订阅托盘快捷动作；首次订阅会按顺序消费 Renderer 挂载前积压的动作。 */
    onAction: (callback: (action: DesktopAction) => void): (() => void) => {
      desktopActionListeners.add(callback)
      const pending = pendingDesktopActions.splice(0)
      for (const action of pending) callback(action)
      return () => desktopActionListeners.delete(callback)
    },
  },
  channels: {
    list: (): Promise<Channel[]> => ipcRenderer.invoke(CHANNEL_IPC_CHANNELS.LIST),
    create: (input: ChannelCreateInput): Promise<Channel> => ipcRenderer.invoke(CHANNEL_IPC_CHANNELS.CREATE, input),
    update: (id: string, input: ChannelUpdateInput): Promise<Channel> => ipcRenderer.invoke(CHANNEL_IPC_CHANNELS.UPDATE, id, input),
    delete: (id: string): Promise<Channel> => ipcRenderer.invoke(CHANNEL_IPC_CHANNELS.DELETE, id),
    request: (input: ChannelNetworkInput): Promise<ChannelNetworkResult> => ipcRenderer.invoke(CHANNEL_IPC_CHANNELS.REQUEST, input),
    cancel: (requestId: string): Promise<boolean> => ipcRenderer.invoke(CHANNEL_IPC_CHANNELS.CANCEL, requestId),
  },
  chat: {
    listConversations: (): Promise<ConversationMeta[]> =>
      ipcRenderer.invoke(CHAT_IPC_CHANNELS.LIST_CONVERSATIONS),
    getConversation: (id: string): Promise<ConversationMeta | null> =>
      ipcRenderer.invoke(CHAT_IPC_CHANNELS.GET_CONVERSATION, id),
    createConversation: (input: ConversationCreateInput = {}): Promise<ConversationMeta> =>
      ipcRenderer.invoke(CHAT_IPC_CHANNELS.CREATE_CONVERSATION, input),
    updateConversation: (id: string, input: ConversationUpdateInput): Promise<ConversationMeta> =>
      ipcRenderer.invoke(CHAT_IPC_CHANNELS.UPDATE_CONVERSATION, id, input),
    deleteConversation: (id: string): Promise<ConversationMeta> =>
      ipcRenderer.invoke(CHAT_IPC_CHANNELS.DELETE_CONVERSATION, id),
    getMessages: (id: string): Promise<ChatMessage[]> =>
      ipcRenderer.invoke(CHAT_IPC_CHANNELS.GET_MESSAGES, id),
    send: (input: ChatSendInput): Promise<ChatSendResult> =>
      ipcRenderer.invoke(CHAT_IPC_CHANNELS.SEND, input),
    stop: (conversationId: string): Promise<boolean> =>
      ipcRenderer.invoke(CHAT_IPC_CHANNELS.STOP, conversationId),
    /** 订阅单次生成生命周期，返回取消订阅函数。 */
    onEvent: (callback: (event: ChatGenerationEvent) => void): (() => void) => {
      const listener = (_event: IpcRendererEvent, event: ChatGenerationEvent): void => callback(event)
      ipcRenderer.on(CHAT_IPC_CHANNELS.EVENT, listener)
      return () => ipcRenderer.removeListener(CHAT_IPC_CHANNELS.EVENT, listener)
    },
  },
  agent: {
    getReasoningCapability: (sessionId: string): Promise<AgentReasoningCapability | undefined> =>
      ipcRenderer.invoke(AGENT_IPC_CHANNELS.GET_REASONING_CAPABILITY, sessionId),
    checkEnvironment: (input: AgentEnvironmentCheckInput = {}): Promise<AgentEnvironmentCheckResult> =>
      ipcRenderer.invoke(AGENT_IPC_CHANNELS.CHECK_ENVIRONMENT, input),
    listSessions: (): Promise<AgentSessionMeta[]> =>
      ipcRenderer.invoke(AGENT_IPC_CHANNELS.LIST_SESSIONS),
    listActiveRuns: (): Promise<AgentActiveRun[]> =>
      ipcRenderer.invoke(AGENT_IPC_CHANNELS.LIST_ACTIVE_RUNS),
    getSession: (id: string): Promise<AgentSessionMeta | null> =>
      ipcRenderer.invoke(AGENT_IPC_CHANNELS.GET_SESSION, id),
    createSession: (input: AgentSessionCreateInput = {}): Promise<AgentSessionMeta> =>
      ipcRenderer.invoke(AGENT_IPC_CHANNELS.CREATE_SESSION, input),
    updateSession: (id: string, input: AgentSessionUpdateInput): Promise<AgentSessionMeta> =>
      ipcRenderer.invoke(AGENT_IPC_CHANNELS.UPDATE_SESSION, id, input),
    deleteSession: (id: string): Promise<AgentSessionMeta> =>
      ipcRenderer.invoke(AGENT_IPC_CHANNELS.DELETE_SESSION, id),
    getMessages: (id: string): Promise<SDKMessage[]> =>
      ipcRenderer.invoke(AGENT_IPC_CHANNELS.GET_MESSAGES, id),
    send: (input: AgentSendInput): Promise<AgentSendResult> =>
      ipcRenderer.invoke(AGENT_IPC_CHANNELS.SEND, input),
    stop: (sessionId: string): Promise<boolean> =>
      ipcRenderer.invoke(AGENT_IPC_CHANNELS.STOP, sessionId),
    isActive: (sessionId: string): Promise<boolean> =>
      ipcRenderer.invoke(AGENT_IPC_CHANNELS.IS_ACTIVE, sessionId),
    listQueuedMessages: (sessionId: string): Promise<AgentQueuedMessage[]> =>
      ipcRenderer.invoke(AGENT_IPC_CHANNELS.LIST_QUEUED_MESSAGES, sessionId),
    cancelQueuedMessage: (input: AgentQueuedMessageControlInput): Promise<boolean> =>
      ipcRenderer.invoke(AGENT_IPC_CHANNELS.CANCEL_QUEUED_MESSAGE, input),
    moveQueuedMessage: (input: AgentMoveQueuedMessageInput): Promise<boolean> =>
      ipcRenderer.invoke(AGENT_IPC_CHANNELS.MOVE_QUEUED_MESSAGE, input),
    respondPermission: (response: AgentPermissionResponse): Promise<boolean> =>
      ipcRenderer.invoke(AGENT_IPC_CHANNELS.PERMISSION_RESPOND, response),
    respondAskUser: (response: AgentAskUserResponse): Promise<boolean> =>
      ipcRenderer.invoke(AGENT_IPC_CHANNELS.ASK_USER_RESPOND, response),
    respondExitPlan: (response: AgentExitPlanResponse): Promise<boolean> =>
      ipcRenderer.invoke(AGENT_IPC_CHANNELS.EXIT_PLAN_MODE_RESPOND, response),
    /** 订阅单轮 Agent 运行生命周期，返回取消订阅函数。 */
    onEvent: (callback: (event: AgentGenerationEvent) => void): (() => void) => {
      const listener = (_event: IpcRendererEvent, event: AgentGenerationEvent): void => callback(event)
      ipcRenderer.on(AGENT_IPC_CHANNELS.EVENT, listener)
      return () => ipcRenderer.removeListener(AGENT_IPC_CHANNELS.EVENT, listener)
    },
    onQueueChanged: (callback: (snapshot: AgentQueueSnapshot) => void): (() => void) => {
      const listener = (_event: IpcRendererEvent, snapshot: AgentQueueSnapshot): void => callback(snapshot)
      ipcRenderer.on(AGENT_IPC_CHANNELS.QUEUE_EVENT, listener)
      return () => ipcRenderer.removeListener(AGENT_IPC_CHANNELS.QUEUE_EVENT, listener)
    },
  },
  agentTasks: {
    list: (rootSessionId: string): Promise<AgentDelegation[]> =>
      ipcRenderer.invoke(AGENT_TASK_IPC_CHANNELS.LIST, rootSessionId),
    get: (rootSessionId: string, taskId: string): Promise<AgentDelegation | null> =>
      ipcRenderer.invoke(AGENT_TASK_IPC_CHANNELS.GET, rootSessionId, taskId),
    getMessages: (rootSessionId: string, taskId: string): Promise<SDKMessage[]> =>
      ipcRenderer.invoke(AGENT_TASK_IPC_CHANNELS.GET_MESSAGES, rootSessionId, taskId),
    onEvent: (callback: (event: AgentTaskEvent) => void): (() => void) => {
      const listener = (_event: IpcRendererEvent, event: AgentTaskEvent): void => callback(event)
      ipcRenderer.on(AGENT_TASK_IPC_CHANNELS.EVENT, listener)
      return () => ipcRenderer.removeListener(AGENT_TASK_IPC_CHANNELS.EVENT, listener)
    },
  },
  agentProjects: {
    list: (): Promise<AgentProject[]> =>
      ipcRenderer.invoke(AGENT_PROJECT_IPC_CHANNELS.LIST),
    get: (id: string): Promise<AgentProject | null> =>
      ipcRenderer.invoke(AGENT_PROJECT_IPC_CHANNELS.GET, id),
    create: (input: AgentProjectCreateInput): Promise<AgentProject> =>
      ipcRenderer.invoke(AGENT_PROJECT_IPC_CHANNELS.CREATE, input),
    update: (id: string, input: AgentProjectUpdateInput): Promise<AgentProject> =>
      ipcRenderer.invoke(AGENT_PROJECT_IPC_CHANNELS.UPDATE, id, input),
    delete: (id: string): Promise<AgentProject> =>
      ipcRenderer.invoke(AGENT_PROJECT_IPC_CHANNELS.DELETE, id),
    pickLocalWorkspace: (): Promise<AgentWorkspaceDirectorySelection> =>
      ipcRenderer.invoke(AGENT_PROJECT_IPC_CHANNELS.PICK_LOCAL_WORKSPACE),
    listDirectory: (projectId: string): Promise<AgentWorkspaceDirectoryListing> =>
      ipcRenderer.invoke(AGENT_PROJECT_IPC_CHANNELS.LIST_DIRECTORY, projectId),
    readFile: (projectId: string, relativePath: string): Promise<AgentWorkspaceFilePreview> =>
      ipcRenderer.invoke(AGENT_PROJECT_IPC_CHANNELS.READ_FILE, projectId, relativePath),
    readDiff: (projectId: string, relativePath: string): Promise<AgentWorkspaceFileDiff> =>
      ipcRenderer.invoke(AGENT_PROJECT_IPC_CHANNELS.READ_DIFF, projectId, relativePath),
    watchDirectory: (projectId: string): Promise<void> =>
      ipcRenderer.invoke(AGENT_PROJECT_IPC_CHANNELS.WATCH_DIRECTORY, projectId),
    unwatchDirectory: (projectId: string): Promise<void> =>
      ipcRenderer.invoke(AGENT_PROJECT_IPC_CHANNELS.UNWATCH_DIRECTORY, projectId),
    /** 变更事件只通知项目和时间，renderer 收到后重新读取权威目录树。 */
    onDirectoryChanged: (callback: (event: AgentWorkspaceDirectoryChangedEvent) => void): (() => void) => {
      const listener = (_event: IpcRendererEvent, change: AgentWorkspaceDirectoryChangedEvent): void => callback(change)
      ipcRenderer.on(AGENT_PROJECT_IPC_CHANNELS.DIRECTORY_CHANGED, listener)
      return () => ipcRenderer.removeListener(AGENT_PROJECT_IPC_CHANNELS.DIRECTORY_CHANGED, listener)
    },
  },
  agentMemory: {
    list: (projectId: string): Promise<AgentMemorySummary> =>
      ipcRenderer.invoke(AGENT_MEMORY_IPC_CHANNELS.LIST, projectId),
    read: (projectId: string, relativePath: string): Promise<AgentMemoryFile> =>
      ipcRenderer.invoke(AGENT_MEMORY_IPC_CHANNELS.READ, projectId, relativePath),
    write: (projectId: string, relativePath: string, content: string): Promise<AgentMemoryFile> =>
      ipcRenderer.invoke(AGENT_MEMORY_IPC_CHANNELS.WRITE, projectId, relativePath, content),
    watch: (projectId: string): Promise<void> =>
      ipcRenderer.invoke(AGENT_MEMORY_IPC_CHANNELS.WATCH, projectId),
    unwatch: (projectId: string): Promise<void> =>
      ipcRenderer.invoke(AGENT_MEMORY_IPC_CHANNELS.UNWATCH, projectId),
    /** 变化事件是刷新信号，文件列表和内容仍通过受限读取接口取得。 */
    onChanged: (callback: (event: AgentMemoryChangedEvent) => void): (() => void) => {
      const listener = (_event: IpcRendererEvent, change: AgentMemoryChangedEvent): void => callback(change)
      ipcRenderer.on(AGENT_MEMORY_IPC_CHANNELS.CHANGED, listener)
      return () => ipcRenderer.removeListener(AGENT_MEMORY_IPC_CHANNELS.CHANGED, listener)
    },
  },
  mcpProjects: {
    getConfig: (projectId: string): Promise<McpProjectConfig> =>
      ipcRenderer.invoke(MCP_IPC_CHANNELS.GET_PROJECT_CONFIG, projectId),
    saveConfig: (projectId: string, config: McpProjectConfig): Promise<McpProjectConfig> =>
      ipcRenderer.invoke(MCP_IPC_CHANNELS.SAVE_PROJECT_CONFIG, projectId, config),
    testConnection: (projectId: string, serverName: string, server: McpServerConfig): Promise<McpConnectionTestResult> =>
      ipcRenderer.invoke(MCP_IPC_CHANNELS.TEST_SERVER_CONNECTION, projectId, serverName, server),
    listBuiltinPresets: (): Promise<BuiltinMcpPresetSummary[]> =>
      ipcRenderer.invoke(MCP_IPC_CHANNELS.LIST_BUILTIN_PRESETS),
    materializeBuiltinPreset: (projectId: string, presetId: string): Promise<MaterializedMcpPreset> =>
      ipcRenderer.invoke(MCP_IPC_CHANNELS.MATERIALIZE_BUILTIN_PRESET, projectId, presetId),
  },
  attachments: {
    /** 保存附件二进制并返回安全元数据；发送消息时把元数据放进 ChatSendInput.attachments。 */
    save: (input: AttachmentSaveInput): Promise<AttachmentSaveResult> =>
      ipcRenderer.invoke(ATTACHMENTS_IPC_CHANNELS.SAVE, input),
  },
  userProfile: {
    get: (): Promise<UserProfile> => ipcRenderer.invoke(USER_PROFILE_IPC_CHANNELS.GET),
    update: (updates: Partial<UserProfile>): Promise<UserProfile> =>
      ipcRenderer.invoke(USER_PROFILE_IPC_CHANNELS.UPDATE, updates),
  },
  settings: {
    get: (): Promise<AppSettings> => ipcRenderer.invoke(SETTINGS_IPC_CHANNELS.GET),
    update: (updates: Partial<AppSettings>): Promise<AppSettings> =>
      ipcRenderer.invoke(SETTINGS_IPC_CHANNELS.UPDATE, updates),
  },
  agentSkills: {
    getSettings: (): Promise<AgentSkillSettingsSnapshot> =>
      ipcRenderer.invoke(AGENT_SKILL_IPC_CHANNELS.GET_SETTINGS),
    applySettings: (catalogIds: string[]): Promise<AgentSkillSettingsSnapshot> =>
      ipcRenderer.invoke(AGENT_SKILL_IPC_CHANNELS.APPLY_SETTINGS, catalogIds),
  },
  window: {
    minimize: (): Promise<void> => ipcRenderer.invoke(WINDOW_IPC_CHANNELS.MINIMIZE),
    maximize: (): Promise<void> => ipcRenderer.invoke(WINDOW_IPC_CHANNELS.MAXIMIZE),
    close: (): Promise<void> => ipcRenderer.invoke(WINDOW_IPC_CHANNELS.CLOSE),
    isMaximized: (): Promise<boolean> => ipcRenderer.invoke(WINDOW_IPC_CHANNELS.IS_MAXIMIZED),
    /** 订阅窗口尺寸变化，返回取消订阅函数 */
    onResize: (callback: () => void): (() => void) => {
      const listener = (): void => callback()
      ipcRenderer.on(WINDOW_IPC_CHANNELS.ON_RESIZE, listener)
      return () => {
        ipcRenderer.removeListener(WINDOW_IPC_CHANNELS.ON_RESIZE, listener)
      }
    },
  },
  /** 应用版本（vite define 注入） */
  version: typeof __APP_VERSION__ !== 'undefined' ? __APP_VERSION__ : '0.0.0',
}

contextBridge.exposeInMainWorld('axon', api)

export type AxonPreloadApi = typeof api
