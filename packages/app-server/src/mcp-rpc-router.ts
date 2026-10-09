/** MCP 配置与草稿诊断协议；SDK、加密和连接租约仍由 core 管理。 */
import { AgentProjectManagerError, McpProjectConfigManagerError } from '@axon/core'
import { APP_SERVER_METHODS as methods } from '@axon/shared'
import { configObject } from './config-input'
import { RpcFault } from './json-rpc-peer'
import type { JsonRpcPeer } from './json-rpc-peer'
import type { AppServerCommandContext, ResolveAppServerClient } from './rpc-command-context'
import { toWireValue } from './wire-value'

export class McpRpcRouter {
  /** 固定方法调用领域 controller；测试信号合并原入口注销，不能指定 cwd 或调用内部工具。 */
  constructor(peer: JsonRpcPeer, resolve: ResolveAppServerClient) {
    const handle = (method: string, fields: readonly string[], action: (
      context: AppServerCommandContext, signal: AbortSignal,
    ) => unknown | Promise<unknown>): void => {
      peer.handle(method, async (params, { signal }) => {
        const context = resolve(params, fields)
        signal.throwIfAborted()
        try { return toWireValue(await action(context, signal)) }
        catch (error) {
          if (error instanceof McpProjectConfigManagerError) throw new RpcFault(-32026, 'MCP 配置命令失败', { code: error.code })
          if (error instanceof AgentProjectManagerError) throw new RpcFault(-32023, '项目命令失败', { code: error.code })
          if (signal.aborted || error instanceof Error && error.name === 'AbortError') throw new RpcFault(-32800, 'MCP 请求已取消')
          throw error
        }
      })
    }
    handle(methods.MCP_GET_CONFIG, ['input'], ({ backend, input }) => backend.mcp.get(input))
    handle(methods.MCP_SAVE_CONFIG, ['input'], ({ backend, input }) => {
      const value = configObject(input, ['projectId', 'config'])
      return backend.mcp.save(value.projectId, value.config)
    })
    handle(methods.MCP_TEST_CONNECTION, ['input'], ({ backend, client, input }, signal) => {
      const value = configObject(input, ['projectId', 'serverName', 'server'])
      const ownerSignal = backend.clients.getSignal(client.clientId)
      if (!ownerSignal) throw new RpcFault(-32004, '客户端已断开')
      return backend.mcp.testConnection(value.projectId, value.serverName, value.server,
        AbortSignal.any([signal, ownerSignal]))
    })
    handle(methods.MCP_LIST_PRESETS, [], ({ backend }) => backend.mcp.listBuiltinPresets())
    handle(methods.MCP_MATERIALIZE_PRESET, ['input'], ({ backend, input }) => {
      const value = configObject(input, ['projectId', 'presetId'])
      return backend.mcp.materializeBuiltinPreset(value.projectId, value.presetId)
    })
  }
}
