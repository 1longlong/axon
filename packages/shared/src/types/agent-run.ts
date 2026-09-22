/** Agent 命令 DTO、交互请求与跨进程运行事件。 */

import type { AgentStreamPayload, AgentTypedError, SDKMessageUsage, SDKResultMessage } from './agent-message'
import type { AgentPermissionMode } from './agent-session'

/** renderer 提交给主进程的一轮 Agent 输入。 */
export interface AgentSendInput {
  sessionId: string
  text: string
}

/** 尚未进入 AgentService 的内存队列项；只有真正派发时才写入会话 JSONL。 */
export interface AgentQueuedMessage {
  id: string
  sessionId: string
  text: string
  createdAt: number
}

export interface AgentQueuedMessageControlInput {
  sessionId: string
  messageId: string
}

export interface AgentMoveQueuedMessageInput {
  sessionId: string
  sourceId: string
  targetId: string
  placement: 'before' | 'after'
}

/** 主进程每次队列变化后发送完整快照，renderer 无需推测操作是否成功。 */
export interface AgentQueueSnapshot {
  sessionId: string
  messages: AgentQueuedMessage[]
}

export type AgentErrorCode =
  | 'invalid_input'
  | 'not_found'
  | 'already_active'
  | 'queue_full'
  | 'channel_unavailable'
  | 'workspace_unavailable'
  | 'custom_tool_unavailable'
  | 'persistence_error'
  | 'runtime_error'
  | 'internal_error'

/** IPC 只表示消息是否由主进程接管；模型成败以派发后 JSONL 中的 result 为准。 */
export type AgentSendResult =
  | { success: true; disposition: 'started' | 'queued'; queuedMessage?: AgentQueuedMessage }
  | { success: false; code: AgentErrorCode; message: string }

export type AgentPermissionDangerLevel = 'safe' | 'normal' | 'dangerous'

/** 主进程发给发起窗口的单次工具权限请求。 */
export interface AgentPermissionRequest {
  requestId: string
  sessionId: string
  runStartedAt: number
  toolUseId: string
  toolName: string
  toolInput: Record<string, unknown>
  description: string
  dangerLevel: AgentPermissionDangerLevel
  allowAlways: boolean
  createdAt: number
  expiresAt: number
}

/** renderer 对权限横幅的答复；updatedInput 可承载用户修正后的路径等参数。 */
export interface AgentPermissionResponse {
  requestId: string
  behavior: 'allow' | 'deny'
  alwaysAllow?: boolean
  updatedInput?: Record<string, unknown>
}

export interface AgentAskUserOption {
  label: string
  description?: string
}

export interface AgentAskUserQuestion {
  question: string
  header?: string
  options: AgentAskUserOption[]
  multiSelect: boolean
}

/** AskUserQuestion 工具暂停后投影到 renderer 的中立请求。 */
export interface AgentAskUserRequest {
  requestId: string
  sessionId: string
  runStartedAt: number
  questions: AgentAskUserQuestion[]
}

export type AgentAskUserResponse =
  | { requestId: string; behavior: 'answer'; answers: Record<string, string> }
  | { requestId: string; behavior: 'cancel' }

/** ExitPlanMode 暂停执行后投影给 renderer 的计划审批请求。 */
export interface AgentExitPlanRequest {
  requestId: string
  sessionId: string
  runStartedAt: number
  plan: string
  allowedOperations: string[]
}

export type AgentExecutionPermissionMode = Exclude<AgentPermissionMode, 'plan'>

export type AgentExitPlanResponse =
  | { requestId: string; action: 'approve'; targetMode: AgentExecutionPermissionMode }
  | { requestId: string; action: 'feedback'; feedback: string }
  | { requestId: string; action: 'reject' }

export interface AgentEnvironmentCheckInput {
  /** 由主进程解析项目的唯一工作区，renderer 不传绝对路径。 */
  projectId?: string
}

export interface AgentEnvironmentCommandCheck {
  available: boolean
  version?: string
  message: string
}

export interface AgentEnvironmentCheckResult {
  cwd: string
  directory: { available: boolean; writable: boolean; message: string }
  git: AgentEnvironmentCommandCheck
  node: AgentEnvironmentCommandCheck
  bun: AgentEnvironmentCommandCheck
}

/** 一轮运行的轻量完成摘要；通知、自动化和无头调用无需重新扫描 JSONL。 */
export interface AgentCompletionPayload {
  terminalReason: string
  resultSubtype: SDKResultMessage['subtype']
  stoppedByUser: boolean
  usage: SDKMessageUsage
  totalCostUsd?: number
  error?: AgentTypedError
  completedAt: number
  durationMs: number
  /** false 表示运行已收束，但终态因存储故障未能写入 JSONL。 */
  persisted: boolean
}

/** Agent 一轮运行的触发来源；background_notification 是后台任务完成后的宿主续跑。 */
export type AgentRunSource = 'renderer' | 'external' | 'delegation' | 'background_notification'

/** 主进程当前运行快照，用于窗口晚于外部任务启动时补齐 UI 状态。 */
export interface AgentActiveRun {
  sessionId: string
  runStartedAt: number
  source: AgentRunSource
}

/**
 * 一轮运行的跨进程生命周期。runStartedAt 同时是运行令牌：renderer 用它丢弃
 * 停止后迟到的旧流，完整 SDKMessage 最终仍由 JSONL 快照校准。
 */
export type AgentGenerationEvent =
  | { type: 'run_started'; sessionId: string; runStartedAt: number; source: AgentRunSource }
  | {
      /** 自动标题已写入会话索引；该事件独立于运行流，供侧栏即时刷新。 */
      type: 'session_title'
      sessionId: string
      runStartedAt: number
      title: string
      updatedAt: number
    }
  | {
      type: 'stream'
      sessionId: string
      runStartedAt: number
      source: AgentRunSource
      payload: AgentStreamPayload
    }
  | {
      type: 'permission_request'
      sessionId: string
      runStartedAt: number
      request: AgentPermissionRequest
    }
  | {
      type: 'permission_resolved'
      sessionId: string
      runStartedAt: number
      requestId: string
      behavior: 'allow' | 'deny'
      reason: 'response' | 'aborted' | 'timeout' | 'owner_gone'
    }
  | {
      type: 'ask_user_request'
      sessionId: string
      runStartedAt: number
      request: AgentAskUserRequest
    }
  | {
      type: 'ask_user_resolved'
      sessionId: string
      runStartedAt: number
      requestId: string
      reason: 'answered' | 'canceled' | 'aborted' | 'owner_gone'
    }
  | {
      type: 'exit_plan_mode_request'
      sessionId: string
      runStartedAt: number
      request: AgentExitPlanRequest
    }
  | {
      type: 'exit_plan_mode_resolved'
      sessionId: string
      runStartedAt: number
      requestId: string
      reason: 'approved' | 'feedback' | 'rejected' | 'aborted' | 'owner_gone'
    }
  | {
      type: 'plan_mode_changed'
      sessionId: string
      runStartedAt: number
      active: boolean
      mode: AgentPermissionMode
      source: 'initial' | 'approval'
    }
  | {
      type: 'run_finished'
      sessionId: string
      runStartedAt: number
      source: AgentRunSource
      completion: AgentCompletionPayload
    }
