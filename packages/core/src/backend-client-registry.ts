/** 可信入口的客户端登记表；身份及取消信号只存在后端，不依赖窗口或传输类型。 */
import { randomUUID } from 'node:crypto'
import type { BackendClientId } from '@axon/shared'

export class BackendClientRegistry {
  private readonly clients = new Map<BackendClientId, AbortController>()
  private readonly listeners = new Set<(clientId: BackendClientId) => void>()
  private disposed = false

  constructor(private readonly createId: () => string = randomUUID) {}

  /** 入口为已验证的连接登记随机身份；调用方不能指定已有 owner。 */
  register(): BackendClientId {
    if (this.disposed) throw new Error('客户端登记表已释放')
    const id = this.createId()
    if (!id || this.clients.has(id)) throw new Error('客户端身份生成失败')
    this.clients.set(id, new AbortController())
    return id
  }

  has(clientId: BackendClientId): boolean { return this.clients.has(clientId) }

  getSignal(clientId: BackendClientId): AbortSignal | undefined { return this.clients.get(clientId)?.signal }

  subscribeDetached(listener: (clientId: BackendClientId) => void): () => void {
    this.listeners.add(listener)
    return () => this.listeners.delete(listener)
  }

  /** 先使身份失效，再取消等待并通知资源所有者，避免断开回调重新接受旧身份。 */
  detach(clientId: BackendClientId): boolean {
    const controller = this.clients.get(clientId)
    if (!controller) return false
    this.clients.delete(clientId)
    controller.abort()
    for (const listener of this.listeners) {
      try { listener(clientId) } catch { console.warn('[后端客户端] 断开清理失败') }
    }
    return true
  }

  /** 整条宿主连接退出时注销其所有逻辑客户端，不自动把运行转给其他连接。 */
  dispose(): void {
    if (this.disposed) return
    this.disposed = true
    for (const id of [...this.clients.keys()]) this.detach(id)
    this.listeners.clear()
  }
}
