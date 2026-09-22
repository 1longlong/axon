import { describe, expect, test } from 'bun:test'

import type { ProviderChatRequest, ProviderFunctionTool } from './provider-chat-input'
import {
  ProviderRequestBodyError,
  buildProviderRequestBody,
} from './provider-request-body'

const weatherTool: ProviderFunctionTool = {
  name: 'get_weather',
  description: '查询天气',
  inputSchema: {
    type: 'object',
    properties: { city: { type: 'string' } },
    required: ['city'],
    additionalProperties: false,
  },
  strict: true,
}

function conversation(
  thinking?: ProviderChatRequest['thinking'],
): ProviderChatRequest {
  return {
    modelId: 'model-test',
    systemPrompt: '保持简洁',
    maxOutputTokens: 4096,
    temperature: 1,
    ...(thinking === undefined ? {} : { thinking }),
    tools: [weatherTool],
    messages: [
      { role: 'user', content: [{ type: 'text', text: '上海天气？' }] },
      {
        role: 'assistant',
        content: [
          {
            type: 'reasoning',
            text: '需要查询',
            signature: 'opaque-signature',
          },
          { type: 'text', text: '我来查询。' },
          {
            type: 'tool_call',
            callId: 'call-weather',
            name: 'get_weather',
            arguments: '{ "city": "上海" }',
          },
        ],
      },
      {
        role: 'user',
        content: [
          {
            type: 'tool_result',
            callId: 'call-weather',
            name: 'get_weather',
            output: '{"temperature":26}',
          },
        ],
      },
    ],
  }
}

describe('OpenAI 请求体编码', () => {
  test('编码 Chat Completions 消息、工具历史、用量流和 effort', () => {
    expect(
      buildProviderRequestBody(
        'openai',
        conversation({ mode: 'effort', effort: 'high' }),
      ),
    ).toEqual({
      model: 'model-test',
      messages: [
        { role: 'system', content: '保持简洁' },
        { role: 'user', content: '上海天气？' },
        {
          role: 'assistant',
          content: '我来查询。',
          tool_calls: [
            {
              id: 'call-weather',
              type: 'function',
              function: {
                name: 'get_weather',
                arguments: '{"city":"上海"}',
              },
            },
          ],
        },
        {
          role: 'tool',
          tool_call_id: 'call-weather',
          content: '{"temperature":26}',
        },
      ],
      stream: true,
      stream_options: { include_usage: true },
      max_completion_tokens: 4096,
      temperature: 1,
      tools: [
        {
          type: 'function',
          function: {
            name: 'get_weather',
            description: '查询天气',
            parameters: weatherTool.inputSchema,
            strict: true,
          },
        },
      ],
      tool_choice: 'auto',
      parallel_tool_calls: true,
      reasoning_effort: 'high',
    })
  })

  test('编码 Responses 的扁平 input items、函数输出和 reasoning', () => {
    expect(
      buildProviderRequestBody(
        'openai-responses',
        conversation({ mode: 'effort', effort: 'medium', includeSummary: true }),
      ),
    ).toEqual({
      model: 'model-test',
      instructions: '保持简洁',
      input: [
        { role: 'user', content: '上海天气？' },
        { role: 'assistant', content: '我来查询。' },
        {
          type: 'function_call',
          call_id: 'call-weather',
          name: 'get_weather',
          arguments: '{"city":"上海"}',
        },
        {
          type: 'function_call_output',
          call_id: 'call-weather',
          output: '{"temperature":26}',
        },
      ],
      stream: true,
      store: false,
      max_output_tokens: 4096,
      temperature: 1,
      tools: [
        {
          type: 'function',
          name: 'get_weather',
          description: '查询天气',
          parameters: weatherTool.inputSchema,
          strict: true,
        },
      ],
      tool_choice: 'auto',
      parallel_tool_calls: true,
      reasoning: { effort: 'medium', summary: 'auto' },
    })
  })

  test('自定义 OpenAI 端点使用兼容性更高的 max_tokens 且不强塞 strict', () => {
    const request = conversation()
    request.tools = [{ ...weatherTool, strict: true }]
    const body = buildProviderRequestBody('custom', request)
    expect(body.max_tokens).toBe(4096)
    expect(body.max_completion_tokens).toBeUndefined()
    expect(body.tools).toEqual([
      {
        type: 'function',
        function: {
          name: 'get_weather',
          description: '查询天气',
          parameters: weatherTool.inputSchema,
        },
      },
    ])
  })
})

describe('Anthropic 与 Gemini 请求体编码', () => {
  test('Anthropic 保持 thinking 签名、工具块与顶层 system', () => {
    expect(
      buildProviderRequestBody(
        'anthropic',
        conversation({ mode: 'budget', budgetTokens: 1024 }),
      ),
    ).toEqual({
      model: 'model-test',
      system: '保持简洁',
      messages: [
        { role: 'user', content: [{ type: 'text', text: '上海天气？' }] },
        {
          role: 'assistant',
          content: [
            {
              type: 'thinking',
              thinking: '需要查询',
              signature: 'opaque-signature',
            },
            { type: 'text', text: '我来查询。' },
            {
              type: 'tool_use',
              id: 'call-weather',
              name: 'get_weather',
              input: { city: '上海' },
            },
          ],
        },
        {
          role: 'user',
          content: [
            {
              type: 'tool_result',
              tool_use_id: 'call-weather',
              content: '{"temperature":26}',
            },
          ],
        },
      ],
      max_tokens: 4096,
      stream: true,
      temperature: 1,
      tools: [
        {
          name: 'get_weather',
          description: '查询天气',
          input_schema: weatherTool.inputSchema,
        },
      ],
      tool_choice: { type: 'auto' },
      thinking: { type: 'enabled', budget_tokens: 1024 },
    })
  })

  test('Gemini 编码 Content/Part、函数响应和 thinkingConfig', () => {
    expect(
      buildProviderRequestBody(
        'google',
        conversation({ mode: 'budget', budgetTokens: 2048 }),
      ),
    ).toEqual({
      systemInstruction: { parts: [{ text: '保持简洁' }] },
      contents: [
        { role: 'user', parts: [{ text: '上海天气？' }] },
        {
          role: 'model',
          parts: [
            {
              text: '需要查询',
              thought: true,
              thoughtSignature: 'opaque-signature',
            },
            { text: '我来查询。' },
            {
              functionCall: {
                id: 'call-weather',
                name: 'get_weather',
                args: { city: '上海' },
              },
            },
          ],
        },
        {
          role: 'user',
          parts: [
            {
              functionResponse: {
                id: 'call-weather',
                name: 'get_weather',
                response: { temperature: 26 },
              },
            },
          ],
        },
      ],
      generationConfig: {
        maxOutputTokens: 4096,
        temperature: 1,
        thinkingConfig: { thinkingBudget: 2048, includeThoughts: true },
      },
      tools: [
        {
          functionDeclarations: [
            {
              name: 'get_weather',
              description: '查询天气',
              parameters: weatherTool.inputSchema,
            },
          ],
        },
      ],
      toolConfig: { functionCallingConfig: { mode: 'AUTO' } },
    })
  })
})

describe('Provider 请求体边界', () => {
  test('拒绝供应商不兼容的思考编码和 Anthropic 非法预算', () => {
    expect(() =>
      buildProviderRequestBody(
        'openai',
        conversation({ mode: 'budget', budgetTokens: 1024 }),
      ),
    ).toThrow(
      expect.objectContaining(
        { code: 'incompatible_thinking' } satisfies Partial<ProviderRequestBodyError>,
      ),
    )
    expect(() =>
      buildProviderRequestBody(
        'google',
        conversation({ mode: 'effort', effort: 'high' }),
      ),
    ).toThrow(
      expect.objectContaining(
        { code: 'incompatible_thinking' } satisfies Partial<ProviderRequestBodyError>,
      ),
    )
    expect(() =>
      buildProviderRequestBody(
        'anthropic',
        conversation({ mode: 'budget', budgetTokens: 4096 }),
      ),
    ).toThrow(
      expect.objectContaining(
        { code: 'incompatible_thinking' } satisfies Partial<ProviderRequestBodyError>,
      ),
    )
  })

  test('拒绝错误角色、无匹配工具结果、重复工具和非对象参数', () => {
    const wrongRole = conversation()
    wrongRole.messages = [
      {
        role: 'user',
        content: [
          {
            type: 'tool_call',
            callId: 'call-1',
            name: 'get_weather',
            arguments: '{}',
          },
        ],
      },
    ]
    expect(() => buildProviderRequestBody('openai', wrongRole)).toThrow(
      expect.objectContaining(
        { code: 'invalid_message' } satisfies Partial<ProviderRequestBodyError>,
      ),
    )

    const orphanResult = conversation()
    orphanResult.messages = [
      {
        role: 'user',
        content: [
          {
            type: 'tool_result',
            callId: 'missing',
            name: 'get_weather',
            output: '{}',
          },
        ],
      },
    ]
    expect(() => buildProviderRequestBody('openai', orphanResult)).toThrow(
      expect.objectContaining(
        { code: 'invalid_message' } satisfies Partial<ProviderRequestBodyError>,
      ),
    )

    const unresolvedCall = conversation()
    unresolvedCall.messages = [
      {
        role: 'assistant',
        content: [
          {
            type: 'tool_call',
            callId: 'pending',
            name: 'get_weather',
            arguments: '{}',
          },
        ],
      },
    ]
    expect(() => buildProviderRequestBody('openai', unresolvedCall)).toThrow(
      expect.objectContaining(
        { code: 'invalid_message' } satisfies Partial<ProviderRequestBodyError>,
      ),
    )

    const duplicateTools = conversation()
    duplicateTools.tools = [weatherTool, { ...weatherTool }]
    expect(() => buildProviderRequestBody('openai', duplicateTools)).toThrow(
      expect.objectContaining(
        { code: 'invalid_tool' } satisfies Partial<ProviderRequestBodyError>,
      ),
    )

    const invalidArguments = conversation()
    invalidArguments.messages = [
      {
        role: 'assistant',
        content: [
          {
            type: 'tool_call',
            callId: 'call-1',
            name: 'get_weather',
            arguments: '[]',
          },
        ],
      },
    ]
    expect(() => buildProviderRequestBody('openai', invalidArguments)).toThrow(
      expect.objectContaining(
        { code: 'invalid_arguments' } satisfies Partial<ProviderRequestBodyError>,
      ),
    )
  })

  test('请求体复制工具 Schema，不与上游共享可变对象', () => {
    const request = conversation()
    const body = buildProviderRequestBody('openai-responses', request)
    const tools = body.tools as Array<{ parameters: Record<string, unknown> }>
    tools[0]!.parameters.type = 'changed'
    expect(weatherTool.inputSchema.type).toBe('object')
  })
})

describe('Provider 图片内容编码', () => {
  const imageBlock = { type: 'image' as const, mediaType: 'image/png', data: 'aW1nLWRhdGE=' }

  function imageConversation(): ProviderChatRequest {
    return {
      modelId: 'model-test',
      maxOutputTokens: 1024,
      messages: [
        { role: 'user', content: [{ type: 'text', text: '这是什么？' }, imageBlock] },
      ],
    }
  }

  test('OpenAI Chat：纯文本保持字符串 content，图片使用多部分数组与 data URL', () => {
    const textOnly = buildProviderRequestBody('openai', {
      modelId: 'm', maxOutputTokens: 8,
      messages: [{ role: 'user', content: [{ type: 'text', text: '你好' }] }],
    })
    expect((textOnly.messages as unknown[])[0]).toEqual({ role: 'user', content: '你好' })

    const body = buildProviderRequestBody('openai', imageConversation())
    const [message] = body.messages as Array<{ role: string; content: unknown }>
    if (!message) throw new Error('缺少编码后的消息')
    expect(message.role).toBe('user')
    expect(message.content).toEqual([
      { type: 'text', text: '这是什么？' },
      { type: 'image_url', image_url: { url: 'data:image/png;base64,aW1nLWRhdGE=' } },
    ])
  })

  test('OpenAI Responses：图片使用 input_image 部件数组', () => {
    const body = buildProviderRequestBody('openai-responses', imageConversation())
    const [item] = body.input as Array<{ role: string; content: unknown }>
    if (!item) throw new Error('缺少 input item')
    expect(item.content).toEqual([
      { type: 'input_text', text: '这是什么？' },
      { type: 'input_image', image_url: 'data:image/png;base64,aW1nLWRhdGE=' },
    ])
  })

  test('Anthropic 使用 image source base64，Gemini 使用 inline_data', () => {
    const anthropic = buildProviderRequestBody('anthropic', imageConversation())
    const [anthropicMessage] = anthropic.messages as Array<{ content: Array<Record<string, unknown>> }>
    if (!anthropicMessage) throw new Error('缺少 Anthropic 消息')
    expect(anthropicMessage.content[1]).toEqual({
      type: 'image',
      source: { type: 'base64', media_type: 'image/png', data: 'aW1nLWRhdGE=' },
    })

    const gemini = buildProviderRequestBody('google', imageConversation())
    const [content] = gemini.contents as Array<{ parts: Array<Record<string, unknown>> }>
    if (!content) throw new Error('缺少 Gemini content')
    expect(content.parts[1]).toEqual({
      inline_data: { mime_type: 'image/png', data: 'aW1nLWRhdGE=' },
    })
  })

  test('拒绝 assistant 图片、白名单外类型与非法 base64', () => {
    const assistantImage: ProviderChatRequest = {
      modelId: 'm', maxOutputTokens: 8,
      messages: [{ role: 'assistant', content: [imageBlock] }],
    }
    expect(() => buildProviderRequestBody('openai', assistantImage)).toThrow(
      expect.objectContaining({ code: 'invalid_message' } satisfies Partial<ProviderRequestBodyError>),
    )

    const badType: ProviderChatRequest = {
      modelId: 'm', maxOutputTokens: 8,
      messages: [{ role: 'user', content: [{ type: 'image', mediaType: 'image/svg+xml', data: 'aGk=' }] }],
    }
    expect(() => buildProviderRequestBody('anthropic', badType)).toThrow(
      expect.objectContaining({ code: 'invalid_message' } satisfies Partial<ProviderRequestBodyError>),
    )

    const badData: ProviderChatRequest = {
      modelId: 'm', maxOutputTokens: 8,
      messages: [{ role: 'user', content: [{ type: 'image', mediaType: 'image/png', data: 'not base64!!' }] }],
    }
    expect(() => buildProviderRequestBody('google', badData)).toThrow(
      expect.objectContaining({ code: 'invalid_message' } satisfies Partial<ProviderRequestBodyError>),
    )
  })
})
