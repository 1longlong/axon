/** app-server 的换行 JSON-RPC 契约；函数、信号和 Runtime SDK 对象不跨此边界。 */
import type { AgentRuntimeCapabilities, AgentRuntimeId } from './agent-session'
import type { AgentSandboxCapability } from './agent-sandbox'
import type { AgentGenerationEvent, AgentQueueSnapshot } from './agent-run'
import type { BackendAgentRunEvent, ChatGenerationIdentityEvent } from './backend'
import type { ChatGenerationEvent } from './chat'
import type { Channel } from './channel'
import type { AppSettings } from './settings'
import type { UserProfile } from './user-profile'
import type { AgentProject, AgentProjectWatchClosedEvent } from './agent-project'
import type { AgentMemoryChangedEvent } from './agent-memory'
import type { AgentTaskSubscription, AgentTaskSubscriptionEvent } from './agent-collaboration'

export type RpcJsonValue = null | boolean | number | string | RpcJsonValue[] | RpcJsonObject
export interface RpcJsonObject { [key: string]: RpcJsonValue }
export type RpcParams = RpcJsonObject | RpcJsonValue[]
export type RpcId = string | number | null

export interface RpcRequest {
  jsonrpc: '2.0'
  id: RpcId
  method: string
  params?: RpcParams
}
export interface RpcNotification {
  jsonrpc: '2.0'
  method: string
  params?: RpcParams
}
export interface RpcErrorBody {
  code: number
  message: string
  data?: RpcJsonValue
}
export interface RpcSuccess { jsonrpc: '2.0'; id: RpcId; result: RpcJsonValue }
export interface RpcFailure { jsonrpc: '2.0'; id: RpcId; error: RpcErrorBody }
export type RpcFrame = RpcRequest | RpcNotification | RpcSuccess | RpcFailure

/** Axon 私有通知只取消对应传输请求，不能代替会话 runId 的业务停止校验。 */
export const AXON_RPC_CANCEL_METHOD = 'axon/request/cancel'

/** 传输内部使用；业务不能直接注册或发送分段控制方法。 */
export const AXON_RPC_CHUNK_METHOD = 'axon/frame/chunk'
export const AXON_RPC_CHUNK_ABORT_METHOD = 'axon/frame/abort'

/** 子端先有界 drain；父端稍后 TERM，再加倍期限 KILL，避免提前打断正常清理。 */
export const APP_SERVER_SHUTDOWN_TIMEOUT_MS = 8_000
export const APP_SERVER_STOP_TIMEOUT_MS = 10_000

/** 应用端点使用同一上限；行帧仍有界，大值分段，不改变领域容量限制。 */
export const APP_SERVER_RPC_OPTIONS = {
  maxFrameBytes: 1024 * 1024,
  maxMessageBytes: 2 * 1024 * 1024 * 1024,
  maxQueuedBytes: 2 * 1024 * 1024 * 1024 + 1024 * 1024,
  // 为已接纳的大消息之外的短控制请求留一行帧的余量。
  maxBufferedMessageBytes: 2 * 1024 * 1024 * 1024 + 1024 * 1024,
  maxChunkTransfers: 8,
  maxChunkParts: 65_536,
  chunkTimeoutMs: 300_000,
} as const

/** 应用握手版本与 JSON-RPC 帧版本独立；首版不读取旧握手格式。 */
export const APP_SERVER_PROTOCOL_VERSION = 1
export const APP_SERVER_METHODS = {
  INITIALIZE: 'axon/initialize',
  REGISTER_CLIENT: 'axon/client/register',
  DETACH_CLIENT: 'axon/client/detach',
  GET_CAPABILITIES: 'axon/capabilities/get',
  HISTORY_READ: 'axon/history/read',
  HISTORY_CLOSE: 'axon/history/close',
  AGENT_GET_REASONING_CAPABILITY: 'axon/agent/reasoning/get',
  AGENT_CHECK_ENVIRONMENT: 'axon/agent/environment/check',
  GET_SETTINGS: 'axon/settings/get',
  VALIDATE_SETTINGS: 'axon/settings/validate',
  UPDATE_SETTINGS: 'axon/settings/update',
  GET_USER_PROFILE: 'axon/user-profile/get',
  UPDATE_USER_PROFILE: 'axon/user-profile/update',
  CHANNEL_LIST: 'axon/channel/list',
  CHANNEL_CREATE: 'axon/channel/create',
  CHANNEL_UPDATE: 'axon/channel/update',
  CHANNEL_DELETE: 'axon/channel/delete',
  CHANNEL_REQUEST: 'axon/channel/request',
  CHANNEL_CANCEL: 'axon/channel/cancel',
  PROJECT_LIST: 'axon/project/list',
  PROJECT_GET: 'axon/project/get',
  PROJECT_CREATE: 'axon/project/create',
  PROJECT_UPDATE: 'axon/project/update',
  PROJECT_DELETE: 'axon/project/delete',
  WORKSPACE_LIST_DIRECTORY: 'axon/workspace/directory/list',
  WORKSPACE_READ_FILE: 'axon/workspace/file/read',
  WORKSPACE_READ_DIFF: 'axon/workspace/file/diff',
  WORKSPACE_WATCH: 'axon/workspace/watch',
  WORKSPACE_UNWATCH: 'axon/workspace/unwatch',
  MEMORY_LIST: 'axon/memory/list',
  MEMORY_READ: 'axon/memory/read',
  MEMORY_WRITE: 'axon/memory/write',
  MEMORY_WATCH: 'axon/memory/watch',
  MEMORY_UNWATCH: 'axon/memory/unwatch',
  MCP_GET_CONFIG: 'axon/mcp/config/get',
  MCP_SAVE_CONFIG: 'axon/mcp/config/save',
  MCP_TEST_CONNECTION: 'axon/mcp/connection/test',
  MCP_LIST_PRESETS: 'axon/mcp/preset/list',
  MCP_MATERIALIZE_PRESET: 'axon/mcp/preset/materialize',
  SKILLS_GET_SETTINGS: 'axon/skills/settings/get',
  SKILLS_APPLY_SETTINGS: 'axon/skills/settings/apply',
  TASK_LIST: 'axon/task/list',
  TASK_GET: 'axon/task/get',
  TASK_SUBSCRIBE: 'axon/task/subscribe',
  TASK_UNSUBSCRIBE: 'axon/task/unsubscribe',
  AGENT_LIST_SESSIONS: 'axon/agent/session/list',
  AGENT_LIST_ACTIVE_RUNS: 'axon/agent/run/list-active',
  AGENT_IS_ACTIVE: 'axon/agent/run/is-active',
  AGENT_GET_SESSION: 'axon/agent/session/get',
  AGENT_CREATE_SESSION: 'axon/agent/session/create',
  AGENT_UPDATE_SESSION: 'axon/agent/session/update',
  AGENT_DELETE_SESSION: 'axon/agent/session/delete',
  AGENT_SEND: 'axon/agent/send',
  AGENT_GET_RUN: 'axon/agent/run/get',
  AGENT_STOP: 'axon/agent/run/stop',
  AGENT_LIST_QUEUE: 'axon/agent/queue/list',
  AGENT_CANCEL_QUEUE: 'axon/agent/queue/cancel',
  AGENT_MOVE_QUEUE: 'axon/agent/queue/move',
  CHAT_LIST_CONVERSATIONS: 'axon/chat/conversation/list',
  CHAT_GET_CONVERSATION: 'axon/chat/conversation/get',
  CHAT_CREATE_CONVERSATION: 'axon/chat/conversation/create',
  CHAT_UPDATE_CONVERSATION: 'axon/chat/conversation/update',
  CHAT_DELETE_CONVERSATION: 'axon/chat/conversation/delete',
  CHAT_SEND: 'axon/chat/send',
  CHAT_GET_GENERATION: 'axon/chat/generation/get',
  CHAT_STOP: 'axon/chat/generation/stop',
  ATTACHMENT_SAVE: 'axon/attachments/save',
} as const

/** 反向交互不通过普通业务通知重复发送；答复目标由服务端捕获，客户端只返回 response。 */
export const APP_SERVER_CLIENT_METHODS = {
  AGENT_PERMISSION: 'axon/client/agent/permission',
  AGENT_ASK_USER: 'axon/client/agent/ask-user',
} as const
export const APP_SERVER_NOTIFICATIONS = {
  AGENT_RUN: 'axon/event/agent/run',
  AGENT_QUEUE: 'axon/event/agent/queue',
  AGENT_METADATA: 'axon/event/agent/metadata',
  CHAT_GENERATION: 'axon/event/chat/generation',
  CHAT_GENERATION_IDENTITY: 'axon/event/chat/generation-identity',
  SETTINGS_UPDATED: 'axon/event/settings/updated',
  USER_PROFILE_UPDATED: 'axon/event/user-profile/updated',
  CHANNELS_CHANGED: 'axon/event/channel/changed',
  PROJECTS_CHANGED: 'axon/event/project/changed',
  WORKSPACE_CHANGED: 'axon/event/workspace/changed',
  MEMORY_CHANGED: 'axon/event/memory/changed',
  PROJECT_WATCH_CLOSED: 'axon/event/project/watch-closed',
  TASK_EVENT: 'axon/event/task',
} as const
/** 每个逻辑客户端一个只读全局任务投影；替换订阅使用新的服务端代次。 */
export interface AppServerTaskSubscription extends AgentTaskSubscription {}
export interface AppServerTaskEvent extends AgentTaskSubscriptionEvent { clientId: string }
export interface AppServerProjectsEvent { clientId: string; projects: AgentProject[] }
/** wire 只增加可信入口，监听标识与桌面共用中立契约。 */
export interface AppServerProjectChangeEvent extends AgentMemoryChangedEvent {
  clientId: string
}
export interface AppServerProjectWatchClosedEvent extends AgentProjectWatchClosedEvent {
  clientId: string
}
export interface AppServerSettingsEvent { clientId: string; settings: AppSettings }
export interface AppServerUserProfileEvent { clientId: string; profile: UserProfile }
export interface AppServerChannelsEvent { clientId: string; channels: Channel[] }
export interface AppServerAgentRunEvent { clientId: string; event: BackendAgentRunEvent }
export interface AppServerChatGenerationEvent { clientId: string; event: ChatGenerationEvent }
export interface AppServerChatGenerationIdentityEvent { clientId: string; event: ChatGenerationIdentityEvent }
export interface AppServerAgentQueueEvent { clientId: string; snapshot: AgentQueueSnapshot }
export interface AppServerAgentMetadataEvent {
  clientId: string
  event: Extract<AgentGenerationEvent, { type: 'session_title' }>
}

export interface AppServerInitializeInput {
  protocolVersion: number
  client: { name: string; version: string }
  /** 仅可信父进程声明；实际加解密与目标确认通过私有反向请求完成。 */
  hostCapabilities: { credentialStorage: 'safe-storage' | 'unavailable'; channelTargetConfirmation: boolean }
}
export interface AppServerRuntimeCapability {
  runtimeId: AgentRuntimeId
  configured: boolean
  capabilities: AgentRuntimeCapabilities
  sandbox: AgentSandboxCapability
}
export interface AppServerCapabilities {
  runtimes: AppServerRuntimeCapability[]
  credentialStorage: 'safe-storage' | 'unavailable'
  channelTargetConfirmation: boolean
}
export interface AppServerInitializeResult {
  protocolVersion: number
  connectionId: string
  applicationVersion: string
  dataDirectory: string
  capabilities: AppServerCapabilities
}
export type AppServerClientKind = 'main' | 'quick' | 'external'
export interface AppServerClientRegistration { kind: AppServerClientKind }
export interface AppServerClient { clientId: string; kind: AppServerClientKind }
export interface AppServerClientParams { clientId: string }

/** 仅父子私有管道使用；不注册为 renderer IPC 或普通应用业务方法。 */
export const APP_SERVER_HOST_METHODS = {
  ENCRYPT_CREDENTIAL: 'axon/host/credential/encrypt',
  DECRYPT_CREDENTIAL: 'axon/host/credential/decrypt',
  CONFIRM_CHANNEL_TARGET: 'axon/host/channel-target/confirm',
} as const
export interface AppServerHostCredentialInput { value: string }
export interface AppServerHostChannelTargetInput { clientId: string; url: string }
