/** Agent 应用命令与定向事件/反向交互；运行、权限和持久化只调用 core 协调器。 */
import { AgentServiceError } from '@axon/core'
import type { AxonBackend } from '@axon/core'
import { APP_SERVER_METHODS as methods, APP_SERVER_CLIENT_METHODS, APP_SERVER_NOTIFICATIONS } from '@axon/shared'
import type { AppServerClient, BackendAgentRunEvent, RpcJsonObject } from '@axon/shared'
import { RpcConnectionError, RpcFault } from './json-rpc-peer'
import type { JsonRpcPeer, RpcHandlerContext } from './json-rpc-peer'
import { toWireValue } from './wire-value'
import type { AppServerCommandContext, ResolveAppServerClient } from './rpc-command-context'

interface ClientRoute {
  backend: AxonBackend
  client: AppServerClient
  releases: Array<() => void>
  interactions: Map<string, { runId: string; controller: AbortController }>
}

export class AgentRpcRouter {
  private readonly routes = new Map<string, ClientRoute>()

  /** 固定业务白名单；父连接负责身份/字段校验，领域负载仍交给 core 严格解析。 */
  constructor(private readonly peer: JsonRpcPeer, resolve: ResolveAppServerClient) {
    const handle = (method: string, fields: readonly string[], action: (
      context: AppServerCommandContext, request: RpcHandlerContext,
    ) => unknown | Promise<unknown>): void => {
      peer.handle(method, async (params, request) => {
        const context = resolve(params, fields)
        request.signal.throwIfAborted()
        try { return toWireValue(await action(context, request)) }
        catch (error) {
          if (error instanceof AgentServiceError) throw new RpcFault(-32020, 'Agent 命令失败', { code: error.code })
          throw error
        }
      })
    }
    handle(methods.AGENT_LIST_SESSIONS, [], ({ backend }) => backend.agentRuns.listSessions())
    // 全局只读快照供 UI 恢复，不返回 owner 或赋予观察入口停止/审批权限。
    handle(methods.AGENT_LIST_ACTIVE_RUNS, [], ({ backend }) => backend.agentRuns.listActiveRuns())
    handle(methods.AGENT_IS_ACTIVE, ['input'], ({ backend, input }) => {
      if (typeof input !== 'string' || !input.trim()) throw new RpcFault(-32602, '会话标识无效')
      return backend.agentRuns.isActive(input)
    })
    handle(methods.AGENT_GET_SESSION, ['input'], ({ backend, input }) => backend.agentRuns.getSession(input))
    handle(methods.AGENT_CREATE_SESSION, ['input'], ({ backend, client, input }, { signal }) => {
      const ownerSignal = backend.clients.getSignal(client.clientId)!
      return backend.agentRuns.createSession(input, AbortSignal.any([signal, ownerSignal]))
    })
    handle(methods.AGENT_UPDATE_SESSION, ['input'], ({ backend, input }) => {
      if (!input || typeof input !== 'object' || Array.isArray(input)
        || Object.keys(input).some((key) => !['sessionId', 'update'].includes(key))) throw new RpcFault(-32602, '会话更新参数无效')
      return backend.agentRuns.updateSession(input.sessionId, input.update)
    })
    handle(methods.AGENT_DELETE_SESSION, ['input'], ({ backend, input }) => backend.agentRuns.deleteSession(input))
    handle(methods.AGENT_SEND, ['input'], ({ backend, client, input }) => backend.agentRuns.send(
      client.clientId, input, () => {}, {
        source: client.kind === 'external' ? 'external' : 'renderer',
        ...(client.kind === 'quick' ? { inputOrigin: 'quick' as const } : {}),
      },
    ))
    handle(methods.AGENT_GET_RUN, ['input'], ({ backend, client, input }) => {
      if (typeof input !== 'string' || !input.trim()) throw new RpcFault(-32602, '会话标识无效')
      return backend.agentRuns.getOwnedRun(client.clientId, input.trim()) ?? null
    })
    handle(methods.AGENT_STOP, ['input'], ({ backend, client, input }) => backend.agentRuns.stopRun(client.clientId, input))
    handle(methods.AGENT_LIST_QUEUE, ['input'], ({ backend, client, input }) => backend.agentRuns.listQueuedMessages(client.clientId, input))
    handle(methods.AGENT_CANCEL_QUEUE, ['input'], ({ backend, client, input }) => backend.agentRuns.cancelQueuedMessage(client.clientId, input))
    handle(methods.AGENT_MOVE_QUEUE, ['input'], ({ backend, client, input }) => backend.agentRuns.moveQueuedMessage(client.clientId, input))
  }

  /** 登记即订阅，先于首次发送；主/子及后台续跑使用执行层原始身份，不另造轮次。 */
  attach(backend: AxonBackend, client: AppServerClient): void {
    const route: ClientRoute = { backend, client, releases: [], interactions: new Map() }
    this.routes.set(client.clientId, route)
    try {
      route.releases.push(backend.agentRuns.subscribeRunEvents(client.clientId, (event) => this.onRunEvent(route, event)))
      route.releases.push(backend.agentRuns.subscribeClientQueueChanges(client.clientId, (snapshot) => {
        this.notify(route, APP_SERVER_NOTIFICATIONS.AGENT_QUEUE, { snapshot })
      }))
      route.releases.push(backend.agentRuns.subscribeSessionMetadata((event) => {
        this.notify(route, APP_SERVER_NOTIFICATIONS.AGENT_METADATA, { event })
      }))
    } catch (error) { this.detach(client.clientId); throw error }
  }

  private live(route: ClientRoute): boolean {
    return !this.peer.closed && this.routes.get(route.client.clientId) === route && route.backend.clients.has(route.client.clientId)
  }

  private notify(route: ClientRoute, method: string, params: Record<string, unknown>): void {
    if (!this.live(route)) return
    try { this.peer.notify(method, toWireValue({ clientId: route.client.clientId, ...params }) as RpcJsonObject) }
    catch { this.peer.close(new RpcConnectionError('protocol', 'Agent 事件无法传输')) }
  }

  /** 请求只走反向 RPC；解决/终态先撤销等待，普通事件再按原始顺序定向通知。 */
  private onRunEvent(route: ClientRoute, event: BackendAgentRunEvent): void {
    if (!this.live(route)) return
    const payload = event.event
    if (payload.type === 'permission_request' || payload.type === 'ask_user_request') {
      void this.interact(route, event)
      return
    }
    if (payload.type === 'permission_resolved' || payload.type === 'ask_user_resolved') {
      route.interactions.get(payload.requestId)?.controller.abort()
      route.interactions.delete(payload.requestId)
    } else if (payload.type === 'run_finished') {
      for (const [id, pending] of route.interactions) {
        if (pending.runId === event.run.runId) { pending.controller.abort(); route.interactions.delete(id) }
      }
    }
    this.notify(route, APP_SERVER_NOTIFICATIONS.AGENT_RUN, { event })
  }

  /** 答复只带 response；控制目标和 requestId 固定为发出时的真实主/子轮次。失败按拒绝/取消结算。 */
  private async interact(route: ClientRoute, envelope: BackendAgentRunEvent): Promise<void> {
    const event = envelope.event
    if (event.type !== 'permission_request' && event.type !== 'ask_user_request') return
    const permission = event.type === 'permission_request'
    const requestId = event.request.requestId
    const controller = new AbortController()
    const pending = { runId: envelope.run.runId, controller }
    route.interactions.set(requestId, pending)
    const target = { sessionId: envelope.run.sessionId, runId: envelope.run.runId }
    const respond = (response: unknown): boolean => permission
      ? route.backend.agentRuns.respondRunPermission(route.client.clientId, { ...target, response })
      : route.backend.agentRuns.respondRunAskUser(route.client.clientId, { ...target, response })
    const refuse = (): void => { respond({ requestId, behavior: permission ? 'deny' : 'cancel' }) }
    try {
      const response = await this.peer.request(permission ? APP_SERVER_CLIENT_METHODS.AGENT_PERMISSION : APP_SERVER_CLIENT_METHODS.AGENT_ASK_USER,
        { clientId: route.client.clientId, event: toWireValue(envelope) }, {
          signal: AbortSignal.any([controller.signal, route.backend.clients.getSignal(route.client.clientId)!]),
          // 审批与 core 的 expiresAt 对齐；追问沿用运行/入口生命周期，不套普通 30 秒超时。
          timeoutMs: event.type === 'permission_request' ? Math.max(1, event.request.expiresAt - Date.now()) : 0,
        })
      if (!this.live(route) || controller.signal.aborted) return
      route.interactions.delete(requestId)
      if (!response || typeof response !== 'object' || Array.isArray(response) || response.requestId !== requestId || !respond(response)) refuse()
    } catch {
      if (this.live(route) && !controller.signal.aborted) refuse()
    } finally {
      if (route.interactions.get(requestId) === pending) route.interactions.delete(requestId)
    }
  }

  /** 先撤销路由再取消反向等待；迟到答复不改投其他入口。 */
  detach(clientId: string): void {
    const route = this.routes.get(clientId)
    if (!route) return
    this.routes.delete(clientId)
    for (const release of route.releases) release()
    for (const pending of route.interactions.values()) pending.controller.abort()
    route.interactions.clear()
  }

  close(): void { for (const id of [...this.routes.keys()]) this.detach(id) }
}
