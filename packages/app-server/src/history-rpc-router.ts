/** 历史协议不接路径或完整服务对象；固定调用 core 的作用域分页与释放。 */
import { AgentTaskControllerError, JsonlHistoryError, MessageHistoryControllerError } from '@axon/core'
import { APP_SERVER_METHODS as methods } from '@axon/shared'
import { RpcFault } from './json-rpc-peer'
import type { JsonRpcPeer } from './json-rpc-peer'
import type { ResolveAppServerClient } from './rpc-command-context'
import { toWireValue } from './wire-value'

export class HistoryRpcRouter {
  constructor(peer: JsonRpcPeer, resolve: ResolveAppServerClient) {
    for (const [method, action] of [[methods.HISTORY_READ, 'read'], [methods.HISTORY_CLOSE, 'close']] as const) {
      peer.handle(method, (params, { signal }) => {
        const { backend, client, input } = resolve(params, ['input'])
        const stop = AbortSignal.any([signal, backend.clients.getSignal(client.clientId)!])
        try {
          stop.throwIfAborted()
          return toWireValue(action === 'read' ? backend.histories.read(client.clientId, input, stop) : backend.histories.close(client.clientId, input))
        } catch (error) {
          if (stop.aborted) throw new RpcFault(-32800, '历史读取已取消')
          if (error instanceof MessageHistoryControllerError || error instanceof JsonlHistoryError || error instanceof AgentTaskControllerError) {
            throw new RpcFault(error.code === 'invalid_input' ? -32602 : -32029, '历史读取失败', { code: error.code })
          }
          throw error
        }
      })
    }
  }
}
