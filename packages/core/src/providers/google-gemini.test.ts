import { describe, expect, test } from 'bun:test'

import {
  GoogleGeminiStreamAdapter,
  GoogleGeminiStreamError,
} from './google-gemini'
import { parseServerSentEvents } from './sse-parser'
import type { ProviderStreamEvent, ServerSentEvent } from './types'

const encoder = new TextEncoder()

function event(payload: Record<string, unknown>): ServerSentEvent {
  return { event: 'message', data: JSON.stringify(payload) }
}

function candidate(
  parts: readonly Record<string, unknown>[],
  finishReason?: string,
): Record<string, unknown> {
  return {
    index: 0,
    content: { role: 'model', parts },
    ...(finishReason === undefined ? {} : { finishReason }),
  }
}

describe('GoogleGeminiStreamAdapter', () => {
  test('映射增量文本、详细用量和 STOP 终态', () => {
    const adapter = new GoogleGeminiStreamAdapter()

    expect(
      adapter.parseEvent(
        event({ responseId: 'resp-test', candidates: [candidate([{ text: '你好' }])] }),
      ),
    ).toEqual([{ type: 'text_delta', delta: '你好' }])
    expect(
      adapter.parseEvent(
        event({
          responseId: 'resp-test',
          candidates: [candidate([{ text: '，世界' }], 'STOP')],
          usageMetadata: {
            promptTokenCount: 12,
            candidatesTokenCount: 7,
            thoughtsTokenCount: 3,
            cachedContentTokenCount: 4,
            totalTokenCount: 22,
          },
        }),
      ),
    ).toEqual([
      { type: 'text_delta', delta: '，世界' },
      {
        type: 'usage',
        usage: {
          inputTokens: 12,
          outputTokens: 7,
          reasoningTokens: 3,
          cacheReadTokens: 4,
          totalTokens: 22,
        },
      },
      { type: 'finish', reason: 'stop', providerReason: 'STOP' },
    ])
    expect(adapter.isComplete).toBe(true)
    expect(() => adapter.assertComplete()).not.toThrow()
  })

  test('将并行 functionCall 对象参数一次展开，并为缺失 id 生成稳定 id', () => {
    const adapter = new GoogleGeminiStreamAdapter()
    expect(
      adapter.parseEvent(
        event({
          candidates: [
            candidate(
              [
                {
                  functionCall: {
                    id: 'call-weather',
                    name: 'get_weather',
                    args: { city: '上海' },
                  },
                },
                { functionCall: { name: 'get_time', args: { zone: 'UTC' } } },
              ],
              'STOP',
            ),
          ],
        }),
      ),
    ).toEqual([
      {
        type: 'tool_call_start',
        callKey: 'candidate:0:call:0',
        callId: 'call-weather',
        name: 'get_weather',
      },
      {
        type: 'tool_call_delta',
        callKey: 'candidate:0:call:0',
        argumentsDelta: '{"city":"上海"}',
      },
      { type: 'tool_call_end', callKey: 'candidate:0:call:0' },
      {
        type: 'tool_call_start',
        callKey: 'candidate:0:call:1',
        callId: 'gemini-call-1',
        name: 'get_time',
      },
      {
        type: 'tool_call_delta',
        callKey: 'candidate:0:call:1',
        argumentsDelta: '{"zone":"UTC"}',
      },
      { type: 'tool_call_end', callKey: 'candidate:0:call:1' },
      { type: 'finish', reason: 'tool_use', providerReason: 'STOP' },
    ])
  })

  test('在正文切换或终态时关闭思考块，并保存 thoughtSignature', () => {
    const adapter = new GoogleGeminiStreamAdapter()

    expect(
      adapter.parseEvent(
        event({ candidates: [candidate([{ thought: true, text: '先分析' }])] }),
      ),
    ).toEqual([
      { type: 'reasoning_start', blockId: 'candidate:0:thought:0' },
      {
        type: 'reasoning_delta',
        blockId: 'candidate:0:thought:0',
        delta: '先分析',
      },
    ])
    expect(
      adapter.parseEvent(
        event({
          candidates: [candidate([{ text: '', thoughtSignature: 'opaque' }])],
        }),
      ),
    ).toEqual([
      {
        type: 'reasoning_signature',
        blockId: 'candidate:0:thought:0',
        signatureDelta: 'opaque',
      },
      { type: 'reasoning_end', blockId: 'candidate:0:thought:0' },
    ])

    const terminalThought = new GoogleGeminiStreamAdapter()
    expect(
      terminalThought.parseEvent(
        event({
          candidates: [
            candidate(
              [{ thought: true, text: '推理', thoughtSignature: 'signed' }],
              'STOP',
            ),
          ],
        }),
      ),
    ).toEqual([
      { type: 'reasoning_start', blockId: 'candidate:0:thought:0' },
      { type: 'reasoning_delta', blockId: 'candidate:0:thought:0', delta: '推理' },
      {
        type: 'reasoning_signature',
        blockId: 'candidate:0:thought:0',
        signatureDelta: 'signed',
      },
      { type: 'reasoning_end', blockId: 'candidate:0:thought:0' },
      { type: 'finish', reason: 'stop', providerReason: 'STOP' },
    ])
  })

  test('无候选的提示词拦截也形成可验证的内容过滤终态', () => {
    const adapter = new GoogleGeminiStreamAdapter()
    expect(
      adapter.parseEvent(
        event({
          promptFeedback: { blockReason: 'SAFETY' },
          usageMetadata: { promptTokenCount: 8, totalTokenCount: 8 },
        }),
      ),
    ).toEqual([
      { type: 'usage', usage: { inputTokens: 8, totalTokens: 8 } },
      { type: 'finish', reason: 'content_filter', providerReason: 'SAFETY' },
    ])
    expect(() => adapter.assertComplete()).not.toThrow()
  })

  test('映射 Gemini 主要结束原因并保留原始原因', () => {
    const cases = [
      ['MAX_TOKENS', 'length'],
      ['SAFETY', 'content_filter'],
      ['RECITATION', 'content_filter'],
      ['MALFORMED_FUNCTION_CALL', 'error'],
      ['LANGUAGE', 'other'],
    ] as const

    for (const [providerReason, reason] of cases) {
      const adapter = new GoogleGeminiStreamAdapter()
      expect(
        adapter.parseEvent(
          event({ candidates: [candidate([], providerReason)] }),
        ),
      ).toEqual([{ type: 'finish', reason, providerReason }])
    }
  })

  test('与增量 SSE 解析器组合后保持 data-only 事件顺序', async () => {
    const chunks = [
      event({ candidates: [candidate([{ text: '流式' }])] }),
      event({ candidates: [candidate([{ text: '文本' }], 'STOP')] }),
    ]
    const body = chunks.map((item) => `data: ${item.data}\n\n`).join('')
    const bytes = encoder.encode(body)
    const stream = new ReadableStream<Uint8Array>({
      start(controller) {
        for (const byte of bytes) {
          controller.enqueue(Uint8Array.of(byte))
        }
        controller.close()
      },
    })
    const adapter = new GoogleGeminiStreamAdapter()
    const events: ProviderStreamEvent[] = []
    for await (const sseEvent of parseServerSentEvents(stream)) {
      events.push(...adapter.parseEvent(sseEvent))
    }
    adapter.assertComplete()

    expect(events).toEqual([
      { type: 'text_delta', delta: '流式' },
      { type: 'text_delta', delta: '文本' },
      { type: 'finish', reason: 'stop', providerReason: 'STOP' },
    ])
  })

  test('拒绝多候选、非法参数、流中错误、响应串线与缺失终态', () => {
    const multiple = new GoogleGeminiStreamAdapter()
    expect(() =>
      multiple.parseEvent(
        event({ candidates: [candidate([]), { ...candidate([]), index: 1 }] }),
      ),
    ).toThrow(
      expect.objectContaining(
        { code: 'unsupported_candidate' } satisfies Partial<GoogleGeminiStreamError>,
      ),
    )

    const invalidArgs = new GoogleGeminiStreamAdapter()
    expect(() =>
      invalidArgs.parseEvent(
        event({
          candidates: [
            candidate([{ functionCall: { name: 'lookup', args: ['not-object'] } }]),
          ],
        }),
      ),
    ).toThrow(
      expect.objectContaining(
        { code: 'invalid_chunk' } satisfies Partial<GoogleGeminiStreamError>,
      ),
    )

    const providerError = new GoogleGeminiStreamAdapter()
    expect(() =>
      providerError.parseEvent(event({ error: { code: 500, message: 'secret' } })),
    ).toThrow(
      expect.objectContaining(
        { code: 'provider_error' } satisfies Partial<GoogleGeminiStreamError>,
      ),
    )

    const crossed = new GoogleGeminiStreamAdapter()
    crossed.parseEvent(event({ responseId: 'resp-1', candidates: [] }))
    expect(() =>
      crossed.parseEvent(event({ responseId: 'resp-2', candidates: [] })),
    ).toThrow(
      expect.objectContaining(
        { code: 'protocol_violation' } satisfies Partial<GoogleGeminiStreamError>,
      ),
    )

    const interrupted = new GoogleGeminiStreamAdapter()
    interrupted.parseEvent(event({ candidates: [candidate([{ text: '未完成' }])] }))
    expect(() => interrupted.assertComplete()).toThrow(
      expect.objectContaining(
        { code: 'protocol_violation' } satisfies Partial<GoogleGeminiStreamError>,
      ),
    )
  })

  test('拒绝终态后的额外片段与非 data-only SSE', () => {
    const completed = new GoogleGeminiStreamAdapter()
    completed.parseEvent(event({ candidates: [candidate([], 'STOP')] }))
    expect(() =>
      completed.parseEvent(event({ candidates: [candidate([], 'STOP')] })),
    ).toThrow(
      expect.objectContaining(
        { code: 'protocol_violation' } satisfies Partial<GoogleGeminiStreamError>,
      ),
    )

    const named = new GoogleGeminiStreamAdapter()
    expect(() =>
      named.parseEvent({ event: 'candidate', data: JSON.stringify({ candidates: [] }) }),
    ).toThrow(
      expect.objectContaining(
        { code: 'invalid_chunk' } satisfies Partial<GoogleGeminiStreamError>,
      ),
    )

    const unspecified = new GoogleGeminiStreamAdapter()
    unspecified.parseEvent(
      event({ candidates: [candidate([], 'FINISH_REASON_UNSPECIFIED')] }),
    )
    expect(() => unspecified.assertComplete()).toThrow(
      expect.objectContaining(
        { code: 'protocol_violation' } satisfies Partial<GoogleGeminiStreamError>,
      ),
    )
  })
})
