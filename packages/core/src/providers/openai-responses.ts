import {
  ProviderStreamProtocolError,
  type ProviderFinishReason,
  type ProviderStreamAdapter,
  type ProviderStreamEvent,
  type ProviderUsage,
  type ServerSentEvent,
} from './types'

export type OpenAIResponsesStreamErrorCode =
  | 'invalid_json'
  | 'invalid_event'
  | 'provider_error'
  | 'unsupported_item'
  | 'protocol_violation'

export class OpenAIResponsesStreamError extends ProviderStreamProtocolError {
  readonly code: OpenAIResponsesStreamErrorCode

  constructor(
    code: OpenAIResponsesStreamErrorCode,
    message: string,
    options?: ErrorOptions,
  ) {
    super(message, options)
    this.name = 'OpenAIResponsesStreamError'
    this.code = code
  }
}

interface FunctionCallState {
  readonly itemId: string
  readonly outputIndex: number
  readonly callKey: string
  readonly callId: string
  readonly name: string
  arguments: string
  ended: boolean
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

function readRequiredString(record: Record<string, unknown>, key: string): string {
  const value = record[key]
  if (typeof value !== 'string' || value.length === 0) {
    throw new OpenAIResponsesStreamError(
      'invalid_event',
      `OpenAI Responses 事件的 ${key} 无效`,
    )
  }
  return value
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
    throw new OpenAIResponsesStreamError(
      'invalid_event',
      `OpenAI Responses 事件的 ${key} 无效`,
    )
  }
  return value
}

function readRequiredIndex(record: Record<string, unknown>, key: string): number {
  const value = record[key]
  if (!Number.isSafeInteger(value) || (value as number) < 0) {
    throw new OpenAIResponsesStreamError(
      'invalid_event',
      `OpenAI Responses 事件的 ${key} 无效`,
    )
  }
  return value as number
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
    throw new OpenAIResponsesStreamError(
      'invalid_event',
      `OpenAI Responses usage.${key} 无效`,
    )
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

function mapIncompleteReason(reason: string | undefined): ProviderFinishReason {
  switch (reason) {
    case 'max_output_tokens':
      return 'length'
    case 'content_filter':
      return 'content_filter'
    default:
      return 'other'
  }
}

/**
 * 将 OpenAI Responses 的命名 SSE 生命周期映射为 Provider 中立事件。
 *
 * 适配器保存单条响应的 item 状态，因此每次生成必须创建新实例。当前只把
 * function call 暴露给客户端工具编排，服务端内建 item 由 OpenAI 自行完成。
 */
export class OpenAIResponsesStreamAdapter implements ProviderStreamAdapter {
  private readonly functionCalls = new Map<string, FunctionCallState>()
  private readonly activeReasoningBlocks = new Set<string>()
  private responseId: string | undefined
  private lastSequenceNumber: number | undefined
  private sawFunctionCall = false
  private completed = false

  get isComplete(): boolean {
    return this.completed
  }

  /** 解析单个命名 SSE，校验事件顺序后输出零个或多个中立事件。 */
  parseEvent(event: ServerSentEvent): readonly ProviderStreamEvent[] {
    if (this.completed) {
      throw new OpenAIResponsesStreamError(
        'protocol_violation',
        'OpenAI Responses 流在终态后仍然产生事件',
      )
    }

    let parsed: unknown
    try {
      parsed = JSON.parse(event.data)
    } catch (error) {
      throw new OpenAIResponsesStreamError(
        'invalid_json',
        'OpenAI Responses 流事件不是合法 JSON',
        { cause: error },
      )
    }
    if (!isRecord(parsed)) {
      throw new OpenAIResponsesStreamError(
        'invalid_event',
        'OpenAI Responses 事件必须是 JSON 对象',
      )
    }

    const type = readRequiredString(parsed, 'type')
    if (event.event !== 'message' && event.event !== type) {
      throw new OpenAIResponsesStreamError(
        'invalid_event',
        'OpenAI Responses 的 SSE event 与 JSON type 不一致',
      )
    }
    this.validateSequence(parsed)

    switch (type) {
      case 'response.created':
        return this.startResponse(parsed)
      case 'response.in_progress':
      case 'response.queued':
        this.assertStarted()
        return []
      case 'response.output_text.delta':
      case 'response.refusal.delta':
        this.assertStarted()
        return this.parseTextDelta(parsed)
      case 'response.reasoning_summary_text.delta':
        this.assertStarted()
        return this.parseReasoningDelta(parsed, 'summary', 'summary_index')
      case 'response.reasoning_text.delta':
        this.assertStarted()
        return this.parseReasoningDelta(parsed, 'reasoning', 'content_index')
      case 'response.reasoning_summary_text.done':
        this.assertStarted()
        return this.finishReasoning(parsed, 'summary', 'summary_index')
      case 'response.reasoning_text.done':
        this.assertStarted()
        return this.finishReasoning(parsed, 'reasoning', 'content_index')
      case 'response.output_item.added':
        this.assertStarted()
        return this.addOutputItem(parsed)
      case 'response.function_call_arguments.delta':
        this.assertStarted()
        return this.addFunctionArguments(parsed)
      case 'response.function_call_arguments.done':
        this.assertStarted()
        return this.finishFunctionArguments(parsed)
      case 'response.output_item.done':
        this.assertStarted()
        return this.finishOutputItem(parsed)
      case 'response.completed':
        return this.finishResponse(parsed, 'completed')
      case 'response.incomplete':
        return this.finishResponse(parsed, 'incomplete')
      case 'response.failed':
      case 'error':
        throw new OpenAIResponsesStreamError(
          'provider_error',
          'OpenAI Responses 在流中返回了错误终态',
        )
      case 'response.custom_tool_call_input.delta':
      case 'response.custom_tool_call_input.done':
        throw new OpenAIResponsesStreamError(
          'unsupported_item',
          '当前中立协议不支持 OpenAI custom tool call',
        )
      default:
        // content part、文本 done 与服务端内建工具事件不产生额外中立语义。
        return []
    }
  }

  /** 由流读取层在 EOF 后调用，防止中断的响应被误当成完整消息。 */
  assertComplete(): void {
    if (!this.completed) {
      throw new OpenAIResponsesStreamError(
        'protocol_violation',
        'OpenAI Responses 流未收到 completed 或 incomplete 终态',
      )
    }
  }

  /** 记录响应标识；后续 item 和终态事件均必须位于 created 之后。 */
  private startResponse(event: Record<string, unknown>): ProviderStreamEvent[] {
    if (this.responseId !== undefined) {
      throw new OpenAIResponsesStreamError(
        'protocol_violation',
        'OpenAI Responses 流重复收到 response.created',
      )
    }
    const response = this.readResponse(event)
    this.responseId = readRequiredString(response, 'id')
    return []
  }

  /** 将正文或拒绝文本的字符串增量合并到统一可见文本流。 */
  private parseTextDelta(event: Record<string, unknown>): ProviderStreamEvent[] {
    const delta = readRequiredString(event, 'delta')
    return [{ type: 'text_delta', delta }]
  }

  /** 首个推理增量隐式打开块，随后保持 start → delta 的稳定顺序。 */
  private parseReasoningDelta(
    event: Record<string, unknown>,
    kind: 'summary' | 'reasoning',
    indexKey: 'summary_index' | 'content_index',
  ): ProviderStreamEvent[] {
    const blockId = this.readReasoningBlockId(event, kind, indexKey)
    const delta = readRequiredString(event, 'delta')
    const events: ProviderStreamEvent[] = []
    if (!this.activeReasoningBlocks.has(blockId)) {
      this.activeReasoningBlocks.add(blockId)
      events.push({ type: 'reasoning_start', blockId })
    }
    events.push({ type: 'reasoning_delta', blockId, delta })
    return events
  }

  /** 文本 done 只关闭已产生增量的推理块，避免制造空块。 */
  private finishReasoning(
    event: Record<string, unknown>,
    kind: 'summary' | 'reasoning',
    indexKey: 'summary_index' | 'content_index',
  ): ProviderStreamEvent[] {
    const blockId = this.readReasoningBlockId(event, kind, indexKey)
    if (!this.activeReasoningBlocks.delete(blockId)) {
      return []
    }
    return [{ type: 'reasoning_end', blockId }]
  }

  /** 注册 output item；function call 立即向工具编排层发出 start。 */
  private addOutputItem(event: Record<string, unknown>): ProviderStreamEvent[] {
    const item = this.readItem(event)
    if (item.type === 'custom_tool_call') {
      throw new OpenAIResponsesStreamError(
        'unsupported_item',
        '当前中立协议不支持 OpenAI custom tool call',
      )
    }
    if (item.type !== 'function_call') {
      return []
    }

    const itemId = readRequiredString(item, 'id')
    if (this.functionCalls.has(itemId)) {
      throw new OpenAIResponsesStreamError(
        'protocol_violation',
        'OpenAI Responses 重复添加 function call item',
      )
    }
    const outputIndex = readRequiredIndex(event, 'output_index')
    const state: FunctionCallState = {
      itemId,
      outputIndex,
      callKey: `output:${outputIndex}`,
      callId: readRequiredString(item, 'call_id'),
      name: readRequiredString(item, 'name'),
      arguments: '',
      ended: false,
    }
    this.functionCalls.set(itemId, state)
    this.sawFunctionCall = true

    const events: ProviderStreamEvent[] = [
      {
        type: 'tool_call_start',
        callKey: state.callKey,
        callId: state.callId,
        name: state.name,
      },
    ]
    const initialArguments = readOptionalString(item, 'arguments')
    if (initialArguments !== undefined && initialArguments.length > 0) {
      state.arguments = initialArguments
      events.push({
        type: 'tool_call_delta',
        callKey: state.callKey,
        argumentsDelta: initialArguments,
      })
    }
    return events
  }

  /** 累计 function 参数文本，并用 item_id 关联到对应的并行调用。 */
  private addFunctionArguments(event: Record<string, unknown>): ProviderStreamEvent[] {
    const state = this.readOpenFunctionCall(event)
    const delta = readRequiredString(event, 'delta')
    state.arguments += delta
    return [{
      type: 'tool_call_delta',
      callKey: state.callKey,
      argumentsDelta: delta,
    }]
  }

  /** 参数 done 是首选工具终点；校验累计文本后只发一次 end。 */
  private finishFunctionArguments(
    event: Record<string, unknown>,
  ): ProviderStreamEvent[] {
    const state = this.readOpenFunctionCall(event)
    const argumentsText = readRequiredString(event, 'arguments')
    this.assertFinalArguments(state, argumentsText)
    state.ended = true
    return [{ type: 'tool_call_end', callKey: state.callKey }]
  }

  /** output item done 校验最终快照，并在缺少参数 done 时兜底关闭工具块。 */
  private finishOutputItem(event: Record<string, unknown>): ProviderStreamEvent[] {
    const item = this.readItem(event)
    if (item.type === 'custom_tool_call') {
      throw new OpenAIResponsesStreamError(
        'unsupported_item',
        '当前中立协议不支持 OpenAI custom tool call',
      )
    }
    if (item.type !== 'function_call') {
      return []
    }

    const itemId = readRequiredString(item, 'id')
    const state = this.functionCalls.get(itemId)
    if (state === undefined) {
      throw new OpenAIResponsesStreamError(
        'protocol_violation',
        'OpenAI Responses 在 item added 前结束了 function call',
      )
    }
    this.assertFunctionIdentity(event, item, state)
    const argumentsText = readRequiredString(item, 'arguments')
    this.assertFinalArguments(state, argumentsText)
    if (state.ended) {
      return []
    }
    state.ended = true
    return [{ type: 'tool_call_end', callKey: state.callKey }]
  }

  /** 将响应终态中的 usage 和结束原因按顺序提交给 Chat 编排层。 */
  private finishResponse(
    event: Record<string, unknown>,
    terminal: 'completed' | 'incomplete',
  ): ProviderStreamEvent[] {
    this.assertStarted()
    const response = this.readResponse(event)
    this.assertResponseIdentity(response)
    if (response.status !== terminal) {
      throw new OpenAIResponsesStreamError(
        'invalid_event',
        'OpenAI Responses 终态事件与 response.status 不一致',
      )
    }

    // 未闭合的工具或推理块不能交给下游执行或持久化。
    if ([...this.functionCalls.values()].some((state) => !state.ended)) {
      throw new OpenAIResponsesStreamError(
        'protocol_violation',
        'OpenAI Responses 终态前存在未结束的 function call',
      )
    }
    if (this.activeReasoningBlocks.size > 0) {
      throw new OpenAIResponsesStreamError(
        'protocol_violation',
        'OpenAI Responses 终态前存在未结束的推理文本块',
      )
    }

    const events: ProviderStreamEvent[] = []
    const usageEvent = this.parseUsage(response.usage)
    if (usageEvent !== undefined) {
      events.push(usageEvent)
    }

    if (terminal === 'completed') {
      events.push({
        type: 'finish',
        reason: this.sawFunctionCall ? 'tool_use' : 'stop',
        providerReason: 'completed',
      })
    } else {
      const incompleteReason = this.readIncompleteReason(response)
      events.push({
        type: 'finish',
        reason: mapIncompleteReason(incompleteReason),
        providerReason: incompleteReason ?? 'incomplete',
      })
    }

    this.completed = true
    return events
  }

  /** 从终态 response.usage 读取累计 token 快照。 */
  private parseUsage(value: unknown): ProviderStreamEvent | undefined {
    if (value === undefined || value === null) {
      return undefined
    }
    if (!isRecord(value)) {
      throw new OpenAIResponsesStreamError(
        'invalid_event',
        'OpenAI Responses usage 结构无效',
      )
    }

    const usage: ProviderUsage = {}
    assignUsageValue(usage, 'inputTokens', readOptionalTokenCount(value, 'input_tokens'))
    assignUsageValue(usage, 'outputTokens', readOptionalTokenCount(value, 'output_tokens'))
    assignUsageValue(usage, 'totalTokens', readOptionalTokenCount(value, 'total_tokens'))

    if (value.input_tokens_details !== undefined) {
      if (!isRecord(value.input_tokens_details)) {
        throw new OpenAIResponsesStreamError(
          'invalid_event',
          'OpenAI Responses input_tokens_details 结构无效',
        )
      }
      assignUsageValue(
        usage,
        'cacheReadTokens',
        readOptionalTokenCount(value.input_tokens_details, 'cached_tokens'),
      )
      assignUsageValue(
        usage,
        'cacheWriteTokens',
        readOptionalTokenCount(value.input_tokens_details, 'cache_write_tokens'),
      )
    }
    if (value.output_tokens_details !== undefined) {
      if (!isRecord(value.output_tokens_details)) {
        throw new OpenAIResponsesStreamError(
          'invalid_event',
          'OpenAI Responses output_tokens_details 结构无效',
        )
      }
      assignUsageValue(
        usage,
        'reasoningTokens',
        readOptionalTokenCount(value.output_tokens_details, 'reasoning_tokens'),
      )
    }

    return Object.keys(usage).length === 0 ? undefined : { type: 'usage', usage }
  }

  /** 校验 sequence_number 严格递增，但兼容未提供该字段的代理实现。 */
  private validateSequence(event: Record<string, unknown>): void {
    if (event.sequence_number === undefined) {
      return
    }
    const sequenceNumber = readRequiredIndex(event, 'sequence_number')
    if (
      this.lastSequenceNumber !== undefined &&
      sequenceNumber <= this.lastSequenceNumber
    ) {
      throw new OpenAIResponsesStreamError(
        'protocol_violation',
        'OpenAI Responses sequence_number 未严格递增',
      )
    }
    this.lastSequenceNumber = sequenceNumber
  }

  private assertStarted(): void {
    if (this.responseId === undefined) {
      throw new OpenAIResponsesStreamError(
        'protocol_violation',
        'OpenAI Responses 在 response.created 前产生了业务事件',
      )
    }
  }

  private readResponse(event: Record<string, unknown>): Record<string, unknown> {
    if (!isRecord(event.response)) {
      throw new OpenAIResponsesStreamError(
        'invalid_event',
        'OpenAI Responses 事件缺少 response 对象',
      )
    }
    return event.response
  }

  private readItem(event: Record<string, unknown>): Record<string, unknown> {
    if (!isRecord(event.item)) {
      throw new OpenAIResponsesStreamError(
        'invalid_event',
        'OpenAI Responses 事件缺少 item 对象',
      )
    }
    return event.item
  }

  private assertResponseIdentity(response: Record<string, unknown>): void {
    if (readRequiredString(response, 'id') !== this.responseId) {
      throw new OpenAIResponsesStreamError(
        'protocol_violation',
        'OpenAI Responses 终态 response.id 发生变化',
      )
    }
  }

  private readReasoningBlockId(
    event: Record<string, unknown>,
    kind: 'summary' | 'reasoning',
    indexKey: 'summary_index' | 'content_index',
  ): string {
    const itemId = readRequiredString(event, 'item_id')
    const index = readRequiredIndex(event, indexKey)
    return `${kind}:${itemId}:${index}`
  }

  private readOpenFunctionCall(
    event: Record<string, unknown>,
  ): FunctionCallState {
    const itemId = readRequiredString(event, 'item_id')
    const state = this.functionCalls.get(itemId)
    if (state === undefined) {
      throw new OpenAIResponsesStreamError(
        'protocol_violation',
        'OpenAI Responses 参数事件找不到对应的 function call',
      )
    }
    if (state.ended) {
      throw new OpenAIResponsesStreamError(
        'protocol_violation',
        'OpenAI Responses function call 结束后仍收到参数事件',
      )
    }
    if (readRequiredIndex(event, 'output_index') !== state.outputIndex) {
      throw new OpenAIResponsesStreamError(
        'protocol_violation',
        'OpenAI Responses function call 的 output_index 发生变化',
      )
    }
    return state
  }

  private assertFunctionIdentity(
    event: Record<string, unknown>,
    item: Record<string, unknown>,
    state: FunctionCallState,
  ): void {
    if (
      readRequiredIndex(event, 'output_index') !== state.outputIndex ||
      readRequiredString(item, 'call_id') !== state.callId ||
      readRequiredString(item, 'name') !== state.name
    ) {
      throw new OpenAIResponsesStreamError(
        'protocol_violation',
        'OpenAI Responses function call 的最终标识发生变化',
      )
    }
  }

  private assertFinalArguments(state: FunctionCallState, finalArguments: string): void {
    if (state.arguments !== finalArguments) {
      throw new OpenAIResponsesStreamError(
        'protocol_violation',
        'OpenAI Responses function call 的累计参数与最终参数不一致',
      )
    }
  }

  private readIncompleteReason(response: Record<string, unknown>): string | undefined {
    if (response.incomplete_details === undefined || response.incomplete_details === null) {
      return undefined
    }
    if (!isRecord(response.incomplete_details)) {
      throw new OpenAIResponsesStreamError(
        'invalid_event',
        'OpenAI Responses incomplete_details 结构无效',
      )
    }
    return readOptionalString(response.incomplete_details, 'reason')
  }
}
