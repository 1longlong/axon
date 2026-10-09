/** 文件树/记忆面板的监听生命周期；仅消费服务端代次，不猜测项目当前监听。 */
import type { AgentMemoryChangedEvent, AgentProjectWatchClosedEvent, AgentProjectWatchSubscription, AgentProjectWatchTarget } from '@axon/shared'

export interface ProjectWatchOptions {
  projectId: string
  kind: AgentProjectWatchSubscription['kind']
  watch(projectId: string): Promise<AgentProjectWatchSubscription>
  unwatch(target: AgentProjectWatchTarget): Promise<boolean>
  onChanged(callback: (event: AgentMemoryChangedEvent) => void): () => void
  onClosed(callback: (event: AgentProjectWatchClosedEvent) => void): () => void
  ready(): void
  changed(event: AgentMemoryChangedEvent): void
  closed(event: AgentProjectWatchClosedEvent): void
  failed(): void
}

/** 先安装事件再登记；成功后读快照覆盖早到变化，关停早于响应也不会消费失效监听。 */
export function observeProjectWatch(options: ProjectWatchOptions): () => void {
  let disposed = false
  let active: AgentProjectWatchSubscription | undefined
  let pending = false
  const earlyClosed = new Map<string, AgentProjectWatchClosedEvent>()
  // 清理只发送已知原代次；失败不重投，所属入口注销仍由后端回收。
  const release = (subscription: AgentProjectWatchSubscription): void => {
    void options.unwatch({ projectId: subscription.projectId, subscriptionId: subscription.subscriptionId }).catch(() => {})
  }
  const handleClosed = (event: AgentProjectWatchClosedEvent): void => {
    active = undefined
    options.closed(event)
    if (!disposed && event.reason === 'project_changed') void register()
  }
  const register = async (): Promise<void> => {
    pending = true
    earlyClosed.clear()
    try {
      const subscription = await options.watch(options.projectId)
      if (disposed) { release(subscription); return }
      pending = false
      const closed = earlyClosed.get(subscription.subscriptionId)
      earlyClosed.clear()
      if (closed) { handleClosed(closed); return }
      active = subscription
      options.ready()
    } catch {
      pending = false
      earlyClosed.clear()
      if (!disposed) options.failed()
    }
  }
  const unsubscribeChanges = options.onChanged((event) => {
    if (!disposed && event.projectId === options.projectId && event.subscriptionId === active?.subscriptionId) options.changed(event)
  })
  let unsubscribeClosed: () => void
  try {
    unsubscribeClosed = options.onClosed((event) => {
      if (disposed || event.projectId !== options.projectId || event.kind !== options.kind) return
      if (event.subscriptionId === active?.subscriptionId) handleClosed(event)
      else if (pending) earlyClosed.set(event.subscriptionId, event)
    })
  } catch (error) { unsubscribeChanges(); throw error }
  void register()
  return () => {
    if (disposed) return
    disposed = true
    earlyClosed.clear()
    unsubscribeChanges(); unsubscribeClosed()
    if (active) { release(active); active = undefined }
  }
}
