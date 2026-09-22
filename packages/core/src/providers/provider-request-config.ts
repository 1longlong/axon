import type { ProviderType } from '@axon/shared'

import { AnthropicMessagesStreamAdapter } from './anthropic-messages'
import { GoogleGeminiStreamAdapter } from './google-gemini'
import { OpenAIChatCompletionsStreamAdapter } from './openai-chat-completions'
import { OpenAIResponsesStreamAdapter } from './openai-responses'
import type { ProviderStreamAdapter } from './types'

export type ProviderWireProtocol =
  | 'openai-chat-completions'
  | 'openai-responses'
  | 'anthropic-messages'
  | 'google-generate-content'

export type ProviderThinkingEncoding =
  | 'reasoning_effort'
  | 'responses_reasoning'
  | 'anthropic_thinking'
  | 'gemini_thinking_config'

export type ProviderReasoningStreamSupport =
  | 'supported'
  | 'not_exposed'
  | 'provider_dependent'

export type ProviderAuthentication = 'bearer' | 'anthropic_key' | 'google_key'

export interface ProviderRequestDescriptor {
  protocol: ProviderWireProtocol
  authentication: ProviderAuthentication
  /** 仅表示请求字段编码方式；具体模型是否支持仍需模型能力判断。 */
  thinkingEncoding: ProviderThinkingEncoding
  reasoningStream: ProviderReasoningStreamSupport
  createStreamAdapter: () => ProviderStreamAdapter
}

export type ProviderRequestConfigErrorCode =
  | 'invalid_base_url'
  | 'invalid_model_id'
  | 'invalid_credential'
  | 'invalid_user_agent'

export class ProviderRequestConfigError extends Error {
  readonly code: ProviderRequestConfigErrorCode

  constructor(code: ProviderRequestConfigErrorCode, message: string) {
    super(message)
    this.name = 'ProviderRequestConfigError'
    this.code = code
  }
}

const PROVIDER_REQUEST_DESCRIPTORS: Record<ProviderType, ProviderRequestDescriptor> = {
  openai: {
    protocol: 'openai-chat-completions',
    authentication: 'bearer',
    thinkingEncoding: 'reasoning_effort',
    reasoningStream: 'not_exposed',
    createStreamAdapter: () => new OpenAIChatCompletionsStreamAdapter(),
  },
  'openai-responses': {
    protocol: 'openai-responses',
    authentication: 'bearer',
    thinkingEncoding: 'responses_reasoning',
    reasoningStream: 'supported',
    createStreamAdapter: () => new OpenAIResponsesStreamAdapter(),
  },
  anthropic: {
    protocol: 'anthropic-messages',
    authentication: 'anthropic_key',
    thinkingEncoding: 'anthropic_thinking',
    reasoningStream: 'supported',
    createStreamAdapter: () => new AnthropicMessagesStreamAdapter(),
  },
  'anthropic-compatible': {
    protocol: 'anthropic-messages',
    authentication: 'anthropic_key',
    thinkingEncoding: 'anthropic_thinking',
    reasoningStream: 'provider_dependent',
    createStreamAdapter: () => new AnthropicMessagesStreamAdapter(),
  },
  google: {
    protocol: 'google-generate-content',
    authentication: 'google_key',
    thinkingEncoding: 'gemini_thinking_config',
    reasoningStream: 'supported',
    createStreamAdapter: () => new GoogleGeminiStreamAdapter(),
  },
  custom: {
    protocol: 'openai-chat-completions',
    authentication: 'bearer',
    thinkingEncoding: 'reasoning_effort',
    reasoningStream: 'provider_dependent',
    createStreamAdapter: () => new OpenAIChatCompletionsStreamAdapter(),
  },
}

/** 返回渠道的协议、鉴权、思考编码方式及对应流适配器工厂。 */
export function getProviderRequestDescriptor(
  provider: ProviderType,
): ProviderRequestDescriptor {
  return PROVIDER_REQUEST_DESCRIPTORS[provider]
}

/** 每次生成创建独立适配器，避免不同请求共享流式状态。 */
export function createProviderStreamAdapter(provider: ProviderType): ProviderStreamAdapter {
  return getProviderRequestDescriptor(provider).createStreamAdapter()
}

/** 生成不含外部地址的稳定 User-Agent，版本由应用启动层明确传入。 */
export function createAxonUserAgent(version: string): string {
  const normalized = version.trim()
  if (!/^[a-zA-Z0-9][a-zA-Z0-9._+-]{0,63}$/.test(normalized)) {
    throw new ProviderRequestConfigError(
      'invalid_user_agent',
      'Axon User-Agent 版本格式无效',
    )
  }
  return `Axon/${normalized}`
}

/** 按协议生成流式请求头；空凭据用于明确支持无鉴权的本地服务。 */
export function buildProviderRequestHeaders(
  provider: ProviderType,
  apiKey: string,
  userAgent: string,
): Record<string, string> {
  const credential = apiKey.trim()
  if (containsControlCharacter(apiKey)) {
    throw new ProviderRequestConfigError(
      'invalid_credential',
      'Provider API Key 不能包含换行符',
    )
  }
  if (!userAgent || userAgent.length > 256 || containsControlCharacter(userAgent)) {
    throw new ProviderRequestConfigError(
      'invalid_user_agent',
      'Provider User-Agent 格式无效',
    )
  }

  const headers: Record<string, string> = {
    Accept: 'text/event-stream',
    'Content-Type': 'application/json',
    'User-Agent': userAgent,
  }
  const authentication = getProviderRequestDescriptor(provider).authentication
  if (authentication === 'anthropic_key') {
    headers['anthropic-version'] = '2023-06-01'
  }
  if (!credential) return headers

  switch (authentication) {
    case 'anthropic_key':
      headers['x-api-key'] = credential
      break
    case 'google_key':
      headers['x-goog-api-key'] = credential
      break
    case 'bearer':
      headers.Authorization = `Bearer ${credential}`
      break
  }
  return headers
}

/** 解析唯一生成端点，不接受可能夹带凭据的 URL 组成部分。 */
export function resolveProviderGenerationUrl(
  provider: ProviderType,
  baseUrl: string,
  modelId: string,
): string {
  const url = parseSafeBaseUrl(baseUrl)
  switch (getProviderRequestDescriptor(provider).protocol) {
    case 'openai-chat-completions':
      setProtocolEndpoint(url, '/chat/completions', ['/responses', '/messages'])
      break
    case 'openai-responses':
      setProtocolEndpoint(url, '/responses', ['/chat/completions', '/messages'])
      break
    case 'anthropic-messages':
      resolveAnthropicPath(url)
      break
    case 'google-generate-content':
      resolveGooglePath(url, modelId)
      break
  }
  return url.toString()
}

/** 将协议根地址补成固定端点；完整端点保持幂等。 */
function setProtocolEndpoint(
  url: URL,
  endpoint: string,
  conflictingEndpoints: readonly string[],
): void {
  const path = trimPath(url.pathname)
  if (path.endsWith(endpoint)) {
    url.pathname = path
    return
  }
  if (conflictingEndpoints.some((suffix) => path.endsWith(suffix))) {
    throw new ProviderRequestConfigError(
      'invalid_base_url',
      'Provider Base URL 指向了其他通信协议端点',
    )
  }
  url.pathname = `${path}${endpoint}`
}

/** Anthropic 根地址按需补 `/v1/messages`，已有版本路径或完整端点不重复。 */
function resolveAnthropicPath(url: URL): void {
  let path = trimPath(url.pathname)
  if (path.endsWith('/messages')) {
    url.pathname = path
    return
  }
  if (path.endsWith('/chat/completions') || path.endsWith('/responses')) {
    throw new ProviderRequestConfigError(
      'invalid_base_url',
      'Provider Base URL 指向了其他通信协议端点',
    )
  }
  if (!/\/v\d+(?:beta\d*)?$/.test(path)) {
    path = `${path}/v1`
  }
  url.pathname = `${path}/messages`
}

/** Gemini 把模型放在路径中，并仅由本函数添加 `alt=sse` 查询参数。 */
function resolveGooglePath(url: URL, modelId: string): void {
  const model = modelId.trim().replace(/^models\//, '')
  if (!model || model.length > 512 || /[/?#]/.test(model)) {
    throw new ProviderRequestConfigError(
      'invalid_model_id',
      'Gemini 模型 ID 格式无效',
    )
  }

  let path = trimPath(url.pathname)
  if (/:(?:stream)?generateContent$/.test(path)) {
    throw new ProviderRequestConfigError(
      'invalid_base_url',
      'Gemini Base URL 必须是协议根地址，不能是生成端点',
    )
  }
  if (!path.endsWith('/models')) {
    path = /\/v\d+(?:beta\d*)?$/.test(path)
      ? `${path}/models`
      : `${path}/v1beta/models`
  }
  url.pathname = `${path}/${encodeURIComponent(model)}:streamGenerateContent`
  url.searchParams.set('alt', 'sse')
}

function parseSafeBaseUrl(baseUrl: string): URL {
  if (!baseUrl.trim() || baseUrl.length > 2048) {
    throw new ProviderRequestConfigError(
      'invalid_base_url',
      'Provider Base URL 不能为空或过长',
    )
  }
  let url: URL
  try {
    url = new URL(baseUrl.trim())
  } catch {
    throw new ProviderRequestConfigError(
      'invalid_base_url',
      'Provider Base URL 不是有效地址',
    )
  }
  if (
    !['https:', 'http:'].includes(url.protocol) ||
    url.username ||
    url.password ||
    url.search ||
    url.hash
  ) {
    throw new ProviderRequestConfigError(
      'invalid_base_url',
      'Provider Base URL 只能使用无凭据、查询参数和片段的 HTTP(S) 地址',
    )
  }
  return url
}

function trimPath(path: string): string {
  const trimmed = path.replace(/\/+$/, '')
  return trimmed === '/' ? '' : trimmed
}

function containsControlCharacter(value: string): boolean {
  return [...value].some((character) => {
    const codePoint = character.codePointAt(0) ?? 0
    return codePoint <= 31 || codePoint === 127
  })
}
