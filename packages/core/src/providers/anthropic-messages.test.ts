import { describe, expect, test } from 'bun:test'

import {
  AnthropicMessagesStreamAdapter,
  AnthropicMessagesStreamError,
} from './anthropic-messages'
import { parseServerSentEvents } from './sse-parser'
import type { ProviderStreamEvent, ServerSentEvent } from './types'

const encoder = new TextEncoder()

function event(type: string, payload: Record<string, unknown> = {}): ServerSentEvent {
  return { event: type, data: JSON.stringify({ type, ...payload }) }
}

function messageStart(usage: Record<string, unknown> = {}): ServerSentEvent {
  return event('message_start', {
    message: {
      id: 'msg-test',
      type: 'message',
      role: 'assistant',
      content: [],
      usage,
    },
  })
}

function messageDelta(
  stopReason: string,
  usage: Record<string, unknown> = {},
): ServerSentEvent {
  return event('message_delta', {
    delta: { stop_reason: stopReason, stop_sequence: null },
    usage,
  })
}

describe('AnthropicMessagesStreamAdapter', () => {
  test('映射文本、分阶段累计用量，并在 message_stop 输出 finish', () => {
    const adapter = new AnthropicMessagesStreamAdapter()

    expect(
      adapter.parseEvent(
        messageStart({
          input_tokens: 18,
          output_tokens: 1,
          cache_read_input_tokens: 4,
          cache_creation_input_tokens: 2,
        }),
      ),
    ).toEqual([
      {
        type: 'usage',
        usage: {
          inputTokens: 24,
          outputTokens: 1,
          cacheReadTokens: 4,
          cacheWriteTokens: 2,
          totalTokens: 25,
        },
      },
    ])
    expect(
      adapter.parseEvent(
        event('content_block_start', {
          index: 0,
          content_block: { type: 'text', text: '' },
        }),
      ),
    ).toEqual([])
    expect(
      adapter.parseEvent(
        event('content_block_delta', {
          index: 0,
          delta: { type: 'text_delta', text: '你好' },
        }),
      ),
    ).toEqual([{ type: 'text_delta', delta: '你好' }])
    adapter.parseEvent(event('content_block_stop', { index: 0 }))
    expect(
      adapter.parseEvent(
        messageDelta('end_turn', {
          output_tokens: 7,
          output_tokens_details: { thinking_tokens: 3 },
        }),
      ),
    ).toEqual([
      {
        type: 'usage',
        usage: {
          inputTokens: 24,
          outputTokens: 7,
          reasoningTokens: 3,
          cacheReadTokens: 4,
          cacheWriteTokens: 2,
          totalTokens: 31,
        },
      },
    ])
    expect(adapter.parseEvent(event('message_stop'))).toEqual([
      { type: 'finish', reason: 'stop', providerReason: 'end_turn' },
    ])
    expect(adapter.isComplete).toBe(true)
    expect(() => adapter.assertComplete()).not.toThrow()
  })

  test('把思考文本和不透明签名保持在同一个 reasoning block', () => {
    const adapter = new AnthropicMessagesStreamAdapter()
    adapter.parseEvent(messageStart())

    expect(
      adapter.parseEvent(
        event('content_block_start', {
          index: 0,
          content_block: { type: 'thinking', thinking: '', signature: '' },
        }),
      ),
    ).toEqual([{ type: 'reasoning_start', blockId: 'content:0' }])
    expect(
      adapter.parseEvent(
        event('content_block_delta', {
          index: 0,
          delta: { type: 'thinking_delta', thinking: '先分析' },
        }),
      ),
    ).toEqual([
      { type: 'reasoning_delta', blockId: 'content:0', delta: '先分析' },
    ])
    expect(
      adapter.parseEvent(
        event('content_block_delta', {
          index: 0,
          delta: { type: 'signature_delta', signature: 'opaque-signature' },
        }),
      ),
    ).toEqual([
      {
        type: 'reasoning_signature',
        blockId: 'content:0',
        signatureDelta: 'opaque-signature',
      },
    ])
    expect(adapter.parseEvent(event('content_block_stop', { index: 0 }))).toEqual([
      { type: 'reasoning_end', blockId: 'content:0' },
    ])
  })

  test('按 content index 关联并行工具参数与生命周期', () => {
    const adapter = new AnthropicMessagesStreamAdapter()
    const events: ProviderStreamEvent[] = []
    adapter.parseEvent(messageStart())

    events.push(
      ...adapter.parseEvent(
        event('content_block_start', {
          index: 0,
          content_block: {
            type: 'tool_use',
            id: 'tool-weather',
            name: 'get_weather',
            input: {},
          },
        }),
      ),
      ...adapter.parseEvent(
        event('content_block_start', {
          index: 1,
          content_block: {
            type: 'tool_use',
            id: 'tool-time',
            name: 'get_time',
            input: {},
          },
        }),
      ),
      ...adapter.parseEvent(
        event('content_block_delta', {
          index: 1,
          delta: { type: 'input_json_delta', partial_json: '{"zone":"UTC"}' },
        }),
      ),
      ...adapter.parseEvent(
        event('content_block_delta', {
          index: 0,
          delta: { type: 'input_json_delta', partial_json: '{"city":"上海"}' },
        }),
      ),
      ...adapter.parseEvent(event('content_block_stop', { index: 1 })),
      ...adapter.parseEvent(event('content_block_stop', { index: 0 })),
      ...adapter.parseEvent(messageDelta('tool_use')),
      ...adapter.parseEvent(event('message_stop')),
    )

    expect(events).toEqual([
      {
        type: 'tool_call_start',
        callKey: 'content:0',
        callId: 'tool-weather',
        name: 'get_weather',
      },
      {
        type: 'tool_call_start',
        callKey: 'content:1',
        callId: 'tool-time',
        name: 'get_time',
      },
      {
        type: 'tool_call_delta',
        callKey: 'content:1',
        argumentsDelta: '{"zone":"UTC"}',
      },
      {
        type: 'tool_call_delta',
        callKey: 'content:0',
        argumentsDelta: '{"city":"上海"}',
      },
      { type: 'tool_call_end', callKey: 'content:1' },
      { type: 'tool_call_end', callKey: 'content:0' },
      { type: 'finish', reason: 'tool_use', providerReason: 'tool_use' },
    ])
  })

  test('映射 Anthropic 的主要停止原因并保留未知原因', () => {
    const cases = [
      ['stop_sequence', 'stop'],
      ['max_tokens', 'length'],
      ['model_context_window_exceeded', 'length'],
      ['refusal', 'content_filter'],
      ['pause_turn', 'other'],
    ] as const

    for (const [providerReason, reason] of cases) {
      const adapter = new AnthropicMessagesStreamAdapter()
      adapter.parseEvent(messageStart())
      adapter.parseEvent(messageDelta(providerReason))
      expect(adapter.parseEvent(event('message_stop'))).toEqual([
        { type: 'finish', reason, providerReason },
      ])
    }
  })

  test('与增量 SSE 解析器组合后保持命名事件顺序', async () => {
    const sourceEvents = [
      messageStart(),
      event('content_block_start', {
        index: 0,
        content_block: { type: 'text', text: '' },
      }),
      event('content_block_delta', {
        index: 0,
        delta: { type: 'text_delta', text: '流式文本' },
      }),
      event('content_block_stop', { index: 0 }),
      messageDelta('end_turn'),
      event('message_stop'),
    ]
    const body = sourceEvents
      .map((item) => `event: ${item.event}\ndata: ${item.data}\n\n`)
      .join('')
    const bytes = encoder.encode(body)
    const stream = new ReadableStream<Uint8Array>({
      start(controller) {
        for (const byte of bytes) {
          controller.enqueue(Uint8Array.of(byte))
        }
        controller.close()
      },
    })
    const adapter = new AnthropicMessagesStreamAdapter()
    const events: ProviderStreamEvent[] = []
    for await (const sseEvent of parseServerSentEvents(stream)) {
      events.push(...adapter.parseEvent(sseEvent))
    }
    adapter.assertComplete()

    expect(events).toEqual([
      { type: 'text_delta', delta: '流式文本' },
      { type: 'finish', reason: 'stop', providerReason: 'end_turn' },
    ])
  })

  test('安全忽略 ping、未知事件和服务端工具块', () => {
    const adapter = new AnthropicMessagesStreamAdapter()
    adapter.parseEvent(messageStart())
    expect(adapter.parseEvent(event('ping'))).toEqual([])
    expect(adapter.parseEvent(event('future_event', { value: 1 }))).toEqual([])
    expect(
      adapter.parseEvent(
        event('content_block_start', {
          index: 0,
          content_block: { type: 'server_tool_use', id: 'srv-1', name: 'web_search' },
        }),
      ),
    ).toEqual([])
    expect(adapter.parseEvent(event('content_block_stop', { index: 0 }))).toEqual([])
  })

  test('拒绝错误事件、块类型错配、缺失终态和终态后事件', () => {
    const providerError = new AnthropicMessagesStreamAdapter()
    expect(() =>
      providerError.parseEvent(
        event('error', { error: { type: 'overloaded_error', message: 'secret' } }),
      ),
    ).toThrow(
      expect.objectContaining(
        { code: 'provider_error' } satisfies Partial<AnthropicMessagesStreamError>,
      ),
    )

    const mismatch = new AnthropicMessagesStreamAdapter()
    mismatch.parseEvent(messageStart())
    mismatch.parseEvent(
      event('content_block_start', {
        index: 0,
        content_block: { type: 'text', text: '' },
      }),
    )
    expect(() =>
      mismatch.parseEvent(
        event('content_block_delta', {
          index: 0,
          delta: { type: 'input_json_delta', partial_json: '{}' },
        }),
      ),
    ).toThrow(
      expect.objectContaining(
        { code: 'protocol_violation' } satisfies Partial<AnthropicMessagesStreamError>,
      ),
    )

    const missingStop = new AnthropicMessagesStreamAdapter()
    missingStop.parseEvent(messageStart())
    expect(() => missingStop.assertComplete()).toThrow(
      expect.objectContaining(
        { code: 'protocol_violation' } satisfies Partial<AnthropicMessagesStreamError>,
      ),
    )

    const completed = new AnthropicMessagesStreamAdapter()
    completed.parseEvent(messageStart())
    completed.parseEvent(messageDelta('end_turn'))
    completed.parseEvent(event('message_stop'))
    expect(() => completed.parseEvent(event('ping'))).toThrow(
      expect.objectContaining(
        { code: 'protocol_violation' } satisfies Partial<AnthropicMessagesStreamError>,
      ),
    )
  })
})
