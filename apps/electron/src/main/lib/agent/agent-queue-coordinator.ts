/** Agent 同会话 deferred queue；消息仅在主进程内存中等待下一轮派发。 */

import { randomUUID } from 'node:crypto'
import type {
  AgentMoveQueuedMessageInput,
  AgentQueuedMessage,
  AgentQueuedMessageControlInput,
  AgentSendInput,
} from '@axon/shared'

const DEFAULT_MAX_QUEUE_LENGTH = 50

export interface AgentQueueCoordinatorOptions {
  createId?: () => string
  now?: () => number
  maxQueueLength?: number
}

export class AgentQueueCoordinator {
  private readonly queues = new Map<string, AgentQueuedMessage[]>()
  private readonly createId: () => string
  private readonly now: () => number
  private readonly maxQueueLength: number

  constructor(options: AgentQueueCoordinatorOptions = {}) {
    this.createId = options.createId ?? randomUUID
    this.now = options.now ?? Date.now
    this.maxQueueLength = options.maxQueueLength ?? DEFAULT_MAX_QUEUE_LENGTH
  }

  /** 接管一条等待消息；达到会话上限时返回 null，调用方不得假装已接受。 */
  enqueue(input: AgentSendInput): AgentQueuedMessage | null {
    const queue = this.queues.get(input.sessionId) ?? []
    if (queue.length >= this.maxQueueLength) return null
    const message: AgentQueuedMessage = {
      id: this.createId(),
      sessionId: input.sessionId,
      text: input.text,
      createdAt: this.now(),
    }
    queue.push(message)
    this.queues.set(input.sessionId, queue)
    return message
  }

  /** 取出下一条后立即从等待队列移除；下游失败时由本轮终态表达，不重复执行。 */
  dequeue(sessionId: string): AgentQueuedMessage | undefined {
    const queue = this.queues.get(sessionId)
    const message = queue?.shift()
    if (queue?.length === 0) this.queues.delete(sessionId)
    return message
  }

  list(sessionId: string): AgentQueuedMessage[] {
    return [...(this.queues.get(sessionId) ?? [])]
  }

  cancel(input: AgentQueuedMessageControlInput): boolean {
    const queue = this.queues.get(input.sessionId)
    const index = queue?.findIndex((message) => message.id === input.messageId) ?? -1
    if (!queue || index < 0) return false
    queue.splice(index, 1)
    if (queue.length === 0) this.queues.delete(input.sessionId)
    return true
  }

  /** 相对目标消息调整顺序；source/target 任一已离队时拒绝操作。 */
  move(input: AgentMoveQueuedMessageInput): boolean {
    const queue = this.queues.get(input.sessionId)
    if (!queue || input.sourceId === input.targetId) return false
    const sourceIndex = queue.findIndex((message) => message.id === input.sourceId)
    const targetIndex = queue.findIndex((message) => message.id === input.targetId)
    if (sourceIndex < 0 || targetIndex < 0) return false
    const [source] = queue.splice(sourceIndex, 1)
    if (!source) return false
    const adjustedTarget = queue.findIndex((message) => message.id === input.targetId)
    const insertIndex = input.placement === 'after' ? adjustedTarget + 1 : adjustedTarget
    queue.splice(insertIndex, 0, source)
    return true
  }

  clear(sessionId: string): number {
    const count = this.queues.get(sessionId)?.length ?? 0
    this.queues.delete(sessionId)
    return count
  }
}
