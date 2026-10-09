/** Task 固定桌面代理；查询/历史/只读订阅交给独立后端，不开放运行控制。 */
import type { IpcMainInvokeEvent, WebContents } from 'electron'
import { AppServerHistoryClient } from '@axon/app-server'
import { AGENT_TASK_IPC_CHANNELS as channels, APP_SERVER_METHODS as methods } from '@axon/shared'
import type { RpcJsonValue } from '@axon/shared'
import type { AppServerProcess } from '../lib/desktop/app-server-process'
import type { AppServerWindowClients } from '../lib/desktop/app-server-window-clients'
import { assertMainFrame } from './assert-main-frame'

export interface AppServerTaskIpcRegistrar {
  handle(channel: string, listener: (event: IpcMainInvokeEvent, ...args: unknown[]) => unknown): void
  removeHandler(channel: string): void
}
export interface AppServerTaskIpcOptions {
  backend: Pick<AppServerProcess, 'request' | 'readyPeer'>
  clients: Pick<AppServerWindowClients, 'get' | 'getClientSignal'>
}
function id(value: unknown): string {
  if (typeof value !== 'string' || !/^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/.test(value.trim())) throw new Error('Task 标识无效')
  return value.trim()
}
function subscriptionId(value: unknown): string {
  if (typeof value !== 'string' || !value.trim() || value.length > 200) throw new Error('Task 订阅标识无效')
  return value.trim()
}

/** 参数校验先于可信页面登记；历史完整读完才交付，取消未知订阅不猜当前代次或重投。 */
export function registerAppServerTaskIpcHandlers(ipc: AppServerTaskIpcRegistrar, options: AppServerTaskIpcOptions): () => void {
  const lifetime = new AbortController(), registered: string[] = []
  const context = async (sender: WebContents) => {
    const client = await options.clients.get(sender), page = options.clients.getClientSignal(client.clientId)
    if (!page || page.aborted) throw new Error('客户端页面已失效')
    const signal = AbortSignal.any([page, lifetime.signal]); signal.throwIfAborted()
    return { clientId: client.clientId, signal }
  }
  const call = async (sender: WebContents, method: typeof methods.TASK_LIST | typeof methods.TASK_GET | typeof methods.TASK_SUBSCRIBE | typeof methods.TASK_UNSUBSCRIBE,
    input?: RpcJsonValue): Promise<RpcJsonValue> => {
    const { clientId, signal } = await context(sender)
    const result = await options.backend.request(clientId, method, input, { signal })
    signal.throwIfAborted()
    return result
  }
  const handle = (channel: string, count: number, action: (sender: WebContents, ...args: unknown[]) => unknown): void => {
    ipc.handle(channel, (event, ...args) => {
      assertMainFrame(event, 'Agent 子任务'); lifetime.signal.throwIfAborted()
      if (args.length !== count) throw new Error('Task IPC 参数数量无效')
      return action(event.sender, ...args)
    })
    registered.push(channel)
  }
  let disposed = false
  const dispose = (): void => {
    if (disposed) return
    disposed = true; lifetime.abort()
    for (const channel of registered) ipc.removeHandler(channel)
  }
  try {
    handle(channels.LIST, 1, (sender, root) => call(sender, methods.TASK_LIST, id(root)))
    handle(channels.GET, 2, (sender, root, task) => call(sender, methods.TASK_GET, { rootSessionId: id(root), taskId: id(task) }))
    handle(channels.SUBSCRIBE, 0, (sender) => call(sender, methods.TASK_SUBSCRIBE))
    handle(channels.UNSUBSCRIBE, 1, (sender, value) => call(sender, methods.TASK_UNSUBSCRIBE, subscriptionId(value)))
    handle(channels.GET_MESSAGES, 2, async (sender, root, task) => {
      const scope = { kind: 'task' as const, rootSessionId: id(root), taskId: id(task) }
      const { clientId, signal } = await context(sender)
      const result = await new AppServerHistoryClient(options.backend.readyPeer(), clientId).read(scope, signal)
      signal.throwIfAborted()
      return result
    })
  } catch (error) { dispose(); throw error }
  return dispose
}
