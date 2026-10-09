/** 项目/工作区/记忆固定代理；目录和文件边界由后端解析，原生选择器留在父进程。 */
import type { IpcMainInvokeEvent, WebContents } from 'electron'
import { toWireValue, parseProjectWatchId, parseProjectWatchTarget } from '@axon/app-server'
import { APP_SERVER_METHODS as methods, AGENT_PROJECT_IPC_CHANNELS as projects, AGENT_MEMORY_IPC_CHANNELS as memory } from '@axon/shared'
import type { AgentWorkspaceDirectorySelection, RpcJsonValue } from '@axon/shared'
import type { AppServerProcess } from '../lib/desktop/app-server-process'
import type { AppServerWindowClients } from '../lib/desktop/app-server-window-clients'
import { assertMainFrame } from './assert-main-frame'

export interface AppServerProjectIpcRegistrar {
  handle(channel: string, listener: (event: IpcMainInvokeEvent, ...args: unknown[]) => unknown): void
  removeHandler(channel: string): void
}
export interface AppServerProjectIpcOptions {
  backend: Pick<AppServerProcess, 'request'>
  clients: Pick<AppServerWindowClients, 'get' | 'getClientSignal' | 'matches'>
  pickLocalWorkspace: (sender: WebContents) => Promise<AgentWorkspaceDirectorySelection>
}
function id(value: unknown): string {
  if (typeof value !== 'string' || !value.trim()) throw new Error('项目标识参数无效')
  return value.trim()
}

/** 固定 CRUD/文件和精确监听代理不接受 cwd/owner/私有 RPC；事件代次由后端生成并由面板匹配。 */
export function registerAppServerProjectIpcHandlers(ipc: AppServerProjectIpcRegistrar, options: AppServerProjectIpcOptions): () => void {
  const registered: string[] = [], lifetime = new AbortController()
  type Method = Parameters<AppServerProcess['request']>[1]
  const context = async (sender: WebContents) => {
    const client = await options.clients.get(sender), page = options.clients.getClientSignal(client.clientId)
    if (!page || page.aborted) throw new Error('客户端页面已失效')
    const signal = AbortSignal.any([page, lifetime.signal])
    signal.throwIfAborted()
    return { clientId: client.clientId, page, signal }
  }
  const call = async (sender: WebContents, method: Method, input?: unknown): Promise<RpcJsonValue> => {
    const value = input === undefined ? undefined : toWireValue(input)
    const owner = await context(sender)
    return options.backend.request(owner.clientId, method, value, { signal: owner.signal })
  }
  const handle = (channel: string, count: number, action: (sender: WebContents, ...args: unknown[]) => unknown): void => {
    ipc.handle(channel, (event, ...args) => {
      assertMainFrame(event, 'Agent 项目')
      lifetime.signal.throwIfAborted()
      if (args.length !== count) throw new Error('项目 IPC 参数数量无效')
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
    handle(projects.LIST, 0, (sender) => call(sender, methods.PROJECT_LIST))
    handle(projects.GET, 1, (sender, projectId) => call(sender, methods.PROJECT_GET, id(projectId)))
    handle(projects.CREATE, 1, (sender, input) => call(sender, methods.PROJECT_CREATE, input))
    handle(projects.UPDATE, 2, (sender, projectId, update) => call(sender, methods.PROJECT_UPDATE, { projectId: id(projectId), update }))
    handle(projects.DELETE, 1, (sender, projectId) => call(sender, methods.PROJECT_DELETE, id(projectId)))
    handle(projects.PICK_LOCAL_WORKSPACE, 0, async (sender) => {
      const owner = await context(sender)
      const result = await options.pickLocalWorkspace(sender)
      // 系统目录对话框不提供取消 signal；返回后复核原页面，不把迟到路径交给重载的新页面。
      owner.signal.throwIfAborted()
      if (!options.clients.matches(sender, owner.clientId) || options.clients.getClientSignal(owner.clientId) !== owner.page) {
        throw new Error('目录选择的原页面已失效')
      }
      return result
    })
    handle(projects.LIST_DIRECTORY, 1, (sender, projectId) => call(sender, methods.WORKSPACE_LIST_DIRECTORY, id(projectId)))
    handle(projects.READ_FILE, 2, (sender, projectId, relativePath) => call(sender, methods.WORKSPACE_READ_FILE, { projectId: id(projectId), relativePath }))
    handle(projects.READ_DIFF, 2, (sender, projectId, relativePath) => call(sender, methods.WORKSPACE_READ_DIFF, { projectId: id(projectId), relativePath }))
    handle(memory.LIST, 1, (sender, projectId) => call(sender, methods.MEMORY_LIST, id(projectId)))
    handle(memory.READ, 2, (sender, projectId, relativePath) => call(sender, methods.MEMORY_READ, { projectId: id(projectId), relativePath }))
    handle(memory.WRITE, 3, (sender, projectId, relativePath, content) => call(sender, methods.MEMORY_WRITE, { projectId: id(projectId), relativePath, content }))
    handle(projects.WATCH_DIRECTORY, 1, (sender, projectId) => call(sender, methods.WORKSPACE_WATCH, parseProjectWatchId(projectId)))
    handle(projects.UNWATCH_DIRECTORY, 1, (sender, target) => call(sender, methods.WORKSPACE_UNWATCH, parseProjectWatchTarget(target)))
    handle(memory.WATCH, 1, (sender, projectId) => call(sender, methods.MEMORY_WATCH, parseProjectWatchId(projectId)))
    handle(memory.UNWATCH, 1, (sender, target) => call(sender, methods.MEMORY_UNWATCH, parseProjectWatchTarget(target)))
  } catch (error) { dispose(); throw error }
  return dispose
}
