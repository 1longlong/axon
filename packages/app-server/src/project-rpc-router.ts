/** 项目/文件/记忆协议：路径与开关归 core，连接只拥有订阅代次及事件路由。 */
import { AgentProjectManagerError, AgentMemoryServiceError, WorkspaceFilePreviewError, WorkspaceFileDiffError } from '@axon/core'
import { APP_SERVER_METHODS as methods, APP_SERVER_NOTIFICATIONS as notices } from '@axon/shared'
import type { AppServerClient, AgentProjectWatchSubscription, RpcJsonObject } from '@axon/shared'
import { configObject } from './config-input'
import { RpcConnectionError, RpcFault } from './json-rpc-peer'
import type { JsonRpcPeer } from './json-rpc-peer'
import type { AppServerCommandContext, ResolveAppServerClient } from './rpc-command-context'
import { toWireValue } from './wire-value'
import { ProjectWatchRegistry, parseProjectWatchId, parseProjectWatchTarget } from './project-watch-registry'

type WatchKind = AgentProjectWatchSubscription['kind']

export class ProjectRpcRouter {
  private readonly watches = new ProjectWatchRegistry()

  /** 固定命令只调用领域 controller；写入成功后通知，文件访问不接收自报 cwd。 */
  constructor(private readonly peer: JsonRpcPeer, resolve: ResolveAppServerClient,
    private readonly getClients: () => Iterable<AppServerClient>) {
    const handle = (method: string, fields: readonly string[], action: (
      context: AppServerCommandContext,
      signal: AbortSignal,
    ) => unknown | Promise<unknown>): void => {
      peer.handle(method, async (params, { signal }) => {
        const context = resolve(params, fields)
        const ownerSignal = context.backend.clients.getSignal(context.client.clientId)
        if (!ownerSignal) throw new RpcFault(-32004, '客户端已断开')
        const stop = AbortSignal.any([signal, ownerSignal])
        if (stop.aborted) throw new RpcFault(-32800, '项目请求已取消')
        try { return toWireValue(await action(context, stop)) }
        catch (error) {
          if (stop.aborted || error instanceof Error && error.name === 'AbortError') throw new RpcFault(-32800, '项目请求已取消')
          if (error instanceof AgentProjectManagerError) throw new RpcFault(-32023, '项目命令失败', { code: error.code })
          if (error instanceof WorkspaceFilePreviewError || error instanceof WorkspaceFileDiffError) {
            throw new RpcFault(-32024, '工作区文件请求失败', { code: error.code })
          }
          if (error instanceof AgentMemoryServiceError) throw new RpcFault(-32025, '记忆命令失败', { code: error.code })
          throw error
        }
      })
    }
    handle(methods.PROJECT_LIST, [], ({ backend }) => backend.projectController.list())
    handle(methods.PROJECT_GET, ['input'], ({ backend, input }) => backend.projectController.get(input))
    handle(methods.PROJECT_CREATE, ['input'], (context) => {
      const project = context.backend.projectController.create(context.input)
      this.projectsChanged(context)
      return project
    })
    handle(methods.PROJECT_UPDATE, ['input'], (context) => {
      const input = configObject(context.input, ['projectId', 'update'])
      const update = configObject(input.update, ['name', 'workspace', 'memoryEnabled'])
      const project = context.backend.projectController.update(input.projectId, update)
      // 落盘成功才失效旧目录；失败保存不能把现有监听一起取消。
      if ('workspace' in update) {
        this.watches.invalidate(project.id, 'project_changed', 'workspace')
        this.watches.invalidate(project.id, update.memoryEnabled === false ? 'memory_disabled' : 'project_changed', 'memory')
      }
      else if (update.memoryEnabled === false) this.watches.invalidate(project.id, 'memory_disabled', 'memory')
      this.projectsChanged(context)
      return project
    })
    handle(methods.PROJECT_DELETE, ['input'], (context) => {
      const project = context.backend.projectController.delete(context.input)
      this.watches.invalidate(project.id, 'project_deleted')
      this.projectsChanged(context)
      return project
    })
    handle(methods.WORKSPACE_LIST_DIRECTORY, ['input'], ({ backend, input }, signal) => backend.projectController.listDirectory(input, signal))
    for (const [method, read] of [[methods.WORKSPACE_READ_FILE, 'readFile'], [methods.WORKSPACE_READ_DIFF, 'readDiff']] as const) {
      handle(method, ['input'], ({ backend, input }, signal) => {
        const value = configObject(input, ['projectId', 'relativePath'])
        return backend.projectController[read](value.projectId, value.relativePath, signal)
      })
    }
    handle(methods.MEMORY_LIST, ['input'], ({ backend, input }) => backend.memory.list(input))
    handle(methods.MEMORY_READ, ['input'], ({ backend, input }) => {
      const value = configObject(input, ['projectId', 'relativePath'])
      return backend.memory.read(value.projectId, value.relativePath)
    })
    handle(methods.MEMORY_WRITE, ['input'], ({ backend, input }) => {
      const value = configObject(input, ['projectId', 'relativePath', 'content'])
      return backend.memory.write(value.projectId, value.relativePath, value.content)
    })
    for (const [watch, unwatch, kind] of [[methods.WORKSPACE_WATCH, methods.WORKSPACE_UNWATCH, 'workspace'],
      [methods.MEMORY_WATCH, methods.MEMORY_UNWATCH, 'memory']] as const) {
      handle(watch, ['input'], (context) => this.watch(context, kind))
      handle(unwatch, ['input'], (context) => this.unwatch(context, kind))
    }
  }

  /** 同一入口/种类/项目只有一个监听；替换后旧代次的取消或回调无效。 */
  private watch(context: AppServerCommandContext, kind: WatchKind): AgentProjectWatchSubscription {
    const projectId = parseProjectWatchId(context.input)
    const { backend, client } = context
    return this.watches.watch(client.clientId, kind, projectId, {
      start: (emit) => {
        if (kind === 'workspace') backend.projectController.watchDirectory(client.clientId, projectId, emit)
        else backend.memory.watch(client.clientId, projectId, emit)
      },
      release: () => kind === 'workspace' ? backend.projectController.unwatchDirectory(client.clientId, projectId)
        : backend.memory.unwatch(client.clientId, projectId),
      changed: (event) => this.notify(context, kind === 'workspace' ? notices.WORKSPACE_CHANGED : notices.MEMORY_CHANGED, toWireValue(event) as RpcJsonObject),
      closed: (event) => this.notify(context, notices.PROJECT_WATCH_CLOSED, toWireValue(event) as RpcJsonObject),
    })
  }

  private unwatch(context: AppServerCommandContext, kind: WatchKind): boolean {
    return this.watches.unwatch(context.client.clientId, kind, parseProjectWatchTarget(context.input))
  }

  private projectsChanged(context: AppServerCommandContext): void {
    const projects = toWireValue(context.backend.projectController.list())
    for (const client of this.getClients()) this.notify({ ...context, client }, notices.PROJECTS_CHANGED, { projects })
  }

  private notify(context: AppServerCommandContext, method: string, payload: RpcJsonObject): void {
    if (this.peer.closed || !context.backend.clients.has(context.client.clientId)) return
    try { this.peer.notify(method, { clientId: context.client.clientId, ...payload }) }
    catch { this.peer.close(new RpcConnectionError('protocol', '项目事件无法传输')) }
  }

  detach(clientId: string): void { this.watches.detach(clientId) }
  close(): void { this.watches.close() }
}
