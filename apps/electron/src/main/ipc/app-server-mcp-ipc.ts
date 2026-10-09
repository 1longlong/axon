/** MCP 固定桌面代理；敏感配置仅经原请求响应返回，不向其他页面广播。 */
import type { IpcMainInvokeEvent, WebContents } from 'electron'
import { toWireValue } from '@axon/app-server'
import { MCP_IPC_CHANNELS as channels, APP_SERVER_METHODS as methods } from '@axon/shared'
import type { RpcJsonValue } from '@axon/shared'
import type { AppServerProcess } from '../lib/desktop/app-server-process'
import type { AppServerWindowClients } from '../lib/desktop/app-server-window-clients'
import { McpConnectionTests, parseMcpConnectionTest, parseMcpRequestId } from '../lib/desktop/mcp-connection-tests'
import { assertMainFrame } from './assert-main-frame'

export interface AppServerMcpIpcRegistrar {
  handle(channel: string, listener: (event: IpcMainInvokeEvent, ...args: unknown[]) => unknown): void
  removeHandler(channel: string): void
}
export interface AppServerMcpIpcOptions {
  backend: Pick<AppServerProcess, 'request'>
  clients: Pick<AppServerWindowClients, 'get' | 'getClientSignal'>
}
type Method = Parameters<AppServerProcess['request']>[1]

/** frame/字段校验先于登记；只代理固定配置方法，测试合并页面与精确取消信号。 */
export function registerAppServerMcpIpcHandlers(ipc: AppServerMcpIpcRegistrar, options: AppServerMcpIpcOptions): () => void {
  const registered: string[] = [], lifetime = new AbortController(), tests = new McpConnectionTests()
  const call = async (sender: WebContents, method: Method, input?: unknown, testSignal?: AbortSignal): Promise<RpcJsonValue> => {
    const value = input === undefined ? undefined : toWireValue(input)
    const client = await options.clients.get(sender)
    const page = options.clients.getClientSignal(client.clientId)
    if (!page || page.aborted) throw new Error('客户端页面已失效')
    const signal = AbortSignal.any([page, lifetime.signal, ...(testSignal ? [testSignal] : [])])
    signal.throwIfAborted()
    // 连接测试使用服务器实际启动/发现期限，不能被普通 RPC 的短期限提前截断。
    return options.backend.request(client.clientId, method, value, { signal, ...(testSignal ? { timeoutMs: 0 } : {}) })
  }
  const handle = (channel: string, count: number, action: (sender: WebContents, ...args: unknown[]) => unknown): void => {
    ipc.handle(channel, (event, ...args) => {
      assertMainFrame(event, 'MCP')
      lifetime.signal.throwIfAborted()
      if (args.length !== count) throw new Error('MCP IPC 参数数量无效')
      return action(event.sender, ...args)
    })
    registered.push(channel)
  }
  let disposed = false
  const dispose = (): void => {
    if (disposed) return
    disposed = true
    lifetime.abort(); tests.dispose()
    for (const channel of registered) ipc.removeHandler(channel)
  }
  try {
    handle(channels.GET_PROJECT_CONFIG, 1, (sender, projectId) => call(sender, methods.MCP_GET_CONFIG, parseMcpRequestId(projectId)))
    handle(channels.SAVE_PROJECT_CONFIG, 2, (sender, projectId, config) => call(sender, methods.MCP_SAVE_CONFIG, { projectId: parseMcpRequestId(projectId), config }))
    handle(channels.LIST_BUILTIN_PRESETS, 0, (sender) => call(sender, methods.MCP_LIST_PRESETS))
    handle(channels.MATERIALIZE_BUILTIN_PRESET, 2, (sender, projectId, presetId) => call(sender, methods.MCP_MATERIALIZE_PRESET,
      { projectId: parseMcpRequestId(projectId), presetId: parseMcpRequestId(presetId) }))
    handle(channels.TEST_SERVER_CONNECTION, 1, (sender, value) => {
      const { requestId, ...input } = parseMcpConnectionTest(value)
      return tests.run(sender, requestId, (signal) => call(sender, methods.MCP_TEST_CONNECTION, input, signal))
    })
    handle(channels.CANCEL_CONNECTION_TEST, 1, (sender, requestId) => tests.cancel(sender, parseMcpRequestId(requestId)))
  } catch (error) { dispose(); throw error }
  return dispose
}
