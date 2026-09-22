import { describe, expect, test } from 'bun:test'

import type { ProviderType } from '@axon/shared'

import { AnthropicMessagesStreamAdapter } from './anthropic-messages'
import { GoogleGeminiStreamAdapter } from './google-gemini'
import { OpenAIChatCompletionsStreamAdapter } from './openai-chat-completions'
import { OpenAIResponsesStreamAdapter } from './openai-responses'
import {
  ProviderRequestConfigError,
  buildProviderRequestHeaders,
  createAxonUserAgent,
  createProviderStreamAdapter,
  getProviderRequestDescriptor,
  resolveProviderGenerationUrl,
} from './provider-request-config'

describe('Provider 请求描述符', () => {
  test('六种渠道收敛到四套线协议和对应适配器', () => {
    const cases = [
      ['openai', 'openai-chat-completions', OpenAIChatCompletionsStreamAdapter],
      ['custom', 'openai-chat-completions', OpenAIChatCompletionsStreamAdapter],
      ['openai-responses', 'openai-responses', OpenAIResponsesStreamAdapter],
      ['anthropic', 'anthropic-messages', AnthropicMessagesStreamAdapter],
      ['anthropic-compatible', 'anthropic-messages', AnthropicMessagesStreamAdapter],
      ['google', 'google-generate-content', GoogleGeminiStreamAdapter],
    ] as const

    for (const [provider, protocol, Adapter] of cases) {
      expect(getProviderRequestDescriptor(provider).protocol).toBe(protocol)
      expect(createProviderStreamAdapter(provider)).toBeInstanceOf(Adapter)
    }
    expect(createProviderStreamAdapter('openai')).not.toBe(
      createProviderStreamAdapter('openai'),
    )
  })

  test('声明思考请求编码和推理流可见性，不冒充模型能力检测', () => {
    expect(getProviderRequestDescriptor('openai')).toMatchObject({
      thinkingEncoding: 'reasoning_effort',
      reasoningStream: 'not_exposed',
    })
    expect(getProviderRequestDescriptor('openai-responses')).toMatchObject({
      thinkingEncoding: 'responses_reasoning',
      reasoningStream: 'supported',
    })
    expect(getProviderRequestDescriptor('anthropic')).toMatchObject({
      thinkingEncoding: 'anthropic_thinking',
      reasoningStream: 'supported',
    })
    expect(getProviderRequestDescriptor('google')).toMatchObject({
      thinkingEncoding: 'gemini_thinking_config',
      reasoningStream: 'supported',
    })
    expect(getProviderRequestDescriptor('custom').reasoningStream).toBe(
      'provider_dependent',
    )
  })
})

describe('Provider 生成端点', () => {
  test('补全四套官方协议端点，并对完整端点保持幂等', () => {
    const cases: readonly [ProviderType, string, string, string][] = [
      [
        'openai',
        'https://api.openai.com/v1',
        'unused',
        'https://api.openai.com/v1/chat/completions',
      ],
      [
        'openai-responses',
        'https://api.openai.com/v1/responses/',
        'unused',
        'https://api.openai.com/v1/responses',
      ],
      [
        'anthropic',
        'https://api.anthropic.com',
        'unused',
        'https://api.anthropic.com/v1/messages',
      ],
      [
        'anthropic-compatible',
        'https://gateway.example/anthropic',
        'unused',
        'https://gateway.example/anthropic/v1/messages',
      ],
      [
        'google',
        'https://generativelanguage.googleapis.com',
        'gemini-test',
        'https://generativelanguage.googleapis.com/v1beta/models/gemini-test:streamGenerateContent?alt=sse',
      ],
    ]

    for (const [provider, baseUrl, modelId, expected] of cases) {
      expect(resolveProviderGenerationUrl(provider, baseUrl, modelId)).toBe(expected)
    }
  })

  test('保留代理路径前缀、已有版本路径和 models 前缀模型 ID', () => {
    expect(
      resolveProviderGenerationUrl(
        'custom',
        'https://gateway.example/api/v2',
        'unused',
      ),
    ).toBe('https://gateway.example/api/v2/chat/completions')
    expect(
      resolveProviderGenerationUrl(
        'anthropic-compatible',
        'https://gateway.example/coding/v2',
        'unused',
      ),
    ).toBe('https://gateway.example/coding/v2/messages')
    expect(
      resolveProviderGenerationUrl(
        'google',
        'https://gateway.example/proxy/v1beta/models',
        'models/gemini-test',
      ),
    ).toBe(
      'https://gateway.example/proxy/v1beta/models/gemini-test:streamGenerateContent?alt=sse',
    )
  })

  test('拒绝隐含凭据、查询参数、错误协议端点和非法模型 ID', () => {
    const invalidUrls = [
      'file:///tmp/api',
      'https://user:secret@example.test/v1',
      'https://example.test/v1?key=secret',
      'https://example.test/v1#secret',
    ]
    for (const baseUrl of invalidUrls) {
      expect(() =>
        resolveProviderGenerationUrl('openai', baseUrl, 'unused'),
      ).toThrow(
        expect.objectContaining(
          { code: 'invalid_base_url' } satisfies Partial<ProviderRequestConfigError>,
        ),
      )
    }
    expect(() =>
      resolveProviderGenerationUrl(
        'openai-responses',
        'https://example.test/v1/chat/completions',
        'unused',
      ),
    ).toThrow(
      expect.objectContaining(
        { code: 'invalid_base_url' } satisfies Partial<ProviderRequestConfigError>,
      ),
    )
    expect(() =>
      resolveProviderGenerationUrl('google', 'https://example.test', '../model'),
    ).toThrow(
      expect.objectContaining(
        { code: 'invalid_model_id' } satisfies Partial<ProviderRequestConfigError>,
      ),
    )
  })
})

describe('Provider 请求头与 User-Agent', () => {
  test('按供应商选择鉴权头，API Key 不进入 URL', () => {
    const userAgent = createAxonUserAgent('0.1.0-test')
    expect(buildProviderRequestHeaders('openai', 'openai-key', userAgent)).toEqual({
      Accept: 'text/event-stream',
      'Content-Type': 'application/json',
      'User-Agent': 'Axon/0.1.0-test',
      Authorization: 'Bearer openai-key',
    })
    expect(buildProviderRequestHeaders('anthropic', 'anthropic-key', userAgent)).toEqual({
      Accept: 'text/event-stream',
      'Content-Type': 'application/json',
      'User-Agent': 'Axon/0.1.0-test',
      'anthropic-version': '2023-06-01',
      'x-api-key': 'anthropic-key',
    })
    expect(buildProviderRequestHeaders('google', 'google-key', userAgent)).toEqual({
      Accept: 'text/event-stream',
      'Content-Type': 'application/json',
      'User-Agent': 'Axon/0.1.0-test',
      'x-goog-api-key': 'google-key',
    })
  })

  test('允许无鉴权本地服务，并拒绝请求头注入', () => {
    expect(buildProviderRequestHeaders('custom', '', 'Axon/0.1.0')).toEqual({
      Accept: 'text/event-stream',
      'Content-Type': 'application/json',
      'User-Agent': 'Axon/0.1.0',
    })
    expect(buildProviderRequestHeaders('anthropic-compatible', '', 'Axon/0.1.0'))
      .toEqual({
        Accept: 'text/event-stream',
        'Content-Type': 'application/json',
        'User-Agent': 'Axon/0.1.0',
        'anthropic-version': '2023-06-01',
      })
    expect(() => buildProviderRequestHeaders('openai', 'secret\nvalue', 'Axon/0.1.0'))
      .toThrow(
        expect.objectContaining(
          { code: 'invalid_credential' } satisfies Partial<ProviderRequestConfigError>,
        ),
      )
    expect(() => createAxonUserAgent('bad version')).toThrow(
      expect.objectContaining(
        { code: 'invalid_user_agent' } satisfies Partial<ProviderRequestConfigError>,
      ),
    )
  })
})
