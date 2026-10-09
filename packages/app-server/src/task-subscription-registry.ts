/** Task 协议与桌面入口共用的精确订阅代次，不持有运行控制权。 */
import { randomUUID } from 'node:crypto'
import type { AgentTaskEvent, AgentTaskSubscription, AgentTaskSubscriptionEvent } from '@axon/shared'
import { RpcFault } from './json-rpc-peer'

interface TaskRoute extends AgentTaskSubscription { release: () => void }

export class TaskSubscriptionRegistry {
  private readonly routes = new Map<string, TaskRoute>()
  private closed = false

  /** 替换先失效旧代次；同步装配中注销或迟到回调也不能复活订阅。 */
  subscribe(clientId: string, connect: (listener: (event: AgentTaskEvent) => void) => () => void,
    isActive: () => boolean, deliver: (event: AgentTaskSubscriptionEvent) => void): AgentTaskSubscription {
    if (this.closed) throw new RpcFault(-32004, '子任务订阅入口已断开')
    this.detach(clientId)
    const route: TaskRoute = { subscriptionId: randomUUID(), release: () => {} }
    this.routes.set(clientId, route)
    try {
      route.release = connect((event) => {
        if (this.routes.get(clientId) === route && isActive()) deliver({ subscriptionId: route.subscriptionId, event })
      })
      if (this.routes.get(clientId) !== route || !isActive()) {
        if (this.routes.get(clientId) === route) this.detach(clientId)
        else route.release()
        throw new RpcFault(-32004, '子任务订阅入口已断开')
      }
    } catch (error) { if (this.routes.get(clientId) === route) this.detach(clientId); throw error }
    return { subscriptionId: route.subscriptionId }
  }

  /** 取消只能命中同一入口的当前代次；旧页面/旧响应不会移除新的投影。 */
  unsubscribe(clientId: string, subscriptionId: string): boolean {
    if (this.routes.get(clientId)?.subscriptionId !== subscriptionId) return false
    this.detach(clientId)
    return true
  }
  /** 先移除代次再清理上游，清理失败不复活旧事件或阻断其他入口。 */
  detach(clientId: string): void {
    const route = this.routes.get(clientId)
    if (!route) return
    this.routes.delete(clientId)
    try { route.release() } catch { console.warn('[子任务协议] 订阅清理失败') }
  }
  close(): void {
    if (this.closed) return
    this.closed = true
    for (const clientId of [...this.routes.keys()]) this.detach(clientId)
  }
}
