/** 应用连接状态与可信客户端边界；业务状态仍由 core 持有，不依赖窗口或 Runtime。 */
import { randomUUID } from 'node:crypto'
import { AsyncWorkTracker } from '@axon/core'
import type { AxonBackend } from '@axon/core'
import { APP_SERVER_METHODS, APP_SERVER_PROTOCOL_VERSION } from '@axon/shared'
import type {
  AppServerCapabilities,
  AppServerClient,
  AppServerClientKind,
  AppServerInitializeInput,
  AppServerInitializeResult,
  RpcJsonObject,
  RpcParams,
} from '@axon/shared'
import { RpcFault } from './json-rpc-peer'
import type { JsonRpcPeer } from './json-rpc-peer'
import { toWireValue } from './wire-value'
import { AgentRpcRouter } from './agent-rpc-router'
import { ChatRpcRouter } from './chat-rpc-router'
import { ConfigRpcRouter } from './config-rpc-router'
import { ProjectRpcRouter } from './project-rpc-router'
import { McpRpcRouter } from './mcp-rpc-router'
import { TaskRpcRouter } from './task-rpc-router'
import { CapabilityRpcRouter } from './capability-rpc-router'
import { HistoryRpcRouter } from './history-rpc-router'
import type { ResolveAppServerClient } from './rpc-command-context'

export interface AppServerBootstrap {
  backend: AxonBackend
  applicationVersion: string
  /** 入口根据真实 adapter/宿主报告能力，不读取 Runtime SDK 类型。 */
  capabilities: AppServerCapabilities
}
export interface AppServerConnectionOptions {
  peer: JsonRpcPeer
  bootstrap: (input: AppServerInitializeInput, signal: AbortSignal) => AppServerBootstrap | Promise<AppServerBootstrap>
  maxClients?: number
}
type ConnectionState = 'new' | 'initializing' | 'ready' | 'failed' | 'closed'

/** 装配资源清理失败与普通初始化失败分开；连接必须把它计入退出诊断。 */
export class AppServerBootstrapCleanupError extends Error {
  constructor() { super('后端装配资源清理失败') }
}

function object(value: unknown, fields: readonly string[]): RpcJsonObject {
  if (!value || typeof value !== 'object' || Array.isArray(value)
    || Object.keys(value).some((key) => !fields.includes(key))) throw new RpcFault(-32602, '应用请求参数无效')
  return value as RpcJsonObject
}
function text(value: unknown): string {
  if (typeof value !== 'string' || !value.trim() || value.length > 200) throw new RpcFault(-32602, '应用请求标识无效')
  return value.trim()
}
/** 初始化只接受固定字段，不允许通过握手自报数据目录、clientId 或执行权限。 */
function parseInitialize(params: RpcParams): AppServerInitializeInput {
  const input = object(params, ['protocolVersion', 'client', 'hostCapabilities'])
  if (input.protocolVersion !== APP_SERVER_PROTOCOL_VERSION) {
    throw new RpcFault(-32006, '应用协议版本不匹配', { supportedVersion: APP_SERVER_PROTOCOL_VERSION })
  }
  const client = object(input.client, ['name', 'version'])
  const host = object(input.hostCapabilities, ['credentialStorage', 'channelTargetConfirmation'])
  if (host.credentialStorage !== 'safe-storage' && host.credentialStorage !== 'unavailable'
    || typeof host.channelTargetConfirmation !== 'boolean') throw new RpcFault(-32602, '宿主能力声明无效')
  return {
    protocolVersion: APP_SERVER_PROTOCOL_VERSION,
    client: { name: text(client.name), version: text(client.version) },
    hostCapabilities: { credentialStorage: host.credentialStorage, channelTargetConfirmation: host.channelTargetConfirmation },
  }
}

export class AppServerConnection {
  private state: ConnectionState = 'new'
  private bootstrapResult?: AppServerBootstrap
  private readonly connectionId = randomUUID()
  private readonly clients = new Map<string, AppServerClient>()
  private readonly maxClients: number
  private readonly unsubscribePeer: () => void
  private readonly agentRouter: AgentRpcRouter
  private readonly projectRouter: ProjectRpcRouter
  private readonly taskRouter: TaskRpcRouter
  private unsubscribeClients = (): void => {}
  private readonly work = new AsyncWorkTracker()
  private readonly cleanupFailures: Error[] = []
  private draining?: Promise<void>

  get closed(): boolean { return this.state === 'closed' }

  /** 先安装初始化/身份命令与关闭回调；业务处理必须经过 ready 和连接归属校验。 */
  constructor(private readonly options: AppServerConnectionOptions) {
    this.maxClients = options.maxClients ?? 128
    if (!Number.isSafeInteger(this.maxClients) || this.maxClients <= 0) throw new Error('客户端数量限制无效')
    const resolve: ResolveAppServerClient = (params, fields) => {
      const input = object(params, ['clientId', ...fields])
      const client = this.requireClient({ clientId: input.clientId! })
      return { backend: this.requireReady().backend, client, input: input.input }
    }
    this.agentRouter = new AgentRpcRouter(options.peer, resolve)
    new ChatRpcRouter(options.peer, resolve)
    new ConfigRpcRouter(options.peer, resolve, () => this.clients.values())
    this.projectRouter = new ProjectRpcRouter(options.peer, resolve, () => this.clients.values())
    new McpRpcRouter(options.peer, resolve)
    this.taskRouter = new TaskRpcRouter(options.peer, resolve)
    new CapabilityRpcRouter(options.peer, resolve)
    new HistoryRpcRouter(options.peer, resolve)
    this.unsubscribePeer = options.peer.onClose(() => this.close())
    options.peer.handle(APP_SERVER_METHODS.INITIALIZE, (params, { signal }) => this.work.run(() => this.initialize(params, signal)))
    options.peer.handle(APP_SERVER_METHODS.REGISTER_CLIENT, (params) => toWireValue(this.registerClient(params)))
    options.peer.handle(APP_SERVER_METHODS.DETACH_CLIENT, (params) => {
      const client = this.requireClient(params)
      return this.detachClient(client.clientId)
    })
    options.peer.handle(APP_SERVER_METHODS.GET_SETTINGS, (params) => {
      this.requireClient(params)
      return toWireValue(this.requireReady().backend.settings.get())
    })
    options.peer.handle(APP_SERVER_METHODS.GET_CAPABILITIES, (params) => {
      this.requireClient(params)
      return toWireValue(this.requireReady().capabilities)
    })
    options.peer.handle(APP_SERVER_METHODS.GET_USER_PROFILE, (params) => {
      this.requireClient(params)
      return toWireValue(this.requireReady().backend.userProfile.get())
    })
  }

  /** 握手成功前不创建后端；初始化取消/断开时不能接纳迟到的装配结果。 */
  private async initialize(params: RpcParams, signal: AbortSignal) {
    if (this.state !== 'new') throw new RpcFault(-32005, '连接已初始化、正在初始化或不可用')
    const input = parseInitialize(params)
    this.state = 'initializing'
    const onAbort = (): void => this.close()
    signal.addEventListener('abort', onAbort, { once: true })
    try {
      const result = await this.options.bootstrap(input, signal)
      if (this.closed || signal.aborted || this.options.peer.closed) {
        this.releaseBackend(result.backend)
        throw new RpcFault(-32800, '后端初始化已取消')
      }
      // 先固定后端归属和注销回调，再开放业务；初始化响应也先检查可传输性。
      this.bootstrapResult = result
      const response: AppServerInitializeResult = {
        protocolVersion: APP_SERVER_PROTOCOL_VERSION, connectionId: this.connectionId,
        applicationVersion: result.applicationVersion, dataDirectory: result.backend.paths.dataDir,
        capabilities: result.capabilities,
      }
      const encoded = toWireValue(response)
      this.unsubscribeClients = result.backend.clients.subscribeDetached((id) => {
        this.clients.delete(id)
        this.agentRouter.detach(id)
        this.projectRouter.detach(id)
        this.taskRouter.detach(id)
      })
      this.state = 'ready'
      return encoded
    } catch (error) {
      if (error instanceof AppServerBootstrapCleanupError) this.cleanupFailures.push(new Error('连接装配资源清理失败'))
      if (!this.closed) {
        this.state = 'failed'
        const backend = this.bootstrapResult?.backend
        this.bootstrapResult = undefined
        if (backend) this.releaseBackend(backend)
      }
      if (error instanceof RpcFault) throw error
      throw new RpcFault(-32003, '后端初始化失败')
    } finally { signal.removeEventListener('abort', onAbort) }
  }

  private requireReady(): AppServerBootstrap {
    if (this.state !== 'ready' || !this.bootstrapResult) throw new RpcFault(-32002, '后端尚未初始化或连接不可用')
    return this.bootstrapResult
  }

  /** 只接受登记来源，随机 ID 由 core 生成；不能把另一个连接的身份带入本连接。 */
  private registerClient(params: RpcParams): AppServerClient {
    const { backend } = this.requireReady()
    const input = object(params, ['kind'])
    if (typeof input.kind !== 'string' || !['main', 'quick', 'external'].includes(input.kind)) {
      throw new RpcFault(-32602, '客户端来源无效')
    }
    if (this.clients.size >= this.maxClients) throw new RpcFault(-32001, '本连接客户端数量超过限制')
    const client: AppServerClient = { clientId: backend.clients.register(), kind: input.kind as AppServerClientKind }
    this.clients.set(client.clientId, client)
    try { this.agentRouter.attach(backend, client) }
    catch (error) { this.detachClient(client.clientId); throw error }
    return client
  }

  private requireClient(params: RpcParams): AppServerClient {
    const { backend } = this.requireReady()
    const input = object(params, ['clientId'])
    const id = text(input.clientId)
    const client = this.clients.get(id)
    if (!client || !backend.clients.has(id)) throw new RpcFault(-32004, '客户端未登记、已断开或不属于本连接')
    return client
  }

  /** 先失效连接内的身份，再通知 core 停止其运行与订阅，不影响其他逻辑入口。 */
  private detachClient(clientId: string): boolean {
    if (!this.clients.delete(clientId)) return false
    this.agentRouter.detach(clientId)
    this.projectRouter.detach(clientId)
    this.taskRouter.detach(clientId)
    return this.bootstrapResult?.backend.clients.detach(clientId) ?? false
  }
  /** 已清空连接引用的后端仍须登记真实等待；清理失败不保留底层敏感原因。 */
  private releaseBackend(backend: AxonBackend): void {
    this.clean(() => backend.dispose())
    void this.work.run(async () => {
      try { await backend.drain() }
      catch { this.cleanupFailures.push(new Error('连接后端异步清理失败')) }
    })
  }

  private clean(action: () => void): void {
    try { action() } catch { this.cleanupFailures.push(new Error('连接同步资源清理失败')) }
  }

  /** 先失效入口再逐项清理；关闭立即生效，真实初始化/后端结束由 drain 等待。 */
  close(): void {
    if (this.state === 'closed') return
    this.state = 'closed'
    const backend = this.bootstrapResult?.backend
    this.bootstrapResult = undefined
    const ids = [...this.clients.keys()]
    this.clients.clear()
    this.clean(() => this.unsubscribePeer?.())
    this.clean(() => this.unsubscribeClients())
    // 路由解绑异常不能跳过其他窗口身份、后端资源或物理管道的收束。
    for (const id of ids) this.clean(() => { backend?.clients.detach(id) })
    this.clean(() => this.agentRouter.close())
    this.clean(() => this.projectRouter.close())
    this.clean(() => this.taskRouter.close())
    if (backend) this.releaseBackend(backend)
    this.clean(() => this.options.peer.close())
  }

  /** 关闭后循环等待初始化及其迟到资源回收，不能以处理信号取消代替实际结束。 */
  drain(): Promise<void> {
    if (!this.closed) return Promise.reject(new Error('必须先关闭连接再等待资源结束'))
    return this.draining ??= this.work.drain().then(() => {
      if (this.cleanupFailures.length) throw new AggregateError([...this.cleanupFailures], '连接资源等待失败')
    })
  }
}
