/** Skills 桌面固定代理；页面只选择 catalog ID，安装包与目录操作留在独立后端。 */
import type { IpcMainInvokeEvent, WebContents } from 'electron'
import { AGENT_SKILL_IPC_CHANNELS as channels, APP_SERVER_METHODS as methods } from '@axon/shared'
import type { RpcJsonValue } from '@axon/shared'
import type { AppServerProcess } from '../lib/desktop/app-server-process'
import type { AppServerWindowClients } from '../lib/desktop/app-server-window-clients'
import { assertMainFrame } from './assert-main-frame'

export interface AppServerSkillIpcRegistrar {
  handle(channel: string, listener: (event: IpcMainInvokeEvent, ...args: unknown[]) => unknown): void
  removeHandler(channel: string): void
}
export interface AppServerSkillIpcOptions {
  backend: Pick<AppServerProcess, 'request'>
  clients: Pick<AppServerWindowClients, 'get' | 'getClientSignal'>
}

/** 校验主 frame/固定负载后登记原页面；目录异步等待取消不重发安装或假装回滚。 */
export function registerAppServerSkillIpcHandlers(ipc: AppServerSkillIpcRegistrar, options: AppServerSkillIpcOptions): () => void {
  const lifetime = new AbortController(), registered: string[] = []
  const call = async (sender: WebContents, method: typeof methods.SKILLS_GET_SETTINGS | typeof methods.SKILLS_APPLY_SETTINGS, input?: RpcJsonValue): Promise<RpcJsonValue> => {
    const client = await options.clients.get(sender), page = options.clients.getClientSignal(client.clientId)
    if (!page || page.aborted) throw new Error('客户端页面已失效')
    const signal = AbortSignal.any([page, lifetime.signal])
    signal.throwIfAborted()
    // catalog provider 可异步读取；不套普通短期限，生命周期信号仍限制等待。
    const result = await options.backend.request(client.clientId, method, input, { signal, timeoutMs: 0 })
    signal.throwIfAborted()
    return result
  }
  const handle = (channel: string, count: number, action: (sender: WebContents, value?: unknown) => unknown): void => {
    ipc.handle(channel, (event, ...args) => {
      assertMainFrame(event, 'Skills')
      lifetime.signal.throwIfAborted()
      if (args.length !== count) throw new Error('Skills IPC 参数数量无效')
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
    handle(channels.GET_SETTINGS, 0, (sender) => call(sender, methods.SKILLS_GET_SETTINGS))
    handle(channels.APPLY_SETTINGS, 1, (sender, value) => {
      if (!value || typeof value !== 'object' || Array.isArray(value)
        || Object.keys(value).some((key) => key !== 'catalogIds' && key !== 'confirmedCatalogIds')) throw new Error('Skills 选择参数无效')
      const item = value as Record<string, unknown>
      const parseIds = (raw: unknown): string[] => {
        if (!Array.isArray(raw) || raw.length > 200) throw new Error('Skills 选择参数无效')
        return Array.from(raw, (id: unknown) => {
          if (typeof id !== 'string' || !id.trim() || id.length > 200) throw new Error('Skills 选择参数无效')
          return id.trim()
        })
      }
      // 只代理确切选择及逐项确认，不开放任意路径或隐含的全局强制覆盖。
      return call(sender, methods.SKILLS_APPLY_SETTINGS, {
        catalogIds: parseIds(item.catalogIds), confirmedCatalogIds: parseIds(item.confirmedCatalogIds ?? []),
      })
    })
  } catch (error) { dispose(); throw error }
  return dispose
}
