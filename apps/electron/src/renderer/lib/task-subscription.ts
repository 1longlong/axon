/** Task 观察先装事件再登记；响应前的有界事件按最终服务端代次重放。 */
import type { AgentTaskEvent, AgentTaskSubscription, AgentTaskSubscriptionEvent } from '@axon/shared'

export interface TaskSubscriptionApi {
  subscribe(): Promise<AgentTaskSubscription>
  unsubscribe(subscriptionId: string): Promise<boolean>
  onEvent(listener: (event: AgentTaskSubscriptionEvent) => void): () => void
}
export interface TaskObservation { ready: Promise<void>; dispose(): void }

/** 未知交付不重投；卸载后的迟到登记只取消原代次，不查询或取消“当前订阅”。 */
export function observeTasks(api: TaskSubscriptionApi, consume: (event: AgentTaskEvent) => void): TaskObservation {
  let active = true, subscription: AgentTaskSubscription | undefined, bytes = 0, overflow = false
  const early: AgentTaskSubscriptionEvent[] = []
  const release = (id: string): void => { void api.unsubscribe(id).catch(() => {}) }
  const unlink = api.onEvent((packet) => {
    if (!active) return
    if (subscription) {
      if (packet.subscriptionId === subscription.subscriptionId) consume(packet.event)
      return
    }
    // 不静默丢 delta，也不无限积压大结果；超限明确失败并释放已知原代次。
    if (overflow) return
    bytes += JSON.stringify(packet).length * 2
    if (early.length >= 128 || bytes > 1024 * 1024) { overflow = true; early.length = 0; return }
    early.push(packet)
  })
  const ready = (async () => {
    try {
      const current = await api.subscribe()
      if (!active) { release(current.subscriptionId); return }
      subscription = current
      if (overflow) { release(current.subscriptionId); subscription = undefined; throw new Error('Task 订阅初始化积压过多') }
      for (const packet of early) {
        if (!active) break
        if (packet.subscriptionId === current.subscriptionId) consume(packet.event)
      }
      early.length = 0
    } catch (error) {
      active = false; early.length = 0; unlink()
      if (subscription) { release(subscription.subscriptionId); subscription = undefined }
      throw error
    }
  })()
  // 页面尚未读取任何根任务时也不能产生未处理的拒绝；调用者仍 await 原 ready。
  void ready.catch(() => {})
  return { ready, dispose: () => {
    if (!active) return
    active = false; early.length = 0; unlink()
    if (subscription) { release(subscription.subscriptionId); subscription = undefined }
  } }
}
