/** 历史快照归 core 管理；协议只传会话范围、随机快照标识和顺序游标。 */
import { randomUUID } from 'node:crypto'
import type { ChatMessage, MessageHistoryPage, MessageHistoryReadInput, MessageHistoryScope, SDKMessage } from '@axon/shared'
import type { BackendClientRegistry } from '../backend-client-registry'
import type { AgentSessionManager } from '../agent/agent-session-manager'
import type { ConversationManager } from '../chat/conversation-manager'
import type { AgentTaskController } from '../collaboration/agent-task-controller'
import type { JsonlHistoryReader } from './jsonl-history-reader'

export interface MessageHistoryControllerOptions {
  clients: Pick<BackendClientRegistry, 'has' | 'subscribeDetached'>
  sessions: Pick<AgentSessionManager, 'get' | 'openMessageHistory'>
  conversations: Pick<ConversationManager, 'get' | 'openMessageHistory'>
  tasks: Pick<AgentTaskController, 'get'>
  /** 内部宿主配置，不接受客户端覆盖；每页使用后刷新空闲期限。 */
  idleTimeoutMs?: number
}
export class MessageHistoryControllerError extends Error {
  constructor(readonly code: 'invalid_input' | 'not_found' | 'unavailable' | 'limit' | 'stale_cursor', message: string) {
    super(message)
    this.name = 'MessageHistoryControllerError'
  }
}
interface HistorySnapshot {
  owner: string
  scope: MessageHistoryScope
  reader: JsonlHistoryReader<SDKMessage | ChatMessage>
  cursor?: string
  lastCursor?: string
  page?: MessageHistoryPage
  timer?: ReturnType<typeof setTimeout>
}
function object(value: unknown, fields: readonly string[]): Record<string, unknown> {
  if (!value || typeof value !== 'object' || Array.isArray(value) || Object.keys(value).some((key) => !fields.includes(key))) {
    throw new MessageHistoryControllerError('invalid_input', '历史查询参数无效')
  }
  return value as Record<string, unknown>
}
function id(value: unknown): string {
  if (typeof value !== 'string' || !/^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/.test(value.trim())) {
    throw new MessageHistoryControllerError('invalid_input', '历史查询标识无效')
  }
  return value.trim()
}
function parseScope(value: unknown): MessageHistoryScope {
  const kind = object(value, ['kind', 'sessionId', 'conversationId', 'rootSessionId', 'taskId']).kind
  if (kind === 'agent') { const scope = object(value, ['kind', 'sessionId']); return { kind, sessionId: id(scope.sessionId) } }
  if (kind === 'chat') { const scope = object(value, ['kind', 'conversationId']); return { kind, conversationId: id(scope.conversationId) } }
  if (kind === 'task') { const scope = object(value, ['kind', 'rootSessionId', 'taskId']); return { kind, rootSessionId: id(scope.rootSessionId), taskId: id(scope.taskId) } }
  throw new MessageHistoryControllerError('invalid_input', '历史查询范围无效')
}
function parseInput(value: unknown): MessageHistoryReadInput {
  const input = object(value, ['scope', 'historyId', 'cursor'])
  if ((input.historyId === undefined) !== (input.cursor === undefined)) throw new MessageHistoryControllerError('invalid_input', '历史游标不完整')
  return { scope: parseScope(input.scope), ...(input.historyId === undefined ? {} : { historyId: id(input.historyId), cursor: id(input.cursor) }) }
}

export class MessageHistoryController {
  private readonly histories = new Map<string, HistorySnapshot>()
  private readonly unsubscribeClients: () => void
  private readonly idleTimeoutMs: number
  private disposed = false

  constructor(private readonly options: MessageHistoryControllerOptions) {
    this.idleTimeoutMs = options.idleTimeoutMs ?? 120_000
    if (!Number.isSafeInteger(this.idleTimeoutMs) || this.idleTimeoutMs <= 0) throw new Error('历史空闲期限无效')
    this.unsubscribeClients = options.clients.subscribeDetached((owner) => {
      for (const [historyId, snapshot] of this.histories) if (snapshot.owner === owner) this.release(historyId)
    })
  }

  /** 初次打开固定文件，续页复核 owner/范围；缓存最近一页，响应丢失时同游标可重读。 */
  read(owner: string, value: unknown, signal?: AbortSignal): MessageHistoryPage {
    signal?.throwIfAborted()
    if (this.disposed || !this.options.clients.has(owner)) throw new MessageHistoryControllerError('unavailable', '历史读取入口不可用')
    const input = parseInput(value)
    let historyId = input.historyId
    let snapshot = historyId ? this.histories.get(historyId) : undefined
    if (historyId && (!snapshot || snapshot.owner !== owner || JSON.stringify(snapshot.scope) !== JSON.stringify(input.scope))) {
      throw new MessageHistoryControllerError('not_found', '历史快照不存在')
    }
    try {
      const sessionId = this.requireScope(input.scope)
      if (!snapshot) {
        if (this.histories.size >= 32 || [...this.histories.values()].filter((item) => item.owner === owner).length >= 4) {
          throw new MessageHistoryControllerError('limit', '历史快照数量已达上限')
        }
        const reader = input.scope.kind === 'chat' ? this.options.conversations.openMessageHistory(input.scope.conversationId)
          : this.options.sessions.openMessageHistory(sessionId!)
        historyId = randomUUID()
        snapshot = { owner, scope: input.scope, reader }
        this.histories.set(historyId, snapshot)
      } else if (input.cursor === snapshot.lastCursor && snapshot.page) {
        this.refresh(historyId!, snapshot)
        return structuredClone(snapshot.page)
      } else if (input.cursor !== snapshot.cursor || !snapshot.cursor) {
        throw new MessageHistoryControllerError('stale_cursor', '历史游标已失效')
      }
      const result = snapshot.reader.readPage()
      signal?.throwIfAborted()
      snapshot.lastCursor = input.cursor
      snapshot.cursor = result.done ? undefined : randomUUID()
      snapshot.page = { historyId: historyId!, messages: result.messages, cursor: snapshot.cursor ?? null }
      this.refresh(historyId!, snapshot)
      return structuredClone(snapshot.page)
    } catch (error) {
      // 范围删除、存储错误或取消先关闭旧文件；错误游标不销毁仍可合法使用的快照。
      if (historyId && !(error instanceof MessageHistoryControllerError && error.code === 'stale_cursor')) this.release(historyId)
      throw error
    }
  }

  /** 只允许原入口释放快照；不知道初次响应 ID 的遗留快照由空闲期限回收。 */
  close(owner: string, value: unknown): boolean {
    const historyId = id(value)
    if (this.histories.get(historyId)?.owner !== owner) return false
    this.release(historyId)
    return true
  }
  private requireScope(scope: MessageHistoryScope): string | undefined {
    if (scope.kind === 'chat') {
      if (this.options.conversations.get(scope.conversationId)) return undefined
    } else if (scope.kind === 'agent') {
      if (this.options.sessions.get(scope.sessionId)) return scope.sessionId
    } else {
      const task = this.options.tasks.get(scope.rootSessionId, scope.taskId)
      if (task && this.options.sessions.get(task.childSessionId)) return task.childSessionId
    }
    throw new MessageHistoryControllerError('not_found', '历史会话或任务不存在')
  }
  private refresh(historyId: string, snapshot: HistorySnapshot): void {
    clearTimeout(snapshot.timer)
    snapshot.timer = setTimeout(() => this.release(historyId), this.idleTimeoutMs)
    snapshot.timer.unref()
  }
  private release(historyId: string): void {
    const snapshot = this.histories.get(historyId)
    if (!snapshot) return
    this.histories.delete(historyId)
    clearTimeout(snapshot.timer)
    try { snapshot.reader.close() } catch { console.warn('[历史快照] 句柄释放失败') }
  }
  /** 后端退出不保留分页缓存；所有身份、游标与文件句柄仅存在内存。 */
  dispose(): void {
    if (this.disposed) return
    this.disposed = true
    this.unsubscribeClients()
    for (const historyId of this.histories.keys()) this.release(historyId)
  }
}
