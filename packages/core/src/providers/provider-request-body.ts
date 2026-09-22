import type { ProviderType } from '@axon/shared'
import { IMAGE_MEDIA_TYPES } from '@axon/shared'

import type {
  ProviderChatContentBlock,
  ProviderChatImageBlock,
  ProviderChatMessage,
  ProviderChatRequest,
  ProviderFunctionTool,
  ProviderThinkingOptions,
} from './provider-chat-input'
import { getProviderRequestDescriptor } from './provider-request-config'

export type ProviderRequestBodyErrorCode =
  | 'invalid_request'
  | 'invalid_message'
  | 'invalid_tool'
  | 'invalid_arguments'
  | 'incompatible_thinking'

export class ProviderRequestBodyError extends Error {
  readonly code: ProviderRequestBodyErrorCode

  constructor(code: ProviderRequestBodyErrorCode, message: string) {
    super(message)
    this.name = 'ProviderRequestBodyError'
    this.code = code
  }
}

interface ValidatedRequest {
  readonly modelId: string
  readonly systemPrompt?: string
  readonly messages: readonly ProviderChatMessage[]
  readonly tools: readonly ProviderFunctionTool[]
  readonly maxOutputTokens: number
  readonly temperature?: number
  readonly thinking?: ProviderThinkingOptions
}

/** 校验中立输入后，按渠道选择唯一的供应商请求体编码器。 */
export function buildProviderRequestBody(
  provider: ProviderType,
  input: ProviderChatRequest,
): Record<string, unknown> {
  const request = validateRequest(provider, input)
  switch (getProviderRequestDescriptor(provider).protocol) {
    case 'openai-chat-completions':
      return buildOpenAIChatBody(provider, request)
    case 'openai-responses':
      return buildOpenAIResponsesBody(request)
    case 'anthropic-messages':
      return buildAnthropicBody(request)
    case 'google-generate-content':
      return buildGeminiBody(request)
  }
}

/** OpenAI Chat 把 assistant 工具调用和后续 tool 消息恢复为原生结构。 */
function buildOpenAIChatBody(
  provider: ProviderType,
  request: ValidatedRequest,
): Record<string, unknown> {
  const messages: Record<string, unknown>[] = []
  if (request.systemPrompt !== undefined) {
    messages.push({ role: 'system', content: request.systemPrompt })
  }

  for (const message of request.messages) {
    if (message.role === 'assistant') {
      // 中立 reasoning 无法安全还原为 Chat 专属历史项，只回放可移植的正文和工具调用。
      const text = message.content
        .filter((block) => block.type === 'text')
        .map((block) => block.text)
        .join('')
      const toolCalls = message.content
        .filter((block) => block.type === 'tool_call')
        .map((block) => ({
          id: block.callId,
          type: 'function',
          function: {
            name: block.name,
            arguments: JSON.stringify(parseArguments(block.arguments)),
          },
        }))
      if (text || toolCalls.length > 0) {
        messages.push({
          role: 'assistant',
          content: text || null,
          ...(toolCalls.length === 0 ? {} : { tool_calls: toolCalls }),
        })
      }
      continue
    }

    // OpenAI 的工具结果必须拆成独立 tool message；正文与图片缓冲保证相对顺序。
    let text = ''
    const parts: Record<string, unknown>[] = []
    const flushTextIntoParts = (): void => {
      if (!text) return
      parts.push({ type: 'text', text })
      text = ''
    }
    const flushParts = (): void => {
      flushTextIntoParts()
      if (parts.length === 0) return
      // 纯文本保持字符串 content，与既有文本历史完全一致；携带图片时用多部分数组。
      messages.push({
        role: 'user',
        content: parts.length === 1 && parts[0]?.type === 'text'
          ? (parts[0] as { text: string }).text
          : parts.slice(),
      })
      parts.length = 0
    }
    for (const block of message.content) {
      if (block.type === 'text') {
        text += block.text
      } else if (block.type === 'image') {
        flushTextIntoParts()
        parts.push({ type: 'image_url', image_url: { url: toImageDataUrl(block) } })
      } else if (block.type === 'tool_result') {
        flushParts()
        messages.push({
          role: 'tool',
          tool_call_id: block.callId,
          content: block.output,
        })
      }
    }
    flushParts()
  }

  const body: Record<string, unknown> = {
    model: request.modelId,
    messages,
    stream: true,
    stream_options: { include_usage: true },
    [provider === 'custom' ? 'max_tokens' : 'max_completion_tokens']:
      request.maxOutputTokens,
  }
  assignCommonSampling(body, request)
  if (request.tools.length > 0) {
    body.tools = request.tools.map((tool) => ({
      type: 'function',
      function: {
        name: tool.name,
        description: tool.description,
        parameters: cloneJsonObject(tool.inputSchema, 'invalid_tool'),
        ...(provider === 'custom' || tool.strict === undefined
          ? {}
          : { strict: tool.strict }),
      },
    }))
    body.tool_choice = 'auto'
    body.parallel_tool_calls = true
  }
  applyEffortThinking(body, request.thinking, 'reasoning_effort')
  return body
}

/** Responses 将消息、function_call 与 function_call_output 展平成 input items。 */
function buildOpenAIResponsesBody(request: ValidatedRequest): Record<string, unknown> {
  const input: Record<string, unknown>[] = []
  for (const message of request.messages) {
    // 中立 reasoning 缺少 Responses 的 item id，不能伪造；正文、图片和工具历史仍可完整回放。
    let text = ''
    const parts: Record<string, unknown>[] = []
    const flushTextIntoParts = (): void => {
      if (!text) return
      parts.push({ type: 'input_text', text })
      text = ''
    }
    const flushParts = (): void => {
      flushTextIntoParts()
      if (parts.length === 0) return
      // 纯文本保持字符串 content；携带图片时用 input_text/input_image 部件数组。
      input.push({
        role: message.role,
        content: parts.length === 1 && parts[0]?.type === 'input_text'
          ? (parts[0] as { text: string }).text
          : parts.slice(),
      })
      parts.length = 0
    }
    for (const block of message.content) {
      if (block.type === 'text') {
        text += block.text
      } else if (block.type === 'image') {
        flushTextIntoParts()
        parts.push({ type: 'input_image', image_url: toImageDataUrl(block) })
      } else if (block.type === 'tool_call') {
        flushParts()
        input.push({
          type: 'function_call',
          call_id: block.callId,
          name: block.name,
          arguments: JSON.stringify(parseArguments(block.arguments)),
        })
      } else if (block.type === 'tool_result') {
        flushParts()
        input.push({
          type: 'function_call_output',
          call_id: block.callId,
          output: block.output,
        })
      }
    }
    flushParts()
  }

  const body: Record<string, unknown> = {
    model: request.modelId,
    input,
    stream: true,
    store: false,
    max_output_tokens: request.maxOutputTokens,
  }
  if (request.systemPrompt !== undefined) body.instructions = request.systemPrompt
  assignCommonSampling(body, request)
  if (request.tools.length > 0) {
    body.tools = request.tools.map((tool) => ({
      type: 'function',
      name: tool.name,
      description: tool.description,
      parameters: cloneJsonObject(tool.inputSchema, 'invalid_tool'),
      ...(tool.strict === undefined ? {} : { strict: tool.strict }),
    }))
    body.tool_choice = 'auto'
    body.parallel_tool_calls = true
  }
  if (request.thinking !== undefined) {
    assertThinkingMode(request.thinking, 'effort', 'OpenAI Responses')
    body.reasoning = {
      effort: request.thinking.effort,
      ...(request.thinking.includeSummary ? { summary: 'auto' } : {}),
    }
  }
  return body
}

/** Anthropic 保持 content block 顺序，并要求历史 thinking 携带完整签名。 */
function buildAnthropicBody(request: ValidatedRequest): Record<string, unknown> {
  const messages = request.messages.map((message) => ({
    role: message.role,
    content: message.content.map((block) => encodeAnthropicBlock(block)),
  }))
  const body: Record<string, unknown> = {
    model: request.modelId,
    messages,
    max_tokens: request.maxOutputTokens,
    stream: true,
  }
  if (request.systemPrompt !== undefined) body.system = request.systemPrompt
  if (request.temperature !== undefined) body.temperature = request.temperature
  if (request.tools.length > 0) {
    body.tools = request.tools.map((tool) => ({
      name: tool.name,
      description: tool.description,
      input_schema: cloneJsonObject(tool.inputSchema, 'invalid_tool'),
    }))
    body.tool_choice = { type: 'auto' }
  }
  if (request.thinking !== undefined) {
    assertThinkingMode(request.thinking, 'budget', 'Anthropic Messages')
    if (request.thinking.budgetTokens < 1024) {
      throw new ProviderRequestBodyError(
        'incompatible_thinking',
        'Anthropic thinking budget 必须至少为 1024',
      )
    }
    if (request.thinking.budgetTokens >= request.maxOutputTokens) {
      throw new ProviderRequestBodyError(
        'incompatible_thinking',
        'Anthropic thinking budget 必须小于 maxOutputTokens',
      )
    }
    if (request.temperature !== undefined && request.temperature !== 1) {
      throw new ProviderRequestBodyError(
        'incompatible_thinking',
        'Anthropic 手动 thinking 只能配合 temperature 1',
      )
    }
    body.thinking = {
      type: 'enabled',
      budget_tokens: request.thinking.budgetTokens,
    }
  }
  return body
}

/** Gemini 将中立块映射到 Content/Part，并在 generationConfig 中编码预算。 */
function buildGeminiBody(request: ValidatedRequest): Record<string, unknown> {
  const contents = request.messages.map((message) => ({
    role: message.role === 'assistant' ? 'model' : 'user',
    parts: message.content.map((block) => encodeGeminiPart(block)),
  }))
  const generationConfig: Record<string, unknown> = {
    maxOutputTokens: request.maxOutputTokens,
  }
  if (request.temperature !== undefined) generationConfig.temperature = request.temperature
  if (request.thinking !== undefined) {
    assertThinkingMode(request.thinking, 'budget', 'Gemini')
    generationConfig.thinkingConfig = {
      thinkingBudget: request.thinking.budgetTokens,
      includeThoughts: true,
    }
  }

  const body: Record<string, unknown> = { contents, generationConfig }
  if (request.systemPrompt !== undefined) {
    body.systemInstruction = { parts: [{ text: request.systemPrompt }] }
  }
  if (request.tools.length > 0) {
    body.tools = [{
      functionDeclarations: request.tools.map((tool) => ({
        name: tool.name,
        description: tool.description,
        parameters: cloneJsonObject(tool.inputSchema, 'invalid_tool'),
      })),
    }]
    body.toolConfig = { functionCallingConfig: { mode: 'AUTO' } }
  }
  return body
}

function encodeAnthropicBlock(block: ProviderChatContentBlock): Record<string, unknown> {
  switch (block.type) {
    case 'text':
      return { type: 'text', text: block.text }
    case 'image':
      return {
        type: 'image',
        source: { type: 'base64', media_type: block.mediaType, data: block.data },
      }
    case 'reasoning':
      if (!block.signature) {
        throw new ProviderRequestBodyError(
          'invalid_message',
          'Anthropic 历史 thinking 缺少不透明签名',
        )
      }
      return { type: 'thinking', thinking: block.text, signature: block.signature }
    case 'tool_call':
      return {
        type: 'tool_use',
        id: block.callId,
        name: block.name,
        input: parseArguments(block.arguments),
      }
    case 'tool_result':
      return {
        type: 'tool_result',
        tool_use_id: block.callId,
        content: block.output,
        ...(block.isError === undefined ? {} : { is_error: block.isError }),
      }
  }
}

function encodeGeminiPart(block: ProviderChatContentBlock): Record<string, unknown> {
  switch (block.type) {
    case 'text':
      return { text: block.text }
    case 'image':
      return { inline_data: { mime_type: block.mediaType, data: block.data } }
    case 'reasoning':
      return {
        text: block.text,
        thought: true,
        ...(block.signature === undefined ? {} : { thoughtSignature: block.signature }),
      }
    case 'tool_call':
      return {
        functionCall: {
          id: block.callId,
          name: block.name,
          args: parseArguments(block.arguments),
        },
      }
    case 'tool_result':
      return {
        functionResponse: {
          id: block.callId,
          name: block.name,
          response: parseGeminiToolOutput(block.output),
        },
      }
  }
}

/** 在编码前集中校验角色、块、工具和采样边界，错误不会带入原始内容。 */
function validateRequest(provider: ProviderType, input: ProviderChatRequest): ValidatedRequest {
  if (!input || typeof input !== 'object') {
    throw new ProviderRequestBodyError('invalid_request', 'Provider 请求必须是对象')
  }
  const modelId = validateNonEmptyString(input.modelId, 512, '模型 ID', 'invalid_request')
  if (!Array.isArray(input.messages) || input.messages.length === 0) {
    throw new ProviderRequestBodyError('invalid_request', 'Provider 请求至少需要一条消息')
  }
  if (!Number.isSafeInteger(input.maxOutputTokens) || input.maxOutputTokens <= 0) {
    throw new ProviderRequestBodyError(
      'invalid_request',
      'maxOutputTokens 必须是正整数',
    )
  }
  if (
    input.temperature !== undefined &&
    (!Number.isFinite(input.temperature) || input.temperature < 0 || input.temperature > 2)
  ) {
    throw new ProviderRequestBodyError('invalid_request', 'temperature 必须位于 0 到 2')
  }
  if (
    (provider === 'anthropic' || provider === 'anthropic-compatible') &&
    input.temperature !== undefined &&
    input.temperature > 1
  ) {
    throw new ProviderRequestBodyError('invalid_request', 'Anthropic temperature 不能超过 1')
  }

  const messages = input.messages.map((message) => validateMessage(message))
  if (input.tools !== undefined && !Array.isArray(input.tools)) {
    throw new ProviderRequestBodyError('invalid_tool', 'Provider tools 必须是数组')
  }
  const tools = (input.tools ?? []).map((tool) => validateTool(tool))
  const names = new Set<string>()
  for (const tool of tools) {
    if (names.has(tool.name)) {
      throw new ProviderRequestBodyError('invalid_tool', 'Provider 工具名称不能重复')
    }
    names.add(tool.name)
  }
  validateToolReferences(messages)

  const systemPrompt = input.systemPrompt === undefined
    ? undefined
    : validateNonEmptyString(
        input.systemPrompt,
        1024 * 1024,
        '系统提示词',
        'invalid_request',
      )
  return {
    modelId,
    ...(systemPrompt === undefined ? {} : { systemPrompt }),
    messages,
    tools,
    maxOutputTokens: input.maxOutputTokens,
    ...(input.temperature === undefined ? {} : { temperature: input.temperature }),
    ...(input.thinking === undefined ? {} : { thinking: validateThinking(input.thinking) }),
  }
}

function validateMessage(message: ProviderChatMessage): ProviderChatMessage {
  if (!message || (message.role !== 'user' && message.role !== 'assistant')) {
    throw new ProviderRequestBodyError('invalid_message', 'Provider 消息 role 无效')
  }
  if (!Array.isArray(message.content) || message.content.length === 0) {
    throw new ProviderRequestBodyError('invalid_message', 'Provider 消息内容不能为空')
  }
  for (const block of message.content) {
    validateBlock(message.role, block)
  }
  return message
}

function validateBlock(
  role: ProviderChatMessage['role'],
  block: ProviderChatContentBlock,
): void {
  if (!block || typeof block !== 'object') {
    throw new ProviderRequestBodyError('invalid_message', 'Provider 消息块无效')
  }
  if (block.type === 'text') {
    validateNonEmptyString(block.text, 8 * 1024 * 1024, '正文', 'invalid_message')
    return
  }
  if (block.type === 'reasoning') {
    if (role !== 'assistant' || (!block.text && !block.signature)) {
      throw new ProviderRequestBodyError('invalid_message', 'Provider 推理块无效')
    }
    return
  }
  if (block.type === 'tool_call') {
    if (role !== 'assistant') {
      throw new ProviderRequestBodyError('invalid_message', '工具调用必须属于 assistant')
    }
    validateCallIdentity(block.callId, block.name)
    parseArguments(block.arguments)
    return
  }
  if (block.type === 'tool_result') {
    if (role !== 'user') {
      throw new ProviderRequestBodyError('invalid_message', '工具结果必须属于 user')
    }
    validateCallIdentity(block.callId, block.name)
    if (typeof block.output !== 'string') {
      throw new ProviderRequestBodyError('invalid_message', '工具结果 output 必须是字符串')
    }
    return
  }
  if (block.type === 'image') {
    // 图片只作为用户输入进入请求；类型白名单与四家供应商的公共支持集一致。
    if (role !== 'user') {
      throw new ProviderRequestBodyError('invalid_message', '图片块必须属于 user')
    }
    if (!IMAGE_MEDIA_TYPES.includes(block.mediaType)) {
      throw new ProviderRequestBodyError('invalid_message', '图片类型不在支持的白名单内')
    }
    if (
      typeof block.data !== 'string'
      || !block.data
      || block.data.length % 4 !== 0
      || !/^[A-Za-z0-9+/]*={0,2}$/.test(block.data)
    ) {
      throw new ProviderRequestBodyError('invalid_message', '图片数据必须是 base64 字符串')
    }
    return
  }
  throw new ProviderRequestBodyError('invalid_message', 'Provider 消息块类型无效')
}

function validateTool(tool: ProviderFunctionTool): ProviderFunctionTool {
  if (!tool || typeof tool !== 'object') {
    throw new ProviderRequestBodyError('invalid_tool', 'Provider 工具定义无效')
  }
  validateToolName(tool.name)
  validateNonEmptyString(tool.description, 4096, '工具描述', 'invalid_tool')
  if (tool.strict !== undefined && typeof tool.strict !== 'boolean') {
    throw new ProviderRequestBodyError('invalid_tool', 'Provider 工具 strict 必须是布尔值')
  }
  cloneJsonObject(tool.inputSchema, 'invalid_tool')
  return tool
}

function validateToolReferences(messages: readonly ProviderChatMessage[]): void {
  const calls = new Map<string, string>()
  for (const message of messages) {
    for (const block of message.content) {
      if (block.type === 'tool_call') {
        if (calls.has(block.callId)) {
          throw new ProviderRequestBodyError('invalid_message', '工具调用 ID 不能重复')
        }
        calls.set(block.callId, block.name)
      } else if (block.type === 'tool_result') {
        if (calls.get(block.callId) !== block.name) {
          throw new ProviderRequestBodyError('invalid_message', '工具结果找不到匹配的调用')
        }
        calls.delete(block.callId)
      }
    }
  }
  if (calls.size > 0) {
    throw new ProviderRequestBodyError('invalid_message', '工具调用缺少匹配的结果')
  }
}

function validateThinking(thinking: ProviderThinkingOptions): ProviderThinkingOptions {
  if (!thinking || typeof thinking !== 'object') {
    throw new ProviderRequestBodyError('invalid_request', '思考参数必须是对象')
  }
  if (thinking.mode === 'effort') {
    if (!['minimal', 'low', 'medium', 'high'].includes(thinking.effort)) {
      throw new ProviderRequestBodyError('invalid_request', '思考 effort 无效')
    }
    return thinking
  }
  if (
    thinking.mode !== 'budget' ||
    !Number.isSafeInteger(thinking.budgetTokens) ||
    thinking.budgetTokens < 0
  ) {
    throw new ProviderRequestBodyError('invalid_request', '思考 budget 无效')
  }
  return thinking
}

function validateCallIdentity(callId: string, name: string): void {
  validateNonEmptyString(callId, 512, '工具调用 ID', 'invalid_message')
  validateToolName(name)
}

function validateToolName(name: string): void {
  if (typeof name !== 'string' || !/^[a-zA-Z0-9_-]{1,64}$/.test(name)) {
    throw new ProviderRequestBodyError('invalid_tool', 'Provider 工具名称格式无效')
  }
}

function validateNonEmptyString(
  value: string,
  maxLength: number,
  label: string,
  code: ProviderRequestBodyErrorCode,
): string {
  if (typeof value !== 'string' || !value.trim() || value.length > maxLength) {
    throw new ProviderRequestBodyError(code, `${label}不能为空或过长`)
  }
  return value.trim()
}

function parseArguments(value: string): Record<string, unknown> {
  try {
    const parsed = JSON.parse(value) as unknown
    if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) {
      return parsed as Record<string, unknown>
    }
  } catch {
    // 统一在下方返回稳定错误，不暴露可能含敏感信息的原始参数。
  }
  throw new ProviderRequestBodyError(
    'invalid_arguments',
    '工具调用参数必须是完整 JSON 对象',
  )
}

function parseGeminiToolOutput(value: string): Record<string, unknown> {
  try {
    const parsed = JSON.parse(value) as unknown
    return parsed && typeof parsed === 'object' && !Array.isArray(parsed)
      ? parsed as Record<string, unknown>
      : { result: parsed }
  } catch {
    return { result: value }
  }
}

function cloneJsonObject(
  value: Readonly<Record<string, unknown>>,
  code: ProviderRequestBodyErrorCode,
): Record<string, unknown> {
  try {
    const cloned = JSON.parse(JSON.stringify(value)) as unknown
    if (cloned && typeof cloned === 'object' && !Array.isArray(cloned)) {
      return cloned as Record<string, unknown>
    }
  } catch {
    // 统一在下方返回稳定错误，不透传序列化实现细节。
  }
  throw new ProviderRequestBodyError(code, 'Provider JSON Schema 必须可序列化')
}

function assignCommonSampling(body: Record<string, unknown>, request: ValidatedRequest): void {
  if (request.temperature !== undefined) body.temperature = request.temperature
}

/** 把中立图片块编码为 data URL；OpenAI 系协议在 image_url/input_image 中使用。 */
function toImageDataUrl(block: ProviderChatImageBlock): string {
  return `data:${block.mediaType};base64,${block.data}`
}

function applyEffortThinking(
  body: Record<string, unknown>,
  thinking: ProviderThinkingOptions | undefined,
  field: 'reasoning_effort',
): void {
  if (thinking === undefined) return
  assertThinkingMode(thinking, 'effort', 'OpenAI Chat Completions')
  body[field] = thinking.effort
}

function assertThinkingMode<T extends ProviderThinkingOptions['mode']>(
  thinking: ProviderThinkingOptions,
  expected: T,
  providerName: string,
): asserts thinking is Extract<ProviderThinkingOptions, { mode: T }> {
  if (thinking.mode !== expected) {
    throw new ProviderRequestBodyError(
      'incompatible_thinking',
      `${providerName} 不支持当前思考参数编码`,
    )
  }
}
