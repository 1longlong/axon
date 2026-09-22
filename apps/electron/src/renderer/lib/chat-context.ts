import type { ChatMessage } from '@axon/shared'
import { contentBlocksToPlainText } from './chat-message'

/** 当前仅作 UI 预算提示，不能冒充供应商精确 tokenizer。 */
export const DEFAULT_CONTEXT_WINDOW_TOKENS = 128_000
export const AUTO_SUMMARY_TRIGGER_RATIO = 0.8
export const AUTO_SUMMARY_KEEP_RECENT_MESSAGES = 8

/** 用 Unicode 字符数近似 token 数，给预算提示留出安全余量。 */
export function estimateTextTokens(text: string): number {
  return Math.ceil(Array.from(text).length / 3.5)
}

/** 估算 Chat 消息历史的输入 token 总量；Agent 提示词不进入 Chat。 */
export function estimateContextTokens(messages: readonly ChatMessage[]): number {
  return messages.reduce((total, message) => total + estimateTextTokens(contentBlocksToPlainText(message.content)) + 4, 0)
}

export function contextUsageLabel(tokens: number, limit = DEFAULT_CONTEXT_WINDOW_TOKENS): string | null {
  const ratio = tokens / limit
  if (ratio < 0.8) return null
  return ratio >= 1 ? '上下文估算已超过预算，请考虑清理历史' : `上下文估算约 ${(ratio * 100).toFixed(0)}%`
}

export interface SummaryCandidate {
  messageIds: string[]
  text: string
  estimatedTokens: number
}

/** 选择最早的完整消息作为摘要候选，保留最近消息和所有未完成消息。 */
export function selectSummaryCandidate(
  messages: readonly ChatMessage[],
  limit = DEFAULT_CONTEXT_WINDOW_TOKENS,
): SummaryCandidate | null {
  const total = estimateContextTokens(messages)
  if (total < limit * AUTO_SUMMARY_TRIGGER_RATIO) return null
  const completed = messages.filter((message) => message.status === 'complete')
  const candidates = completed.slice(0, Math.max(0, completed.length - AUTO_SUMMARY_KEEP_RECENT_MESSAGES))
  if (candidates.length === 0) return null
  const text = candidates.map((message) => contentBlocksToPlainText(message.content)).join('\n\n')
  return {
    messageIds: candidates.map((message) => message.id),
    text,
    estimatedTokens: estimateTextTokens(text),
  }
}
