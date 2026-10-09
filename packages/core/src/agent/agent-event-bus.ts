/** Agent 中立事件总线：把编排结果交给订阅者，监听器失败不反向打断运行。 */

import type { AgentGenerationEvent, BackendOwnedRun } from '@axon/shared'

export type AgentEventListener = (event: AgentGenerationEvent, run?: BackendOwnedRun) => void

export class AgentEventBus {
  private readonly listeners = new Set<AgentEventListener>()

  subscribe(listener: AgentEventListener): () => void {
    this.listeners.add(listener)
    return () => this.listeners.delete(listener)
  }

  /** 广播事件及执行层提供的真实身份；元数据不附轮次，消费者失败不破坏持久化主链。 */
  emit(event: AgentGenerationEvent, run?: BackendOwnedRun): void {
    for (const listener of this.listeners) {
      try {
        listener(event, run)
      } catch {
        console.warn('[Agent 事件] 监听器处理失败')
      }
    }
  }
}
