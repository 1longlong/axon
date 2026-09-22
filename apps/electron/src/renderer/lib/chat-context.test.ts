import { describe, expect, test } from 'bun:test'
import type { ChatMessage } from '@axon/shared'
import { contextUsageLabel, estimateContextTokens, estimateTextTokens, selectSummaryCandidate } from './chat-context'

const message: ChatMessage = {
  id: 'message-1',
  role: 'user',
  content: [{ type: 'text', text: '你好，世界' }],
  createdAt: 1,
  status: 'complete',
}

describe('Chat 上下文估算', () => {
  test('按 Unicode 字符近似 token，并计入消息结构开销', () => {
    expect(estimateTextTokens('abcd')).toBe(2)
    expect(estimateContextTokens([message])).toBeGreaterThan(estimateTextTokens('你好，世界'))
  })

  test('只在接近或超过预算时显示提示', () => {
    expect(contextUsageLabel(1_000, 2_000)).toBeNull()
    expect(contextUsageLabel(1_600, 2_000)).toContain('80%')
    expect(contextUsageLabel(2_000, 2_000)).toContain('超过预算')
  })

  test('只选择最早的完整消息，保留最近消息作为上下文', () => {
    const messages = Array.from({ length: 10 }, (_, index) => ({ ...message, id: `message-${index}`, content: [{ type: 'text' as const, text: 'x'.repeat(10_000) }] }))
    const candidate = selectSummaryCandidate(messages, 1_000)
    expect(candidate?.messageIds).toEqual(['message-0', 'message-1'])
    expect(candidate?.text).not.toContain('message-8')
  })
})
