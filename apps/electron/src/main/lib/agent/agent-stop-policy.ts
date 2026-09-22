import type { AgentStreamPayload, SDKMessageUsage, SDKResultMessage } from '@axon/shared'

interface UserStoppedResultInput {
  sessionId: string
  usage?: SDKMessageUsage
  totalCostUsd?: number
}

/**
 * 生成统一的用户停止终态，供 adapter 正常中止和编排层异常中止共同使用。
 * 上游只提供已产生的用量；下游据 stopped_by_user 更新 UI、JSONL 与完成通知。
 */
export function createUserStoppedResult(input: UserStoppedResultInput): SDKResultMessage {
  return {
    type: 'result',
    subtype: 'error',
    usage: input.usage ?? { input_tokens: 0, output_tokens: 0 },
    ...(input.totalCostUsd === undefined ? {} : { total_cost_usd: input.totalCostUsd }),
    terminal_reason: 'stopped',
    stopped_by_user: true,
    errors: ['Agent 执行已停止'],
    error: {
      code: 'canceled',
      category: 'canceled',
      message: 'Agent 执行已停止',
      retryable: false,
    },
    session_id: input.sessionId,
  }
}

/**
 * 用户停止后丢弃迟到的 delta、工具消息与重试状态，只允许唯一 result 继续下游。
 * 即使 adapter 存在竞态，编排层也不会把停止后的活动写入 Axon JSONL 或 UI。
 */
export function normalizePayloadAfterUserStop(
  payload: AgentStreamPayload,
  sessionId: string,
): AgentStreamPayload | null {
  if (payload.kind !== 'sdk_message' || payload.message.type !== 'result') return null
  const result = payload.message as SDKResultMessage
  return {
    kind: 'sdk_message',
    message: createUserStoppedResult({
      sessionId,
      usage: result.usage,
      totalCostUsd: result.total_cost_usd,
    }),
  }
}
