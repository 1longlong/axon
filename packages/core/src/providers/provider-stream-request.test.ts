import { describe, expect, test } from 'bun:test'

import { OpenAIChatStreamError } from './openai-chat-completions'
import type { ProviderChatRequest } from './provider-chat-input'
import {
  ProviderStreamRequestError,
  streamProviderChat,
} from './provider-stream-request'
import type {
  ProviderFetch,
  ProviderStreamRequest,
} from './provider-stream-request'
import type { ProviderStreamEvent } from './types'

const encoder = new TextEncoder()

const chatRequest: ProviderChatRequest = {
  modelId: 'model-test',
  messages: [{ role: 'user', content: [{ type: 'text', text: '你好' }] }],
  maxOutputTokens: 256,
}

function request(
  overrides: Partial<ProviderStreamRequest> = {},
): ProviderStreamRequest {
  return {
    provider: 'openai',
    baseUrl: 'https://api.openai.com/v1',
    apiKey: 'secret-key',
    userAgent: 'Axon/0.1.0',
    chatRequest,
    ...overrides,
  }
}

function eventStream(
  source: string,
  onCancel?: () => void,
  close = true,
): ReadableStream<Uint8Array> {
  return new ReadableStream<Uint8Array>({
    start(controller) {
      controller.enqueue(encoder.encode(source))
      if (close) controller.close()
    },
    cancel() {
      onCancel?.()
    },
  })
}

function sseResponse(source: string): Response {
  return new Response(eventStream(source), {
    headers: { 'Content-Type': 'text/event-stream; charset=utf-8' },
  })
}

async function collect(
  input: ProviderStreamRequest,
  fetch: ProviderFetch,
): Promise<ProviderStreamEvent[]> {
  const events: ProviderStreamEvent[] = []
  for await (const event of streamProviderChat(input, { fetch })) {
    events.push(event)
  }
  return events
}

const openAIStream = [
  'data: {"object":"chat.completion.chunk","choices":[{"index":0,"delta":{"content":"你好"},"finish_reason":null}]}\n\n',
  'data: {"object":"chat.completion.chunk","choices":[{"index":0,"delta":{},"finish_reason":"stop"}]}\n\n',
  'data: [DONE]\n\n',
].join('')

describe('Provider 流式请求执行器', () => {
  test('组合 OpenAI URL、鉴权、请求体并按顺序输出中立事件', async () => {
    let actualUrl = ''
    let actualInit: RequestInit | undefined
    const fetch: ProviderFetch = async (url, init) => {
      actualUrl = url
      actualInit = init
      return sseResponse(openAIStream)
    }

    expect(await collect(request(), fetch)).toEqual([
      { type: 'text_delta', delta: '你好' },
      { type: 'finish', reason: 'stop', providerReason: 'stop' },
    ])
    expect(actualUrl).toBe('https://api.openai.com/v1/chat/completions')
    expect(actualInit).toMatchObject({
      method: 'POST',
      redirect: 'manual',
      headers: {
        Accept: 'text/event-stream',
        'Content-Type': 'application/json',
        'User-Agent': 'Axon/0.1.0',
        Authorization: 'Bearer secret-key',
      },
    })
    expect(JSON.parse(actualInit?.body as string)).toEqual({
      model: 'model-test',
      messages: [{ role: 'user', content: '你好' }],
      stream: true,
      stream_options: { include_usage: true },
      max_completion_tokens: 256,
    })
    expect(actualUrl).not.toContain('secret-key')
    expect(actualInit?.body).not.toContain('secret-key')
  })

  test('同一执行器可驱动 Responses、Anthropic 与 Gemini 适配器', async () => {
    const cases: Array<{
      input: ProviderStreamRequest
      url: string
      source: string
      delta: string
    }> = [
      {
        input: request({ provider: 'openai-responses' }),
        url: 'https://api.openai.com/v1/responses',
        source: [
          'event: response.created\ndata: {"type":"response.created","response":{"id":"resp-1","status":"in_progress"}}\n\n',
          'event: response.output_text.delta\ndata: {"type":"response.output_text.delta","item_id":"msg-1","output_index":0,"content_index":0,"delta":"R"}\n\n',
          'event: response.completed\ndata: {"type":"response.completed","response":{"id":"resp-1","status":"completed"}}\n\n',
        ].join(''),
        delta: 'R',
      },
      {
        input: request({
          provider: 'anthropic',
          baseUrl: 'https://api.anthropic.com',
        }),
        url: 'https://api.anthropic.com/v1/messages',
        source: [
          'event: message_start\ndata: {"type":"message_start","message":{"id":"msg-1","type":"message","role":"assistant","content":[],"usage":{}}}\n\n',
          'event: content_block_start\ndata: {"type":"content_block_start","index":0,"content_block":{"type":"text","text":""}}\n\n',
          'event: content_block_delta\ndata: {"type":"content_block_delta","index":0,"delta":{"type":"text_delta","text":"A"}}\n\n',
          'event: content_block_stop\ndata: {"type":"content_block_stop","index":0}\n\n',
          'event: message_delta\ndata: {"type":"message_delta","delta":{"stop_reason":"end_turn","stop_sequence":null},"usage":{}}\n\n',
          'event: message_stop\ndata: {"type":"message_stop"}\n\n',
        ].join(''),
        delta: 'A',
      },
      {
        input: request({
          provider: 'google',
          baseUrl: 'https://generativelanguage.googleapis.com',
        }),
        url: 'https://generativelanguage.googleapis.com/v1beta/models/model-test:streamGenerateContent?alt=sse',
        source: 'data: {"responseId":"resp-1","candidates":[{"index":0,"content":{"role":"model","parts":[{"text":"G"}]},"finishReason":"STOP"}]}\n\n',
        delta: 'G',
      },
    ]

    for (const item of cases) {
      let actualUrl = ''
      const events = await collect(item.input, async (url) => {
        actualUrl = url
        return sseResponse(item.source)
      })
      expect(actualUrl).toBe(item.url)
      expect(events).toContainEqual({ type: 'text_delta', delta: item.delta })
      expect(events.at(-1)).toMatchObject({ type: 'finish' })
    }
  })

  test('HTTP 错误按状态分类且不读取或回显正文', async () => {
    const cases: Array<[number, ProviderStreamRequestError['code']]> = [
      [302, 'redirect'],
      [401, 'unauthorized'],
      [403, 'forbidden'],
      [404, 'not_found'],
      [429, 'rate_limit'],
      [503, 'server'],
      [400, 'http'],
    ]
    for (const [status, code] of cases) {
      try {
        await collect(request(), async () => new Response('sensitive-body', { status }))
        throw new Error('预期请求失败')
      } catch (error) {
        expect(error).toBeInstanceOf(ProviderStreamRequestError)
        expect(error).toMatchObject({ code, status })
        expect((error as Error).message).not.toContain('sensitive-body')
      }
    }
  })

  test('拒绝非 SSE 响应和缺失正文流', async () => {
    let invalidBodyCancelled = false
    await expect(
      collect(request(), async () => new Response(
        eventStream('{}', () => { invalidBodyCancelled = true }),
        { headers: { 'Content-Type': 'application/json' } },
      )),
    ).rejects.toMatchObject({ code: 'invalid_content_type' })
    expect(invalidBodyCancelled).toBe(true)

    await expect(
      collect(request(), async () => new Response(null, {
        headers: { 'Content-Type': 'text/event-stream' },
      })),
    ).rejects.toMatchObject({ code: 'invalid_response' })
  })

  test('把连接失败分类为 network，不暴露底层错误文本', async () => {
    try {
      await collect(request(), async () => {
        throw new Error('https://secret-host.example/internal')
      })
      throw new Error('预期请求失败')
    } catch (error) {
      expect(error).toMatchObject({ code: 'network' })
      expect((error as Error).message).not.toContain('secret-host')
    }
  })

  test('外部取消和总超时覆盖建连及正文读取', async () => {
    const stalledFetch: ProviderFetch = async () => new Response(
      new ReadableStream<Uint8Array>({}),
      { headers: { 'Content-Type': 'text/event-stream' } },
    )

    const external = new AbortController()
    const cancelled = collect(request({ signal: external.signal }), stalledFetch)
    queueMicrotask(() => external.abort())
    await expect(cancelled).rejects.toMatchObject({ code: 'cancelled' })

    await expect(
      collect(request({ timeoutMs: 5 }), stalledFetch),
    ).rejects.toMatchObject({ code: 'timeout' })

    const pendingFetch: ProviderFetch = async (_url, init) => new Promise<Response>(
      (_resolve, reject) => {
        const signal = init.signal
        if (!signal) return
        signal.addEventListener('abort', () => reject(signal.reason), { once: true })
      },
    )
    await expect(
      collect(request({ timeoutMs: 5 }), pendingFetch),
    ).rejects.toMatchObject({ code: 'timeout' })

    let fetched = false
    const preCancelled = new AbortController()
    preCancelled.abort()
    await expect(
      collect(request({ signal: preCancelled.signal }), async () => {
        fetched = true
        return sseResponse(openAIStream)
      }),
    ).rejects.toMatchObject({ code: 'cancelled' })
    expect(fetched).toBe(false)
  })

  test('消费者提前退出时取消正文流和底层请求', async () => {
    let bodyCancelled = false
    let requestSignal: AbortSignal | undefined
    const fetch: ProviderFetch = async (_url, init) => {
      requestSignal = init.signal ?? undefined
      return new Response(
        eventStream(
          'data: {"object":"chat.completion.chunk","choices":[{"index":0,"delta":{"content":"首段"},"finish_reason":null}]}\n\n',
          () => { bodyCancelled = true },
          false,
        ),
        { headers: { 'Content-Type': 'text/event-stream' } },
      )
    }

    const iterator = streamProviderChat(request(), { fetch })
    expect(await iterator.next()).toEqual({
      done: false,
      value: { type: 'text_delta', delta: '首段' },
    })
    await iterator.return(undefined)
    expect(bodyCancelled).toBe(true)
    expect(requestSignal?.aborted).toBe(true)
  })

  test('保留供应商协议错误，并在发送前限制超时与请求体大小', async () => {
    await expect(
      collect(request(), async () => sseResponse(
        'data: {"object":"chat.completion.chunk","choices":[{"index":0,"delta":{"content":"未完成"},"finish_reason":null}]}\n\n',
      )),
    ).rejects.toBeInstanceOf(OpenAIChatStreamError)

    let fetched = false
    const fetch: ProviderFetch = async () => {
      fetched = true
      return sseResponse(openAIStream)
    }
    await expect(
      collect(request({ timeoutMs: 0 }), fetch),
    ).rejects.toMatchObject({ code: 'invalid_timeout' })
    await expect(
      (async () => {
        const events: ProviderStreamEvent[] = []
        for await (const event of streamProviderChat(request(), {
          fetch,
          maxRequestBodyBytes: 10,
        })) {
          events.push(event)
        }
        return events
      })(),
    ).rejects.toMatchObject({ code: 'request_too_large' })
    expect(fetched).toBe(false)
  })
})
