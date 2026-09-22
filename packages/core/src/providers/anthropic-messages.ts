import {
  ProviderStreamProtocolError,
  type ProviderFinishReason,
  type ProviderStreamAdapter,
  type ProviderStreamEvent,
  type ProviderUsage,
  type ServerSentEvent,
} from './types'

export type AnthropicMessagesStreamErrorCode =
  | 'invalid_json'
  | 'invalid_event'
  | 'provider_error'
  | 'unsupported_block'
  | 'protocol_violation'

export class AnthropicMessagesStreamError extends ProviderStreamProtocolError {
  readonly code: AnthropicMessagesStreamErrorCode

  constructor(
    code: AnthropicMessagesStreamErrorCode,
    message: string,
    options?: ErrorOptions,
  ) {
    super(message, options)
    this.name = 'AnthropicMessagesStreamError'
    this.code = code
  }
}

interface TextBlockState {
  readonly type: 'text'
}

interface ThinkingBlockState {
  readonly type: 'thinking'
  readonly blockId: string
}

interface ToolBlockState {
  readonly type: 'tool_use'
  readonly callKey: string
  readonly callId: string
  readonly name: string
}

interface IgnoredBlockState {
  readonly type: 'ignored'
}

type ContentBlockState =
  | TextBlockState
  | ThinkingBlockState
  | ToolBlockState
  | IgnoredBlockState

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

function readRequiredString(record: Record<string, unknown>, key: string): string {
  const value = record[key]
  if (typeof value !== 'string' || value.length === 0) {
    throw new AnthropicMessagesStreamError(
      'invalid_event',
      `Anthropic 事件的 ${key} 无效`,
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
    throw new AnthropicMessagesStreamError(
      'invalid_event',
      `Anthropic 事件的 ${key} 无效`,
    )
  }
  return value
}

function readIndex(record: Record<string, unknown>, key = 'index'): number {
  const value = record[key]
  if (!Number.isSafeInteger(value) || (value as number) < 0) {
    throw new AnthropicMessagesStreamError(
      'invalid_event',
      `Anthropic 事件的 ${key} 无效`,
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
    throw new AnthropicMessagesStreamError(
      'invalid_event',
      `Anthropic usage.${key} 无效`,
    )
  }
  return value as number
}

function mapStopReason(reason: string): ProviderFinishReason {
  switch (reason) {
    case 'end_turn':
    case 'stop_sequence':
      return 'stop'
    case 'max_tokens':
    case 'model_context_window_exceeded':
      return 'length'
    case 'tool_use':
      return 'tool_use'
    case 'refusal':
      return 'content_filter'
    default:
      return 'other'
  }
}

/**
 * 将 Anthropic Messages 的命名 SSE 映射为 Provider 中立事件。
 *
 * 单实例只处理一条 message 流；content block 的 index 用于关联文本、思考、
 * 签名和工具参数，message_stop 才确认整条响应完整。
 */
export class AnthropicMessagesStreamAdapter implements ProviderStreamAdapter {
  private readonly blocks = new Map<number, ContentBlockState>()
  private usage: ProviderUsage = {}
  private uncachedInputTokens: number | undefined
  private messageId: string | undefined
  private stopReason: string | undefined
  private sawClientTool = false
  private completed = false

  get isComplete(): boolean {
    return this.completed
  }

  /** 校验单个 Anthropic SSE 的名称与负载，并按内容块生命周期派发。 */
  parseEvent(event: ServerSentEvent): readonly ProviderStreamEvent[] {
    if (this.completed) {
      throw new AnthropicMessagesStreamError(
        'protocol_violation',
        'Anthropic 流在 message_stop 后仍然产生事件',
      )
    }

    let parsed: unknown
    try {
      parsed = JSON.parse(event.data)
    } catch (error) {
      throw new AnthropicMessagesStreamError(
        'invalid_json',
        'Anthropic 流事件不是合法 JSON',
        { cause: error },
      )
    }
    if (!isRecord(parsed)) {
      throw new AnthropicMessagesStreamError(
        'invalid_event',
        'Anthropic 事件必须是 JSON 对象',
      )
    }

    const type = readRequiredString(parsed, 'type')
    if (event.event !== 'message' && event.event !== type) {
      throw new AnthropicMessagesStreamError(
        'invalid_event',
        'Anthropic SSE event 与 JSON type 不一致',
      )
    }

    switch (type) {
      case 'message_start':
        return this.startMessage(parsed)
      case 'content_block_start':
        this.assertStarted()
        return this.startContentBlock(parsed)
      case 'content_block_delta':
        this.assertStarted()
        return this.parseContentBlockDelta(parsed)
      case 'content_block_stop':
        this.assertStarted()
        return this.stopContentBlock(parsed)
      case 'message_delta':
        this.assertStarted()
        return this.parseMessageDelta(parsed)
      case 'message_stop':
        return this.stopMessage()
      case 'error':
        throw new AnthropicMessagesStreamError(
          'provider_error',
          'Anthropic 在流中返回了错误事件',
        )
      case 'ping':
        return []
      default:
        // Anthropic 允许未来增加事件类型；未知事件不能破坏现有流。
        return []
    }
  }

  /** 由底层读取层在 EOF 后调用，确保 message_stop 没有因断流而缺失。 */
  assertComplete(): void {
    if (!this.completed) {
      throw new AnthropicMessagesStreamError(
        'protocol_violation',
        'Anthropic 流未收到 message_stop',
      )
    }
  }

  /** 记录 message 标识并发送第一份累计输入用量。 */
  private startMessage(event: Record<string, unknown>): ProviderStreamEvent[] {
    if (this.messageId !== undefined) {
      throw new AnthropicMessagesStreamError(
        'protocol_violation',
        'Anthropic 流重复收到 message_start',
      )
    }
    if (!isRecord(event.message)) {
      throw new AnthropicMessagesStreamError(
        'invalid_event',
        'Anthropic message_start 缺少 message 对象',
      )
    }
    if (event.message.type !== 'message' || event.message.role !== 'assistant') {
      throw new AnthropicMessagesStreamError(
        'invalid_event',
        'Anthropic message_start 的消息类型无效',
      )
    }
    this.messageId = readRequiredString(event.message, 'id')
    return this.mergeUsage(event.message.usage)
  }

  /** 按 index 打开文本、思考或客户端工具块，并先发对应 start。 */
  private startContentBlock(event: Record<string, unknown>): ProviderStreamEvent[] {
    const index = readIndex(event)
    if (this.blocks.has(index)) {
      throw new AnthropicMessagesStreamError(
        'protocol_violation',
        'Anthropic 重复打开同一 content block',
      )
    }
    if (!isRecord(event.content_block)) {
      throw new AnthropicMessagesStreamError(
        'invalid_event',
        'Anthropic content_block_start 缺少内容块',
      )
    }

    switch (event.content_block.type) {
      case 'text':
        this.blocks.set(index, { type: 'text' })
        return []
      case 'thinking': {
        const blockId = `content:${index}`
        this.blocks.set(index, { type: 'thinking', blockId })
        return [{ type: 'reasoning_start', blockId }]
      }
      case 'tool_use': {
        const callId = readRequiredString(event.content_block, 'id')
        const name = readRequiredString(event.content_block, 'name')
        const block: ToolBlockState = {
          type: 'tool_use',
          callKey: `content:${index}`,
          callId,
          name,
        }
        this.blocks.set(index, block)
        this.sawClientTool = true
        return [{
          type: 'tool_call_start',
          callKey: block.callKey,
          callId,
          name,
        }]
      }
      case 'redacted_thinking':
      case 'server_tool_use':
      case 'web_search_tool_result':
      case 'web_fetch_tool_result':
      case 'code_execution_tool_result':
      case 'bash_code_execution_tool_result':
      case 'text_editor_code_execution_tool_result':
        this.blocks.set(index, { type: 'ignored' })
        return []
      default:
        // 服务端工具和未来内容块由 Anthropic 完成，不进入客户端工具编排。
        this.blocks.set(index, { type: 'ignored' })
        return []
    }
  }

  /** 根据已打开块约束 delta 类型，避免不同块的数据被错误拼接。 */
  private parseContentBlockDelta(
    event: Record<string, unknown>,
  ): ProviderStreamEvent[] {
    const block = this.readOpenBlock(event)
    if (block.type === 'ignored') {
      return []
    }
    if (!isRecord(event.delta)) {
      throw new AnthropicMessagesStreamError(
        'invalid_event',
        'Anthropic content_block_delta 缺少 delta',
      )
    }

    switch (event.delta.type) {
      case 'text_delta':
        this.assertBlockType(block, 'text', 'text_delta')
        return [{ type: 'text_delta', delta: readRequiredString(event.delta, 'text') }]
      case 'thinking_delta':
        this.assertBlockType(block, 'thinking', 'thinking_delta')
        return [{
          type: 'reasoning_delta',
          blockId: block.blockId,
          delta: readRequiredString(event.delta, 'thinking'),
        }]
      case 'signature_delta':
        this.assertBlockType(block, 'thinking', 'signature_delta')
        return [{
          type: 'reasoning_signature',
          blockId: block.blockId,
          signatureDelta: readRequiredString(event.delta, 'signature'),
        }]
      case 'input_json_delta':
        this.assertBlockType(block, 'tool_use', 'input_json_delta')
        return [{
          type: 'tool_call_delta',
          callKey: block.callKey,
          argumentsDelta: readRequiredString(event.delta, 'partial_json'),
        }]
      default:
        return []
    }
  }

  /** 关闭对应内容块；思考与工具必须先结束，再允许整条消息结束。 */
  private stopContentBlock(event: Record<string, unknown>): ProviderStreamEvent[] {
    const index = readIndex(event)
    const block = this.blocks.get(index)
    if (block === undefined) {
      throw new AnthropicMessagesStreamError(
        'protocol_violation',
        'Anthropic 在 start 前停止了 content block',
      )
    }
    this.blocks.delete(index)

    switch (block.type) {
      case 'thinking':
        return [{ type: 'reasoning_end', blockId: block.blockId }]
      case 'tool_use':
        return [{ type: 'tool_call_end', callKey: block.callKey }]
      default:
        return []
    }
  }

  /** 保存 stop_reason，并把 message_delta 的累计输出用量合并后发送。 */
  private parseMessageDelta(event: Record<string, unknown>): ProviderStreamEvent[] {
    if (this.stopReason !== undefined) {
      throw new AnthropicMessagesStreamError(
        'protocol_violation',
        'Anthropic 流重复提供 stop_reason',
      )
    }
    if (!isRecord(event.delta)) {
      throw new AnthropicMessagesStreamError(
        'invalid_event',
        'Anthropic message_delta 缺少 delta',
      )
    }
    this.stopReason = readRequiredString(event.delta, 'stop_reason')
    if (this.sawClientTool && this.stopReason !== 'tool_use') {
      throw new AnthropicMessagesStreamError(
        'protocol_violation',
        'Anthropic 客户端工具块与 stop_reason 不一致',
      )
    }
    return this.mergeUsage(event.usage)
  }

  /** message_stop 确认所有块已闭合，并产生本轮唯一 finish。 */
  private stopMessage(): ProviderStreamEvent[] {
    this.assertStarted()
    if (this.blocks.size > 0) {
      throw new AnthropicMessagesStreamError(
        'protocol_violation',
        'Anthropic message_stop 前仍有未结束的 content block',
      )
    }
    if (this.stopReason === undefined) {
      throw new AnthropicMessagesStreamError(
        'protocol_violation',
        'Anthropic message_stop 前缺少 stop_reason',
      )
    }

    this.completed = true
    return [{
      type: 'finish',
      reason: mapStopReason(this.stopReason),
      providerReason: this.stopReason,
    }]
  }

  /** 合并分散在 message_start/message_delta 的累计 token 字段。 */
  private mergeUsage(value: unknown): ProviderStreamEvent[] {
    if (value === undefined || value === null) {
      return []
    }
    if (!isRecord(value)) {
      throw new AnthropicMessagesStreamError(
        'invalid_event',
        'Anthropic usage 结构无效',
      )
    }

    let changed = false
    const uncachedInputTokens = readOptionalTokenCount(value, 'input_tokens')
    if (uncachedInputTokens !== undefined) {
      this.uncachedInputTokens = uncachedInputTokens
      changed = true
    }
    const outputTokens = readOptionalTokenCount(value, 'output_tokens')
    if (outputTokens !== undefined) {
      this.usage.outputTokens = outputTokens
      changed = true
    }
    const cacheReadTokens = readOptionalTokenCount(value, 'cache_read_input_tokens')
    if (cacheReadTokens !== undefined) {
      this.usage.cacheReadTokens = cacheReadTokens
      changed = true
    }
    const cacheWriteTokens = readOptionalTokenCount(value, 'cache_creation_input_tokens')
    if (cacheWriteTokens !== undefined) {
      this.usage.cacheWriteTokens = cacheWriteTokens
      changed = true
    }
    if (value.output_tokens_details !== undefined && value.output_tokens_details !== null) {
      if (!isRecord(value.output_tokens_details)) {
        throw new AnthropicMessagesStreamError(
          'invalid_event',
          'Anthropic output_tokens_details 结构无效',
        )
      }
      const reasoningTokens = readOptionalTokenCount(
        value.output_tokens_details,
        'thinking_tokens',
      )
      if (reasoningTokens !== undefined) {
        this.usage.reasoningTokens = reasoningTokens
        changed = true
      }
    }
    if (!changed) {
      return []
    }

    // Anthropic 的 input_tokens 不含缓存读写，需要合并后才是完整输入量。
    if (this.uncachedInputTokens !== undefined) {
      this.usage.inputTokens =
        this.uncachedInputTokens +
        (this.usage.cacheReadTokens ?? 0) +
        (this.usage.cacheWriteTokens ?? 0)
    }
    if (this.usage.inputTokens !== undefined && this.usage.outputTokens !== undefined) {
      this.usage.totalTokens = this.usage.inputTokens + this.usage.outputTokens
    }
    return [{ type: 'usage', usage: { ...this.usage } }]
  }

  private assertStarted(): void {
    if (this.messageId === undefined) {
      throw new AnthropicMessagesStreamError(
        'protocol_violation',
        'Anthropic 在 message_start 前产生了业务事件',
      )
    }
  }

  private readOpenBlock(event: Record<string, unknown>): ContentBlockState {
    const index = readIndex(event)
    const block = this.blocks.get(index)
    if (block === undefined) {
      throw new AnthropicMessagesStreamError(
        'protocol_violation',
        'Anthropic delta 找不到已打开的 content block',
      )
    }
    return block
  }

  private assertBlockType<T extends ContentBlockState['type']>(
    block: ContentBlockState,
    expected: T,
    deltaType: string,
  ): asserts block is Extract<ContentBlockState, { type: T }> {
    if (block.type !== expected) {
      throw new AnthropicMessagesStreamError(
        'protocol_violation',
        `Anthropic ${deltaType} 与已打开的内容块类型不一致`,
      )
    }
  }
}
