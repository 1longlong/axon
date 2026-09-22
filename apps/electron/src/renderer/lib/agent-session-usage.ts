import type { SDKMessage } from '@axon/shared'

export interface AgentContextWindowUsage {
  usedTokens: number
  limitTokens: number | null
  ratio: number | null
}

function readTokenCount(value: unknown): number {
  return typeof value === 'number' && Number.isFinite(value) && value >= 0 ? value : 0
}

function estimateDraftTokens(text: string): number {
  return Math.ceil(Array.from(text).length / 3.5)
}

function usageTokens(value: unknown): number | null {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return null
  const usage = value as Record<string, unknown>
  if (typeof usage.input_tokens !== 'number') return null
  return readTokenCount(usage.input_tokens)
    + readTokenCount(usage.output_tokens)
    + readTokenCount(usage.cache_read_input_tokens)
    + readTokenCount(usage.cache_creation_input_tokens)
}

/**
 * 计算下一次请求的上下文窗口占用：最后一次模型调用代表当前历史基线，
 * 再加入尚未发送的草稿；不能累计所有 result，否则会把历史重复计数。
 */
export function getAgentContextWindowUsage(
  messages: readonly SDKMessage[],
  draft = '',
): AgentContextWindowUsage {
  let limitTokens: number | null = null
  let baselineTokens = 0
  let baselineFound = false

  // 从尾部取最近配置和最近调用，使模型切换及工具循环后的结果立即生效。
  for (let index = messages.length - 1; index >= 0; index -= 1) {
    const message = messages[index]! as Record<string, unknown>
    if (
      limitTokens === null
      && message.type === 'system'
      && message.subtype === 'init'
      && readTokenCount(message.context_window_tokens) > 0
    ) limitTokens = readTokenCount(message.context_window_tokens)

    if (
      !baselineFound
      && message.type === 'system'
      && message.subtype === 'compact_boundary'
      && message.compact_result === 'success'
    ) {
      baselineTokens = typeof message.context_tokens_after === 'number'
        && Number.isFinite(message.context_tokens_after)
        && message.context_tokens_after >= 0
        ? message.context_tokens_after
        : typeof message.summary === 'string' ? estimateDraftTokens(message.summary) : 0
      baselineFound = true
    }
    if (!baselineFound && message.type === 'assistant') {
      const payload = message.message
      const tokens = payload && typeof payload === 'object' && !Array.isArray(payload)
        ? usageTokens((payload as Record<string, unknown>).usage)
        : null
      if (tokens !== null) {
        baselineTokens = tokens
        baselineFound = true
      }
    }
    if (limitTokens !== null && baselineFound) break
  }

  const usedTokens = baselineTokens + estimateDraftTokens(draft)
  return {
    usedTokens,
    limitTokens,
    ratio: limitTokens === null ? null : usedTokens / limitTokens,
  }
}
