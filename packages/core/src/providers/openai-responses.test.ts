import { describe, expect, test } from 'bun:test'

import {
  OpenAIResponsesStreamAdapter,
  OpenAIResponsesStreamError,
} from './openai-responses'
import { parseServerSentEvents } from './sse-parser'
import type { ProviderStreamEvent, ServerSentEvent } from './types'

const encoder = new TextEncoder()

function response(status: string, extra: Record<string, unknown> = {}): Record<string, unknown> {
  return { id: 'resp-test', status, ...extra }
}

function event(
  type: string,
  payload: Record<string, unknown> = {},
  sequenceNumber?: number,
): ServerSentEvent {
  return {
    event: type,
    data: JSON.stringify({
      type,
      ...payload,
      ...(sequenceNumber === undefined ? {} : { sequence_number: sequenceNumber }),
    }),
  }
}

function created(sequenceNumber?: number): ServerSentEvent {
  return event('response.created', { response: response('in_progress') }, sequenceNumber)
}

function functionItem(
  id: string,
  callId: string,
  name: string,
  argumentsText = '',
): Record<string, unknown> {
  return {
    type: 'function_call',
    id,
    call_id: callId,
    name,
    arguments: argumentsText,
    status: 'in_progress',
  }
}

describe('OpenAIResponsesStreamAdapter', () => {
  test('映射命名文本事件，并在 completed 中依次输出详细用量和 finish', () => {
    const adapter = new OpenAIResponsesStreamAdapter()

    expect(adapter.parseEvent(created(0))).toEqual([])
    expect(
      adapter.parseEvent(
        event(
          'response.output_text.delta',
          { item_id: 'msg-1', output_index: 0, content_index: 0, delta: '你好' },
          1,
        ),
      ),
    ).toEqual([{ type: 'text_delta', delta: '你好' }])
    expect(
      adapter.parseEvent(
        event(
          'response.refusal.delta',
          { item_id: 'msg-1', output_index: 0, content_index: 0, delta: '无法回答' },
          2,
        ),
      ),
    ).toEqual([{ type: 'text_delta', delta: '无法回答' }])

    expect(
      adapter.parseEvent(
        event(
          'response.completed',
          {
            response: response('completed', {
              usage: {
                input_tokens: 12,
                output_tokens: 7,
                total_tokens: 19,
                input_tokens_details: {
                  cached_tokens: 4,
                  cache_write_tokens: 2,
                },
                output_tokens_details: { reasoning_tokens: 3 },
              },
            }),
          },
          3,
        ),
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
      { type: 'finish', reason: 'stop', providerReason: 'completed' },
    ])
    expect(adapter.isComplete).toBe(true)
    expect(() => adapter.assertComplete()).not.toThrow()
  })

  test('按 item_id 分别累计并行 function call，并以 tool_use 结束', () => {
    const adapter = new OpenAIResponsesStreamAdapter()
    const events: ProviderStreamEvent[] = []
    adapter.parseEvent(created())

    events.push(
      ...adapter.parseEvent(
        event('response.output_item.added', {
          output_index: 0,
          item: functionItem('fc-weather', 'call-weather', 'get_weather'),
        }),
      ),
    )
    events.push(
      ...adapter.parseEvent(
        event('response.output_item.added', {
          output_index: 1,
          item: functionItem('fc-time', 'call-time', 'get_time'),
        }),
      ),
    )
    events.push(
      ...adapter.parseEvent(
        event('response.function_call_arguments.delta', {
          item_id: 'fc-time',
          output_index: 1,
          delta: '{"zone":"Asia/Shanghai"}',
        }),
      ),
    )
    events.push(
      ...adapter.parseEvent(
        event('response.function_call_arguments.delta', {
          item_id: 'fc-weather',
          output_index: 0,
          delta: '{"city":',
        }),
      ),
    )
    events.push(
      ...adapter.parseEvent(
        event('response.function_call_arguments.delta', {
          item_id: 'fc-weather',
          output_index: 0,
          delta: '"上海"}',
        }),
      ),
    )
    events.push(
      ...adapter.parseEvent(
        event('response.function_call_arguments.done', {
          item_id: 'fc-time',
          output_index: 1,
          name: 'get_time',
          arguments: '{"zone":"Asia/Shanghai"}',
        }),
      ),
    )
    events.push(
      ...adapter.parseEvent(
        event('response.function_call_arguments.done', {
          item_id: 'fc-weather',
          output_index: 0,
          name: 'get_weather',
          arguments: '{"city":"上海"}',
        }),
      ),
    )
    events.push(
      ...adapter.parseEvent(
        event('response.output_item.done', {
          output_index: 0,
          item: {
            ...functionItem(
              'fc-weather',
              'call-weather',
              'get_weather',
              '{"city":"上海"}',
            ),
            status: 'completed',
          },
        }),
      ),
    )
    events.push(
      ...adapter.parseEvent(
        event('response.completed', { response: response('completed') }),
      ),
    )

    expect(events).toEqual([
      {
        type: 'tool_call_start',
        callKey: 'output:0',
        callId: 'call-weather',
        name: 'get_weather',
      },
      {
        type: 'tool_call_start',
        callKey: 'output:1',
        callId: 'call-time',
        name: 'get_time',
      },
      {
        type: 'tool_call_delta',
        callKey: 'output:1',
        argumentsDelta: '{"zone":"Asia/Shanghai"}',
      },
      {
        type: 'tool_call_delta',
        callKey: 'output:0',
        argumentsDelta: '{"city":',
      },
      {
        type: 'tool_call_delta',
        callKey: 'output:0',
        argumentsDelta: '"上海"}',
      },
      { type: 'tool_call_end', callKey: 'output:1' },
      { type: 'tool_call_end', callKey: 'output:0' },
      { type: 'finish', reason: 'tool_use', providerReason: 'completed' },
    ])
  })

  test('output item done 可在参数 done 缺失时校验并兜底结束工具块', () => {
    const adapter = new OpenAIResponsesStreamAdapter()
    adapter.parseEvent(created())
    expect(
      adapter.parseEvent(
        event('response.output_item.added', {
          output_index: 0,
          item: functionItem('fc-1', 'call-1', 'lookup', '{}'),
        }),
      ),
    ).toEqual([
      {
        type: 'tool_call_start',
        callKey: 'output:0',
        callId: 'call-1',
        name: 'lookup',
      },
      { type: 'tool_call_delta', callKey: 'output:0', argumentsDelta: '{}' },
    ])
    expect(
      adapter.parseEvent(
        event('response.output_item.done', {
          output_index: 0,
          item: functionItem('fc-1', 'call-1', 'lookup', '{}'),
        }),
      ),
    ).toEqual([{ type: 'tool_call_end', callKey: 'output:0' }])
  })

  test('把推理摘要和原始推理文本映射为相互独立的块生命周期', () => {
    const adapter = new OpenAIResponsesStreamAdapter()
    adapter.parseEvent(created())

    expect(
      adapter.parseEvent(
        event('response.reasoning_summary_text.delta', {
          item_id: 'rs-1',
          output_index: 0,
          summary_index: 0,
          delta: '先分析',
        }),
      ),
    ).toEqual([
      { type: 'reasoning_start', blockId: 'summary:rs-1:0' },
      { type: 'reasoning_delta', blockId: 'summary:rs-1:0', delta: '先分析' },
    ])
    expect(
      adapter.parseEvent(
        event('response.reasoning_text.delta', {
          item_id: 'rs-1',
          output_index: 0,
          content_index: 0,
          delta: '内部推理',
        }),
      ),
    ).toEqual([
      { type: 'reasoning_start', blockId: 'reasoning:rs-1:0' },
      { type: 'reasoning_delta', blockId: 'reasoning:rs-1:0', delta: '内部推理' },
    ])
    expect(
      adapter.parseEvent(
        event('response.reasoning_summary_text.done', {
          item_id: 'rs-1',
          output_index: 0,
          summary_index: 0,
          text: '先分析',
        }),
      ),
    ).toEqual([{ type: 'reasoning_end', blockId: 'summary:rs-1:0' }])
    expect(
      adapter.parseEvent(
        event('response.reasoning_text.done', {
          item_id: 'rs-1',
          output_index: 0,
          content_index: 0,
          text: '内部推理',
        }),
      ),
    ).toEqual([{ type: 'reasoning_end', blockId: 'reasoning:rs-1:0' }])
  })

  test('将 incomplete 原因映射为中立结束原因', () => {
    const cases = [
      ['max_output_tokens', 'length'],
      ['content_filter', 'content_filter'],
      ['vendor_extension', 'other'],
    ] as const

    for (const [providerReason, expectedReason] of cases) {
      const adapter = new OpenAIResponsesStreamAdapter()
      adapter.parseEvent(created())
      expect(
        adapter.parseEvent(
          event('response.incomplete', {
            response: response('incomplete', {
              incomplete_details: { reason: providerReason },
            }),
          }),
        ),
      ).toEqual([
        {
          type: 'finish',
          reason: expectedReason,
          providerReason,
        },
      ])
      expect(() => adapter.assertComplete()).not.toThrow()
    }
  })

  test('与 SSE 解析器组合后按命名事件保持顺序', async () => {
    const events = [
      created(),
      event('response.output_text.delta', {
        item_id: 'msg-1',
        output_index: 0,
        content_index: 0,
        delta: '你',
      }),
      event('response.output_text.delta', {
        item_id: 'msg-1',
        output_index: 0,
        content_index: 0,
        delta: '好',
      }),
      event('response.completed', { response: response('completed') }),
    ]
    const body = events
      .map((sseEvent) => `event: ${sseEvent.event}\ndata: ${sseEvent.data}\n\n`)
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
    const adapter = new OpenAIResponsesStreamAdapter()
    const providerEvents: ProviderStreamEvent[] = []
    for await (const sseEvent of parseServerSentEvents(stream)) {
      providerEvents.push(...adapter.parseEvent(sseEvent))
    }
    adapter.assertComplete()

    expect(providerEvents).toEqual([
      { type: 'text_delta', delta: '你' },
      { type: 'text_delta', delta: '好' },
      { type: 'finish', reason: 'stop', providerReason: 'completed' },
    ])
  })

  test('拒绝非法 JSON、事件名错配、乱序序号和供应商错误', () => {
    const invalidJson = new OpenAIResponsesStreamAdapter()
    expect(() =>
      invalidJson.parseEvent({ event: 'response.created', data: '{secret' }),
    ).toThrow(
      expect.objectContaining(
        { code: 'invalid_json' } satisfies Partial<OpenAIResponsesStreamError>,
      ),
    )

    const mismatched = new OpenAIResponsesStreamAdapter()
    expect(() =>
      mismatched.parseEvent({
        event: 'response.completed',
        data: JSON.stringify({
          type: 'response.created',
          response: response('in_progress'),
        }),
      }),
    ).toThrow(
      expect.objectContaining(
        { code: 'invalid_event' } satisfies Partial<OpenAIResponsesStreamError>,
      ),
    )

    const outOfOrder = new OpenAIResponsesStreamAdapter()
    outOfOrder.parseEvent(created(2))
    expect(() =>
      outOfOrder.parseEvent(
        event('response.in_progress', { response: response('in_progress') }, 2),
      ),
    ).toThrow(
      expect.objectContaining(
        { code: 'protocol_violation' } satisfies Partial<OpenAIResponsesStreamError>,
      ),
    )

    const providerError = new OpenAIResponsesStreamAdapter()
    expect(() =>
      providerError.parseEvent(
        event('error', { code: 'server_error', message: 'secret detail' }),
      ),
    ).toThrow(
      expect.objectContaining(
        { code: 'provider_error' } satisfies Partial<OpenAIResponsesStreamError>,
      ),
    )
  })

  test('拒绝缺失 created/终态、未闭合工具、终态后事件和 custom tool', () => {
    const missingCreated = new OpenAIResponsesStreamAdapter()
    expect(() =>
      missingCreated.parseEvent(
        event('response.output_text.delta', { delta: '越过 created' }),
      ),
    ).toThrow(
      expect.objectContaining(
        { code: 'protocol_violation' } satisfies Partial<OpenAIResponsesStreamError>,
      ),
    )

    const missingTerminal = new OpenAIResponsesStreamAdapter()
    missingTerminal.parseEvent(created())
    expect(() => missingTerminal.assertComplete()).toThrow(
      expect.objectContaining(
        { code: 'protocol_violation' } satisfies Partial<OpenAIResponsesStreamError>,
      ),
    )

    const openTool = new OpenAIResponsesStreamAdapter()
    openTool.parseEvent(created())
    openTool.parseEvent(
      event('response.output_item.added', {
        output_index: 0,
        item: functionItem('fc-open', 'call-open', 'lookup'),
      }),
    )
    expect(() =>
      openTool.parseEvent(
        event('response.completed', { response: response('completed') }),
      ),
    ).toThrow(
      expect.objectContaining(
        { code: 'protocol_violation' } satisfies Partial<OpenAIResponsesStreamError>,
      ),
    )

    const completed = new OpenAIResponsesStreamAdapter()
    completed.parseEvent(created())
    completed.parseEvent(event('response.completed', { response: response('completed') }))
    expect(() =>
      completed.parseEvent(event('response.completed', { response: response('completed') })),
    ).toThrow(
      expect.objectContaining(
        { code: 'protocol_violation' } satisfies Partial<OpenAIResponsesStreamError>,
      ),
    )

    const custom = new OpenAIResponsesStreamAdapter()
    custom.parseEvent(created())
    expect(() =>
      custom.parseEvent(
        event('response.output_item.added', {
          output_index: 0,
          item: { type: 'custom_tool_call', id: 'ct-1', name: 'shell' },
        }),
      ),
    ).toThrow(
      expect.objectContaining(
        { code: 'unsupported_item' } satisfies Partial<OpenAIResponsesStreamError>,
      ),
    )
  })

  test('拒绝最终参数不一致，并安全忽略未来未知事件', () => {
    const adapter = new OpenAIResponsesStreamAdapter()
    adapter.parseEvent(created())
    adapter.parseEvent(
      event('response.output_item.added', {
        output_index: 0,
        item: functionItem('fc-1', 'call-1', 'lookup'),
      }),
    )
    adapter.parseEvent(
      event('response.function_call_arguments.delta', {
        item_id: 'fc-1',
        output_index: 0,
        delta: '{"id":1}',
      }),
    )
    expect(() =>
      adapter.parseEvent(
        event('response.function_call_arguments.done', {
          item_id: 'fc-1',
          output_index: 0,
          arguments: '{"id":2}',
        }),
      ),
    ).toThrow(
      expect.objectContaining(
        { code: 'protocol_violation' } satisfies Partial<OpenAIResponsesStreamError>,
      ),
    )

    const futureEvent = new OpenAIResponsesStreamAdapter()
    futureEvent.parseEvent(created())
    expect(
      futureEvent.parseEvent(event('response.future_extension.delta', { delta: 'x' })),
    ).toEqual([])
  })
})
