import { describe, expect, test } from 'bun:test'

import {
  OpenAIChatCompletionsStreamAdapter,
  OpenAIChatStreamError,
} from './openai-chat-completions'
import { parseServerSentEvents } from './sse-parser'
import type { ProviderStreamEvent, ServerSentEvent } from './types'

const encoder = new TextEncoder()

function event(data: string): ServerSentEvent {
  return { event: 'message', data }
}

function chunk(
  choices: readonly Record<string, unknown>[],
  usage?: Record<string, unknown>,
): ServerSentEvent {
  return event(
    JSON.stringify({
      id: 'chatcmpl-test',
      object: 'chat.completion.chunk',
      choices,
      ...(usage === undefined ? {} : { usage }),
    }),
  )
}

function choice(
  delta: Record<string, unknown>,
  finishReason: string | null = null,
): Record<string, unknown> {
  return { index: 0, delta, finish_reason: finishReason }
}

describe('OpenAIChatCompletionsStreamAdapter', () => {
  test('累计正文、拒绝文本、详细用量，并在 [DONE] 才发出 finish', () => {
    const adapter = new OpenAIChatCompletionsStreamAdapter()

    expect(adapter.parseEvent(chunk([choice({ role: 'assistant', content: '' })]))).toEqual(
      [],
    )
    expect(adapter.parseEvent(chunk([choice({ content: '你好' })]))).toEqual([
      { type: 'text_delta', delta: '你好' },
    ])
    expect(adapter.parseEvent(chunk([choice({ refusal: '无法回答' })]))).toEqual([
      { type: 'text_delta', delta: '无法回答' },
    ])
    expect(adapter.parseEvent(chunk([choice({}, 'stop')]))).toEqual([])
    expect(
      adapter.parseEvent(
        chunk([], {
          prompt_tokens: 12,
          completion_tokens: 7,
          total_tokens: 19,
          prompt_tokens_details: {
            cached_tokens: 4,
            cache_write_tokens: 2,
          },
          completion_tokens_details: { reasoning_tokens: 3 },
        }),
      ),
    ).toEqual([
      {
        type: 'usage',
        usage: {
          inputTokens: 12,
          outputTokens: 7,
          reasoningTokens: 3,
          cacheReadTokens: 4,
          cacheWriteTokens: 2,
          totalTokens: 19,
        },
      },
    ])
    expect(adapter.isComplete).toBe(false)
    expect(adapter.parseEvent(event('[DONE]'))).toEqual([
      { type: 'finish', reason: 'stop', providerReason: 'stop' },
    ])
    expect(adapter.isComplete).toBe(true)
    expect(() => adapter.assertComplete()).not.toThrow()
  })

  test('用稳定 callKey 分别累计并行工具调用及参数分片', () => {
    const adapter = new OpenAIChatCompletionsStreamAdapter()
    const events: ProviderStreamEvent[] = []

    events.push(
      ...adapter.parseEvent(
        chunk([
          choice({
            tool_calls: [
              {
                index: 0,
                id: 'call-weather',
                type: 'function',
                function: { name: 'get_weather', arguments: '{"city":' },
              },
              {
                index: 1,
                id: 'call-time',
                type: 'function',
                function: { name: 'get_time', arguments: '' },
              },
            ],
          }),
        ]),
      ),
    )
    events.push(
      ...adapter.parseEvent(
        chunk([
          choice({
            tool_calls: [
              { index: 1, function: { arguments: '{"zone":"Asia/Shanghai"}' } },
              { index: 0, function: { arguments: '"上海"}' } },
            ],
          }),
        ]),
      ),
    )
    events.push(...adapter.parseEvent(chunk([choice({}, 'tool_calls')])))

    expect(events).toEqual([
      {
        type: 'tool_call_start',
        callKey: '0:0',
        callId: 'call-weather',
        name: 'get_weather',
      },
      {
        type: 'tool_call_delta',
        callKey: '0:0',
        argumentsDelta: '{"city":',
      },
      {
        type: 'tool_call_start',
        callKey: '0:1',
        callId: 'call-time',
        name: 'get_time',
      },
      {
        type: 'tool_call_delta',
        callKey: '0:1',
        argumentsDelta: '{"zone":"Asia/Shanghai"}',
      },
      {
        type: 'tool_call_delta',
        callKey: '0:0',
        argumentsDelta: '"上海"}',
      },
      { type: 'tool_call_end', callKey: '0:0' },
      { type: 'tool_call_end', callKey: '0:1' },
    ])
    expect(adapter.parseEvent(event('[DONE]'))).toEqual([
      { type: 'finish', reason: 'tool_use', providerReason: 'tool_calls' },
    ])
  })

  test('元数据晚于参数时先缓冲，仍保证 start 在 delta 之前', () => {
    const adapter = new OpenAIChatCompletionsStreamAdapter()
    expect(
      adapter.parseEvent(
        chunk([
          choice({
            tool_calls: [{ index: 0, function: { arguments: '{"city":"上海"}' } }],
          }),
        ]),
      ),
    ).toEqual([])

    expect(
      adapter.parseEvent(
        chunk([
          choice({
            tool_calls: [
              {
                index: 0,
                id: 'call-late',
                type: 'function',
                function: { name: 'get_weather' },
              },
            ],
          }),
        ]),
      ),
    ).toEqual([
      {
        type: 'tool_call_start',
        callKey: '0:0',
        callId: 'call-late',
        name: 'get_weather',
      },
      {
        type: 'tool_call_delta',
        callKey: '0:0',
        argumentsDelta: '{"city":"上海"}',
      },
    ])
  })

  test('把 OpenAI 结束原因映射为中立原因，并保留未知值', () => {
    const cases = [
      ['stop', 'stop'],
      ['length', 'length'],
      ['content_filter', 'content_filter'],
      ['vendor_extension', 'other'],
    ] as const

    for (const [providerReason, expectedReason] of cases) {
      const adapter = new OpenAIChatCompletionsStreamAdapter()
      expect(adapter.parseEvent(chunk([choice({}, providerReason)]))).toEqual([])
      expect(adapter.parseEvent(event('[DONE]'))).toEqual([
        {
          type: 'finish',
          reason: expectedReason,
          providerReason,
        },
      ])
    }
  })

  test('与增量 SSE 解析器组合后保持事件顺序', async () => {
    const body = [
      `data: ${chunk([choice({ content: '你' })]).data}\r\n\r\n`,
      `data: ${chunk([choice({ content: '好' })]).data}\n\n`,
      `data: ${chunk([choice({}, 'stop')]).data}\n\n`,
      'data: [DONE]\n\n',
    ].join('')
    const bytes = encoder.encode(body)
    const stream = new ReadableStream<Uint8Array>({
      start(controller) {
        for (const byte of bytes) {
          controller.enqueue(Uint8Array.of(byte))
        }
        controller.close()
      },
    })
    const adapter = new OpenAIChatCompletionsStreamAdapter()
    const events: ProviderStreamEvent[] = []
    for await (const sseEvent of parseServerSentEvents(stream)) {
      events.push(...adapter.parseEvent(sseEvent))
    }
    adapter.assertComplete()

    expect(events).toEqual([
      { type: 'text_delta', delta: '你' },
      { type: 'text_delta', delta: '好' },
      { type: 'finish', reason: 'stop', providerReason: 'stop' },
    ])
  })

  test('拒绝不可信 JSON、错误事件、多候选与非法用量', () => {
    const invalidJson = new OpenAIChatCompletionsStreamAdapter()
    expect(() => invalidJson.parseEvent(event('{secret'))).toThrow(
      expect.objectContaining(
        { code: 'invalid_json' } satisfies Partial<OpenAIChatStreamError>,
      ),
    )

    const providerError = new OpenAIChatCompletionsStreamAdapter()
    expect(() =>
      providerError.parseEvent(event('{"error":{"message":"secret detail"}}')),
    ).toThrow(
      expect.objectContaining(
        { code: 'provider_error' } satisfies Partial<OpenAIChatStreamError>,
      ),
    )

    const multipleChoices = new OpenAIChatCompletionsStreamAdapter()
    expect(() =>
      multipleChoices.parseEvent(
        chunk([{ index: 1, delta: { content: '不支持' }, finish_reason: null }]),
      ),
    ).toThrow(
      expect.objectContaining(
        { code: 'unsupported_choice' } satisfies Partial<OpenAIChatStreamError>,
      ),
    )

    const invalidUsage = new OpenAIChatCompletionsStreamAdapter()
    expect(() => invalidUsage.parseEvent(chunk([], { prompt_tokens: -1 }))).toThrow(
      expect.objectContaining(
        { code: 'invalid_chunk' } satisfies Partial<OpenAIChatStreamError>,
      ),
    )
  })

  test('拒绝缺失终态、工具元数据不全和终态后的额外事件', () => {
    const missingFinish = new OpenAIChatCompletionsStreamAdapter()
    expect(() => missingFinish.parseEvent(event('[DONE]'))).toThrow(
      expect.objectContaining(
        { code: 'protocol_violation' } satisfies Partial<OpenAIChatStreamError>,
      ),
    )
    expect(() => missingFinish.assertComplete()).toThrow(
      expect.objectContaining(
        { code: 'protocol_violation' } satisfies Partial<OpenAIChatStreamError>,
      ),
    )

    const incompleteTool = new OpenAIChatCompletionsStreamAdapter()
    incompleteTool.parseEvent(
      chunk([
        choice({
          tool_calls: [{ index: 0, function: { arguments: '{}' } }],
        }),
      ]),
    )
    expect(() => incompleteTool.parseEvent(chunk([choice({}, 'tool_calls')]))).toThrow(
      expect.objectContaining(
        { code: 'protocol_violation' } satisfies Partial<OpenAIChatStreamError>,
      ),
    )

    const completed = new OpenAIChatCompletionsStreamAdapter()
    completed.parseEvent(chunk([choice({}, 'stop')]))
    completed.parseEvent(event('[DONE]'))
    expect(() => completed.parseEvent(event('[DONE]'))).toThrow(
      expect.objectContaining(
        { code: 'protocol_violation' } satisfies Partial<OpenAIChatStreamError>,
      ),
    )
  })

  test('拒绝旧版 function_call 和非 function 工具', () => {
    const legacy = new OpenAIChatCompletionsStreamAdapter()
    expect(() =>
      legacy.parseEvent(
        chunk([choice({ function_call: { name: 'legacy', arguments: '{}' } })]),
      ),
    ).toThrow(
      expect.objectContaining(
        { code: 'unsupported_tool' } satisfies Partial<OpenAIChatStreamError>,
      ),
    )

    const custom = new OpenAIChatCompletionsStreamAdapter()
    expect(() =>
      custom.parseEvent(
        chunk([
          choice({
            tool_calls: [{ index: 0, type: 'custom', custom: { name: 'shell' } }],
          }),
        ]),
      ),
    ).toThrow(
      expect.objectContaining(
        { code: 'unsupported_tool' } satisfies Partial<OpenAIChatStreamError>,
      ),
    )
  })
})
