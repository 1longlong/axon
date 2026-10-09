/** Chat 输入校验、可信客户端所有权与生成生命周期协调。 */

import type {
  ChatGenerationEvent,
  ChatSendInput,
  ChatSendResult,
  ConversationCreateInput,
  ConversationUpdateInput,
  BackendClientId,
  BackendChatGeneration,
  ChatGenerationIdentityEvent,
} from '@axon/shared'
import { ChatServiceError } from './chat-service'
import type { ChatService } from './chat-service'
import type { AttachmentService } from './attachment-service'
import type { ConversationManager } from './conversation-manager'
import type { BackendClientRegistry } from '../backend-client-registry'
import { AsyncWorkTracker } from '../async/async-work-tracker'

export interface ChatRunCoordinatorOptions {
  clients: Pick<BackendClientRegistry, 'has' | 'subscribeDetached'>
  conversations: Pick<
    ConversationManager,
    'list' | 'get' | 'create' | 'update' | 'delete' | 'getMessages'
  >
  chat: Pick<ChatService, 'sendMessage' | 'stopGeneration' | 'isActive' | 'getActiveGeneration'>
  /** 可选的附件清理依赖；注入后会话删除时级联清理附件目录。 */
  attachments?: Pick<AttachmentService, 'deleteConversationAttachments'>
}

interface GenerationOwner {
  owner: BackendClientId
}

function invalid(): never {
  throw new ChatServiceError('invalid_input', 'Chat 请求格式无效')
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

export class ChatRunCoordinator {
  private readonly work = new AsyncWorkTracker()
  private readonly owners = new Map<string, GenerationOwner>()
  private readonly unsubscribeClients: () => void
  private disposed = false

  /** 注销入口时停止它的生成；transport 不直接触碰 Provider 或请求控制器。 */
  constructor(private readonly options: ChatRunCoordinatorOptions) {
    this.unsubscribeClients = options.clients.subscribeDetached((id) => this.cancelOwner(id))
  }

  /** 返回所属入口的实际 generationId，包括凭据预检期，不暴露 AbortController。 */
  getOwnedGeneration(owner: BackendClientId, conversationId: string): BackendChatGeneration | undefined {
    return !this.disposed && this.options.clients.has(owner) && this.owners.get(conversationId)?.owner === owner
      ? this.options.chat.getActiveGeneration(conversationId) : undefined
  }

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
      console.warn(`[Chat 协调] 清理会话附件失败: ${conversationId}`)
    }
    return meta
  }

  getMessages(id: unknown) {
    return this.options.conversations.getMessages(parseId(id))
  }

  /**
   * 可信 owner 在生成前登记；只回送真实会话事件，断开丢弃迟到投递，所有错误转为稳定结果。
   */
  send(
    owner: BackendClientId,
    value: unknown,
    emit: (event: ChatGenerationEvent) => void,
    inputOrigin?: 'quick',
    identitySink?: (event: ChatGenerationIdentityEvent) => void,
  ): Promise<ChatSendResult> {
    return this.work.run(() => this.executeSend(owner, value, emit, inputOrigin, identitySink))
  }

  /** 等待完整生成及其 finally；Provider 完成不代表 owner 已经释放。 */
  private async executeSend(
    owner: BackendClientId,
    value: unknown,
    emit: (event: ChatGenerationEvent) => void,
    inputOrigin: 'quick' | undefined,
    identitySink: ((event: ChatGenerationIdentityEvent) => void) | undefined,
  ): Promise<ChatSendResult> {
    let input: ChatSendInput
    try {
      input = parseSendInput(value)
    } catch (error) {
      return failed(error)
    }
    if (this.disposed || !this.options.clients.has(owner)) {
      return failed(new ChatServiceError('invalid_input', '生成客户端未登记或已断开'))
    }
    const conversationId = input.conversationId.trim()
    if (this.owners.has(conversationId) || this.options.chat.isActive(conversationId)) {
      return failed(new ChatServiceError('already_active', '该对话正在生成'))
    }

    const ownership: GenerationOwner = { owner }
    this.owners.set(conversationId, ownership)
    try {
      const message = await this.options.chat.sendMessage(input, (event) => {
        if (this.disposed || !this.options.clients.has(owner) || event.conversationId !== conversationId) return
        // 标题可能晚于生成 finally 返回；它不属于生成流，不能要求仍占用该轮 owner。
        if (event.type !== 'title' && this.owners.get(conversationId) !== ownership) return
        emit(event)
      }, inputOrigin, (event) => {
        if (this.disposed || !this.options.clients.has(owner) || this.owners.get(conversationId) !== ownership) return
        identitySink?.(event)
      })
      return { success: true, message }
    } catch (error) {
      return failed(error)
    } finally {
      // 对象身份防止旧请求的 finally 清掉同窗口未来重新开始的生成。
      if (this.owners.get(conversationId) === ownership) this.owners.delete(conversationId)
    }
  }

  /** 只有发起生成的 renderer 可以停止该对话，其他窗口无法越权取消。 */
  stop(owner: BackendClientId, id: unknown): boolean {
    if (this.disposed || !this.options.clients.has(owner)) return false
    let conversationId: string
    try {
      conversationId = parseId(id)
    } catch {
      return false
    }
    if (this.owners.get(conversationId)?.owner !== owner) return false
    return this.options.chat.stopGeneration(conversationId)
  }

  /** 新后端停止必须命中实际轮次；旧 generationId 不能取消同会话的新生成。 */
  stopGeneration(owner: BackendClientId, value: unknown): boolean {
    if (!value || typeof value !== 'object' || Array.isArray(value)) return false
    const input = value as Record<string, unknown>
    if (Object.keys(input).some((key) => !['conversationId', 'generationId'].includes(key))) return false
    if (typeof input.conversationId !== 'string' || typeof input.generationId !== 'string') return false
    const run = this.getOwnedGeneration(owner, input.conversationId)
    return run?.generationId === input.generationId && this.stop(owner, input.conversationId)
  }

  /** renderer 销毁或重载时取消它拥有的全部请求，避免事件投递到失效窗口。 */
  cancelOwner(owner: BackendClientId): number {
    const conversationIds = [...this.owners]
      .filter(([, currentOwner]) => currentOwner.owner === owner)
      .map(([conversationId]) => conversationId)
    let cancelled = 0
    const failures: unknown[] = []
    for (const conversationId of conversationIds) {
      try { if (this.options.chat.stopGeneration(conversationId)) cancelled += 1 }
      catch (error) { failures.push(error) }
    }
    if (failures.length) throw new AggregateError(failures, 'Chat 客户端生成清理失败')
    return cancelled
  }

  /** 同步发出停止并断开订阅，完整 Provider/标题 drain 留给后端退出生命周期。 */
  dispose(): void {
    if (this.disposed) return
    this.disposed = true
    this.unsubscribeClients()
    const failures: unknown[] = []
    for (const owner of new Set([...this.owners.values()].map((run) => run.owner))) {
      try { this.cancelOwner(owner) } catch (error) { failures.push(error) }
    }
    if (failures.length) throw new AggregateError(failures, 'Chat 协调资源清理失败')
  }

  /** 等待已登记发送真实退出并清掉 owner，不包括独立后台标题。 */
  drain(): Promise<void> { return this.work.drain() }
}
