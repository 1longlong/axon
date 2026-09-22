/** Chat IPC 的纯逻辑边界：校验不可信负载并隔离各 renderer 的生成所有权。 */

import type {
  ChatGenerationEvent,
  ChatSendInput,
  ChatSendResult,
  ConversationCreateInput,
  ConversationUpdateInput,
} from '@axon/shared'
import { ChatServiceError } from './chat-service'
import type { ChatService } from './chat-service'
import type { AttachmentService } from './attachment-service'
import type { ConversationManager } from './conversation-manager'

export interface ChatIpcControllerOptions {
  conversations: Pick<
    ConversationManager,
    'list' | 'get' | 'create' | 'update' | 'delete' | 'getMessages'
  >
  chat: Pick<ChatService, 'sendMessage' | 'stopGeneration' | 'isActive'>
  /** 可选的附件清理依赖；注入后会话删除时级联清理附件目录。 */
  attachments?: Pick<AttachmentService, 'deleteConversationAttachments'>
}

interface GenerationOwner {
  owner: number
}

function invalid(): never {
  throw new ChatServiceError('invalid_input', 'Chat IPC 请求格式无效')
}

function parseId(value: unknown): string {
  if (typeof value !== 'string' || !value.trim()) return invalid()
  return value.trim()
}

function parseConversationInput(
  value: unknown,
  allowNull: boolean,
): ConversationCreateInput | ConversationUpdateInput {
  if (value === undefined && !allowNull) return {}
  if (!value || typeof value !== 'object' || Array.isArray(value)) return invalid()
  const input = value as Record<string, unknown>
  const allowed = ['title', 'channelId', 'modelId']
  if (Object.keys(input).some((key) => !allowed.includes(key))) return invalid()
  if (input.title !== undefined && typeof input.title !== 'string') return invalid()
  for (const key of ['channelId', 'modelId']) {
    if (
      input[key] !== undefined
      && typeof input[key] !== 'string'
      && !(allowNull && input[key] === null)
    ) return invalid()
  }
  return input as ConversationCreateInput | ConversationUpdateInput
}

function parseSendInput(value: unknown): ChatSendInput {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return invalid()
  const input = value as Record<string, unknown>
  const allowed = ['conversationId', 'text', 'attachments', 'maxOutputTokens', 'temperature']
  if (Object.keys(input).some((key) => !allowed.includes(key))) return invalid()
  if (typeof input.conversationId !== 'string' || typeof input.text !== 'string') return invalid()
  if (input.maxOutputTokens !== undefined && typeof input.maxOutputTokens !== 'number') return invalid()
  if (input.temperature !== undefined && typeof input.temperature !== 'number') return invalid()
  // 附件只做数组形状检查；成员结构与数量上限由 ChatService 在落盘前统一校验。
  if (input.attachments !== undefined) {
    if (!Array.isArray(input.attachments)) return invalid()
    if (input.attachments.some((item) => !item || typeof item !== 'object' || Array.isArray(item))) return invalid()
  }
  return input as unknown as ChatSendInput
}

function failed(error: unknown): ChatSendResult {
  if (error instanceof ChatServiceError) {
    return { success: false, code: error.code, message: error.message }
  }
  return { success: false, code: 'internal_error', message: 'Chat 请求失败' }
}

export class ChatIpcController {
  private readonly owners = new Map<string, GenerationOwner>()

  constructor(private readonly options: ChatIpcControllerOptions) {}

  listConversations() {
    return this.options.conversations.list()
  }

  getConversation(value: unknown) {
    return this.options.conversations.get(parseId(value)) ?? null
  }

  createConversation(value: unknown) {
    return this.options.conversations.create(
      parseConversationInput(value, false) as ConversationCreateInput,
    )
  }

  updateConversation(id: unknown, value: unknown) {
    return this.options.conversations.update(
      parseId(id),
      parseConversationInput(value, true) as ConversationUpdateInput,
    )
  }

  deleteConversation(id: unknown) {
    const conversationId = parseId(id)
    if (this.options.chat.isActive(conversationId)) {
      throw new ChatServiceError('already_active', '生成期间不能删除对话')
    }
    const meta = this.options.conversations.delete(conversationId)
    // 会话删除成功后级联清理附件目录；清理失败只留下孤儿文件并记录警告，
    // 不能让删除结果失败或回滚——会话索引与 JSONL 已经删除。
    try {
      this.options.attachments?.deleteConversationAttachments(conversationId)
    } catch {
      console.warn(`[Chat IPC] 清理会话附件失败: ${conversationId}`)
    }
    return meta
  }

  getMessages(id: unknown) {
    return this.options.conversations.getMessages(parseId(id))
  }

  /**
   * renderer owner 在生成开始前登记，事件只回送给发起者；所有错误转为稳定结果。
   */
  async send(
    owner: number,
    value: unknown,
    emit: (event: ChatGenerationEvent) => void,
    inputOrigin?: 'quick',
  ): Promise<ChatSendResult> {
    let input: ChatSendInput
    try {
      input = parseSendInput(value)
    } catch (error) {
      return failed(error)
    }
    const conversationId = input.conversationId.trim()
    if (this.owners.has(conversationId) || this.options.chat.isActive(conversationId)) {
      return failed(new ChatServiceError('already_active', '该对话正在生成'))
    }

    const ownership: GenerationOwner = { owner }
    this.owners.set(conversationId, ownership)
    try {
      const message = await this.options.chat.sendMessage(input, emit, inputOrigin)
      return { success: true, message }
    } catch (error) {
      return failed(error)
    } finally {
      // 对象身份防止旧请求的 finally 清掉同窗口未来重新开始的生成。
      if (this.owners.get(conversationId) === ownership) this.owners.delete(conversationId)
    }
  }

  /** 只有发起生成的 renderer 可以停止该对话，其他窗口无法越权取消。 */
  stop(owner: number, id: unknown): boolean {
    let conversationId: string
    try {
      conversationId = parseId(id)
    } catch {
      return false
    }
    if (this.owners.get(conversationId)?.owner !== owner) return false
    return this.options.chat.stopGeneration(conversationId)
  }

  /** renderer 销毁或重载时取消它拥有的全部请求，避免事件投递到失效窗口。 */
  cancelOwner(owner: number): number {
    const conversationIds = [...this.owners]
      .filter(([, currentOwner]) => currentOwner.owner === owner)
      .map(([conversationId]) => conversationId)
    let cancelled = 0
    for (const conversationId of conversationIds) {
      if (this.options.chat.stopGeneration(conversationId)) cancelled += 1
    }
    return cancelled
  }
}
