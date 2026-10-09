/** 应用中立历史的分页契约；游标只标识后端快照，不接受文件路径或 Runtime artifact。 */
import type { SDKMessage } from './agent'
import type { ChatMessage } from './chat'

export interface AgentHistoryScope { kind: 'agent'; sessionId: string }
export interface ChatHistoryScope { kind: 'chat'; conversationId: string }
export interface TaskHistoryScope { kind: 'task'; rootSessionId: string; taskId: string }
export type MessageHistoryScope = AgentHistoryScope | ChatHistoryScope | TaskHistoryScope
export interface MessageHistoryReadInput {
  scope: MessageHistoryScope
  historyId?: string
  cursor?: string
}
export interface MessageHistoryPage<T = SDKMessage | ChatMessage> {
  historyId: string
  messages: T[]
  /** null 表示已完整读到快照末尾，不表示只恢复最近消息。 */
  cursor: string | null
}

export const MESSAGE_HISTORY_PAGE_MESSAGES = 100
export const MESSAGE_HISTORY_PAGE_BYTES = 1024 * 1024
