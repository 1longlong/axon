import type { AgentTypedError } from './agent-message'
import type { AgentGenerationEvent } from './agent-run'

/** 单个根任务最多同时运行的子 Agent，避免模型无界并发。 */
export const MAX_AGENT_DELEGATION_CONCURRENCY = 4
export const MAX_AGENT_DELEGATION_DEPTH = 1
export const MAX_AGENT_DELEGATIONS_PER_ROOT = 24
export const MAX_AGENT_DELEGATION_TITLE_LENGTH = 120
export const MAX_AGENT_DELEGATION_OBJECTIVE_LENGTH = 8_000
export const MAX_AGENT_DELEGATION_PROGRESS_LENGTH = 4_000
export const MAX_AGENT_DELEGATION_RESULT_LENGTH = 16_000

export type AgentSubagentType = 'coder' | 'explore' | 'plan'

export type AgentDelegationStatus =
  | 'queued'
  | 'running'
  | 'blocked'
  | 'completed'
  | 'failed'
  | 'canceled'
  | 'interrupted'

/** blocked 只表示需要父页面承接的交互，普通模型/API 等待仍属于 running。 */
export type AgentDelegationBlockReason = 'permission' | 'ask_user' | 'plan_approval'

/**
 * 一次父 Agent → 子 Agent 的稳定关联记录。
 * 子 Agent 保存独立消息 JSONL；公开 DTO 带根/父字段方便编排，磁盘 state
 * 由所属目录推导这些字段，只保存 agentId、父工具调用、状态与结果摘要。
 */
export interface AgentDelegation {
  id: string
  rootSessionId: string
  parentSessionId: string
  childSessionId: string
  parentToolUseId: string
  title: string
  objective: string
  subagentType: AgentSubagentType
  /** false 为默认前台调用；true 才进入后台 Task 管理与完成通知。 */
  runInBackground: boolean
  depth: number
  status: AgentDelegationStatus
  latestProgress?: string
  blockedReason?: AgentDelegationBlockReason
  resultSummary?: string
  error?: AgentTypedError
  createdAt: number
  updatedAt: number
  startedAt?: number
  finishedAt?: number
}

/** 仅供主进程编排层创建委派；renderer 不能直接构造父子关系。 */
export interface AgentDelegationCreateInput {
  rootSessionId: string
  parentSessionId: string
  childSessionId: string
  parentToolUseId: string
  title: string
  objective: string
  subagentType: AgentSubagentType
  runInBackground: boolean
  depth: number
}

/** 状态变更采用判别联合，让每个终态必须携带它所需的结果。 */
export type AgentDelegationTransitionInput =
  | { status: 'running'; latestProgress?: string }
  | { status: 'blocked'; blockedReason: AgentDelegationBlockReason; latestProgress?: string }
  | { status: 'completed'; resultSummary: string; latestProgress?: string }
  | { status: 'failed'; error: AgentTypedError; latestProgress?: string }
  | { status: 'canceled' | 'interrupted'; latestProgress?: string }

export function isAgentDelegationTerminal(status: AgentDelegationStatus): boolean {
  return status === 'completed' || status === 'failed' || status === 'canceled' || status === 'interrupted'
}

/** 主进程写入 task 状态后推送完整快照，renderer 无需自行合并状态补丁。 */
export interface AgentTaskChangedEvent {
  type: 'changed'
  rootSessionId: string
  task: AgentDelegation
}

/** 子 Agent 的实时运行事件；taskId 让 renderer 直接定位父工具卡片。 */
export interface AgentTaskRunEvent {
  type: 'agent_event'
  rootSessionId: string
  taskId: string
  agentId: string
  event: AgentGenerationEvent
}

export type AgentTaskEvent = AgentTaskChangedEvent | AgentTaskRunEvent

export const AGENT_TASK_IPC_CHANNELS = {
  LIST: 'axon:agent:tasks:list',
  GET: 'axon:agent:tasks:get',
  GET_MESSAGES: 'axon:agent:tasks:get-messages',
  EVENT: 'axon:agent:tasks:event',
} as const
