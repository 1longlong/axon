/** Agent renderer 的状态形状与 Jotai atoms；不包含 IPC 调用和事件副作用。 */

import { atom } from 'jotai'
import type {
  AgentAskUserRequest,
  AgentCompactionStatus,
  AgentExitPlanRequest,
  AgentPermissionRequest,
  AgentProject,
  AgentQueuedMessage,
  AgentRetryStatus,
  AgentRunSource,
  AgentSessionMeta,
  SDKMessage,
} from '@axon/shared'

export type AgentLoadStatus = 'idle' | 'loading' | 'ready' | 'error'

export interface AgentRendererError {
  scope: 'sessions' | 'messages' | 'run' | 'environment' | 'projects'
  message: string
  code?: string
  sessionId?: string
}

export interface AgentRendererState {
  sessions: AgentSessionMeta[]
  sessionsStatus: AgentLoadStatus
  projects: AgentProject[]
  projectsStatus: AgentLoadStatus
  messagesBySession: Record<string, SDKMessage[]>
  messageStatusBySession: Record<string, AgentLoadStatus>
  /** 值是当前运行令牌；不存在即未运行。 */
  activeRunsBySession: Record<string, number>
  /** 与运行令牌同步清理，用于区分前台发送和外部后台任务。 */
  activeRunSourcesBySession: Record<string, AgentRunSource>
  /** 当前模型 API 自动重试；瞬时 UI 状态，不从 JSONL 恢复。 */
  retryStatusBySession: Record<string, AgentRetryStatus>
  /** 当前 runtime 正在压缩上下文；瞬时 UI 状态，不从 JSONL 恢复。 */
  compactionStatusBySession: Record<string, AgentCompactionStatus>
  /** 工具心跳按调用 ID 去重；只用于运行中图标，不作为独立消息展示。 */
  activeToolUseIdsBySession: Record<string, string[]>
  /** 当前尚未收到完整消息的 assistant，用于思考行的运行中图标。 */
  streamingAssistantUuidBySession: Record<string, string>
  pendingPermissionsBySession: Record<string, AgentPermissionRequest[]>
  pendingAskUsersBySession: Record<string, AgentAskUserRequest[]>
  pendingExitPlansBySession: Record<string, AgentExitPlanRequest[]>
  queuedMessagesBySession: Record<string, AgentQueuedMessage[]>
  lastError: AgentRendererError | null
}

export function createInitialAgentRendererState(): AgentRendererState {
  return {
    sessions: [],
    sessionsStatus: 'idle',
    projects: [],
    projectsStatus: 'idle',
    messagesBySession: {},
    messageStatusBySession: {},
    activeRunsBySession: {},
    activeRunSourcesBySession: {},
    retryStatusBySession: {},
    compactionStatusBySession: {},
    activeToolUseIdsBySession: {},
    streamingAssistantUuidBySession: {},
    pendingPermissionsBySession: {},
    pendingAskUsersBySession: {},
    pendingExitPlansBySession: {},
    queuedMessagesBySession: {},
    lastError: null,
  }
}

export const agentStateAtom = atom<AgentRendererState>(createInitialAgentRendererState())
export const agentSessionsAtom = atom((get) => get(agentStateAtom).sessions)
export const agentMessagesBySessionAtom = atom((get) => get(agentStateAtom).messagesBySession)
export const agentActiveRunsAtom = atom((get) => get(agentStateAtom).activeRunsBySession)
export const agentPendingPermissionsAtom = atom((get) => get(agentStateAtom).pendingPermissionsBySession)

export function sortAgentSessions(sessions: readonly AgentSessionMeta[]): AgentSessionMeta[] {
  return [...sessions].sort((left, right) => right.updatedAt - left.updatedAt)
}

export function upsertAgentSession(
  sessions: readonly AgentSessionMeta[],
  incoming: AgentSessionMeta,
): AgentSessionMeta[] {
  return sortAgentSessions([...sessions.filter((item) => item.id !== incoming.id), incoming])
}

export function sortAgentProjects(projects: readonly AgentProject[]): AgentProject[] {
  return [...projects].sort((left, right) => left.name.localeCompare(right.name, 'zh-CN'))
}

export function upsertAgentProject(
  projects: readonly AgentProject[],
  incoming: AgentProject,
): AgentProject[] {
  return sortAgentProjects([...projects.filter((item) => item.id !== incoming.id), incoming])
}
