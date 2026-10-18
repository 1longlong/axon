/** Loop 桌面固定白名单；页面只发业务输入，不持有调度身份或本地 CLI 凭据。 */
import type { IpcMainInvokeEvent } from 'electron'
import { toWireValue } from '@axon/app-server'
import { APP_SERVER_METHODS as methods, LOOP_IPC_CHANNELS as channels } from '@axon/shared'
import type { AppServerTaskIpcRegistrar, AppServerTaskIpcOptions } from './app-server-task-ipc'
import { assertMainFrame } from './assert-main-frame'
import { McpConnectionTests, parseMcpRequestId } from '../lib/desktop/mcp-connection-tests'

/** 校验原页面后转交固定后端命令；取消等待不重投已接受的创建/运行请求。 */
export function registerAppServerLoopIpcHandlers(ipc: AppServerTaskIpcRegistrar, options: AppServerTaskIpcOptions): () => void {
  const lifetime = new AbortController()
  const tests = new McpConnectionTests()
  const registered: string[] = []
  const routes = [
    [channels.LIST, methods.LOOP_LIST, 0], [channels.GET, methods.LOOP_GET, 1], [channels.CREATE, methods.LOOP_CREATE, 1],
    [channels.RUNS, methods.LOOP_RUNS, 1],
    [channels.MCP_TOOLS, methods.LOOP_MCP_TOOLS, 1],
    [channels.MCP_GET_CONFIG, methods.LOOP_MCP_GET_CONFIG, 1],
    [channels.MCP_SAVE_CONFIG, methods.LOOP_MCP_SAVE_CONFIG, 1],
    [channels.MCP_TEST_CONNECTION, methods.LOOP_MCP_TEST_CONNECTION, 1],
    [channels.PREPARE, methods.LOOP_PREPARE, 1],
    [channels.UPDATE, methods.LOOP_UPDATE, 1], [channels.DELETE, methods.LOOP_DELETE, 1], [channels.RUN, methods.LOOP_RUN, 1],
    [channels.STOP, methods.LOOP_STOP, 1], [channels.EVOLVE, methods.LOOP_EVOLVE, 1], [channels.EDIT, methods.LOOP_EDIT, 1],
    [channels.RUN_DETAIL, methods.LOOP_RUN_DETAIL, 1], [channels.ARTIFACTS, methods.LOOP_ARTIFACTS, 1],
    [channels.READ_ARTIFACT, methods.LOOP_READ_ARTIFACT, 1],
  ] as const
  let disposed = false
  const dispose = (): void => {
    if (disposed) return
    disposed = true; lifetime.abort(); tests.dispose()
    for (const channel of registered) ipc.removeHandler(channel)
  }
  try {
    for (const [channel, method, count] of routes) {
      ipc.handle(channel, async (event: IpcMainInvokeEvent, ...args: unknown[]) => {
        assertMainFrame(event, 'Loop')
        lifetime.signal.throwIfAborted()
        if (args.length !== count) throw new Error('Loop IPC 参数数量无效')
        const call = async (input: unknown, testSignal?: AbortSignal) => {
          const client = await options.clients.get(event.sender)
          if (client.kind !== 'main') throw new Error('此窗口不可管理 Loop')
          const page = options.clients.getClientSignal(client.clientId)
          if (!page || page.aborted) throw new Error('Loop 页面已失效')
          const signal = AbortSignal.any([lifetime.signal, page, ...(testSignal ? [testSignal] : [])])
          signal.throwIfAborted()
          const result = await options.backend.request(client.clientId, method, count ? toWireValue(input) : undefined,
            { signal, ...([channels.MCP_TOOLS, channels.MCP_TEST_CONNECTION].some((value) => value === channel) ? { timeoutMs: 0 } : {}) })
          signal.throwIfAborted(); return result
        }
        if (channel === channels.MCP_TEST_CONNECTION) {
          const value = args[0]
          if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error('MCP 测试参数无效')
          const { requestId, ...input } = value as Record<string, unknown>
          return tests.run(event.sender, parseMcpRequestId(requestId), (signal) => call(input, signal))
        }
        return call(args[0])
      })
      registered.push(channel)
    }
    ipc.handle(channels.MCP_CANCEL_TEST, (event, ...args) => {
      assertMainFrame(event, 'Loop MCP'); lifetime.signal.throwIfAborted()
      if (args.length !== 1) throw new Error('MCP 取消参数无效')
      return tests.cancel(event.sender, parseMcpRequestId(args[0]))
    })
    registered.push(channels.MCP_CANCEL_TEST)
  } catch (error) { dispose(); throw error }
  return dispose
}
