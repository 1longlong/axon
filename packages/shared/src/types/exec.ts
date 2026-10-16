/** CLI 的公开 JSONL 运行事件；不输出私有 RPC 包、客户端身份或 Runtime SDK 对象。 */
import type { AgentWorkflowResult, BackendAgentRunEvent, BackendAgentWorkflow, BackendOwnedRun } from './backend'

export interface ExecEventIdentity {
  version: 1
  executionId: string
  sequence: number
  timestamp: number
}
export interface ExecAgentEvent extends ExecEventIdentity {
  type: 'agent_event'
  /** 主/子轮次使用实际执行身份，不用 UI 投影冒充主轮。 */
  run: BackendOwnedRun
  visibleSessionId: string
  event: BackendAgentRunEvent['event']
}

/** 后端业务范围收束，不代表 stdout/文件/进程清理已经成功。 */
export type ExecWorkflowEvent =
  | (ExecEventIdentity & { type: 'workflow_started'; workflow: BackendAgentWorkflow })
  | (ExecEventIdentity & { type: 'workflow_finished'; result: AgentWorkflowResult })

export type ExecExitCode = 0 | 1 | 2 | 3 | 124 | 130 | 143
export interface ExecExecutionCompletion {
  exitCode: ExecExitCode
  cleanup: 'completed' | 'failed' | 'not_started'
  error?: import('./agent-message').AgentTypedError
}
/** CLI 范围包含业务完成之后的输出和后端退出；进程退出码仍是最终交付依据。 */
export type ExecExecutionEvent =
  | (ExecEventIdentity & { type: 'exec_started' })
  | (ExecEventIdentity & { type: 'exec_finished'; completion: ExecExecutionCompletion })

export type ExecEvent = ExecAgentEvent | ExecWorkflowEvent | ExecExecutionEvent
