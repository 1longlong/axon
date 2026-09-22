/** Agent 主进程事件总线：把编排结果投影给后续 IPC，监听器失败不反向打断运行。 */

import type { AgentGenerationEvent } from '@axon/shared'

/** 主进程旧名称保留为共享事件的别名，避免服务测试重复声明协议。 */
export type AgentServiceEvent = AgentGenerationEvent
export type AgentEventListener = (event: AgentGenerationEvent) => void

export class AgentEventBus {
  private readonly listeners = new Set<AgentEventListener>()

  subscribe(listener: AgentEventListener): () => void {
    this.listeners.add(listener)
    return () => this.listeners.delete(listener)
  }

  /** 广播运行事件；UI/IPC 消费失败只能记日志，不能破坏 Agent 与持久化主链。 */
  emit(event: AgentGenerationEvent): void {
    for (const listener of this.listeners) {
      try {
        listener(event)
      } catch {
        console.warn('[Agent 事件] 监听器处理失败')
      }
    }
  }
}
