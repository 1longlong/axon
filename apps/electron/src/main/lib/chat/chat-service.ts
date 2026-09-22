/** Chat 主进程编排：连接渠道、会话仓储与单次 Provider 流式生成。 */

import { randomUUID } from 'node:crypto'
import {
  ProviderStreamProtocolError,
  ProviderStreamRequestError,
  streamProviderChat,
} from '@axon/core'
import type {
  ProviderChatContentBlock,
  ProviderChatMessage,
  ProviderStreamEvent,
  ProviderStreamRequest,
} from '@axon/core'
import {
  DEFAULT_CONVERSATION_TITLE,
  MAX_ATTACHMENT_NAME_LENGTH,
  MAX_ATTACHMENTS_PER_MESSAGE,
  MAX_CHAT_INPUT_LENGTH,
  MAX_CONVERSATION_TITLE_LENGTH,
  MAX_REQUEST_IMAGE_SIZE,
  isImageAttachment,
} from '@axon/shared'
import type {
  ChatContentBlock,
  ChatErrorCode,
  ChatFinishReason,
  ChatGenerationEvent,
  ChatMessage,
  ChatSendInput,
  ChatStreamEvent,
  ChatTokenUsage,
  ConversationMeta,
  ConversationUpdateInput,
  FileAttachment,
  ResolvedChannel,
} from '@axon/shared'
import type { ChannelManager } from '../channel/channel-manager'
import type { ConversationManager } from './conversation-manager'

const DEFAULT_MAX_OUTPUT_TOKENS = 4096
const MAX_OUTPUT_TOKENS = 1_000_000

/** 标题生成的输入截断与输出预算；标题是尽力而为的小请求，不允许挤占对话上下文。 */
const TITLE_SOURCE_MAX_LENGTH = 4_000
const TITLE_MAX_OUTPUT_TOKENS = 64

/** 清洗模型输出的标题：去引号括号、折叠空白，空结果表示放弃本次生成。 */
function normalizeGeneratedTitle(raw: string): string {
  const cleaned = raw
    .replace(/\s+/g, ' ')
    .replace(/^[「『"'“‘（《【\[\s]+|[」』"'”’）》】\]\s]+$/g, '')
    .trim()
  if (!cleaned) return ''
  return cleaned.slice(0, MAX_CONVERSATION_TITLE_LENGTH)
}

export class ChatServiceError extends Error {
  constructor(
    readonly code: Exclude<ChatErrorCode, 'internal_error'>,
    message: string,
  ) {
    super(message)
    this.name = 'ChatServiceError'
  }
}

export type ChatStreamExecutor = (
  input: ProviderStreamRequest,
) => AsyncIterable<ProviderStreamEvent>

export interface ChatServiceOptions {
  channelManager: Pick<ChannelManager, 'resolve'>
  conversationManager: Pick<
    ConversationManager,
    'get' | 'getMessages' | 'appendMessage' | 'update'
  >
  userAgent: string
  stream?: ChatStreamExecutor
  emit?: (event: ChatGenerationEvent) => void
  createId?: () => string
  now?: () => number
  /**
   * 读取附件内容为 base64；由装配层注入（生产用 AttachmentService），core 不接触文件系统。
   * 返回 undefined 表示读取失败，图片会按稳定规则降级为文本提示。
   */
  readAttachmentData?: (localPath: string) => string | undefined
  /**
   * 提取文档附件文本（PDF/DOCX/文本类）；由装配层注入 document-parser，可异步。
   * 返回 undefined 表示解析失败，文档会按稳定规则降级为文本提示。
   */
  extractDocumentText?: (attachment: FileAttachment) => string | undefined | Promise<string | undefined>
}

interface NormalizedSendInput {
  conversationId: string
  text: string
  attachments?: FileAttachment[]
  maxOutputTokens: number
  temperature?: number
}

/**
 * 校验发送输入携带的附件元数据：结构、数量与路径形状。
 * 在用户消息落盘前失败（invalid_input），避免把坏元数据写进 JSONL 后无法挽回；
 * 文件本体必须已通过附件 IPC 落盘，本层不接触附件内容。
 */
function normalizeAttachments(value: unknown): FileAttachment[] | undefined {
  if (value === undefined) return undefined
  if (!Array.isArray(value) || value.length === 0 || value.length > MAX_ATTACHMENTS_PER_MESSAGE) {
    throw new ChatServiceError('invalid_input', '附件列表无效')
  }
  return value.map((item) => {
    if (!item || typeof item !== 'object' || Array.isArray(item)) {
      throw new ChatServiceError('invalid_input', '附件元数据无效')
    }
    const attachment = item as Record<string, unknown>
    const id = attachment.id
    const filename = attachment.filename
    const mediaType = attachment.mediaType
    const localPath = attachment.localPath
    const size = attachment.size
    const createdAt = attachment.createdAt
    if (
      typeof localPath !== 'string' || !localPath || localPath.length > 512 || localPath.includes('\0')
      || localPath.startsWith('/') || localPath.startsWith('\\')
      || /^[A-Za-z]:[\\/]/.test(localPath)
      || localPath.split(/[\\/]/).includes('..')
    ) {
      throw new ChatServiceError('invalid_input', '附件元数据无效')
    }
    if (
      typeof id !== 'string' || !id || id.length > 128
      || typeof filename !== 'string' || !filename || filename.length > MAX_ATTACHMENT_NAME_LENGTH
      || typeof mediaType !== 'string' || !mediaType || mediaType.length > 100
      || typeof size !== 'number' || !Number.isSafeInteger(size) || size < 0
      || typeof createdAt !== 'number' || !Number.isFinite(createdAt) || createdAt < 0
    ) {
      throw new ChatServiceError('invalid_input', '附件元数据无效')
    }
    return { id, filename, mediaType, localPath, size, createdAt }
  })
}

interface ActiveGeneration {
  generationId: string
  controller: AbortController
}

interface TextState {
  kind: 'text'
  text: string
}

interface ReasoningState {
  kind: 'reasoning'
  blockId: string
  text: string
  signature: string
  ended: boolean
}

interface ToolCallState {
  kind: 'tool_call'
  callKey: string
  callId: string
  name: string
  arguments: string
  ended: boolean
}

type OutputBlockState = TextState | ReasoningState | ToolCallState

function normalizeSendInput(input: ChatSendInput): NormalizedSendInput {
  if (!input || typeof input !== 'object') {
    throw new ChatServiceError('invalid_input', 'Chat 请求格式无效')
  }
  const conversationId = typeof input.conversationId === 'string'
    ? input.conversationId.trim()
    : ''
  const text = typeof input.text === 'string' ? input.text.trim() : ''
  if (!conversationId || !text || text.length > MAX_CHAT_INPUT_LENGTH) {
    throw new ChatServiceError('invalid_input', '对话 ID 或消息正文无效')
  }
  const maxOutputTokens = input.maxOutputTokens ?? DEFAULT_MAX_OUTPUT_TOKENS
  if (
    !Number.isSafeInteger(maxOutputTokens)
    || maxOutputTokens <= 0
    || maxOutputTokens > MAX_OUTPUT_TOKENS
  ) {
    throw new ChatServiceError('invalid_input', '最大输出 token 数无效')
  }
  if (
    input.temperature !== undefined
    && (!Number.isFinite(input.temperature) || input.temperature < 0 || input.temperature > 2)
  ) {
    throw new ChatServiceError('invalid_input', 'temperature 必须位于 0 到 2')
  }
  const attachments = normalizeAttachments(input.attachments)
  return {
    conversationId,
    text,
    ...(attachments === undefined ? {} : { attachments }),
    maxOutputTokens,
    ...(input.temperature === undefined ? {} : { temperature: input.temperature }),
  }
}

function copyContent(block: ChatContentBlock): ChatContentBlock {
  if (block.type === 'text') return { type: 'text', text: block.text }
  if (block.type === 'reasoning') {
    return {
      type: 'reasoning',
      text: block.text,
      ...(block.signature === undefined ? {} : { signature: block.signature }),
    }
  }
  if (block.type === 'tool_call') {
    return {
      type: 'tool_call',
      callId: block.callId,
      name: block.name,
      arguments: block.arguments,
    }
  }
  return {
    type: 'tool_result',
    callId: block.callId,
    name: block.name,
    output: block.output,
    ...(block.isError === undefined ? {} : { isError: block.isError }),
  }
}

/**
 * 只把完整助手回复送回模型，并排除已被摘要覆盖的旧消息。
 * 用户消息的图片/文档附件在此处解码注入；读取或解析失败时降级为文本提示，不静默丢弃。
 */
async function toProviderHistory(
  messages: readonly ChatMessage[],
  coveredMessageIds: readonly string[] = [],
  readAttachmentData?: (localPath: string) => string | undefined,
  extractDocumentText?: (attachment: FileAttachment) => string | undefined | Promise<string | undefined>,
): Promise<ProviderChatMessage[]> {
  const covered = new Set(coveredMessageIds)
  const result: ProviderChatMessage[] = []
  for (const message of messages) {
    if (covered.has(message.id) || !(message.role === 'user' || message.status === 'complete')) continue
    if (message.role === 'user' && message.attachments?.length) {
      result.push({
        role: message.role,
        content: [...message.content.map(copyContent), ...(await attachmentBlocks(message.attachments, readAttachmentData, extractDocumentText))],
      })
    } else {
      result.push({ role: message.role, content: message.content.map(copyContent) })
    }
  }
  return result
}

/**
 * 附件元数据转为请求内容块：白名单图片按大小上限读取编码为图片块；
 * 文档附件提取文本并以 `<file>` 块注入（不持久化提取结果，每轮重提取）。
 * 读取/解析失败统一降级为可见文本提示，不静默丢弃、不中断生成。
 */
async function attachmentBlocks(
  attachments: readonly FileAttachment[],
  readAttachmentData?: (localPath: string) => string | undefined,
  extractDocumentText?: (attachment: FileAttachment) => string | undefined | Promise<string | undefined>,
): Promise<ProviderChatContentBlock[]> {
  const blocks: ProviderChatContentBlock[] = []
  for (const attachment of attachments) {
    if (isImageAttachment(attachment.mediaType)) {
      const data = attachment.size <= MAX_REQUEST_IMAGE_SIZE
        ? readAttachmentData?.(attachment.localPath)
        : undefined
      blocks.push(data
        ? { type: 'image', mediaType: attachment.mediaType, data }
        : { type: 'text', text: `（图片附件 ${attachment.filename} 未能随消息发送）` })
      continue
    }
    let text: string | undefined
    try {
      // 解析器的稳定错误与意外异常都归一为提示，文档问题不允许拖垮本轮生成。
      text = await extractDocumentText?.(attachment)
    } catch {
      text = undefined
    }
    blocks.push(text
      ? { type: 'text', text: `<file name="${attachment.filename}">\n${text}\n</file>` }
      : { type: 'text', text: `（文档附件 ${attachment.filename} 未能随消息发送）` })
  }
  return blocks
}

function toChatStreamEvent(event: ProviderStreamEvent): ChatStreamEvent {
  if (event.type === 'usage') return { type: 'usage', usage: { ...event.usage } }
  if (event.type === 'finish') {
    return {
      type: 'finish',
      reason: event.reason,
      ...(event.providerReason === undefined ? {} : { providerReason: event.providerReason }),
    }
  }
  return { ...event }
}

function isJsonObject(value: string): boolean {
  try {
    const parsed: unknown = JSON.parse(value)
    return Boolean(parsed && typeof parsed === 'object' && !Array.isArray(parsed))
  } catch {
    return false
  }
}

/** 按流事件状态机累计富内容块，并在完成前验证块边界和工具参数。 */
class ChatStreamAccumulator {
  private readonly blocks: OutputBlockState[] = []
  private readonly reasoning = new Map<string, ReasoningState>()
  private readonly toolCalls = new Map<string, ToolCallState>()
  private usage: ChatTokenUsage | undefined
  private finishReason: ChatFinishReason | undefined

  /** 消费一个中立 Provider 事件，并维护正文、推理和工具块的闭合状态。 */
  apply(event: ProviderStreamEvent): void {
    if (this.finishReason !== undefined) this.failProtocol()

    if (event.type === 'text_delta') {
      if (!event.delta) return
      const tail = this.blocks.at(-1)
      if (tail?.kind === 'text') tail.text += event.delta
      else this.blocks.push({ kind: 'text', text: event.delta })
      return
    }
    if (event.type === 'reasoning_start') {
      if (this.reasoning.has(event.blockId)) this.failProtocol()
      const state: ReasoningState = {
        kind: 'reasoning',
        blockId: event.blockId,
        text: '',
        signature: '',
        ended: false,
      }
      this.reasoning.set(event.blockId, state)
      this.blocks.push(state)
      return
    }
    if (event.type === 'reasoning_delta' || event.type === 'reasoning_signature') {
      const state = this.reasoning.get(event.blockId)
      if (!state || state.ended) this.failProtocol()
      if (event.type === 'reasoning_delta') state.text += event.delta
      else state.signature += event.signatureDelta
      return
    }
    if (event.type === 'reasoning_end') {
      const state = this.reasoning.get(event.blockId)
      if (!state || state.ended) this.failProtocol()
      state.ended = true
      return
    }
    if (event.type === 'tool_call_start') {
      if (this.toolCalls.has(event.callKey)) this.failProtocol()
      const state: ToolCallState = {
        kind: 'tool_call',
        callKey: event.callKey,
        callId: event.callId,
        name: event.name,
        arguments: '',
        ended: false,
      }
      this.toolCalls.set(event.callKey, state)
      this.blocks.push(state)
      return
    }
    if (event.type === 'tool_call_delta') {
      const state = this.toolCalls.get(event.callKey)
      if (!state || state.ended) this.failProtocol()
      state.arguments += event.argumentsDelta
      return
    }
    if (event.type === 'tool_call_end') {
      const state = this.toolCalls.get(event.callKey)
      if (!state || state.ended) this.failProtocol()
      state.ended = true
      return
    }
    if (event.type === 'usage') {
      this.usage = { ...event.usage }
      return
    }
    this.finishReason = event.reason
  }

  /** 合法终态才能生成 complete 消息；未闭合块不会进入持久化历史。 */
  complete(id: string, modelId: string, createdAt: number): ChatMessage {
    if (!this.finishReason || this.finishReason === 'error') this.failProtocol()
    if (
      [...this.reasoning.values()].some((item) => !item.ended)
      || [...this.toolCalls.values()].some((item) => !item.ended || !isJsonObject(item.arguments))
    ) {
      this.failProtocol()
    }
    const content = this.snapshot(false)
    if (content.length === 0 && this.finishReason !== 'content_filter') this.failProtocol()
    return {
      id,
      role: 'assistant',
      content,
      createdAt,
      status: 'complete',
      modelId,
      finishReason: this.finishReason,
      ...(this.usage === undefined ? {} : { usage: { ...this.usage } }),
    }
  }

  /** 把当前可验证的局部块收口为 stopped/failed 消息，丢弃半截工具参数。 */
  interrupted(
    id: string,
    modelId: string,
    createdAt: number,
    stopped: boolean,
    error?: string,
  ): ChatMessage {
    return {
      id,
      role: 'assistant',
      content: this.snapshot(true),
      createdAt,
      status: stopped ? 'stopped' : 'error',
      modelId,
      finishReason: stopped ? 'other' : 'error',
      ...(this.usage === undefined ? {} : { usage: { ...this.usage } }),
      ...(error === undefined ? {} : { error }),
    }
  }

  private snapshot(allowPartial: boolean): ChatContentBlock[] {
    const content: ChatContentBlock[] = []
    for (const state of this.blocks) {
      if (state.kind === 'text' && state.text) {
        content.push({ type: 'text', text: state.text })
      } else if (state.kind === 'reasoning' && (state.text || state.signature)) {
        content.push({
          type: 'reasoning',
          text: state.text,
          ...(state.signature ? { signature: state.signature } : {}),
        })
      } else if (
        state.kind === 'tool_call'
        && state.ended
        && isJsonObject(state.arguments)
      ) {
        content.push({
          type: 'tool_call',
          callId: state.callId,
          name: state.name,
          arguments: state.arguments,
        })
      } else if (!allowPartial) {
        this.failProtocol()
      }
    }
    return content
  }

  private failProtocol(): never {
    throw new ChatServiceError('provider_failed', 'Provider 流事件顺序无效')
  }
}

function resolveGenerationError(error: unknown, aborted: boolean): ChatServiceError {
  if (
    aborted
    || (error instanceof ProviderStreamRequestError && error.code === 'cancelled')
  ) {
    return new ChatServiceError('cancelled', '生成已停止')
  }
  if (error instanceof ChatServiceError) return error
  if (error instanceof ProviderStreamRequestError) {
    return new ChatServiceError('provider_failed', error.message)
  }
  if (error instanceof ProviderStreamProtocolError) {
    return new ChatServiceError('provider_failed', 'Provider 响应格式无效')
  }
  return new ChatServiceError('provider_failed', '生成失败')
}

export class ChatService {
  private readonly active = new Map<string, ActiveGeneration>()
  private readonly stream: ChatStreamExecutor
  private readonly emitEvent: (event: ChatGenerationEvent) => void
  private readonly createId: () => string
  private readonly now: () => number
  private readonly readAttachmentData?: (localPath: string) => string | undefined
  private readonly extractDocumentText?: (attachment: FileAttachment) => string | undefined | Promise<string | undefined>

  private async maybeSummarize(conversationId: string, channel: ResolvedChannel, modelId: string, signal: AbortSignal): Promise<void> {
    const conversation = this.options.conversationManager.get(conversationId)
    const messages = this.options.conversationManager.getMessages(conversationId)
    if (!conversation || conversation.contextSummary || messages.length < 12) return
    const completed = messages.filter((message) => message.status === 'complete')
    const candidates = completed.slice(0, Math.max(0, completed.length - 8))
    const source = candidates.map((message) => message.content.map((block) => 'text' in block ? block.text : '').join('')).join('\n\n')
    if (source.length < 80_000) return

    const summaryParts: string[] = []
    for await (const event of this.stream({
      provider: channel.provider,
      baseUrl: channel.baseUrl,
      apiKey: channel.apiKey,
      userAgent: this.options.userAgent,
      chatRequest: {
        modelId,
        messages: [{ role: 'user', content: [{ type: 'text', text: source }] }],
        systemPrompt: '请把以下对话压缩成一份准确、简洁、可继续使用的事实摘要。只输出摘要，不要解释过程。',
        maxOutputTokens: 2_000,
      },
      signal,
    })) {
      if (event.type === 'text_delta') summaryParts.push(event.delta)
    }
    const text = summaryParts.join('').trim()
    if (!text) return
    const update: ConversationUpdateInput = {
      contextSummary: { text, coveredMessageIds: candidates.map((message) => message.id), updatedAt: this.now() },
    }
    this.options.conversationManager.update(conversationId, update)
  }

  /**
   * 会话仍是默认标题时，用首轮问答内容生成一次会话标题。
   * 尽力而为：完成事件之后异步执行，失败/取消/空输出静默放弃；
   * 更新前复查标题，用户在生成期间手动改名时让位，不覆盖用户的命名。
   */
  private async maybeGenerateTitle(
    conversationId: string,
    channel: ResolvedChannel,
    modelId: string,
    userText: string,
    assistantText: string,
    signal: AbortSignal,
    eventSink: ((event: ChatGenerationEvent) => void) | undefined,
  ): Promise<void> {
    const conversation = this.options.conversationManager.get(conversationId)
    if (!conversation || conversation.title !== DEFAULT_CONVERSATION_TITLE) return
    const source = `${userText}\n\n${assistantText}`.trim().slice(0, TITLE_SOURCE_MAX_LENGTH)
    if (!source) return

    let raw = ''
    for await (const event of this.stream({
      provider: channel.provider,
      baseUrl: channel.baseUrl,
      apiKey: channel.apiKey,
      userAgent: this.options.userAgent,
      chatRequest: {
        modelId,
        messages: [{ role: 'user', content: [{ type: 'text', text: source }] }],
        systemPrompt: '请为这段对话生成一个不超过 20 个字的简洁标题，直接输出标题本身，不要引号、句号或任何解释。',
        maxOutputTokens: TITLE_MAX_OUTPUT_TOKENS,
      },
      signal,
    })) {
      if (event.type === 'text_delta') raw += event.delta
    }
    const title = normalizeGeneratedTitle(raw)
    if (!title) return
    // 生成期间用户可能已手动改名；标题仍被占用才允许自动标题落地。
    const latest = this.options.conversationManager.get(conversationId)
    if (!latest || latest.title !== DEFAULT_CONVERSATION_TITLE) return
    this.options.conversationManager.update(conversationId, { title })
    this.emit({ type: 'title', conversationId, title }, eventSink)
  }

  constructor(private readonly options: ChatServiceOptions) {
    this.stream = options.stream ?? ((input) => streamProviderChat(input))
    this.emitEvent = options.emit ?? (() => {})
    this.createId = options.createId ?? randomUUID
    this.now = options.now ?? Date.now
    this.readAttachmentData = options.readAttachmentData
    this.extractDocumentText = options.extractDocumentText
  }

  /**
   * 把一条用户输入编排为“预落盘 → Provider 流 → 助手终态落盘”。
   * 返回值是已由 ConversationManager 规范化的最终助手消息。
   */
  async sendMessage(
    rawInput: ChatSendInput,
    eventSink: ((event: ChatGenerationEvent) => void) | undefined = undefined,
    inputOrigin?: 'quick',
  ): Promise<ChatMessage> {
    const input = normalizeSendInput(rawInput)
    if (this.active.has(input.conversationId)) {
      throw new ChatServiceError('already_active', '该对话正在生成')
    }
    const { channel, modelId } = this.resolveTarget(input.conversationId)

    const generationId = this.createId()
    const assistantMessageId = this.createId()
    const controller = new AbortController()
    const current: ActiveGeneration = { generationId, controller }
    const accumulator = new ChatStreamAccumulator()
    this.active.set(input.conversationId, current)
    let started = false

    try {
      // 摘要成功后才更新会话索引；失败会被吞掉，主请求仍使用原始历史。
      let contextSummary = this.options.conversationManager.get(input.conversationId)?.contextSummary
      if (!contextSummary) {
        try { await this.maybeSummarize(input.conversationId, channel, modelId, controller.signal) } catch { /* 保留完整历史 */ }
        contextSummary = this.options.conversationManager.get(input.conversationId)?.contextSummary
      }
      // 用户消息先落盘；即使网络失败，用户原始输入仍能恢复和重试。
      const userMessage = this.options.conversationManager.appendMessage(
        input.conversationId,
        {
          id: this.createId(),
          role: 'user',
          ...(inputOrigin === 'quick' ? { inputOrigin } : {}),
          content: [{ type: 'text', text: input.text }],
          createdAt: this.now(),
          status: 'complete',
          ...(input.attachments === undefined ? {} : { attachments: input.attachments }),
        },
      )
      started = true
      this.emit({
        type: 'started',
        conversationId: input.conversationId,
        generationId,
        assistantMessageId,
        userMessage,
      }, eventSink)

      // 从刚落盘的可信历史构建请求，Provider 层不接触会话文件和渠道密钥存储。
      const history = await toProviderHistory(
        this.options.conversationManager.getMessages(input.conversationId),
        contextSummary?.coveredMessageIds,
        this.readAttachmentData,
        this.extractDocumentText,
      )
      // 摘要是被移出请求的早期历史替身；Chat 不接收用户配置的 Agent 系统提示词。
      const historySummary = contextSummary ? `以下是更早对话的摘要：\n${contextSummary.text}` : undefined
      for await (const event of this.stream({
        provider: channel.provider,
        baseUrl: channel.baseUrl,
        apiKey: channel.apiKey,
        userAgent: this.options.userAgent,
        chatRequest: {
          modelId,
          messages: history,
          ...(historySummary ? { systemPrompt: historySummary } : {}),
          maxOutputTokens: input.maxOutputTokens,
          ...(input.temperature === undefined ? {} : { temperature: input.temperature }),
        },
        signal: controller.signal,
      })) {
        accumulator.apply(event)
        this.emit({
          type: 'stream',
          conversationId: input.conversationId,
          generationId,
          event: toChatStreamEvent(event),
        }, eventSink)
      }

      const assistantMessage = this.options.conversationManager.appendMessage(
        input.conversationId,
        accumulator.complete(assistantMessageId, modelId, this.now()),
      )
      this.emit({
        type: 'completed',
        conversationId: input.conversationId,
        generationId,
        message: assistantMessage,
      }, eventSink)
      // 标题生成尽力而为：不阻塞返回值，失败、取消或空输出都被吞掉，只在成功时广播 title 事件。
      void this.maybeGenerateTitle(
        input.conversationId,
        channel,
        modelId,
        input.text,
        assistantMessage.content
          .filter((block): block is Extract<ChatContentBlock, { type: 'text' }> => block.type === 'text')
          .map((block) => block.text)
          .join(''),
        controller.signal,
        eventSink,
      ).catch(() => {})
      return assistantMessage
    } catch (error) {
      const resolved = resolveGenerationError(error, controller.signal.aborted)
      if (!started) {
        throw new ChatServiceError('persistence_failed', '保存用户消息失败')
      }

      // 已开始的生成必须产生 stopped/failed 终态，避免 UI 永久停在生成中。
      const stopped = resolved.code === 'cancelled'
      const interrupted = accumulator.interrupted(
        assistantMessageId,
        modelId,
        this.now(),
        stopped,
        stopped ? undefined : resolved.message,
      )
      let persisted = interrupted
      try {
        persisted = this.options.conversationManager.appendMessage(
          input.conversationId,
          interrupted,
        )
      } catch {
        this.emit({
          type: 'failed',
          conversationId: input.conversationId,
          generationId,
          message: interrupted,
        }, eventSink)
        throw new ChatServiceError('persistence_failed', '保存助手消息失败')
      }
      this.emit({
        type: stopped ? 'stopped' : 'failed',
        conversationId: input.conversationId,
        generationId,
        message: persisted,
      }, eventSink)
      throw resolved
    } finally {
      // generationId 防止旧请求的 finally 误删同会话未来的新任务。
      if (this.active.get(input.conversationId)?.generationId === generationId) {
        this.active.delete(input.conversationId)
      }
    }
  }

  /** 取消指定对话的下游 AbortSignal；最终 stopped 消息由 sendMessage 统一收口。 */
  stopGeneration(conversationId: string): boolean {
    const generation = this.active.get(conversationId)
    if (!generation || generation.controller.signal.aborted) return false
    generation.controller.abort(new DOMException('用户停止生成', 'AbortError'))
    return true
  }

  /** 应用退出或统一停止时取消全部生成，并返回实际发出取消信号的数量。 */
  stopAllGenerations(): number {
    const generations = [...this.active.values()]
      .filter((generation) => !generation.controller.signal.aborted)
    for (const generation of generations) {
      generation.controller.abort(new DOMException('停止全部生成', 'AbortError'))
    }
    return generations.length
  }

  isActive(conversationId?: string): boolean {
    return conversationId === undefined
      ? this.active.size > 0
      : this.active.has(conversationId)
  }

  /** 在写消息和联网前解析会话选择，阻止停用渠道或模型进入下游。 */
  private resolveTarget(conversationId: string): { channel: ResolvedChannel; modelId: string; contextSummary?: ConversationMeta['contextSummary'] } {
    let conversation
    try {
      conversation = this.options.conversationManager.get(conversationId)
    } catch {
      throw new ChatServiceError('invalid_input', '对话 ID 格式无效')
    }
    if (!conversation) {
      throw new ChatServiceError('conversation_not_found', '对话不存在')
    }
    if (!conversation.channelId) {
      throw new ChatServiceError('channel_required', '请先为对话选择渠道')
    }
    if (!conversation.modelId) {
      throw new ChatServiceError('model_required', '请先为对话选择模型')
    }

    let channel: ResolvedChannel
    try {
      channel = this.options.channelManager.resolve(conversation.channelId)
    } catch {
      throw new ChatServiceError('channel_unavailable', '渠道不可用或凭据无法读取')
    }
    if (!channel.enabled) {
      throw new ChatServiceError('channel_unavailable', '渠道已停用')
    }
    if (channel.models.length > 0) {
      const model = channel.models.find((item) => item.id === conversation.modelId)
      if (!model?.enabled) {
        throw new ChatServiceError('model_unavailable', '所选模型不存在或已停用')
      }
    }
    return { channel, modelId: conversation.modelId, ...(conversation.contextSummary === undefined ? {} : { contextSummary: conversation.contextSummary }) }
  }

  private emit(
    event: ChatGenerationEvent,
    eventSink: ((event: ChatGenerationEvent) => void) | undefined,
  ): void {
    try {
      const sink = eventSink ?? this.emitEvent
      sink(event)
    } catch {
      // 事件消费者故障不能中断模型生成或影响消息落盘。
      console.warn('[Chat 服务] 生成事件发送失败')
    }
  }
}
