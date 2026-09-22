/**
 * Chat 会话持久化。
 *
 * conversations.json 只保存轻量索引；每个会话的完整消息独立保存为 JSONL。
 */

import { randomUUID } from 'node:crypto'
import {
  chmodSync,
  copyFileSync,
  existsSync,
  mkdirSync,
  readFileSync,
  statSync,
  unlinkSync,
} from 'node:fs'
import { dirname, join } from 'node:path'
import {
  DEFAULT_CONVERSATION_TITLE,
  MAX_ATTACHMENT_NAME_LENGTH,
  MAX_ATTACHMENTS_PER_MESSAGE,
  MAX_CHAT_CONTENT_BLOCKS,
  MAX_CONVERSATION_TITLE_LENGTH,
} from '@axon/shared'
import type {
  ChatContentBlock,
  ChatFinishReason,
  ChatMessage,
  ChatMessageStatus,
  ChatTokenUsage,
  ConversationCreateInput,
  ConversationMeta,
  ConversationUpdateInput,
  FileAttachment,
  RecentChatMessages,
} from '@axon/shared'
import { readJsonFileSafe, writeJsonFileAtomic, writeTextFileAtomic } from '../core/safe-file'

const INDEX_VERSION = 1
const MAX_MESSAGES = 100_000
const MAX_MESSAGES_FILE_BYTES = 128 * 1024 * 1024
const MAX_MESSAGE_TEXT_LENGTH = 8 * 1024 * 1024
const MAX_ERROR_LENGTH = 4096
const ID_PATTERN = /^[a-zA-Z0-9_-]{1,100}$/
const TOOL_NAME_PATTERN = /^[a-zA-Z0-9_-]{1,64}$/
const MESSAGE_STATUSES: readonly ChatMessageStatus[] = ['complete', 'stopped', 'error']
const FINISH_REASONS: readonly ChatFinishReason[] = [
  'stop',
  'length',
  'tool_use',
  'content_filter',
  'error',
  'other',
]
const USAGE_KEYS: readonly (keyof ChatTokenUsage)[] = [
  'inputTokens',
  'outputTokens',
  'reasoningTokens',
  'cacheReadTokens',
  'cacheWriteTokens',
  'totalTokens',
]

interface ConversationsIndex {
  version: number
  conversations: ConversationMeta[]
}

export type ConversationManagerErrorCode =
  | 'invalid_input'
  | 'not_found'
  | 'duplicate'
  | 'too_large'
  | 'storage_error'

export class ConversationManagerError extends Error {
  constructor(
    readonly code: ConversationManagerErrorCode,
    message: string,
  ) {
    super(message)
    this.name = 'ConversationManagerError'
  }
}

export interface ConversationManagerOptions {
  indexPath: string
  messagesDir: string
  createId?: () => string
  now?: () => number
}

function cloneJson<T>(value: T): T {
  return JSON.parse(JSON.stringify(value)) as T
}

function normalizeId(value: unknown, label: string): string {
  if (typeof value !== 'string' || !ID_PATTERN.test(value)) {
    throw new ConversationManagerError('invalid_input', `${label}格式无效`)
  }
  return value
}

function normalizeOptionalId(
  value: unknown,
  label: string,
  maxLength: number,
): string | undefined {
  if (value === undefined || value === null) return undefined
  if (typeof value !== 'string' || !value.trim() || value.length > maxLength) {
    throw new ConversationManagerError('invalid_input', `${label}格式无效`)
  }
  return value.trim()
}

function normalizeOpaqueString(
  value: unknown,
  label: string,
  maxLength: number,
): string | undefined {
  if (value === undefined || value === null) return undefined
  if (typeof value !== 'string' || !value.trim() || value.length > maxLength) {
    throw new ConversationManagerError('invalid_input', `${label}格式无效`)
  }
  return value
}

function normalizeTitle(value: unknown): string {
  if (value === undefined) return DEFAULT_CONVERSATION_TITLE
  if (typeof value !== 'string' || !value.trim()) {
    throw new ConversationManagerError('invalid_input', '对话标题不能为空')
  }
  return value.trim().slice(0, MAX_CONVERSATION_TITLE_LENGTH)
}

function normalizeToolIdentity(callId: unknown, name: unknown): {
  callId: string
  name: string
} {
  const normalizedCallId = normalizeOpaqueString(callId, '工具调用 ID', 512)
  if (!normalizedCallId || typeof name !== 'string' || !TOOL_NAME_PATTERN.test(name)) {
    throw new ConversationManagerError('invalid_input', '工具调用标识无效')
  }
  return { callId: normalizedCallId, name }
}

function parseToolArguments(value: unknown): string {
  if (typeof value !== 'string' || value.length > MAX_MESSAGE_TEXT_LENGTH) {
    throw new ConversationManagerError('invalid_input', '工具参数格式无效')
  }
  try {
    const parsed = JSON.parse(value) as unknown
    if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) {
      return JSON.stringify(parsed)
    }
  } catch {
    // 统一在下方返回稳定错误，不记录可能含敏感信息的原始参数。
  }
  throw new ConversationManagerError('invalid_input', '工具参数必须是完整 JSON 对象')
}

function normalizeContentBlock(
  role: ChatMessage['role'],
  value: unknown,
): ChatContentBlock {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    throw new ConversationManagerError('invalid_input', '消息内容块无效')
  }
  const block = value as Record<string, unknown>
  if (block.type === 'text') {
    if (
      typeof block.text !== 'string'
      || !block.text.trim()
      || block.text.length > MAX_MESSAGE_TEXT_LENGTH
    ) {
      throw new ConversationManagerError('invalid_input', '消息正文不能为空或过长')
    }
    return { type: 'text', text: block.text }
  }
  if (block.type === 'reasoning') {
    if (role !== 'assistant' || typeof block.text !== 'string') {
      throw new ConversationManagerError('invalid_input', '推理块必须属于 assistant')
    }
    const signature = normalizeOpaqueString(
      block.signature,
      '推理签名',
      MAX_MESSAGE_TEXT_LENGTH,
    )
    if ((!block.text && !signature) || block.text.length > MAX_MESSAGE_TEXT_LENGTH) {
      throw new ConversationManagerError('invalid_input', '推理块为空或过长')
    }
    return {
      type: 'reasoning',
      text: block.text,
      ...(signature === undefined ? {} : { signature }),
    }
  }
  if (block.type === 'tool_call') {
    if (role !== 'assistant') {
      throw new ConversationManagerError('invalid_input', '工具调用必须属于 assistant')
    }
    return {
      type: 'tool_call',
      ...normalizeToolIdentity(block.callId, block.name),
      arguments: parseToolArguments(block.arguments),
    }
  }
  if (block.type === 'tool_result') {
    if (role !== 'user' || typeof block.output !== 'string') {
      throw new ConversationManagerError('invalid_input', '工具结果必须属于 user')
    }
    if (block.output.length > MAX_MESSAGE_TEXT_LENGTH) {
      throw new ConversationManagerError('invalid_input', '工具结果过长')
    }
    if (block.isError !== undefined && typeof block.isError !== 'boolean') {
      throw new ConversationManagerError('invalid_input', '工具结果错误标记无效')
    }
    return {
      type: 'tool_result',
      ...normalizeToolIdentity(block.callId, block.name),
      output: block.output,
      ...(block.isError === undefined ? {} : { isError: block.isError }),
    }
  }
  throw new ConversationManagerError('invalid_input', '消息内容块类型无效')
}

function normalizeUsage(value: unknown): ChatTokenUsage | undefined {
  if (value === undefined) return undefined
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    throw new ConversationManagerError('invalid_input', '消息用量无效')
  }
  const source = value as Record<string, unknown>
  const usage: ChatTokenUsage = {}
  for (const key of USAGE_KEYS) {
    const count = source[key]
    if (count === undefined) continue
    if (!Number.isSafeInteger(count) || (count as number) < 0) {
      throw new ConversationManagerError('invalid_input', '消息用量必须是非负整数')
    }
    usage[key] = count as number
  }
  return usage
}

/** 统一校验消息内嵌附件元数据；只允许用户消息携带，二进制文件不在本层处理。 */
function normalizeMessageAttachments(
  role: ChatMessage['role'],
  value: unknown,
): FileAttachment[] | undefined {
  if (value === undefined) return undefined
  if (role !== 'user') {
    throw new ConversationManagerError('invalid_input', '附件只能属于用户消息')
  }
  if (!Array.isArray(value) || value.length === 0 || value.length > MAX_ATTACHMENTS_PER_MESSAGE) {
    throw new ConversationManagerError('invalid_input', '消息附件数量无效')
  }
  return value.map((item) => {
    if (!item || typeof item !== 'object' || Array.isArray(item)) {
      throw new ConversationManagerError('invalid_input', '消息附件元数据无效')
    }
    const attachment = item as Record<string, unknown>
    const id = normalizeOpaqueString(attachment.id, '附件 ID', 128)
    if (!id) {
      throw new ConversationManagerError('invalid_input', '消息附件元数据无效')
    }
    if (
      typeof attachment.filename !== 'string'
      || !attachment.filename.trim()
      || attachment.filename.length > MAX_ATTACHMENT_NAME_LENGTH
      || typeof attachment.mediaType !== 'string'
      || !attachment.mediaType
      || attachment.mediaType.length > 100
      || typeof attachment.size !== 'number'
      || !Number.isSafeInteger(attachment.size)
      || attachment.size < 0
      || typeof attachment.createdAt !== 'number'
      || !Number.isFinite(attachment.createdAt)
      || attachment.createdAt < 0
    ) {
      throw new ConversationManagerError('invalid_input', '消息附件元数据无效')
    }
    // localPath 只做形状防御（相对、无穿越、无空字节）；真正的访问仍被
    // AttachmentService 的解析入口限制在附件根目录内。
    const localPath = attachment.localPath
    if (
      typeof localPath !== 'string'
      || !localPath
      || localPath.length > 512
      || localPath.includes('\0')
      || localPath.startsWith('/')
      || localPath.startsWith('\\')
      || /^[A-Za-z]:[\\/]/.test(localPath)
      || localPath.split(/[\\/]/).includes('..')
    ) {
      throw new ConversationManagerError('invalid_input', '消息附件路径无效')
    }
    return {
      id,
      filename: attachment.filename,
      mediaType: attachment.mediaType,
      localPath,
      size: attachment.size,
      createdAt: attachment.createdAt,
    }
  })
}

/** 统一校验 IPC 输入和磁盘行，返回不共享引用的规范消息。 */
function normalizeMessage(value: unknown): ChatMessage {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    throw new ConversationManagerError('invalid_input', '消息必须是对象')
  }
  const message = value as Record<string, unknown>
  const id = normalizeId(message.id, '消息 ID')
  if (message.role !== 'user' && message.role !== 'assistant') {
    throw new ConversationManagerError('invalid_input', '消息角色无效')
  }
  const role = message.role
  if (
    typeof message.createdAt !== 'number'
    || !Number.isFinite(message.createdAt)
    || message.createdAt < 0
    || !MESSAGE_STATUSES.includes(message.status as ChatMessageStatus)
  ) {
    throw new ConversationManagerError('invalid_input', '消息时间或状态无效')
  }

  const status = message.status as ChatMessageStatus
  const finishReason = FINISH_REASONS.includes(message.finishReason as ChatFinishReason)
    ? message.finishReason as ChatFinishReason
    : undefined
  if (!Array.isArray(message.content)) {
    throw new ConversationManagerError('invalid_input', '消息内容格式无效')
  }
  // 停止、失败或内容过滤可能没有首个增量；其他完整消息与用户输入必须有正文。
  if (
    message.content.length === 0
    && (role === 'user' || (status === 'complete' && finishReason !== 'content_filter'))
  ) {
    throw new ConversationManagerError('invalid_input', '消息内容不能为空')
  }
  if (message.content.length > MAX_CHAT_CONTENT_BLOCKS) {
    throw new ConversationManagerError('too_large', '消息内容块过多')
  }
  const content = message.content.map((block) => normalizeContentBlock(role, block))
  const modelId = normalizeOptionalId(message.modelId, '模型 ID', 512)
  const usage = normalizeUsage(message.usage)
  const error = message.error === undefined
    ? undefined
    : normalizeOptionalId(message.error, '消息错误', MAX_ERROR_LENGTH)

  if (message.finishReason !== undefined && finishReason === undefined) {
    throw new ConversationManagerError('invalid_input', '消息结束原因无效')
  }
  const attachments = normalizeMessageAttachments(role, message.attachments)
  if (message.inputOrigin !== undefined && (role !== 'user' || message.inputOrigin !== 'quick')) {
    throw new ConversationManagerError('invalid_input', '消息来源标记无效')
  }
  if (role === 'user') {
    if (status !== 'complete' || modelId || finishReason || usage || error) {
      throw new ConversationManagerError('invalid_input', '用户消息不能包含生成结果字段')
    }
  } else if ((status === 'error') !== (error !== undefined)) {
    throw new ConversationManagerError('invalid_input', '错误消息必须包含稳定错误说明')
  }

  return {
    id,
    role,
    content,
    createdAt: message.createdAt,
    status,
    ...(message.inputOrigin === 'quick' ? { inputOrigin: 'quick' as const } : {}),
    ...(attachments === undefined ? {} : { attachments }),
    ...(modelId === undefined ? {} : { modelId }),
    ...(finishReason === undefined ? {} : { finishReason }),
    ...(usage === undefined ? {} : { usage }),
    ...(error === undefined ? {} : { error }),
  }
}

function normalizeMeta(value: unknown): ConversationMeta {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    throw new ConversationManagerError('invalid_input', '对话索引项无效')
  }
  const meta = value as Record<string, unknown>
  const id = normalizeId(meta.id, '对话 ID')
  const channelId = normalizeOptionalId(meta.channelId, '渠道 ID', 100)
  const modelId = normalizeOptionalId(meta.modelId, '模型 ID', 512)
  const rawSummary = meta.contextSummary
  const contextSummary = rawSummary && typeof rawSummary === 'object' && !Array.isArray(rawSummary)
    ? (() => {
        const value = rawSummary as Record<string, unknown>
        const text = typeof value.text === 'string' ? value.text.trim() : ''
        const coveredMessageIds = Array.isArray(value.coveredMessageIds)
          ? value.coveredMessageIds.filter((id): id is string => typeof id === 'string' && id.length > 0)
          : []
        const updatedAt = typeof value.updatedAt === 'number' && Number.isFinite(value.updatedAt) ? value.updatedAt : 0
        return text && coveredMessageIds.length > 0 ? { text, coveredMessageIds, updatedAt } : undefined
      })()
    : undefined
  if (
    typeof meta.createdAt !== 'number'
    || !Number.isFinite(meta.createdAt)
    || meta.createdAt < 0
    || typeof meta.updatedAt !== 'number'
    || !Number.isFinite(meta.updatedAt)
    || meta.updatedAt < meta.createdAt
  ) {
    throw new ConversationManagerError('invalid_input', '对话时间无效')
  }
  return {
    id,
    title: normalizeTitle(meta.title),
    ...(channelId === undefined ? {} : { channelId }),
    ...(modelId === undefined ? {} : { modelId }),
    ...(contextSummary === undefined ? {} : { contextSummary }),
    createdAt: meta.createdAt,
    updatedAt: meta.updatedAt,
  }
}

export class ConversationManager {
  private readonly indexPath: string
  private readonly messagesDir: string
  private readonly createId: () => string
  private readonly now: () => number

  constructor(options: ConversationManagerOptions) {
    this.indexPath = options.indexPath
    this.messagesDir = options.messagesDir
    this.createId = options.createId ?? randomUUID
    this.now = options.now ?? Date.now
    mkdirSync(dirname(this.indexPath), { recursive: true })
    mkdirSync(this.messagesDir, { recursive: true })
    if (process.platform !== 'win32') chmodSync(this.messagesDir, 0o700)
  }

  list(): ConversationMeta[] {
    return this.readIndex().conversations
      .map((conversation) => cloneJson(conversation))
      .sort((left, right) => right.updatedAt - left.updatedAt)
  }

  get(id: string): ConversationMeta | undefined {
    const normalizedId = normalizeId(id, '对话 ID')
    const meta = this.readIndex().conversations.find((item) => item.id === normalizedId)
    return meta ? cloneJson(meta) : undefined
  }

  create(input: ConversationCreateInput = {}): ConversationMeta {
    const index = this.readIndex()
    const timestamp = this.currentTimestamp()
    const channelId = normalizeOptionalId(input.channelId, '渠道 ID', 100)
    const modelId = normalizeOptionalId(input.modelId, '模型 ID', 512)
    const meta: ConversationMeta = {
      id: this.createUniqueId(index.conversations),
      title: normalizeTitle(input.title),
      ...(channelId === undefined ? {} : { channelId }),
      ...(modelId === undefined ? {} : { modelId }),
      createdAt: timestamp,
      updatedAt: timestamp,
    }
    index.conversations.push(meta)
    this.writeIndex(index)
    console.log(`[对话管理] 已创建对话: ${meta.title} (${meta.id})`)
    return cloneJson(meta)
  }

  update(id: string, input: ConversationUpdateInput): ConversationMeta {
    const normalizedId = normalizeId(id, '对话 ID')
    const index = this.readIndex()
    const position = index.conversations.findIndex((item) => item.id === normalizedId)
    if (position < 0) throw new ConversationManagerError('not_found', '对话不存在')
    const existing = index.conversations[position]!
    const channelId = input.channelId === undefined
      ? existing.channelId
      : normalizeOptionalId(input.channelId, '渠道 ID', 100)
    const modelId = input.modelId === undefined
      ? existing.modelId
      : normalizeOptionalId(input.modelId, '模型 ID', 512)
    const contextSummary = input.contextSummary === undefined
      ? existing.contextSummary
      : input.contextSummary === null ? undefined : input.contextSummary
    const updated: ConversationMeta = {
      id: existing.id,
      title: input.title === undefined ? existing.title : normalizeTitle(input.title),
      ...(channelId === undefined ? {} : { channelId }),
      ...(modelId === undefined ? {} : { modelId }),
      ...(contextSummary === undefined ? {} : { contextSummary }),
      createdAt: existing.createdAt,
      updatedAt: Math.max(existing.updatedAt, this.currentTimestamp()),
    }
    index.conversations[position] = updated
    this.writeIndex(index)
    console.log(`[对话管理] 已更新对话: ${updated.title} (${updated.id})`)
    return cloneJson(updated)
  }

  delete(id: string): ConversationMeta {
    const normalizedId = normalizeId(id, '对话 ID')
    const index = this.readIndex()
    const position = index.conversations.findIndex((item) => item.id === normalizedId)
    if (position < 0) throw new ConversationManagerError('not_found', '对话不存在')
    const [removed] = index.conversations.splice(position, 1)
    this.writeIndex(index)

    // 索引先落盘；消息及恢复副本清理失败只留下不可达孤儿文件。
    const messagePath = this.messagePath(normalizedId)
    for (const path of [messagePath, `${messagePath}.tmp`, `${messagePath}.corrupt`]) {
      if (!existsSync(path)) continue
      try { unlinkSync(path) } catch { console.warn(`[对话管理] 清理消息文件失败: ${normalizedId}`) }
    }
    console.log(`[对话管理] 已删除对话: ${removed!.title} (${removed!.id})`)
    return cloneJson(removed!)
  }

  getMessages(id: string): ChatMessage[] {
    const normalizedId = this.requireConversation(id)
    return this.readMessages(normalizedId).map((message) => cloneJson(message))
  }

  getRecentMessages(id: string, limit: number): RecentChatMessages {
    if (!Number.isSafeInteger(limit) || limit <= 0 || limit > 1000) {
      throw new ConversationManagerError('invalid_input', '最近消息数量必须位于 1 到 1000')
    }
    const messages = this.getMessages(id)
    return {
      messages: messages.slice(-limit),
      total: messages.length,
      hasMore: messages.length > limit,
    }
  }

  /** 原子重写 JSONL 后再更新时间；崩溃时旧文件或新文件至少有一份完整。 */
  appendMessage(id: string, value: ChatMessage): ChatMessage {
    const normalizedId = this.requireConversation(id)
    const message = normalizeMessage(value)
    const messages = this.readMessages(normalizedId)
    if (messages.some((item) => item.id === message.id)) {
      throw new ConversationManagerError('duplicate', '消息 ID 已存在')
    }
    if (messages.length >= MAX_MESSAGES) {
      throw new ConversationManagerError('too_large', '对话消息数量已达上限')
    }
    this.writeMessages(normalizedId, [...messages, message])
    this.touch(normalizedId)
    return cloneJson(message)
  }

  replaceMessages(id: string, values: readonly ChatMessage[]): ChatMessage[] {
    const normalizedId = this.requireConversation(id)
    if (!Array.isArray(values) || values.length > MAX_MESSAGES) {
      throw new ConversationManagerError('too_large', '对话消息数量已达上限')
    }
    const messages = values.map((value) => normalizeMessage(value))
    const ids = new Set<string>()
    for (const message of messages) {
      if (ids.has(message.id)) {
        throw new ConversationManagerError('duplicate', '消息 ID 不能重复')
      }
      ids.add(message.id)
    }
    this.writeMessages(normalizedId, messages)
    this.touch(normalizedId)
    return messages.map((message) => cloneJson(message))
  }

  private messagePath(id: string): string {
    return join(this.messagesDir, `${normalizeId(id, '对话 ID')}.jsonl`)
  }

  private requireConversation(id: string): string {
    const normalizedId = normalizeId(id, '对话 ID')
    if (!this.readIndex().conversations.some((item) => item.id === normalizedId)) {
      throw new ConversationManagerError('not_found', '对话不存在')
    }
    return normalizedId
  }

  /** 逐行隔离损坏记录；修复前保留原文件副本，避免静默销毁证据。 */
  private readMessages(id: string): ChatMessage[] {
    const path = this.messagePath(id)
    if (!existsSync(path)) return []
    try {
      if (statSync(path).size > MAX_MESSAGES_FILE_BYTES) {
        throw new ConversationManagerError('too_large', '对话消息文件过大')
      }
    } catch (error) {
      if (error instanceof ConversationManagerError) throw error
      throw new ConversationManagerError('storage_error', '读取对话消息失败')
    }

    let raw: string
    try {
      raw = readFileSync(path, 'utf-8')
    } catch {
      throw new ConversationManagerError('storage_error', '读取对话消息失败')
    }
    const messages: ChatMessage[] = []
    const ids = new Set<string>()
    let damaged = false
    for (const line of raw.split('\n')) {
      if (!line.trim()) continue
      try {
        const message = normalizeMessage(JSON.parse(line) as unknown)
        if (ids.has(message.id)) {
          damaged = true
          continue
        }
        ids.add(message.id)
        messages.push(message)
      } catch {
        damaged = true
      }
    }
    if (damaged) this.recoverMessages(path, messages)
    return messages
  }

  private recoverMessages(path: string, messages: readonly ChatMessage[]): void {
    try {
      copyFileSync(path, `${path}.corrupt`)
      if (process.platform !== 'win32') chmodSync(`${path}.corrupt`, 0o600)
      this.writeMessagesFile(path, messages)
      console.warn(`[对话管理] 已隔离损坏消息文件: ${path}`)
    } catch {
      console.error(`[对话管理] 消息文件自动恢复失败: ${path}`)
    }
  }

  private writeMessages(id: string, messages: readonly ChatMessage[]): void {
    try {
      this.writeMessagesFile(this.messagePath(id), messages)
    } catch (error) {
      if (error instanceof ConversationManagerError) throw error
      throw new ConversationManagerError('storage_error', '写入对话消息失败')
    }
  }

  private writeMessagesFile(path: string, messages: readonly ChatMessage[]): void {
    const content = messages.length === 0
      ? ''
      : `${messages.map((message) => JSON.stringify(message)).join('\n')}\n`
    if (new TextEncoder().encode(content).byteLength > MAX_MESSAGES_FILE_BYTES) {
      throw new ConversationManagerError('too_large', '对话消息文件过大')
    }
    writeTextFileAtomic(path, content, 0o600)
  }

  private touch(id: string): void {
    const index = this.readIndex()
    const position = index.conversations.findIndex((item) => item.id === id)
    if (position < 0) throw new ConversationManagerError('not_found', '对话不存在')
    index.conversations[position]!.updatedAt = Math.max(
      index.conversations[position]!.updatedAt,
      this.currentTimestamp(),
    )
    this.writeIndex(index)
  }

  private createUniqueId(conversations: readonly ConversationMeta[]): string {
    const ids = new Set(conversations.map((conversation) => conversation.id))
    for (let attempt = 0; attempt < 10; attempt += 1) {
      const id = this.createId()
      if (ID_PATTERN.test(id) && !ids.has(id)) return id
    }
    throw new ConversationManagerError('invalid_input', '无法生成唯一对话 ID')
  }

  private currentTimestamp(): number {
    const timestamp = this.now()
    if (!Number.isFinite(timestamp) || timestamp < 0) {
      throw new ConversationManagerError('invalid_input', '当前时间无效')
    }
    return timestamp
  }

  /** 读取时清洗索引并原子回写，坏条目不会拖垮其他会话。 */
  private readIndex(): ConversationsIndex {
    if (!existsSync(this.indexPath)) return { version: INDEX_VERSION, conversations: [] }
    const value = readJsonFileSafe<unknown>(this.indexPath)
    if (!value || typeof value !== 'object' || Array.isArray(value)) {
      return { version: INDEX_VERSION, conversations: [] }
    }
    const source = value as Record<string, unknown>
    const items = Array.isArray(source.conversations) ? source.conversations : []
    const conversations: ConversationMeta[] = []
    const ids = new Set<string>()
    for (const item of items) {
      try {
        const meta = normalizeMeta(item)
        if (ids.has(meta.id)) continue
        ids.add(meta.id)
        conversations.push(meta)
      } catch {
        // 单个坏索引项被隔离，其余会话仍可加载。
      }
    }
    const normalized = { version: INDEX_VERSION, conversations }
    if (
      source.version !== INDEX_VERSION
      || !Array.isArray(source.conversations)
      || conversations.length !== items.length
    ) {
      this.writeIndex(normalized)
      console.warn('[对话管理] 已清理无效或旧版会话索引')
    }
    return normalized
  }

  private writeIndex(index: ConversationsIndex): void {
    try {
      writeJsonFileAtomic(this.indexPath, index)
      if (process.platform !== 'win32') chmodSync(this.indexPath, 0o600)
    } catch {
      throw new ConversationManagerError('storage_error', '写入对话索引失败')
    }
  }
}
