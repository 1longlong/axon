/** 渠道固定代理；凭据、保存与目录网络诊断均只由独立后端处理。 */
import type { IpcMainInvokeEvent, WebContents } from 'electron'
import { toWireValue } from '@axon/app-server'
import { CHANNEL_IPC_CHANNELS as channels, APP_SERVER_METHODS as methods } from '@axon/shared'
import type { RpcJsonValue } from '@axon/shared'
import type { AppServerProcess } from '../lib/desktop/app-server-process'
import type { AppServerWindowClients } from '../lib/desktop/app-server-window-clients'
import { assertMainFrame } from './assert-main-frame'

export interface AppServerChannelIpcRegistrar {
  handle(channel: string, listener: (event: IpcMainInvokeEvent, ...args: unknown[]) => unknown): void
  removeHandler(channel: string): void
}
export interface AppServerChannelIpcOptions {
  backend: Pick<AppServerProcess, 'request'>
  clients: Pick<AppServerWindowClients, 'get' | 'getClientSignal'>
}
type Method = Parameters<AppServerProcess['request']>[1]
function id(value: unknown): string {
  if (typeof value !== 'string' || !value.trim()) throw new Error('渠道标识参数无效')
  return value.trim()
}

/** 校验真实主 frame 后登记原页面；固定路由不开放 resolve、私有桥或任意 RPC。 */
export function registerAppServerChannelIpcHandlers(ipc: AppServerChannelIpcRegistrar, options: AppServerChannelIpcOptions): () => void {
  const registered: string[] = [], lifetime = new AbortController()
  const call = async (sender: WebContents, method: Method, input?: unknown, long = false): Promise<RpcJsonValue> => {
    const value = input === undefined ? undefined : toWireValue(input)
    const client = await options.clients.get(sender)
    const page = options.clients.getClientSignal(client.clientId)
    if (!page || page.aborted) throw new Error('客户端页面已失效')
    const signal = AbortSignal.any([page, lifetime.signal])
    signal.throwIfAborted()
    // 目录请求包含人工确认，不能套通用短期限；实际网络/正文期限仍由 core 控制。
    return options.backend.request(client.clientId, method, value, { signal, ...(long ? { timeoutMs: 0 } : {}) })
  }
  const handle = (channel: string, count: number, action: (sender: WebContents, ...args: unknown[]) => unknown): void => {
    ipc.handle(channel, (event, ...args) => {
      assertMainFrame(event, '渠道')
      lifetime.signal.throwIfAborted()
      if (args.length !== count) throw new Error('渠道 IPC 参数数量无效')
      return action(event.sender, ...args)
    })
    registered.push(channel)
  }
  let disposed = false
  const dispose = (): void => {
    if (disposed) return
    disposed = true
    lifetime.abort()
    for (const channel of registered) ipc.removeHandler(channel)
  }
  try {
    handle(channels.LIST, 0, (sender) => call(sender, methods.CHANNEL_LIST))
    handle(channels.CREATE, 1, (sender, input) => call(sender, methods.CHANNEL_CREATE, input))
    handle(channels.UPDATE, 2, (sender, channelId, update) => call(sender, methods.CHANNEL_UPDATE, { channelId: id(channelId), update }))
    handle(channels.DELETE, 1, (sender, channelId) => call(sender, methods.CHANNEL_DELETE, id(channelId)))
    handle(channels.REQUEST, 1, (sender, input) => call(sender, methods.CHANNEL_REQUEST, input, true))
    handle(channels.CANCEL, 1, (sender, requestId) => call(sender, methods.CHANNEL_CANCEL, id(requestId)))
  } catch (error) { dispose(); throw error }
  return dispose
}
