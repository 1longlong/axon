import type { AgentCompletionPayload, SDKResultMessage } from '@axon/shared'

/**
 * 把已收束的 result 格式化为轻量完成事件；上游传入持久化状态和时间，
 * 下游通知、自动化与 renderer 不需要理解 runtime 或重新遍历消息历史。
 */
export function buildAgentCompletionPayload(
  result: SDKResultMessage,
  runStartedAt: number,
  completedAt: number,
  persisted: boolean,
): AgentCompletionPayload {
  return {
    terminalReason: result.terminal_reason ?? (result.subtype === 'success' ? 'completed' : 'failed'),
    resultSubtype: result.subtype,
    stoppedByUser: result.stopped_by_user === true,
    usage: result.usage,
    ...(result.total_cost_usd === undefined ? {} : { totalCostUsd: result.total_cost_usd }),
    ...(result.error ? { error: result.error } : {}),
    completedAt,
    durationMs: Math.max(0, completedAt - runStartedAt),
    persisted,
  }
}
