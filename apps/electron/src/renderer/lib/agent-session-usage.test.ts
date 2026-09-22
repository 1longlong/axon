import { describe, expect, test } from 'bun:test'
import type { SDKMessage } from '@axon/shared'
import { getAgentContextWindowUsage } from './agent-session-usage'

function assistant(input: number, output = 0, cacheRead = 0, cacheWrite = 0): SDKMessage {
  return {
    type: 'assistant',
    message: {
      content: [],
      usage: {
        input_tokens: input,
        output_tokens: output,
        cache_read_input_tokens: cacheRead,
        cache_creation_input_tokens: cacheWrite,
      },
    },
    parent_tool_use_id: null,
  }
}

describe('Agent 上下文窗口用量', () => {
  test('使用最近一次模型调用作为基线，并加入未发送草稿', () => {
    const messages: SDKMessage[] = [
      { type: 'system', subtype: 'init', context_window_tokens: 200_000 },
      assistant(1_000, 200),
      assistant(4_000, 500, 300, 200),
    ]

    expect(getAgentContextWindowUsage(messages, '1234567')).toEqual({
      usedTokens: 5_002,
      limitTokens: 200_000,
      ratio: 5_002 / 200_000,
    })
  })

  test('模型切换后采用最近窗口，压缩后不再使用旧调用基线', () => {
    const messages: SDKMessage[] = [
      { type: 'system', subtype: 'init', context_window_tokens: 100_000 },
      assistant(80_000, 1_000),
      {
        type: 'system', subtype: 'compact_boundary', compact_result: 'success',
        summary: '1234567', context_tokens_after: 12_500,
      },
      { type: 'system', subtype: 'init', context_window_tokens: 32_000 },
    ]

    expect(getAgentContextWindowUsage(messages)).toEqual({
      usedTokens: 12_500,
      limitTokens: 32_000,
      ratio: 12_500 / 32_000,
    })
  })

  test('失败或取消的压缩边界不清空最近一次有效用量', () => {
    const messages: SDKMessage[] = [
      { type: 'system', subtype: 'init', context_window_tokens: 100_000 },
      assistant(70_000, 2_000),
      { type: 'system', subtype: 'compact_boundary', compact_result: 'failed', compact_error: '摘要失败' },
    ]

    expect(getAgentContextWindowUsage(messages)).toEqual({
      usedTokens: 72_000,
      limitTokens: 100_000,
      ratio: 72_000 / 100_000,
    })
  })

  test('首次模型初始化前仍返回用量估算，但比例未知', () => {
    expect(getAgentContextWindowUsage([], '1234')).toEqual({
      usedTokens: 2,
      limitTokens: null,
      ratio: null,
    })
  })
})
