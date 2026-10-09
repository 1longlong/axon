/** 设置/资料固定代理；快捷键事务只持有原生注册器，业务校验和保存由后端完成。 */
import type { IpcMainInvokeEvent, WebContents } from 'electron'
import { toWireValue } from '@axon/app-server'
import { APP_SERVER_METHODS as methods, SETTINGS_IPC_CHANNELS, USER_PROFILE_IPC_CHANNELS } from '@axon/shared'
import type { AppSettings, RpcJsonValue } from '@axon/shared'
import type { AppServerProcess } from '../lib/desktop/app-server-process'
import type { AppServerWindowClients } from '../lib/desktop/app-server-window-clients'
import type { AppServerSettingsTransaction } from '../lib/desktop/app-server-settings-transaction'
import { assertMainFrame } from './assert-main-frame'

export interface AppServerSettingsIpcRegistrar {
  handle(channel: string, listener: (event: IpcMainInvokeEvent, ...args: unknown[]) => unknown): void
  removeHandler(channel: string): void
}
export interface AppServerSettingsIpcOptions {
  backend: Pick<AppServerProcess, 'request'>
  clients: Pick<AppServerWindowClients, 'get' | 'getClientSignal'>
  transaction: Pick<AppServerSettingsTransaction, 'apply'>
}

/** 校验真实 frame/参数后只调用固定方法；不公开 validate 或可信宿主重读身份。 */
export function registerAppServerSettingsIpcHandlers(ipc: AppServerSettingsIpcRegistrar, options: AppServerSettingsIpcOptions): () => void {
  const registered: string[] = [], lifetime = new AbortController()
  type Method = Parameters<AppServerProcess['request']>[1]
  const context = async (sender: WebContents) => {
    const client = await options.clients.get(sender), page = options.clients.getClientSignal(client.clientId)
    if (!page || page.aborted) throw new Error('客户端页面已失效')
    const signal = AbortSignal.any([page, lifetime.signal])
    signal.throwIfAborted()
    return { clientId: client.clientId, signal }
  }
  const call = async (sender: WebContents, method: Method, input?: unknown): Promise<RpcJsonValue> => {
    const value = input === undefined ? undefined : toWireValue(input)
    const owner = await context(sender)
    return options.backend.request(owner.clientId, method, value, { signal: owner.signal })
  }
  const handle = (channel: string, count: number, action: (sender: WebContents, input?: unknown) => unknown): void => {
    ipc.handle(channel, (event, ...args) => {
      assertMainFrame(event, '设置')
      lifetime.signal.throwIfAborted()
      if (args.length !== count) throw new Error('设置 IPC 参数数量无效')
      return action(event.sender, args[0])
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
    handle(SETTINGS_IPC_CHANNELS.GET, 0, (sender) => call(sender, methods.GET_SETTINGS))
    handle(SETTINGS_IPC_CHANNELS.UPDATE, 1, async (sender, input) => {
      const value = toWireValue(input), owner = await context(sender)
      // 校验全补丁与真实绑定会话，再让父端占用系统键；保存命令仍会再次校验。
      const patch = await options.backend.request(owner.clientId, methods.VALIDATE_SETTINGS, value, { signal: owner.signal })
      owner.signal.throwIfAborted()
      if (!patch || typeof patch !== 'object' || Array.isArray(patch)) throw new Error('后端设置校验响应无效')
      const saved = await options.transaction.apply(patch as unknown as Partial<AppSettings>, async () =>
        await options.backend.request(owner.clientId, methods.UPDATE_SETTINGS, patch, { signal: owner.signal }) as unknown as AppSettings,
      owner.signal)
      // 原生注册须核对已保存结果；已失效页面不能接收迟到成功，但不撤销真正保存的设置。
      owner.signal.throwIfAborted()
      return toWireValue(saved)
    })
    handle(USER_PROFILE_IPC_CHANNELS.GET, 0, (sender) => call(sender, methods.GET_USER_PROFILE))
    handle(USER_PROFILE_IPC_CHANNELS.UPDATE, 1, (sender, input) => call(sender, methods.UPDATE_USER_PROFILE, input))
  } catch (error) { dispose(); throw error }
  return dispose
}
