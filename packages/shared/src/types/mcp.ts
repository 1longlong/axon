/** MCP 项目配置的中立契约；连接实现和 runtime SDK 类型不得进入这里。 */

export const MCP_PROJECT_CONFIG_VERSION = 1 as const
export const DEFAULT_MCP_STARTUP_TIMEOUT_MS = 30_000
export const DEFAULT_MCP_REQUEST_TIMEOUT_MS = 60_000

export type McpTransportType = 'stdio' | 'http'

interface McpServerCommonConfig {
  /** false 时保留配置但不连接。 */
  enabled: boolean
  /** true 时连接失败会阻断本轮；默认服务器只降级并记录诊断。 */
  required: boolean
  startupTimeoutMs: number
  requestTimeoutMs: number
}

export interface McpStdioServerConfig extends McpServerCommonConfig {
  type: 'stdio'
  command: string
  args?: string[]
  env?: Record<string, string>
}

export interface McpHttpServerConfig extends McpServerCommonConfig {
  type: 'http'
  url: string
  headers?: Record<string, string>
}

export type McpServerConfig = McpStdioServerConfig | McpHttpServerConfig

/** 一个项目只有一份 MCP 配置，其下全部会话共享同一组服务器。 */
export interface McpProjectConfig {
  version: typeof MCP_PROJECT_CONFIG_VERSION
  servers: Record<string, McpServerConfig>
}

/** MCP tools/list 的工具条目；服务端可附加 outputSchema、annotations 等扩展字段。 */
export interface McpListedToolInfo {
  name: string
  description?: string
  inputSchema: Record<string, unknown>
}

/** 临时连接的握手与分页工具发现结果；测试不保存或启用服务器。 */
export type McpConnectionTestResult =
  | { ok: true; tools: McpListedToolInfo[] }
  | { ok: false; message: string }

export type BuiltinMcpPresetCategory = 'workspace' | 'reference'

/** renderer 可见的安全目录元数据；不包含命令、路径、请求头或环境变量。 */
export interface BuiltinMcpPresetSummary {
  id: string
  name: string
  displayName: string
  description: string
  category: BuiltinMcpPresetCategory
  transport: McpTransportType
}

/** 主进程按可信项目上下文展开后的预设，仍需用户保存才进入项目配置。 */
export interface MaterializedMcpPreset {
  name: string
  config: McpServerConfig
}

export type McpConfigDiagnosticCode =
  | 'invalid_document'
  | 'unsupported_version'
  | 'too_many_servers'
  | 'invalid_server_name'
  | 'invalid_server'
  | 'unknown_field'
  | 'invalid_transport'
  | 'invalid_command'
  | 'invalid_arguments'
  | 'invalid_environment'
  | 'invalid_url'
  | 'invalid_headers'
  | 'invalid_timeout'

export interface McpConfigDiagnostic {
  path: string
  code: McpConfigDiagnosticCode
  message: string
}

export type McpProjectConfigParseResult =
  | { ok: true; config: McpProjectConfig }
  | { ok: false; diagnostics: McpConfigDiagnostic[] }

export const MCP_IPC_CHANNELS = {
  GET_PROJECT_CONFIG: 'axon:mcp:get-project-config',
  SAVE_PROJECT_CONFIG: 'axon:mcp:save-project-config',
  TEST_SERVER_CONNECTION: 'axon:mcp:test-server-connection',
  LIST_BUILTIN_PRESETS: 'axon:mcp:list-builtin-presets',
  MATERIALIZE_BUILTIN_PRESET: 'axon:mcp:materialize-builtin-preset',
} as const
