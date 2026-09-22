import type { ProviderType } from '@axon/shared'

import type { ProviderChatRequest } from './provider-chat-input'
import { buildProviderRequestBody } from './provider-request-body'
import {
  buildProviderRequestHeaders,
  createProviderStreamAdapter,
  resolveProviderGenerationUrl,
} from './provider-request-config'
import { parseServerSentEvents } from './sse-parser'
import { ProviderStreamProtocolError } from './types'
import type { ProviderStreamEvent } from './types'

const DEFAULT_TIMEOUT_MS = 5 * 60 * 1000
const MAX_TIMEOUT_MS = 30 * 60 * 1000
const DEFAULT_MAX_REQUEST_BODY_BYTES = 32 * 1024 * 1024

export type ProviderFetch = (url: string, init: RequestInit) => Promise<Response>

export type ProviderStreamRequestErrorCode =
  | 'invalid_timeout'
  | 'request_too_large'
  | 'cancelled'
  | 'timeout'
  | 'network'
  | 'redirect'
  | 'unauthorized'
  | 'forbidden'
  | 'not_found'
  | 'rate_limit'
  | 'server'
  | 'http'
  | 'invalid_content_type'
  | 'invalid_response'

export class ProviderStreamRequestError extends Error {
  readonly code: ProviderStreamRequestErrorCode
  readonly status?: number

  constructor(
    code: ProviderStreamRequestErrorCode,
    message: string,
    status?: number,
  ) {
    super(message)
    this.name = 'ProviderStreamRequestError'
    this.code = code
    this.status = status
  }
}

export interface ProviderStreamRequest {
  provider: ProviderType
  baseUrl: string
  apiKey: string
  userAgent: string
  chatRequest: ProviderChatRequest
  /** 整个生成从建立连接到合法终态的总时限。 */
  timeoutMs?: number
  signal?: AbortSignal
}

export interface ProviderStreamExecutorOptions {
  fetch?: ProviderFetch
  maxRequestBodyBytes?: number
}

function resolvePositiveLimit(value: number | undefined, fallback: number): number {
  return value !== undefined && Number.isSafeInteger(value) && value > 0
    ? value
    : fallback
}

function resolveTimeout(value: number | undefined): number {
  const timeout = value ?? DEFAULT_TIMEOUT_MS
  if (!Number.isSafeInteger(timeout) || timeout <= 0 || timeout > MAX_TIMEOUT_MS) {
    throw new ProviderStreamRequestError(
      'invalid_timeout',
      `Provider 请求超时必须位于 1 到 ${MAX_TIMEOUT_MS} 毫秒`,
    )
  }
  return timeout
}

function mapHttpError(status: number): ProviderStreamRequestError {
  if (status >= 300 && status < 400) {
    return new ProviderStreamRequestError('redirect', 'Provider 拒绝重定向响应', status)
  }
  if (status === 401) {
    return new ProviderStreamRequestError('unauthorized', 'Provider 凭据无效', status)
  }
  if (status === 403) {
    return new ProviderStreamRequestError('forbidden', 'Provider 拒绝访问', status)
  }
  if (status === 404) {
    return new ProviderStreamRequestError('not_found', 'Provider 端点或模型不存在', status)
  }
  if (status === 429) {
    return new ProviderStreamRequestError('rate_limit', 'Provider 请求达到速率限制', status)
  }
  if (status >= 500) {
    return new ProviderStreamRequestError('server', 'Provider 服务暂时不可用', status)
  }
  return new ProviderStreamRequestError('http', 'Provider 请求失败', status)
}

function assertEventStreamResponse(response: Response): ReadableStream<Uint8Array> {
  if (response.redirected) {
    void response.body?.cancel().catch(() => {})
    throw new ProviderStreamRequestError(
      'redirect',
      'Provider 拒绝已跟随的重定向响应',
      response.status,
    )
  }
  if (response.status >= 300 && response.status < 400) {
    void response.body?.cancel().catch(() => {})
    throw mapHttpError(response.status)
  }
  if (!response.ok) {
    void response.body?.cancel().catch(() => {})
    throw mapHttpError(response.status)
  }

  const contentType = response.headers.get('content-type')
  if (contentType?.split(';', 1)[0]?.trim().toLowerCase() !== 'text/event-stream') {
    void response.body?.cancel().catch(() => {})
    throw new ProviderStreamRequestError(
      'invalid_content_type',
      'Provider 响应不是 SSE 事件流',
      response.status,
    )
  }
  if (!response.body || response.body.locked) {
    throw new ProviderStreamRequestError(
      'invalid_response',
      'Provider 响应缺少可读取的正文流',
      response.status,
    )
  }
  return response.body
}

function createRequestBody(
  provider: ProviderType,
  request: ProviderChatRequest,
  maxBytes: number,
): string {
  const body = JSON.stringify(buildProviderRequestBody(provider, request))
  if (new TextEncoder().encode(body).byteLength > maxBytes) {
    throw new ProviderStreamRequestError(
      'request_too_large',
      `Provider 请求体超过 ${maxBytes} 字节`,
    )
  }
  return body
}

/**
 * 发起单次 Provider 流式生成，并把供应商 SSE 按原顺序转换为中立事件。
 *
 * 本层只负责一次网络请求；工具执行和多轮循环属于上层 Chat 编排。
 */
export async function* streamProviderChat(
  input: ProviderStreamRequest,
  options: ProviderStreamExecutorOptions = {},
): AsyncGenerator<ProviderStreamEvent> {
  if (input.signal?.aborted) {
    throw new ProviderStreamRequestError('cancelled', 'Provider 请求已取消')
  }

  const timeoutMs = resolveTimeout(input.timeoutMs)
  const maxBodyBytes = resolvePositiveLimit(
    options.maxRequestBodyBytes,
    DEFAULT_MAX_REQUEST_BODY_BYTES,
  )
  const url = resolveProviderGenerationUrl(
    input.provider,
    input.baseUrl,
    input.chatRequest.modelId,
  )
  const headers = buildProviderRequestHeaders(
    input.provider,
    input.apiKey,
    input.userAgent,
  )
  const body = createRequestBody(input.provider, input.chatRequest, maxBodyBytes)
  const adapter = createProviderStreamAdapter(input.provider)
  const controller = new AbortController()
  let timedOut = false

  const relayAbort = (): void => {
    controller.abort(input.signal?.reason)
  }
  input.signal?.addEventListener('abort', relayAbort, { once: true })
  const timer = setTimeout(() => {
    timedOut = true
    controller.abort(new DOMException('Provider 请求超时', 'TimeoutError'))
  }, timeoutMs)

  try {
    let response: Response
    try {
      response = await (options.fetch ?? fetch)(url, {
        method: 'POST',
        headers,
        body,
        redirect: 'manual',
        signal: controller.signal,
      })
    } catch {
      if (controller.signal.aborted) {
        throw new ProviderStreamRequestError(
          timedOut ? 'timeout' : 'cancelled',
          timedOut ? 'Provider 请求超时' : 'Provider 请求已取消',
        )
      }
      throw new ProviderStreamRequestError('network', '无法连接 Provider 服务')
    }

    const stream = assertEventStreamResponse(response)
    try {
      // SSE 只负责切帧，adapter 再把每帧展开为零到多个中立事件。
      for await (const sseEvent of parseServerSentEvents(stream, {
        signal: controller.signal,
      })) {
        for (const event of adapter.parseEvent(sseEvent)) {
          yield event
        }
      }
      adapter.assertComplete()
    } catch (error) {
      if (controller.signal.aborted) {
        throw new ProviderStreamRequestError(
          timedOut ? 'timeout' : 'cancelled',
          timedOut ? 'Provider 请求超时' : 'Provider 请求已取消',
        )
      }
      if (
        error instanceof ProviderStreamRequestError
        || error instanceof ProviderStreamProtocolError
      ) {
        throw error
      }
      throw new ProviderStreamRequestError('network', '读取 Provider 响应失败')
    }
  } finally {
    clearTimeout(timer)
    input.signal?.removeEventListener('abort', relayAbort)
    // 消费者提前停止迭代时同时关闭底层连接，不能让生成在后台继续计费。
    if (!controller.signal.aborted) {
      controller.abort(new DOMException('Provider 流已关闭', 'AbortError'))
    }
  }
}
