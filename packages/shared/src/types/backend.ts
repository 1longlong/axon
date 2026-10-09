/** 后端逻辑身份由可信入口登记；不采用 renderer 自报的窗口或会话标识作为 owner。 */
import type { AgentAskUserResponse, AgentGenerationEvent, AgentPermissionResponse } from './agent-run'

export type BackendClientId = string
export type BackendRunId = string

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
