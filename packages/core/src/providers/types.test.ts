import { describe, expect, test } from 'bun:test'

import { isProviderFinishEvent } from './types'
import type {
  ProviderStreamAdapter,
  ProviderStreamEvent,
  ServerSentEvent,
} from './types'

describe('ProviderStreamEvent', () => {
  test('一个原始事件可以展开为有序的工具调用、用量和结束事件', () => {
    const adapter: ProviderStreamAdapter = {
      parseEvent(event: ServerSentEvent): readonly ProviderStreamEvent[] {
        if (event.event !== 'tool') {
          return []
        }
        return [
          {
            type: 'tool_call_start',
            callKey: '0',
            callId: 'call-1',
            name: 'weather',
          },
          { type: 'tool_call_delta', callKey: '0', argumentsDelta: event.data },
          { type: 'tool_call_end', callKey: '0' },
          { type: 'usage', usage: { inputTokens: 8, outputTokens: 5 } },
          { type: 'finish', reason: 'tool_use', providerReason: 'tool_calls' },
        ]
      },
      assertComplete(): void {},
    }

    const events = adapter.parseEvent({ event: 'tool', data: '{"city":"上海"}' })
    expect(events.map((event) => event.type)).toEqual([
      'tool_call_start',
      'tool_call_delta',
      'tool_call_end',
      'usage',
      'finish',
    ])
    expect(events.some(isProviderFinishEvent)).toBe(true)
  })

  test('推理内容和签名通过稳定 blockId 关联', () => {
    const events: ProviderStreamEvent[] = [
      { type: 'reasoning_start', blockId: 'reasoning-0' },
      { type: 'reasoning_delta', blockId: 'reasoning-0', delta: '先分析' },
      {
        type: 'reasoning_signature',
        blockId: 'reasoning-0',
        signatureDelta: 'signed',
      },
      { type: 'reasoning_end', blockId: 'reasoning-0' },
      { type: 'text_delta', delta: '结论' },
    ]

    expect(events.map((event) => event.type)).toEqual([
      'reasoning_start',
      'reasoning_delta',
      'reasoning_signature',
      'reasoning_end',
      'text_delta',
    ])
  })
})
