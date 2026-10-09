/** 监听代次与资源归属；桌面切换前入口和独立协议共用，不包含文件读取或业务保存。 */
import { randomUUID } from 'node:crypto'
import type { AgentMemoryChangedEvent, AgentProjectWatchClosedEvent, AgentProjectWatchSubscription, AgentProjectWatchTarget } from '@axon/shared'
import { RpcFault } from './json-rpc-peer'
import { configObject } from './config-input'

export function parseProjectWatchId(value: unknown): string {
  if (typeof value !== 'string' || !value.trim() || value.length > 200) throw new RpcFault(-32602, '项目订阅标识无效')
  return value.trim()
}

/** IPC 与 RPC 均拒绝只带项目 ID 或自报 kind/owner 的取消请求。 */
export function parseProjectWatchTarget(value: unknown): AgentProjectWatchTarget {
  const input = configObject(value, ['projectId', 'subscriptionId'])
  return { projectId: parseProjectWatchId(input.projectId), subscriptionId: parseProjectWatchId(input.subscriptionId) }
}

type WatchKind = AgentProjectWatchSubscription['kind']
interface ProjectWatchCallbacks {
  start(emit: (changedAt: number, relativePath?: string) => void): void
  release(): void
  changed(event: AgentMemoryChangedEvent): void
  closed(event: AgentProjectWatchClosedEvent): void
}
interface ProjectWatch extends AgentProjectWatchSubscription {
  clientId: string
  callbacks: ProjectWatchCallbacks
}
const MAX_PROJECT_SUBSCRIPTIONS = 128

export class ProjectWatchRegistry {
  private readonly watches = new Map<string, ProjectWatch>()
  private disposed = false

  /** 先保存新代次再启动句柄；替换、同步回调及启动失败都不能复活旧监听。 */
  watch(clientId: string, kind: WatchKind, projectId: string, callbacks: ProjectWatchCallbacks): AgentProjectWatchSubscription {
    if (this.disposed) throw new RpcFault(-32001, '项目订阅已关闭')
    const key = this.key(clientId, kind, projectId)
    if (!this.watches.has(key) && [...this.watches.values()].filter((watch) => watch.clientId === clientId).length >= MAX_PROJECT_SUBSCRIPTIONS) {
      throw new RpcFault(-32001, '项目订阅数量超过限制')
    }
    this.release(key)
    const subscriptionId = randomUUID()
    const route: ProjectWatch = { clientId, kind, projectId, subscriptionId, callbacks }
    this.watches.set(key, route)
    try {
      callbacks.start((changedAt, relativePath) => {
        if (this.watches.get(key) !== route) return
        callbacks.changed({ subscriptionId, projectId, changedAt, ...(relativePath === undefined ? {} : { relativePath }) })
      })
    } catch (error) { this.release(key); throw error }
    return { subscriptionId, projectId, kind }
  }

  /** owner、种类、项目及代次全部匹配才释放；迟到取消不能误关新面板。 */
  unwatch(clientId: string, kind: WatchKind, target: AgentProjectWatchTarget): boolean {
    const key = this.key(clientId, kind, target.projectId)
    if (this.watches.get(key)?.subscriptionId !== target.subscriptionId) return false
    this.release(key)
    return true
  }

  /** 项目成功保存后才调用；先失效/释放，再通知客户端决定是否重新订阅。 */
  invalidate(projectId: string, reason: AgentProjectWatchClosedEvent['reason'], kind?: WatchKind): void {
    for (const [key, route] of [...this.watches]) {
      if (route.projectId !== projectId || kind && route.kind !== kind) continue
      this.release(key)
      try { route.callbacks.closed({ subscriptionId: route.subscriptionId, projectId, kind: route.kind, reason }) }
      catch { console.warn('[项目协议] 订阅关闭通知失败') }
    }
  }

  detach(clientId: string): void {
    for (const [key, route] of [...this.watches]) if (route.clientId === clientId) this.release(key)
  }
  close(): void {
    if (this.disposed) return
    this.disposed = true
    for (const key of [...this.watches.keys()]) this.release(key)
  }
  private key(clientId: string, kind: WatchKind, projectId: string): string { return JSON.stringify([clientId, kind, projectId]) }

  /** 清理失败也移除归属并继续其他资源；回调已不能再进入新代次。 */
  private release(key: string): void {
    const route = this.watches.get(key)
    if (!route) return
    this.watches.delete(key)
    try { route.callbacks.release() } catch { console.warn('[项目协议] 订阅清理失败') }
  }
}
