/** 所有前端共用的历史汇聚；只返回完整快照，不把失败半页当作完整历史。 */
import { APP_SERVER_METHODS as methods, MESSAGE_HISTORY_PAGE_MESSAGES } from '@axon/shared'
import type { AgentHistoryScope, ChatHistoryScope, ChatMessage, MessageHistoryPage, MessageHistoryScope, RpcJsonValue, SDKMessage, TaskHistoryScope } from '@axon/shared'
import type { JsonRpcPeer } from './json-rpc-peer'
import { toWireValue } from './wire-value'

function page(value: RpcJsonValue): MessageHistoryPage {
  if (!value || typeof value !== 'object' || Array.isArray(value)
    || Object.keys(value).some((key) => !['historyId', 'messages', 'cursor'].includes(key))
    || typeof value.historyId !== 'string' || !value.historyId
    || !(value.cursor === null || typeof value.cursor === 'string' && value.cursor.length > 0)
    || !Array.isArray(value.messages) || value.messages.length > MESSAGE_HISTORY_PAGE_MESSAGES
    || value.messages.some((message) => !message || typeof message !== 'object' || Array.isArray(message))) {
    throw new Error('历史分页响应无效')
  }
  return value as unknown as MessageHistoryPage
}

export class AppServerHistoryClient {
  constructor(private readonly peer: JsonRpcPeer, private readonly clientId: string) {}

  read(scope: AgentHistoryScope | TaskHistoryScope, signal?: AbortSignal): Promise<SDKMessage[]>
  read(scope: ChatHistoryScope, signal?: AbortSignal): Promise<ChatMessage[]>
  /** 上游先订阅实时事件，再按返回游标读到 null；取消/错误不返回部分数组且不自动重投。 */
  async read(scope: MessageHistoryScope, signal?: AbortSignal): Promise<Array<SDKMessage | ChatMessage>> {
    const messages: Array<SDKMessage | ChatMessage> = []
    const cursors = new Set<string>()
    let historyId: string | undefined
    let cursor: string | undefined
    try {
      while (true) {
        signal?.throwIfAborted()
        const input = { scope, ...(historyId ? { historyId, cursor } : {}) }
        const response = page(await this.peer.request(methods.HISTORY_READ, { clientId: this.clientId, input: toWireValue(input) }, { signal }))
        if (historyId && response.historyId !== historyId) throw new Error('历史快照标识改变')
        historyId = response.historyId
        signal?.throwIfAborted()
        messages.push(...response.messages)
        if (response.cursor === null) return messages
        if (!response.messages.length || cursors.has(response.cursor)) throw new Error('历史游标没有前进')
        cursor = response.cursor
        cursors.add(cursor)
      }
    } finally {
      // 不使用已经取消的读取信号；仅做有界只读清理，初次响应丢失由服务端空闲期限兜底。
      if (historyId && !this.peer.closed) {
        try { await this.peer.request(methods.HISTORY_CLOSE, { clientId: this.clientId, input: historyId }, { timeoutMs: 2_000 }) }
        catch { /* 连接断开或入口注销已在服务端清理，不覆盖原读取错误。 */ }
      }
    }
  }
}
