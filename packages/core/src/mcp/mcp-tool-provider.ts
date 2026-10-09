/** MCP Client 桥接层：管理项目连接，并把协议工具转换成 runtime 无关的自定义工具。 */

import { createHash } from 'node:crypto'
import { waitWithSignal } from '../async/wait-with-signal'
import { AsyncWorkTracker } from '../async/async-work-tracker'
import { Client } from '@modelcontextprotocol/sdk/client/index.js'
import { getDefaultEnvironment, StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js'
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js'
import type { Transport } from '@modelcontextprotocol/sdk/shared/transport.js'
import type {
  AgentCustomToolDefinition,
  AgentCustomToolResult,
  McpListedToolInfo,
  McpProjectConfig,
  McpServerConfig,
} from '@axon/shared'

const MAX_TOOL_PAGES = 100
const MAX_TOOLS_PER_SERVER = 1_024

interface McpRequestOptions {
  signal?: AbortSignal
  timeout: number
  resetTimeoutOnProgress: boolean
}

interface McpListToolsResult {
  tools: McpListedToolInfo[]
  nextCursor?: string
}

type McpCallToolResult =
  | { toolResult: unknown }
  | {
      content: unknown
      isError?: boolean
      structuredContent?: Record<string, unknown>
      _meta?: Record<string, unknown>
    }

export interface McpClientSession {
  listTools(params: { cursor?: string } | undefined, options: McpRequestOptions): Promise<McpListToolsResult>
  callTool(params: { name: string; arguments: Record<string, unknown> }, options: McpRequestOptions): Promise<McpCallToolResult>
  close(): Promise<void>
}

export interface ConnectedMcpClientSession {
  client: McpClientSession
  ready: Promise<void>
}

interface McpConnection {
  client: McpClientSession
  configHash: string
  ready: Promise<void>
  leases: number
  stale: boolean
  closing?: Promise<void>
}

interface AcquiredConnection {
  connection: McpConnection
  release: () => void
}

export class McpToolProviderError extends Error {
  constructor(
    readonly code: 'required_server_unavailable' | 'tool_call_failed',
    message: string,
    readonly serverName: string,
    readonly rootCause?: unknown,
  ) {
    super(message)
    this.name = 'McpToolProviderError'
  }
}

export interface McpToolProviderOptions {
  applicationVersion: string
  getProjectConfig: (projectId: string) => Promise<McpProjectConfig>
  /** 测试可替换协议会话；生产默认使用官方 MCP SDK。 */
  connectServer?: (config: McpServerConfig) => ConnectedMcpClientSession
}

function serverConfigHash(config: McpServerConfig): string {
  return createHash('sha256').update(JSON.stringify(config)).digest('hex')
}

function normalizedName(value: string): string {
  const normalized = value.replace(/[^A-Za-z0-9_]/g, '_').replace(/_+/g, '_')
  return normalized.replace(/^_+|_+$/g, '') || 'tool'
}

function toolDefinitionName(serverName: string, toolName: string): string {
  const fullName = `mcp__${normalizedName(serverName)}__${normalizedName(toolName)}`
  if (fullName.length <= 64) return fullName
  const suffix = createHash('sha256').update(fullName).digest('hex').slice(0, 8)
  return `${fullName.slice(0, 55)}_${suffix}`
}

function createTransport(config: McpServerConfig): Transport {
  if (config.type === 'stdio') {
    const transport = new StdioClientTransport({
      command: config.command,
      ...(config.args ? { args: config.args } : {}),
      ...(config.env ? { env: { ...getDefaultEnvironment(), ...config.env } } : {}),
      stderr: 'pipe',
    })
    // 当前阶段不展示 server 日志，但必须持续排空 stderr，避免子进程因管道写满而阻塞。
    transport.stderr?.on('data', () => undefined)
    return transport
  }
  return new StreamableHTTPClientTransport(new URL(config.url), {
    requestInit: config.headers ? { headers: config.headers } : undefined,
  })
}

/** 将官方 SDK 的宽类型收束为连接管理器真正需要的最小 Client 能力。 */
function connectSdkServer(config: McpServerConfig, applicationVersion: string, signal?: AbortSignal): ConnectedMcpClientSession {
  const sdkClient = new Client({ name: 'axon', version: applicationVersion }, { capabilities: {} })
  const transport = createTransport(config)
  // SDK 的 stdio close 在最后 SIGKILL 后可能先返回；进程 close 事件才证明管道已退出。
  let processClosed = (): void => {}
  const closed = new Promise<void>((resolve) => { processClosed = resolve })
  if (transport instanceof StdioClientTransport) transport.onclose = processClosed
  const ready = sdkClient.connect(transport, { timeout: config.startupTimeoutMs, signal })
  const hasProcess = transport instanceof StdioClientTransport && transport.pid !== null
  const client: McpClientSession = {
    listTools: (params, options) => sdkClient.listTools(params, options),
    callTool: async (params, options) => (
      await sdkClient.callTool(params, undefined, options) as McpCallToolResult
    ),
    close: async () => {
      await sdkClient.close()
      if (hasProcess) await closed
    },
  }
  return {
    client,
    ready,
  }
}

function abortError(): Error {
  return new DOMException('MCP 操作已取消', 'AbortError')
}

function resultContent(value: unknown): AgentCustomToolResult['content'] {
  if (!Array.isArray(value)) return [{ type: 'text', text: JSON.stringify(value) ?? '' }]
  return value.map((block) => {
    if (block && typeof block === 'object') {
      const record = block as Record<string, unknown>
      if (record.type === 'text' && typeof record.text === 'string') {
        return { type: 'text' as const, text: record.text }
      }
      if (
        record.type === 'image' && typeof record.data === 'string'
        && typeof record.mimeType === 'string'
      ) return { type: 'image' as const, data: record.data, mimeType: record.mimeType }
    }
    // 中立工具结果只约定文本和图片，其余协议块转成 JSON 文本保留语义。
    return { type: 'text' as const, text: JSON.stringify(block) ?? '' }
  })
}

/** 握手后的工具发现同时供 Agent 注入与临时连接测试使用，保持分页和数量边界一致。 */
async function collectTools(client: McpClientSession, config: McpServerConfig, signal?: AbortSignal): Promise<McpListedToolInfo[]> {
  const tools: McpListedToolInfo[] = []
  const seenCursors = new Set<string>()
  let cursor: string | undefined
  for (let page = 0; page < MAX_TOOL_PAGES; page += 1) {
    if (signal?.aborted) throw abortError()
    const result = await client.listTools(
      cursor ? { cursor } : undefined,
      { signal, timeout: config.requestTimeoutMs, resetTimeoutOnProgress: true },
    )
    if (signal?.aborted) throw abortError()
    // 测试页需要看到 tools/list 的完整条目，不能丢弃服务端附加的 schema/annotations 字段。
    tools.push(...result.tools)
    if (tools.length > MAX_TOOLS_PER_SERVER) throw new Error('服务器返回的工具数量超过 1024')
    if (!result.nextCursor) return tools
    if (seenCursors.has(result.nextCursor)) throw new Error('服务器返回了重复分页游标')
    seenCursors.add(result.nextCursor)
    cursor = result.nextCursor
  }
  throw new Error('服务器工具分页超过 100 页')
}

/**
 * 每轮按项目配置发现 MCP 工具；连接按“项目 + 服务器 + 配置哈希”复用，
 * 配置变化时旧连接先标记过期，待现有调用释放后再关闭。
 */
export class McpToolProvider {
  private readonly connections = new Map<string, McpConnection>()
  private readonly liveConnections = new Set<McpConnection>()
  private readonly lifetime = new AbortController()
  private readonly work = new AsyncWorkTracker()
  private readonly closeFailures: Error[] = []
  private draining?: Promise<void>

  constructor(private readonly options: McpToolProviderOptions) {}

  /** 草稿测试独立于 Agent 租约；取消/退出结束等待并关闭临时连接，迟到握手不得继续发现工具。 */
  testConnection(config: McpServerConfig, signal?: AbortSignal): Promise<McpListedToolInfo[]> {
    return this.work.run(() => this.executeTestConnection(config, signal))
  }

  /** 临时会话依次握手、分页、关闭；取消提前结束响应等待，但底层工作继续登记。 */
  private async executeTestConnection(config: McpServerConfig, signal?: AbortSignal): Promise<McpListedToolInfo[]> {
    const combined = this.operationSignal(signal)
    if (combined.aborted) throw abortError()
    const connected = this.options.connectServer?.(config) ?? connectSdkServer(config, this.options.applicationVersion, combined)
    let tools: McpListedToolInfo[]
    try {
      await waitWithSignal(this.work.run(() => connected.ready), combined)
      if (combined.aborted) throw abortError()
      tools = await waitWithSignal(this.work.run(() => collectTools(connected.client, config, combined)), combined)
    } finally {
      await this.closeClient(connected.client)
    }
    // 关闭本身也是异步等待；此期间取消不能把已取得的工具列表作为成功交付。
    if (combined.aborted) throw abortError()
    return tools
  }

  /** 登记完整发现链，退出取消等待；被取消的底层解密/分页仍由 drain 等待。 */
  getTools(projectId: string, signal?: AbortSignal): Promise<AgentCustomToolDefinition[]> {
    return this.work.run(() => this.discoverTools(projectId, this.operationSignal(signal)))
  }

  /** 解密配置后并行发现服务器；取消优先于可选服务器降级，避免退出返回半份目录。 */
  private async discoverTools(projectId: string, signal: AbortSignal): Promise<AgentCustomToolDefinition[]> {
    if (signal?.aborted) throw abortError()
    const config = await waitWithSignal(this.work.run(() => this.options.getProjectConfig(projectId)), signal)
    if (signal?.aborted) throw abortError()
    const definitions: AgentCustomToolDefinition[] = []
    const usedNames = new Set<string>()

    // 各服务器互不依赖，并行连接可把启动等待限制在最慢的一台，而不是所有超时之和。
    const enabledServers = Object.entries(config.servers).filter(([, server]) => server.enabled)
    const discoveries = await Promise.allSettled(enabledServers.map(async ([serverName, server]) => ({
      serverName,
      server,
      tools: await this.listTools(projectId, serverName, server, signal),
    })))
    if (signal.aborted) throw abortError()

    for (const [index, discovery] of discoveries.entries()) {
      const [serverName, server] = enabledServers[index]!
      try {
        if (discovery.status === 'rejected') throw discovery.reason
        const candidateNames = new Set(usedNames)
        const candidates = discovery.value.tools.map((tool) => {
          const name = toolDefinitionName(serverName, tool.name)
          if (candidateNames.has(name)) throw new Error(`工具名称规范化后冲突：${name}`)
          candidateNames.add(name)
          return { name, tool }
        })
        for (const candidate of candidates) usedNames.add(candidate.name)
        definitions.push(...candidates.map(({ name, tool }) => (
          this.createTool(projectId, serverName, server, tool, name)
        )))
      } catch (error) {
        if (signal?.aborted) throw error
        if (server.required) {
          throw new McpToolProviderError(
            'required_server_unavailable',
            `必需的 MCP 服务器“${serverName}”不可用`,
            serverName,
            error,
          )
        }
        console.warn(`[MCP] 可选服务器“${serverName}”不可用，本轮已跳过:`, error)
      }
    }
    return definitions
  }

  /** 退出先封住操作并取消，再关闭全部连接；配置淘汰仍按租约延迟关闭，与退出分开。 */
  dispose(): void {
    if (this.lifetime.signal.aborted) return
    this.lifetime.abort(abortError())
    this.connections.clear()
    // 过期连接可能已不在缓存中但仍有租约，退出也必须关闭它们。
    for (const connection of this.liveConnections) {
      connection.stale = true
      void this.close(connection)
    }
  }

  /** 取消不等于资源关闭；等待真实操作/握手/关闭完成，关闭失败以固定诊断报告。 */
  drain(): Promise<void> {
    if (!this.lifetime.signal.aborted) return Promise.reject(new Error('必须先释放 MCP 服务再等待退出'))
    return this.draining ??= this.work.drain().then(() => {
      if (this.closeFailures.length) throw new AggregateError(this.closeFailures, 'MCP 连接未完整关闭')
    })
  }

  private operationSignal(signal?: AbortSignal): AbortSignal {
    return signal ? AbortSignal.any([signal, this.lifetime.signal]) : this.lifetime.signal
  }

  /** 配置保存后只淘汰所属项目连接，其他项目及当前持有的调用租约不受影响。 */
  disposeProject(projectId: string): void {
    const prefix = `${projectId}:`
    for (const [key, connection] of this.connections) {
      if (!key.startsWith(prefix)) continue
      this.connections.delete(key)
      this.markStale(connection)
    }
  }

  private async listTools(
    projectId: string,
    serverName: string,
    config: McpServerConfig,
    signal?: AbortSignal,
  ): Promise<McpListedToolInfo[]> {
    const acquired = await this.acquire(projectId, serverName, config, signal)
    try {
      return await waitWithSignal(this.work.run(() => collectTools(acquired.connection.client, config, signal)), signal)
    } finally {
      acquired.release()
    }
  }

  /** 生成中立工具，执行仍回到当前连接租约；旧定义不能绕过后端退出边界。 */
  private createTool(
    projectId: string,
    serverName: string,
    config: McpServerConfig,
    tool: McpListedToolInfo,
    name: string,
  ): AgentCustomToolDefinition {
    return {
      name,
      description: tool.description
        ? `[MCP ${serverName}/${tool.name}] ${tool.description}`
        : `调用 MCP 服务器 ${serverName} 的 ${tool.name} 工具`,
      inputSchema: tool.inputSchema,
      isDeferred: true,
      execute: (input, context) => this.work.run(async () => {
        const signal = this.operationSignal(context.signal)
        const acquired = await this.acquire(projectId, serverName, config, signal)
        try {
          const result = await waitWithSignal(this.work.run(() => acquired.connection.client.callTool(
            { name: tool.name, arguments: input },
            { signal, timeout: config.requestTimeoutMs, resetTimeoutOnProgress: true },
          )), signal)
          if (signal.aborted) throw abortError()
          if ('toolResult' in result) {
            return { content: [{ type: 'text', text: JSON.stringify(result.toolResult) ?? '' }], details: result }
          }
          return {
            content: resultContent(result.content),
            ...(result.isError ? { isError: true } : {}),
            details: result.structuredContent ?? result._meta,
          }
        } catch (error) {
          if (signal.aborted) throw abortError()
          throw new McpToolProviderError(
            'tool_call_failed',
            `MCP 工具调用失败：${serverName}/${tool.name}`,
            serverName,
            error,
          )
        } finally {
          acquired.release()
        }
      }),
    }
  }

  /** 获取连接租约；连接失败会从缓存移除，下一轮可以重新建立而不会复用失败 Promise。 */
  private async acquire(
    projectId: string,
    serverName: string,
    config: McpServerConfig,
    signal?: AbortSignal,
  ): Promise<AcquiredConnection> {
    if (this.lifetime.signal.aborted || signal?.aborted) throw abortError()
    const key = `${projectId}:${serverName}`
    const configHash = serverConfigHash(config)
    let connection = this.connections.get(key)
    if (connection && connection.configHash !== configHash) {
      this.connections.delete(key)
      this.markStale(connection)
      connection = undefined
    }
    if (!connection) {
      connection = this.createConnection(config, configHash)
      this.connections.set(key, connection)
    }
    connection.leases += 1
    let released = false
    const release = () => {
      if (released) return
      released = true
      connection!.leases -= 1
      if (connection!.stale && connection!.leases === 0) void this.close(connection!)
    }
    try {
      await waitWithSignal(connection.ready, signal)
      if (this.lifetime.signal.aborted || signal?.aborted) throw abortError()
      return { connection, release }
    } catch (error) {
      release()
      if (this.connections.get(key) === connection) this.connections.delete(key)
      this.markStale(connection)
      throw error
    }
  }

  /** 握手与真实连接同时登记；缓存淘汰不丢弃仍需关闭的连接。 */
  private createConnection(config: McpServerConfig, configHash: string): McpConnection {
    const connected = this.options.connectServer?.(config) ?? connectSdkServer(config, this.options.applicationVersion, this.lifetime.signal)
    const connection: McpConnection = {
      client: connected.client,
      configHash,
      leases: 0,
      stale: false,
      ready: Promise.resolve(),
    }
    this.liveConnections.add(connection)
    // connect 自带初始化握手；startupTimeout 同时约束传输建立和 initialize 响应。
    connection.ready = this.work.run(() => connected.ready)
      .catch(async (error: unknown) => {
        await this.close(connection)
        throw error
      })
    return connection
  }

  private markStale(connection: McpConnection): void {
    connection.stale = true
    if (connection.leases === 0) void this.close(connection)
  }

  /** 同一连接共享关闭 Promise，避免第一次关闭尚未结束时第二次误判为已结束。 */
  private close(connection: McpConnection): Promise<void> {
    return connection.closing ??= this.closeClient(connection.client).finally(() => {
      this.liveConnections.delete(connection)
    })
  }

  /** 登记实际关闭，逐项收束失败；最终 drain 报告固定错误，不泄漏 SDK 原因。 */
  private closeClient(client: McpClientSession): Promise<void> {
    return this.work.run(async () => {
      try { await client.close() }
      catch {
        this.closeFailures.push(new Error('MCP 连接关闭失败'))
        console.warn('[MCP] 关闭连接失败')
      }
    })
  }
}
