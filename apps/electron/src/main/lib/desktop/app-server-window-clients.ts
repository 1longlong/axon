/** 可信原生窗口与服务端身份映射；不在桌面生成第二套业务 owner。 */
import type { WebContents } from 'electron'
import type { AppServerClient, AppServerClientKind } from '@axon/shared'
import type { AppServerProcess } from './app-server-process'

type WindowKind = Extract<AppServerClientKind, 'main' | 'quick'>
/** 后端断开时原页面仍在，可关闭其等待 UI；页面重载则绝不向新页面发送旧取消。 */
export const APP_SERVER_PAGE_DISCONNECTED = 'axon_backend_disconnected'
export interface AppServerWindowClientOptions {
  backend: Pick<AppServerProcess, 'registerClient' | 'detachClient' | 'getClientSignal'>
  /** 只查主进程持有的真实主窗口/浮窗；未登记的 WebContents 不进入后端。 */
  kindOf: (sender: WebContents) => WindowKind | undefined
  /** 页面失效时同步撤销其原生运行投影；不等待服务端注销或迟到终态。 */
  onDetached?: (clientId: string) => void
}
interface PageEntry {
  sender: WebContents
  kind: WindowKind
  controller: AbortController
  registration: Promise<AppServerClient>
  client?: AppServerClient
  unlinkServer?: () => void
}

/** 页面对话入口拥有独立代次；重载先取消旧代次，迟到登记不覆盖新页面。 */
export class AppServerWindowClients {
  private readonly pages = new WeakMap<WebContents, PageEntry>()
  private readonly entries = new Set<PageEntry>()
  private readonly byId = new Map<string, PageEntry>()
  private readonly watched = new Map<WebContents, () => void>()
  private disposed = false

  constructor(private readonly options: AppServerWindowClientOptions) {}

  /** 上游 registrar 已校验主 frame；同一可信页面的并发调用共享一次异步登记。 */
  get(sender: WebContents): Promise<AppServerClient> {
    const current = this.pages.get(sender)
    if (this.disposed || sender.isDestroyed()) {
      if (current) this.invalidate(current, true)
      return Promise.reject(new Error('客户端窗口已关闭'))
    }
    const kind = this.kindOf(sender)
    if (!kind) {
      if (current) this.invalidate(current, true)
      return Promise.reject(new Error('窗口不是已登记的会话入口'))
    }
    if (current && this.valid(current) && current.kind === kind) return current.registration
    if (current) this.invalidate(current, true)
    let accepted!: (client: AppServerClient) => void, rejected!: (error: unknown) => void
    const registration = new Promise<AppServerClient>((resolve, reject) => { accepted = resolve; rejected = reject })
    const entry: PageEntry = { sender, kind, controller: new AbortController(), registration }
    // 先发布代次和监听，再调用后端；同步注销也不能让登记结果复活该页面。
    this.pages.set(sender, entry)
    this.entries.add(entry)
    this.watch(sender)
    void this.register(entry).then(accepted, rejected)
    return registration
  }

  /** 只找已完成登记的同一页面；反向请求/事件查找不创建身份，不改投当前主窗口。 */
  find(clientId: string): WebContents | undefined {
    const entry = this.byId.get(clientId)
    if (!entry) return undefined
    if (!this.valid(entry) || !this.options.backend.getClientSignal(clientId)
      || this.options.backend.getClientSignal(clientId)?.aborted) {
      this.invalidate(entry, true)
      return undefined
    }
    return entry.sender
  }
  matches(sender: WebContents, clientId: string): boolean { return this.find(clientId) === sender }
  getClientSignal(clientId: string): AbortSignal | undefined {
    return this.find(clientId) ? this.byId.get(clientId)?.controller.signal : undefined
  }
  private kindOf(sender: WebContents): WindowKind | undefined {
    try { return this.options.kindOf(sender) } catch { return undefined }
  }
  private valid(entry: PageEntry): boolean {
    return !this.disposed && !entry.controller.signal.aborted && !entry.sender.isDestroyed()
      && this.pages.get(entry.sender) === entry && this.kindOf(entry.sender) === entry.kind
  }

  /** 等待期间反复核对原页面；断开信号联动解除映射，但不为旧页面自动重新登记。 */
  private async register(entry: PageEntry): Promise<AppServerClient> {
    try {
      if (!this.valid(entry)) throw new Error('客户端页面已失效')
      const client = await this.options.backend.registerClient(entry.kind, entry.controller.signal)
      if (!this.valid(entry)) {
        this.detach(client.clientId)
        throw new Error('客户端页面已失效')
      }
      const serverSignal = this.options.backend.getClientSignal(client.clientId)
      if (!serverSignal || serverSignal.aborted) {
        this.detach(client.clientId)
        throw new Error('后端客户端已失效')
      }
      const disconnected = (): void => this.invalidate(entry, false, true)
      serverSignal.addEventListener('abort', disconnected, { once: true })
      entry.unlinkServer = () => serverSignal.removeEventListener('abort', disconnected)
      entry.client = client
      this.byId.set(client.clientId, entry)
      return client
    } catch (error) {
      this.invalidate(entry, true)
      throw error
    }
  }

  /** 每个原生 WebContents 只装一次监听；隐藏窗口不注销，重载/崩溃/销毁才失效。 */
  private watch(sender: WebContents): void {
    if (this.watched.has(sender)) return
    const reload = (): void => { const entry = this.pages.get(sender); if (entry) this.invalidate(entry, true) }
    const destroy = (): void => { reload(); this.watched.get(sender)?.(); this.watched.delete(sender) }
    sender.on('did-start-loading', reload)
    sender.on('render-process-gone', reload)
    sender.on('destroyed', destroy)
    this.watched.set(sender, () => {
      sender.removeListener('did-start-loading', reload)
      sender.removeListener('render-process-gone', reload)
      sender.removeListener('destroyed', destroy)
    })
  }

  /** 删除归属先于广播取消；旧清理/迟到登记不得删除同一 WebContents 的新代次。 */
  private invalidate(entry: PageEntry, detachServer: boolean, backendDisconnected = false): void {
    const closeOriginalUi = backendDisconnected && this.valid(entry)
    if (!this.entries.delete(entry)) return
    if (this.pages.get(entry.sender) === entry) this.pages.delete(entry.sender)
    if (entry.client && this.byId.get(entry.client.clientId) === entry) this.byId.delete(entry.client.clientId)
    entry.unlinkServer?.()
    if (entry.client) {
      try { this.options.onDetached?.(entry.client.clientId) } catch { console.warn('[应用服务] 原生入口投影清理失败') }
    }
    entry.controller.abort(closeOriginalUi ? APP_SERVER_PAGE_DISCONNECTED : 'axon_page_invalidated')
    if (detachServer && entry.client) this.detach(entry.client.clientId)
  }
  private detach(clientId: string): void {
    void this.options.backend.detachClient(clientId).catch(() => console.warn('[应用服务] 窗口客户端注销失败'))
  }

  /** 释放本映射的全部页面/监听，不停止其他客户端共享的后端；异步登记仍回收迟到结果。 */
  dispose(): void {
    if (this.disposed) return
    this.disposed = true
    for (const entry of [...this.entries]) this.invalidate(entry, true)
    for (const unwatch of this.watched.values()) unwatch()
    this.watched.clear()
  }
}
