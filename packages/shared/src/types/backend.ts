/** 后端逻辑身份由可信入口登记；不采用 renderer 自报的窗口或会话标识作为 owner。 */
import type { AgentAskUserResponse, AgentCompletionPayload, AgentGenerationEvent, AgentPermissionResponse } from './agent-run'
import type { AgentTypedError } from './agent-message'

export type BackendClientId = string
export type BackendRunId = string

/** 后端本次装配的能力上限，不由会话设置或工具输入放宽。 */
export interface BackendAgentFeatures {
  skills: boolean
  mcp: boolean
  memory: boolean
  tasks: boolean
}

/** 可信入口的瞬时 Agent 配置；不改写 settings.json。 */
export interface BackendAgentConfiguration {
  systemPrompt: string
  /** 可信入口的中立最终输出要求，仅注入根 Agent 系统上下文，不作为协议级结构化输出承诺。 */
  finalOutputInstruction?: string
  features: BackendAgentFeatures
  generateTitle: boolean
}

export interface BackendOwnedRun {
  sessionId: string
  runId: BackendRunId
  runStartedAt: number
}

/** 仅供原入口保存真实停止目标；不进入 JSONL，不把子轮次当作父会话控制目标。 */
export interface AgentRunIdentityEvent {
  phase: 'started' | 'finished'
  run: BackendOwnedRun
}

/** 后端控制命令指向真实主/子轮次，不以页面上的父会话投影代替执行对象。 */
export interface BackendRunControlInput {
  sessionId: string
  runId: BackendRunId
}

/** 暂停先收束原根执行，再产生可继续凭据；不保存客户端身份或 Runtime 对象。 */
export interface AgentPauseSnapshot extends BackendOwnedRun {
  /** 原始输入消息 UUID；继续沿用该逻辑轮次，不复用旧执行 runId。 */
  turnId: string
  pauseId: string
  state: 'pausing' | 'paused'
}

/** 继续只接受确切暂停身份，不接受新正文、重放工具或客户端自报的旧运行上下文。 */
export interface AgentContinueInput {
  sessionId: string
  pauseId: string
}

/** 暂停变化只使缓存失效；观察入口必须重读快照，不能凭通知恢复旧控制权限。 */
export interface AgentPauseChangedEvent { sessionId: string }

export interface BackendPermissionReply extends BackendRunControlInput {
  response: AgentPermissionResponse
}

export interface BackendAskUserReply extends BackendRunControlInput {
  response: AgentAskUserResponse
}

/** 元数据广播不属于运行流；事件包保留真实执行身份和单独的 UI 归属。 */
export interface BackendAgentRunEvent {
  run: BackendOwnedRun
  visibleSessionId: string
  event: Exclude<AgentGenerationEvent, { type: 'session_title' }>
}

/** 工作流身份覆盖初始主轮、子任务及后台合成续跑；不是某一个 Runtime 轮次。 */
export interface BackendAgentWorkflow {
  sessionId: string
  workflowId: string
  startedAt: number
}
export interface AgentWorkflowControlInput { sessionId: string; workflowId: string }
export interface AgentWorkflowResult {
  workflow: BackendAgentWorkflow
  status: 'completed' | 'failed' | 'canceled'
  /** 最后一轮主 Agent 的真实身份/落盘摘要；取消于发送前时可以没有。 */
  lastRun?: BackendOwnedRun
  completion?: AgentCompletionPayload
  error?: AgentTypedError
}
export type BackendAgentWorkflowEvent =
  | { type: 'workflow_started'; workflow: BackendAgentWorkflow }
  | { type: 'workflow_finished'; result: AgentWorkflowResult }

/** Chat 复用执行层已有 generationId，不为同一次生成再创建另一份轮次身份。 */
export interface BackendChatGeneration {
  conversationId: string
  generationId: string
}

/** 原入口的真实控制身份，覆盖凭据预检期；不作为消息或历史持久化。 */
export interface ChatGenerationIdentityEvent {
  phase: 'started' | 'finished'
  generation: BackendChatGeneration
}
