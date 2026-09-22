import {
  ProviderStreamProtocolError,
  type ProviderFinishReason,
  type ProviderStreamAdapter,
  type ProviderStreamEvent,
  type ProviderUsage,
  type ServerSentEvent,
} from './types'

export type OpenAIChatStreamErrorCode =
  | 'invalid_json'
  | 'invalid_chunk'
  | 'provider_error'
  | 'unsupported_choice'
  | 'unsupported_tool'
  | 'protocol_violation'

export class OpenAIChatStreamError extends ProviderStreamProtocolError {
  readonly code: OpenAIChatStreamErrorCode

  constructor(code: OpenAIChatStreamErrorCode, message: string, options?: ErrorOptions) {
    super(message, options)
    this.name = 'OpenAIChatStreamError'
    this.code = code
  }
}

interface ToolCallState {
  readonly callKey: string
  callId: string
  name: string
  readonly argumentDeltas: string[]
  sawArguments: boolean
  started: boolean
  ended: boolean
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

function readOptionalString(
  record: Record<string, unknown>,
  key: string,
): string | undefined {
  const value = record[key]
  if (value === undefined || value === null) {
    return undefined
  }
  if (typeof value !== 'string') {
    throw new OpenAIChatStreamError('invalid_chunk', `OpenAI chunk 的 ${key} 类型无效`)
  }
  return value
}

function readOptionalTokenCount(
  record: Record<string, unknown>,
  key: string,
): number | undefined {
  const value = record[key]
  if (value === undefined || value === null) {
    return undefined
  }
  if (!Number.isSafeInteger(value) || (value as number) < 0) {
    throw new OpenAIChatStreamError('invalid_chunk', `OpenAI usage.${key} 类型无效`)
  }
  return value as number
}

function assignUsageValue(
  usage: ProviderUsage,
  key: keyof ProviderUsage,
  value: number | undefined,
): void {
  if (value !== undefined) {
    usage[key] = value
  }
}

function mapFinishReason(reason: string): ProviderFinishReason {
  switch (reason) {
    case 'stop':
      return 'stop'
    case 'length':
      return 'length'
    case 'tool_calls':
    case 'function_call':
      return 'tool_use'
    case 'content_filter':
      return 'content_filter'
    default:
      return 'other'
  }
}

/**
 * 将 OpenAI Chat Completions 的 data-only SSE 映射为 Provider 中立事件。
 *
 * 适配器只支持单候选（请求端应固定 n=1）和 function tools。它保存单条
 * 流的少量状态，因此每次生成必须创建新实例，不能跨请求复用。
 */
export class OpenAIChatCompletionsStreamAdapter implements ProviderStreamAdapter {
  private readonly tools = new Map<number, ToolCallState>()
  private pendingFinishReason: string | undefined
  private completed = false

  get isComplete(): boolean {
    return this.completed
  }

  /** 接收上游已切分的 SSE，校验 OpenAI chunk 后输出中立增量事件。 */
  parseEvent(event: ServerSentEvent): readonly ProviderStreamEvent[] {
    if (this.completed) {
      throw new OpenAIChatStreamError(
        'protocol_violation',
        'OpenAI 流在 [DONE] 后仍然产生事件',
      )
    }

    const data = event.data.trim()
    // `[DONE]` 是传输终点；finish_reason 已在更早的 choice 中暂存。
    if (data === '[DONE]') {
      return this.completeStream()
    }

    let parsed: unknown
    try {
      parsed = JSON.parse(data)
    } catch (error) {
      throw new OpenAIChatStreamError('invalid_json', 'OpenAI 流事件不是合法 JSON', {
        cause: error,
      })
    }

    if (!isRecord(parsed)) {
      throw new OpenAIChatStreamError('invalid_chunk', 'OpenAI chunk 必须是 JSON 对象')
    }
    if (isRecord(parsed.error)) {
      throw new OpenAIChatStreamError('provider_error', 'OpenAI 在流中返回了错误事件')
    }
    if (parsed.object !== 'chat.completion.chunk' || !Array.isArray(parsed.choices)) {
      throw new OpenAIChatStreamError('invalid_chunk', 'OpenAI chunk 缺少必要字段')
    }

    // 先映射 choice，再映射可能独立到达的 usage，保持供应商事件顺序。
    const events: ProviderStreamEvent[] = []
    for (const choice of parsed.choices) {
      events.push(...this.parseChoice(choice))
    }

    const usageEvent = this.parseUsage(parsed.usage)
    if (usageEvent !== undefined) {
      events.push(usageEvent)
    }
    return events
  }

  assertComplete(): void {
    if (!this.completed) {
      throw new OpenAIChatStreamError(
        'protocol_violation',
        'OpenAI 流未收到 [DONE]，不能视为完整生成',
      )
    }
  }

  /** 映射单候选正文、工具分片和模型结束原因；当前契约固定 n=1。 */
  private parseChoice(value: unknown): ProviderStreamEvent[] {
    if (!isRecord(value) || !Number.isSafeInteger(value.index)) {
      throw new OpenAIChatStreamError('invalid_chunk', 'OpenAI choice 结构无效')
    }
    if (value.index !== 0) {
      throw new OpenAIChatStreamError(
        'unsupported_choice',
        'OpenAI 适配器仅支持 n=1 的单候选响应',
      )
    }
    if (this.pendingFinishReason !== undefined) {
      throw new OpenAIChatStreamError(
        'protocol_violation',
        'OpenAI finish_reason 后出现了额外 choice',
      )
    }
    if (!isRecord(value.delta)) {
      throw new OpenAIChatStreamError('invalid_chunk', 'OpenAI choice.delta 结构无效')
    }

    const events: ProviderStreamEvent[] = []
    const content = readOptionalString(value.delta, 'content')
    if (content !== undefined && content.length > 0) {
      events.push({ type: 'text_delta', delta: content })
    }
    const refusal = readOptionalString(value.delta, 'refusal')
    if (refusal !== undefined && refusal.length > 0) {
      events.push({ type: 'text_delta', delta: refusal })
    }

    if (value.delta.function_call !== undefined) {
      throw new OpenAIChatStreamError(
        'unsupported_tool',
        '不支持已弃用的 OpenAI function_call 流格式',
      )
    }
    if (value.delta.tool_calls !== undefined) {
      if (!Array.isArray(value.delta.tool_calls)) {
        throw new OpenAIChatStreamError('invalid_chunk', 'OpenAI tool_calls 结构无效')
      }
      for (const toolCall of value.delta.tool_calls) {
        events.push(...this.parseToolCall(toolCall))
      }
    }

    const finishReason = readOptionalString(value, 'finish_reason')
    if (finishReason !== undefined) {
      events.push(...this.recordFinish(finishReason))
    }
    return events
  }

  /** 按 tool index 累计调用；元数据不完整时先缓冲参数，不提前发 start。 */
  private parseToolCall(value: unknown): ProviderStreamEvent[] {
    if (!isRecord(value) || !Number.isSafeInteger(value.index) || (value.index as number) < 0) {
      throw new OpenAIChatStreamError('invalid_chunk', 'OpenAI tool_call.index 无效')
    }
    if (value.type !== undefined && value.type !== 'function') {
      throw new OpenAIChatStreamError(
        'unsupported_tool',
        '当前仅支持 OpenAI function tools',
      )
    }

    const index = value.index as number
    let state = this.tools.get(index)
    if (state === undefined) {
      state = {
        callKey: `0:${index}`,
        callId: '',
        name: '',
        argumentDeltas: [],
        sawArguments: false,
        started: false,
        ended: false,
      }
      this.tools.set(index, state)
    }
    if (state.ended) {
      throw new OpenAIChatStreamError(
        'protocol_violation',
        'OpenAI 工具调用结束后仍收到参数分片',
      )
    }

    const idDelta = readOptionalString(value, 'id')
    if (idDelta !== undefined) {
      if (state.started) {
        throw new OpenAIChatStreamError(
          'protocol_violation',
          'OpenAI 工具调用开始后仍收到 id 分片',
        )
      }
      state.callId += idDelta
    }

    if (value.function !== undefined && !isRecord(value.function)) {
      throw new OpenAIChatStreamError('invalid_chunk', 'OpenAI tool_call.function 结构无效')
    }
    if (isRecord(value.function)) {
      const nameDelta = readOptionalString(value.function, 'name')
      if (nameDelta !== undefined) {
        if (state.started) {
          throw new OpenAIChatStreamError(
            'protocol_violation',
            'OpenAI 工具调用开始后仍收到名称分片',
          )
        }
        state.name += nameDelta
      }
      const argumentsDelta = readOptionalString(value.function, 'arguments')
      if (argumentsDelta !== undefined) {
        state.sawArguments = true
        if (argumentsDelta.length > 0) {
          state.argumentDeltas.push(argumentsDelta)
        }
      }
    }

    // 只有关联所需的 id/name 齐全后，才能把之前缓存的参数交给下游。
    if (state.sawArguments && state.callId.length > 0 && state.name.length > 0) {
      return this.startAndFlushTool(state)
    }
    return []
  }

  /** 保证工具生命周期顺序为 start → delta → end，并清空已发送缓冲。 */
  private startAndFlushTool(state: ToolCallState): ProviderStreamEvent[] {
    const events: ProviderStreamEvent[] = []
    if (!state.started) {
      state.started = true
      events.push({
        type: 'tool_call_start',
        callKey: state.callKey,
        callId: state.callId,
        name: state.name,
      })
    }
    for (const delta of state.argumentDeltas.splice(0)) {
      events.push({
        type: 'tool_call_delta',
        callKey: state.callKey,
        argumentsDelta: delta,
      })
    }
    return events
  }

  /** 校验工具状态并结束所有调用；统一 finish 延迟到 `[DONE]`。 */
  private recordFinish(reason: string): ProviderStreamEvent[] {
    if (this.pendingFinishReason !== undefined) {
      throw new OpenAIChatStreamError(
        'protocol_violation',
        'OpenAI 流重复提供 finish_reason',
      )
    }

    const hasTools = this.tools.size > 0
    const isToolFinish = reason === 'tool_calls' || reason === 'function_call'
    if (hasTools !== isToolFinish) {
      throw new OpenAIChatStreamError(
        'protocol_violation',
        'OpenAI 工具调用与 finish_reason 不一致',
      )
    }

    // 先关闭每个工具块，下游才能在收到整轮 finish 前得到完整参数。
    const events: ProviderStreamEvent[] = []
    for (const state of this.tools.values()) {
      if (state.callId.length === 0 || state.name.length === 0) {
        throw new OpenAIChatStreamError(
          'protocol_violation',
          'OpenAI 工具调用缺少 id 或名称',
        )
      }
      events.push(...this.startAndFlushTool(state))
      state.ended = true
      events.push({ type: 'tool_call_end', callKey: state.callKey })
    }

    this.pendingFinishReason = reason
    return events
  }

  /** 将 OpenAI 累计 token 统计转换为 Provider 用量快照。 */
  private parseUsage(value: unknown): ProviderStreamEvent | undefined {
    if (value === undefined || value === null) {
      return undefined
    }
    if (!isRecord(value)) {
      throw new OpenAIChatStreamError('invalid_chunk', 'OpenAI usage 结构无效')
    }

    const usage: ProviderUsage = {}
    assignUsageValue(usage, 'inputTokens', readOptionalTokenCount(value, 'prompt_tokens'))
    assignUsageValue(
      usage,
      'outputTokens',
      readOptionalTokenCount(value, 'completion_tokens'),
    )
    assignUsageValue(usage, 'totalTokens', readOptionalTokenCount(value, 'total_tokens'))

    if (value.completion_tokens_details !== undefined) {
      if (!isRecord(value.completion_tokens_details)) {
        throw new OpenAIChatStreamError(
          'invalid_chunk',
          'OpenAI completion_tokens_details 结构无效',
        )
      }
      assignUsageValue(
        usage,
        'reasoningTokens',
        readOptionalTokenCount(value.completion_tokens_details, 'reasoning_tokens'),
      )
    }
    if (value.prompt_tokens_details !== undefined) {
      if (!isRecord(value.prompt_tokens_details)) {
        throw new OpenAIChatStreamError(
          'invalid_chunk',
          'OpenAI prompt_tokens_details 结构无效',
        )
      }
      assignUsageValue(
        usage,
        'cacheReadTokens',
        readOptionalTokenCount(value.prompt_tokens_details, 'cached_tokens'),
      )
      assignUsageValue(
        usage,
        'cacheWriteTokens',
        readOptionalTokenCount(value.prompt_tokens_details, 'cache_write_tokens'),
      )
    }

    return Object.keys(usage).length === 0 ? undefined : { type: 'usage', usage }
  }

  /** 用传输哨兵确认模型终态完整，并产生本轮唯一的 finish。 */
  private completeStream(): ProviderStreamEvent[] {
    if (this.pendingFinishReason === undefined) {
      throw new OpenAIChatStreamError(
        'protocol_violation',
        'OpenAI [DONE] 前缺少 finish_reason',
      )
    }

    this.completed = true
    return [
      {
        type: 'finish',
        reason: mapFinishReason(this.pendingFinishReason),
        providerReason: this.pendingFinishReason,
      },
    ]
  }
}
