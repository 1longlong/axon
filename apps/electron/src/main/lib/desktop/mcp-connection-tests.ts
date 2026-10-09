/** MCP 草稿测试的桌面生命周期；取消权只属于发起测试的原生页面。 */
import type { WebContents } from 'electron'
import { toWireValue } from '@axon/app-server'
import type { RpcJsonValue } from '@axon/shared'

export interface ParsedMcpConnectionTest {
  requestId: string
  projectId: string
  serverName: string
  server: RpcJsonValue
}

export function parseMcpRequestId(value: unknown): string {
  if (typeof value !== 'string' || !value.trim() || value.length > 200) throw new Error('MCP 请求标识无效')
  return value.trim()
}

/** 先验证固定字段及 JSON 边界，避免无效负载触发窗口登记或本地进程。 */
export function parseMcpConnectionTest(value: unknown): ParsedMcpConnectionTest {
  if (!value || typeof value !== 'object' || Array.isArray(value)
    || Object.keys(value).length !== 4 || Object.keys(value).some((key) => !['requestId', 'projectId', 'serverName', 'server'].includes(key))) {
    throw new Error('MCP 测试参数无效')
  }
  const input = value as Record<string, unknown>
  return { requestId: parseMcpRequestId(input.requestId), projectId: parseMcpRequestId(input.projectId),
    serverName: parseMcpRequestId(input.serverName), server: toWireValue(input.server) }
}

interface PendingTest {
  controller: AbortController
  invalidate(): void
}

export class McpConnectionTests {
  private readonly pages = new WeakMap<WebContents, Map<string, PendingTest>>()
  private readonly pending = new Set<PendingTest>()
  private disposed = false

  /** 在异步登记前绑定页面事件；取消不能遗漏尚未拿到后端 clientId 的测试。 */
  async run<T>(sender: WebContents, requestId: string, execute: (signal: AbortSignal) => Promise<T>): Promise<T> {
    if (this.disposed || sender.isDestroyed()) throw new Error('MCP 测试入口已关闭')
    let page = this.pages.get(sender)
    if (!page) { page = new Map(); this.pages.set(sender, page) }
    if (page.has(requestId)) throw new Error('MCP 测试请求标识重复')
    if (this.pending.size >= 128) throw new Error('MCP 测试数量超过限制')
    const controller = new AbortController()
    const entry: PendingTest = { controller, invalidate: () => controller.abort() }
    page.set(requestId, entry)
    this.pending.add(entry)
    sender.on('did-start-loading', entry.invalidate)
    sender.on('render-process-gone', entry.invalidate)
    sender.on('destroyed', entry.invalidate)
    try {
      const result = await execute(controller.signal)
      // 不配合取消的原生/协议回调也不能把迟到结果交付给新页面。
      controller.signal.throwIfAborted()
      return result
    } finally {
      page.delete(requestId)
      this.pending.delete(entry)
      sender.removeListener('did-start-loading', entry.invalidate)
      sender.removeListener('render-process-gone', entry.invalidate)
      sender.removeListener('destroyed', entry.invalidate)
    }
  }

  /** 精确取消同一页面的现有请求；不登记新身份，不发送额外业务请求或扩大为项目取消。 */
  cancel(sender: WebContents, requestId: string): boolean {
    const entry = this.pages.get(sender)?.get(requestId)
    if (!entry || entry.controller.signal.aborted || sender.isDestroyed()) return false
    entry.controller.abort()
    return true
  }

  /** 释放代理只撤销等待；实际连接关闭由 core/provider 的 finally 完成。 */
  dispose(): void {
    if (this.disposed) return
    this.disposed = true
    for (const entry of this.pending) entry.controller.abort()
  }
}
