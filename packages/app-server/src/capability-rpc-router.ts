/** 能力请求固定调用 core controller；宿主与 Runtime SDK 仍由后端入口装配。 */
import { AgentCapabilityControllerError, AgentProjectManagerError } from '@axon/core'
import { APP_SERVER_METHODS as methods } from '@axon/shared'
import { RpcFault } from './json-rpc-peer'
import type { JsonRpcPeer } from './json-rpc-peer'
import type { ResolveAppServerClient } from './rpc-command-context'
import { toWireValue } from './wire-value'

export class CapabilityRpcRouter {
  /** 合并请求与真实入口取消；已断开入口不能消费共享目录加载的迟到结果。 */
  constructor(peer: JsonRpcPeer, resolve: ResolveAppServerClient) {
    for (const [method, action] of [[methods.AGENT_GET_REASONING_CAPABILITY, 'getReasoningCapability'],
      [methods.AGENT_CHECK_ENVIRONMENT, 'checkEnvironment']] as const) {
      peer.handle(method, async (params, { signal }) => {
        const { backend, client, input } = resolve(params, ['input'])
        const ownerSignal = backend.clients.getSignal(client.clientId)!
        const stop = AbortSignal.any([signal, ownerSignal])
        try { return toWireValue(await backend.agentCapabilities[action](input, stop) ?? null) }
        catch (error) {
          if (stop.aborted || error instanceof Error && error.name === 'AbortError') throw new RpcFault(-32800, '能力查询已取消')
          if (error instanceof AgentCapabilityControllerError) {
            throw new RpcFault(error.code === 'invalid_input' ? -32602 : -32028, '能力查询失败', { code: error.code })
          }
          if (error instanceof AgentProjectManagerError) throw new RpcFault(-32023, '项目命令失败', { code: error.code })
          throw error
        }
      })
    }
  }
}
