/** MCP Client 桥接层：管理项目连接，并把协议工具转换成 runtime 无关的自定义工具。 */

import { createHash } from 'node:crypto'
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
  closed: boolean
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
  getProjectConfig: (projectId: string) => McpProjectConfig
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
function connectSdkServer(config: McpServerConfig): ConnectedMcpClientSession {
  const sdkClient = new Client({ name: 'axon', version: '0.1.0' }, { capabilities: {} })
  const transport = createTransport(config)
  const client: McpClientSession = {
    listTools: (params, options) => sdkClient.listTools(params, options),
    callTool: async (params, options) => (
      await sdkClient.callTool(params, undefined, options) as McpCallToolResult
    ),
    close: () => sdkClient.close(),
  }
  return {
    client,
    ready: sdkClient.connect(transport, { timeout: config.startupTimeoutMs }),
  }
}

function abortError(): Error {
  return new DOMException('MCP 操作已取消', 'AbortError')
}

/** 等待共享连接时只取消当前调用者，不用一个会话的停止信号关闭其他会话正在复用的连接。 */
function waitWithSignal<T>(promise: Promise<T>, signal?: AbortSignal): Promise<T> {
  if (!signal) return promise
  if (signal.aborted) return Promise.reject(abortError())
  return new Promise<T>((resolve, reject) => {
    const onAbort = () => reject(abortError())
    signal.addEventListener('abort', onAbort, { once: true })
    promise.then(
      (value) => { signal.removeEventListener('abort', onAbort); resolve(value) },
      (error: unknown) => { signal.removeEventListener('abort', onAbort); reject(error) },
    )
  })
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
    // Pi 当前只接受文本和图片；资源、音频和链接保留完整 JSON 语义后交给模型。
    return { type: 'text' as const, text: JSON.stringify(block) ?? '' }
  })
}

/** 握手后的工具发现同时供 Agent 注入与临时连接测试使用，保持分页和数量边界一致。 */
async function collectTools(client: McpClientSession, config: McpServerConfig, signal?: AbortSignal): Promise<McpListedToolInfo[]> {
  const tools: McpListedToolInfo[] = []
  const seenCursors = new Set<string>()
  let cursor: string | undefined
  for (let page = 0; page < MAX_TOOL_PAGES; page += 1) {
    const result = await client.listTools(
      cursor ? { cursor } : undefined,
      { signal, timeout: config.requestTimeoutMs, resetTimeoutOnProgress: true },
    )
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

  constructor(private readonly options: McpToolProviderOptions) {}

  /** 用未保存草稿建立一次独立连接，验证 initialize 与 tools/list 后必定关闭，不进入 Agent 连接缓存。 */
  async testConnection(config: McpServerConfig): Promise<McpListedToolInfo[]> {
    const connected = this.options.connectServer?.(config) ?? connectSdkServer(config)
    try {
      await connected.ready
      return await collectTools(connected.client, config)
    } finally {
      try { await connected.client.close() }
      catch (error) { console.warn('[MCP] 关闭测试连接失败:', error) }
    }
  }

  async getTools(projectId: string, signal?: AbortSignal): Promise<AgentCustomToolDefinition[]> {
    const config = this.options.getProjectConfig(projectId)
    const definitions: AgentCustomToolDefinition[] = []
    const usedNames = new Set<string>()

    // 各服务器互不依赖，并行连接可把启动等待限制在最慢的一台，而不是所有超时之和。
    const enabledServers = Object.entries(config.servers).filter(([, server]) => server.enabled)
    const discoveries = await Promise.allSettled(enabledServers.map(async ([serverName, server]) => ({
      serverName,
      server,
      tools: await this.listTools(projectId, serverName, server, signal),
    })))

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

  /** 应用退出时立即令缓存失效；没有活跃调用的连接会在此处完成关闭。 */
  dispose(): void {
    for (const [key, connection] of this.connections) {
      this.connections.delete(key)
      this.markStale(connection)
    }
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
      return await collectTools(acquired.connection.client, config, signal)
    } finally {
      acquired.release()
    }
  }

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
      execute: async (input, context) => {
        const acquired = await this.acquire(projectId, serverName, config, context.signal)
        try {
          const result = await acquired.connection.client.callTool(
            { name: tool.name, arguments: input },
            { signal: context.signal, timeout: config.requestTimeoutMs, resetTimeoutOnProgress: true },
          )
          if ('toolResult' in result) {
            return { content: [{ type: 'text', text: JSON.stringify(result.toolResult) ?? '' }], details: result }
          }
          return {
            content: resultContent(result.content),
            ...(result.isError ? { isError: true } : {}),
            details: result.structuredContent ?? result._meta,
          }
        } catch (error) {
          if (context.signal?.aborted) throw error
          throw new McpToolProviderError(
            'tool_call_failed',
            `MCP 工具调用失败：${serverName}/${tool.name}`,
            serverName,
            error,
          )
        } finally {
          acquired.release()
        }
      },
    }
  }

  /** 获取连接租约；连接失败会从缓存移除，下一轮可以重新建立而不会复用失败 Promise。 */
  private async acquire(
    projectId: string,
    serverName: string,
    config: McpServerConfig,
    signal?: AbortSignal,
  ): Promise<AcquiredConnection> {
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
      return { connection, release }
    } catch (error) {
      release()
      if (this.connections.get(key) === connection) this.connections.delete(key)
      this.markStale(connection)
      throw error
    }
  }

  private createConnection(config: McpServerConfig, configHash: string): McpConnection {
    const connected = this.options.connectServer?.(config) ?? connectSdkServer(config)
    const connection: McpConnection = {
      client: connected.client,
      configHash,
      leases: 0,
      stale: false,
      closed: false,
      ready: Promise.resolve(),
    }
    // connect 自带初始化握手；startupTimeout 同时约束传输建立和 initialize 响应。
    connection.ready = connected.ready
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

  private async close(connection: McpConnection): Promise<void> {
    if (connection.closed) return
    connection.closed = true
    try { await connection.client.close() }
    catch (error) { console.warn('[MCP] 关闭连接失败:', error) }
  }
}
