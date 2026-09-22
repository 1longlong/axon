import {
  ProviderStreamProtocolError,
  type ProviderFinishReason,
  type ProviderStreamAdapter,
  type ProviderStreamEvent,
  type ProviderUsage,
  type ServerSentEvent,
} from './types'

export type GoogleGeminiStreamErrorCode =
  | 'invalid_json'
  | 'invalid_chunk'
  | 'provider_error'
  | 'unsupported_candidate'
  | 'protocol_violation'

export class GoogleGeminiStreamError extends ProviderStreamProtocolError {
  readonly code: GoogleGeminiStreamErrorCode

  constructor(
    code: GoogleGeminiStreamErrorCode,
    message: string,
    options?: ErrorOptions,
  ) {
    super(message, options)
    this.name = 'GoogleGeminiStreamError'
    this.code = code
  }
}

interface CandidateResult {
  readonly events: ProviderStreamEvent[]
  readonly finishReason?: string
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
    throw new GoogleGeminiStreamError(
      'invalid_chunk',
      `Gemini 响应的 ${key} 无效`,
    )
  }
  return value
}

function readRequiredString(record: Record<string, unknown>, key: string): string {
  const value = readOptionalString(record, key)
  if (value === undefined || value.length === 0) {
    throw new GoogleGeminiStreamError(
      'invalid_chunk',
      `Gemini 响应的 ${key} 无效`,
    )
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
    throw new GoogleGeminiStreamError(
      'invalid_chunk',
      `Gemini usageMetadata.${key} 无效`,
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

function mapFinishReason(reason: string, sawFunctionCall: boolean): ProviderFinishReason {
  switch (reason) {
    case 'STOP':
      return sawFunctionCall ? 'tool_use' : 'stop'
    case 'MAX_TOKENS':
      return 'length'
    case 'SAFETY':
    case 'RECITATION':
    case 'BLOCKLIST':
    case 'PROHIBITED_CONTENT':
    case 'SPII':
    case 'IMAGE_SAFETY':
    case 'IMAGE_PROHIBITED_CONTENT':
      return 'content_filter'
    case 'MALFORMED_FUNCTION_CALL':
    case 'UNEXPECTED_TOOL_CALL':
      return 'error'
    default:
      return 'other'
  }
}

/**
 * 将 Gemini streamGenerateContent 的 data-only SSE 映射为中立事件。
 *
 * Gemini 每个 data 都是一个 GenerateContentResponse 增量；文本直接追加，
 * functionCall 的对象参数一次展开，候选 finishReason 才确认完整终态。
 */
export class GoogleGeminiStreamAdapter implements ProviderStreamAdapter {
  private readonly activeReasoningBlocks = new Set<string>()
  private responseId: string | undefined
  private functionCallSequence = 0
  private sawFunctionCall = false
  private completed = false

  get isComplete(): boolean {
    return this.completed
  }

  /** 解析单个 GenerateContentResponse，保持内容、用量、finish 的输出顺序。 */
  parseEvent(event: ServerSentEvent): readonly ProviderStreamEvent[] {
    if (this.completed) {
      throw new GoogleGeminiStreamError(
        'protocol_violation',
        'Gemini 流在 finishReason 后仍然产生事件',
      )
    }
    if (event.event !== 'message') {
      throw new GoogleGeminiStreamError(
        'invalid_chunk',
        'Gemini streamGenerateContent 应使用 data-only SSE',
      )
    }

    let parsed: unknown
    try {
      parsed = JSON.parse(event.data)
    } catch (error) {
      throw new GoogleGeminiStreamError(
        'invalid_json',
        'Gemini 流事件不是合法 JSON',
        { cause: error },
      )
    }
    if (!isRecord(parsed)) {
      throw new GoogleGeminiStreamError(
        'invalid_chunk',
        'Gemini 响应片段必须是 JSON 对象',
      )
    }
    if (isRecord(parsed.error)) {
      throw new GoogleGeminiStreamError(
        'provider_error',
        'Gemini 在流中返回了错误对象',
      )
    }
    this.validateResponseId(parsed)

    const events: ProviderStreamEvent[] = []
    const candidateResult = this.parseCandidates(parsed.candidates)
    events.push(...candidateResult.events)

    if (candidateResult.finishReason !== undefined) {
      events.push(...this.closeReasoningBlocks())
    }

    const usageEvent = this.parseUsage(parsed.usageMetadata)
    if (usageEvent !== undefined) {
      events.push(usageEvent)
    }

    // 正常候选以 finishReason 收口；提示词拦截则可能完全没有候选。
    if (candidateResult.finishReason !== undefined) {
      events.push(this.createFinish(candidateResult.finishReason))
      this.completed = true
    } else {
      const blockReason = this.readPromptBlockReason(parsed.promptFeedback)
      if (blockReason !== undefined) {
        events.push(...this.closeReasoningBlocks())
        events.push({
          type: 'finish',
          reason: 'content_filter',
          providerReason: blockReason,
        })
        this.completed = true
      }
    }
    return events
  }

  /** 由底层读取层在 EOF 后调用，防止无 finishReason 的断流被提交。 */
  assertComplete(): void {
    if (!this.completed) {
      throw new GoogleGeminiStreamError(
        'protocol_violation',
        'Gemini 流未收到 finishReason 或提示词拦截终态',
      )
    }
  }

  /** 当前中立协议只表达一个候选，因此固定接受 candidate index 0。 */
  private parseCandidates(value: unknown): CandidateResult {
    if (value === undefined || value === null) {
      return { events: [] }
    }
    if (!Array.isArray(value)) {
      throw new GoogleGeminiStreamError(
        'invalid_chunk',
        'Gemini candidates 结构无效',
      )
    }
    if (value.length > 1) {
      throw new GoogleGeminiStreamError(
        'unsupported_candidate',
        'Gemini 适配器仅支持单候选响应',
      )
    }
    if (value.length === 0) {
      return { events: [] }
    }

    const candidate = value[0]
    if (!isRecord(candidate) || candidate.index !== 0) {
      throw new GoogleGeminiStreamError(
        'unsupported_candidate',
        'Gemini 适配器仅支持 candidate index 0',
      )
    }
    const events = this.parseContent(candidate.content)
    const rawFinishReason = readOptionalString(candidate, 'finishReason')
    const finishReason =
      rawFinishReason === 'FINISH_REASON_UNSPECIFIED' ? undefined : rawFinishReason
    return { events, finishReason }
  }

  /** 顺序处理 parts；可见正文或工具出现前先关闭仍打开的思考块。 */
  private parseContent(value: unknown): ProviderStreamEvent[] {
    if (value === undefined || value === null) {
      return []
    }
    if (!isRecord(value) || !Array.isArray(value.parts)) {
      throw new GoogleGeminiStreamError(
        'invalid_chunk',
        'Gemini candidate.content 结构无效',
      )
    }

    const events: ProviderStreamEvent[] = []
    for (const [partIndex, part] of value.parts.entries()) {
      if (!isRecord(part)) {
        throw new GoogleGeminiStreamError(
          'invalid_chunk',
          'Gemini content part 结构无效',
        )
      }
      events.push(...this.parsePart(part, partIndex))
    }
    return events
  }

  /** 将文本、thoughtSignature 或 functionCall part 转为对应中立生命周期。 */
  private parsePart(part: Record<string, unknown>, partIndex: number): ProviderStreamEvent[] {
    if (part.thought !== undefined && typeof part.thought !== 'boolean') {
      throw new GoogleGeminiStreamError(
        'invalid_chunk',
        'Gemini part.thought 类型无效',
      )
    }
    const text = readOptionalString(part, 'text')
    const signature = readOptionalString(part, 'thoughtSignature')
    const isThought = part.thought === true

    if (part.functionCall !== undefined) {
      if (text !== undefined) {
        throw new GoogleGeminiStreamError(
          'invalid_chunk',
          'Gemini part 不能同时包含 text 和 functionCall',
        )
      }
      const events = this.emitSignature(signature, partIndex)
      events.push(...this.closeReasoningBlocks())
      events.push(...this.parseFunctionCall(part.functionCall))
      return events
    }

    if (text !== undefined && isThought) {
      const blockId = `candidate:0:thought:${partIndex}`
      const events: ProviderStreamEvent[] = []
      if (!this.activeReasoningBlocks.has(blockId)) {
        this.activeReasoningBlocks.add(blockId)
        events.push({ type: 'reasoning_start', blockId })
      }
      if (text.length > 0) {
        events.push({ type: 'reasoning_delta', blockId, delta: text })
      }
      if (signature !== undefined && signature.length > 0) {
        events.push({
          type: 'reasoning_signature',
          blockId,
          signatureDelta: signature,
        })
      }
      return events
    }

    if (text !== undefined) {
      const hadActiveReasoning = this.activeReasoningBlocks.size > 0
      const events = hadActiveReasoning ? this.emitSignature(signature, partIndex) : []
      events.push(...this.closeReasoningBlocks())
      if (text.length > 0) {
        events.push({ type: 'text_delta', delta: text })
      }
      if (!hadActiveReasoning) {
        events.push(...this.emitSignature(signature, partIndex))
      }
      return events
    }
    if (signature !== undefined) {
      return this.emitSignature(signature, partIndex)
    }

    // inlineData、代码执行和检索元数据不属于当前文本中立协议。
    return []
  }

  /** Gemini 函数参数已经是对象，因此一次序列化后展开完整工具生命周期。 */
  private parseFunctionCall(value: unknown): ProviderStreamEvent[] {
    if (!isRecord(value)) {
      throw new GoogleGeminiStreamError(
        'invalid_chunk',
        'Gemini functionCall 结构无效',
      )
    }
    const name = readRequiredString(value, 'name')
    const providerCallId = readOptionalString(value, 'id')
    if (value.args !== undefined && !isRecord(value.args)) {
      throw new GoogleGeminiStreamError(
        'invalid_chunk',
        'Gemini functionCall.args 必须是 JSON 对象',
      )
    }

    const sequence = this.functionCallSequence
    this.functionCallSequence += 1
    const callKey = `candidate:0:call:${sequence}`
    const callId = providerCallId ?? `gemini-call-${sequence}`
    const argumentsText = JSON.stringify(value.args ?? {})
    this.sawFunctionCall = true
    return [
      { type: 'tool_call_start', callKey, callId, name },
      { type: 'tool_call_delta', callKey, argumentsDelta: argumentsText },
      { type: 'tool_call_end', callKey },
    ]
  }

  /** 保存 thoughtSignature；若没有活跃思考块，则创建一个签名专用空块。 */
  private emitSignature(
    signature: string | undefined,
    partIndex: number,
  ): ProviderStreamEvent[] {
    if (signature === undefined || signature.length === 0) {
      return []
    }
    const activeBlockId = [...this.activeReasoningBlocks].at(-1)
    if (activeBlockId !== undefined) {
      return [{
        type: 'reasoning_signature',
        blockId: activeBlockId,
        signatureDelta: signature,
      }]
    }

    const blockId = `candidate:0:signature:${partIndex}`
    return [
      { type: 'reasoning_start', blockId },
      { type: 'reasoning_signature', blockId, signatureDelta: signature },
      { type: 'reasoning_end', blockId },
    ]
  }

  /** Gemini 没有 part stop；在内容切换或候选终态时统一关闭思考块。 */
  private closeReasoningBlocks(): ProviderStreamEvent[] {
    const events: ProviderStreamEvent[] = []
    for (const blockId of this.activeReasoningBlocks) {
      events.push({ type: 'reasoning_end', blockId })
    }
    this.activeReasoningBlocks.clear()
    return events
  }

  /** 将 Gemini 的累计用量字段转换为 Provider 用量快照。 */
  private parseUsage(value: unknown): ProviderStreamEvent | undefined {
    if (value === undefined || value === null) {
      return undefined
    }
    if (!isRecord(value)) {
      throw new GoogleGeminiStreamError(
        'invalid_chunk',
        'Gemini usageMetadata 结构无效',
      )
    }

    const usage: ProviderUsage = {}
    assignUsageValue(
      usage,
      'inputTokens',
      readOptionalTokenCount(value, 'promptTokenCount'),
    )
    assignUsageValue(
      usage,
      'outputTokens',
      readOptionalTokenCount(value, 'candidatesTokenCount'),
    )
    assignUsageValue(
      usage,
      'reasoningTokens',
      readOptionalTokenCount(value, 'thoughtsTokenCount'),
    )
    assignUsageValue(
      usage,
      'cacheReadTokens',
      readOptionalTokenCount(value, 'cachedContentTokenCount'),
    )
    assignUsageValue(
      usage,
      'totalTokens',
      readOptionalTokenCount(value, 'totalTokenCount'),
    )
    return Object.keys(usage).length === 0 ? undefined : { type: 'usage', usage }
  }

  private createFinish(reason: string): ProviderStreamEvent {
    return {
      type: 'finish',
      reason: mapFinishReason(reason, this.sawFunctionCall),
      providerReason: reason,
    }
  }

  private validateResponseId(chunk: Record<string, unknown>): void {
    const responseId = readOptionalString(chunk, 'responseId')
    if (responseId === undefined) {
      return
    }
    if (this.responseId === undefined) {
      this.responseId = responseId
    } else if (responseId !== this.responseId) {
      throw new GoogleGeminiStreamError(
        'protocol_violation',
        'Gemini 流中的 responseId 发生变化',
      )
    }
  }

  private readPromptBlockReason(value: unknown): string | undefined {
    if (value === undefined || value === null) {
      return undefined
    }
    if (!isRecord(value)) {
      throw new GoogleGeminiStreamError(
        'invalid_chunk',
        'Gemini promptFeedback 结构无效',
      )
    }
    const blockReason = readOptionalString(value, 'blockReason')
    return blockReason === 'BLOCK_REASON_UNSPECIFIED' ? undefined : blockReason
  }
}
