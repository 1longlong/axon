/** 将磁盘或 IPC 输入校验为严格的项目 MCP 配置，不负责建立网络连接。 */

import {
  DEFAULT_MCP_REQUEST_TIMEOUT_MS,
  DEFAULT_MCP_STARTUP_TIMEOUT_MS,
  MCP_PROJECT_CONFIG_VERSION,
} from '@axon/shared'
import type {
  McpConfigDiagnostic,
  McpConfigDiagnosticCode,
  McpHttpServerConfig,
  McpProjectConfigParseResult,
  McpServerConfig,
  McpStdioServerConfig,
} from '@axon/shared'

const MAX_SERVERS = 64
const MAX_COMMAND_LENGTH = 4_096
const MAX_URL_LENGTH = 8_192
const MAX_ITEMS = 128
const MAX_ITEM_LENGTH = 8_192
const SERVER_NAME_PATTERN = /^[a-z][a-z0-9-]{0,62}[a-z0-9]$|^[a-z]$/
const ENV_NAME_PATTERN = /^[A-Za-z_][A-Za-z0-9_]*$/
const HTTP_HEADER_NAME_PATTERN = /^[!#$%&'*+.^_`|~0-9A-Za-z-]+$/
const COMMON_FIELDS = new Set(['type', 'enabled', 'required', 'startupTimeoutMs', 'requestTimeoutMs'])
const STDIO_FIELDS = new Set([...COMMON_FIELDS, 'command', 'args', 'env'])
const HTTP_FIELDS = new Set([...COMMON_FIELDS, 'url', 'headers'])

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === 'object' && !Array.isArray(value)
}

function diagnostic(path: string, code: McpConfigDiagnosticCode, message: string): McpConfigDiagnostic {
  return { path, code, message }
}

function parseBoolean(value: unknown, fallback: boolean): boolean | undefined {
  return value === undefined ? fallback : typeof value === 'boolean' ? value : undefined
}

function parseTimeout(value: unknown, fallback: number): number | undefined {
  if (value === undefined) return fallback
  return typeof value === 'number' && Number.isInteger(value) && value >= 100 && value <= 600_000
    ? value
    : undefined
}

function parseStringMap(
  value: unknown,
  keyPattern: RegExp | undefined,
  forbidValueNewlines: boolean,
): Record<string, string> | undefined | null {
  if (value === undefined) return undefined
  if (!isRecord(value) || Object.keys(value).length > MAX_ITEMS) return null
  const result: Record<string, string> = {}
  for (const [key, item] of Object.entries(value)) {
    if (
      !key || key.length > 256 || key.includes('\r') || key.includes('\n')
      || (keyPattern && !keyPattern.test(key))
      || typeof item !== 'string' || item.length > MAX_ITEM_LENGTH
      || (forbidValueNewlines && (item.includes('\r') || item.includes('\n')))
    ) return null
    result[key] = item
  }
  return Object.keys(result).length > 0 ? result : undefined
}

function parseStringArray(value: unknown): string[] | undefined | null {
  if (value === undefined) return undefined
  if (!Array.isArray(value) || value.length > MAX_ITEMS) return null
  const result: string[] = []
  for (const item of value) {
    if (typeof item !== 'string' || !item || item.length > MAX_ITEM_LENGTH || item.includes('\0')) return null
    result.push(item)
  }
  return result.length > 0 ? result : undefined
}

function reportUnknownFields(
  path: string,
  value: Record<string, unknown>,
  allowed: ReadonlySet<string>,
  diagnostics: McpConfigDiagnostic[],
): void {
  for (const key of Object.keys(value)) {
    if (!allowed.has(key)) diagnostics.push(diagnostic(`${path}.${key}`, 'unknown_field', '包含不支持的字段'))
  }
}

function parseCommon(
  path: string,
  value: Record<string, unknown>,
  diagnostics: McpConfigDiagnostic[],
): Pick<McpServerConfig, 'enabled' | 'required' | 'startupTimeoutMs' | 'requestTimeoutMs'> | undefined {
  const enabled = parseBoolean(value.enabled, true)
  const required = parseBoolean(value.required, false)
  const startupTimeoutMs = parseTimeout(value.startupTimeoutMs, DEFAULT_MCP_STARTUP_TIMEOUT_MS)
  const requestTimeoutMs = parseTimeout(value.requestTimeoutMs, DEFAULT_MCP_REQUEST_TIMEOUT_MS)
  if (enabled === undefined) diagnostics.push(diagnostic(`${path}.enabled`, 'invalid_server', 'enabled 必须是布尔值'))
  if (required === undefined) diagnostics.push(diagnostic(`${path}.required`, 'invalid_server', 'required 必须是布尔值'))
  if (startupTimeoutMs === undefined) diagnostics.push(diagnostic(`${path}.startupTimeoutMs`, 'invalid_timeout', '启动超时必须是 100 到 600000 毫秒的整数'))
  if (requestTimeoutMs === undefined) diagnostics.push(diagnostic(`${path}.requestTimeoutMs`, 'invalid_timeout', '请求超时必须是 100 到 600000 毫秒的整数'))
  if (enabled === undefined || required === undefined || startupTimeoutMs === undefined || requestTimeoutMs === undefined) return undefined
  return { enabled, required, startupTimeoutMs, requestTimeoutMs }
}

function parseStdioServer(
  path: string,
  value: Record<string, unknown>,
  diagnostics: McpConfigDiagnostic[],
): McpStdioServerConfig | undefined {
  reportUnknownFields(path, value, STDIO_FIELDS, diagnostics)
  const common = parseCommon(path, value, diagnostics)
  const command = typeof value.command === 'string' ? value.command.trim() : ''
  if (!command || command.length > MAX_COMMAND_LENGTH || command.includes('\0')) {
    diagnostics.push(diagnostic(`${path}.command`, 'invalid_command', 'stdio command 不能为空且不能超过 4096 个字符'))
  }
  const args = parseStringArray(value.args)
  if (args === null) diagnostics.push(diagnostic(`${path}.args`, 'invalid_arguments', 'args 必须是最多 128 项的非空字符串数组'))
  const env = parseStringMap(value.env, ENV_NAME_PATTERN, false)
  if (env === null) diagnostics.push(diagnostic(`${path}.env`, 'invalid_environment', 'env 必须是合法的环境变量映射'))
  if (!common || !command || command.length > MAX_COMMAND_LENGTH || command.includes('\0') || args === null || env === null) return undefined
  return { type: 'stdio', ...common, command, ...(args ? { args } : {}), ...(env ? { env } : {}) }
}

function parseHttpServer(
  path: string,
  value: Record<string, unknown>,
  diagnostics: McpConfigDiagnostic[],
): McpHttpServerConfig | undefined {
  reportUnknownFields(path, value, HTTP_FIELDS, diagnostics)
  const common = parseCommon(path, value, diagnostics)
  const rawUrl = typeof value.url === 'string' ? value.url.trim() : ''
  let url: URL | undefined
  try { url = new URL(rawUrl) } catch { /* 统一在下方报告。 */ }
  if (
    !url || rawUrl.length > MAX_URL_LENGTH || !['http:', 'https:'].includes(url.protocol)
    || url.username || url.password || url.hash
  ) diagnostics.push(diagnostic(`${path}.url`, 'invalid_url', 'URL 必须是无用户信息和片段的 HTTP(S) 地址'))
  const headers = parseStringMap(value.headers, HTTP_HEADER_NAME_PATTERN, true)
  if (headers === null) diagnostics.push(diagnostic(`${path}.headers`, 'invalid_headers', 'headers 必须是最多 128 项且不含换行的字符串映射'))
  if (!common || !url || rawUrl.length > MAX_URL_LENGTH || !['http:', 'https:'].includes(url.protocol) || url.username || url.password || url.hash || headers === null) return undefined
  return { type: 'http', ...common, url: url.toString(), ...(headers ? { headers } : {}) }
}

/**
 * 把不可信 JSON 解析为运行期唯一配置形状：补齐默认值、拒绝未知字段，
 * 并一次返回全部诊断，供后续持久化、设置 UI 和连接层共同使用。
 */
export function parseMcpProjectConfig(value: unknown): McpProjectConfigParseResult {
  if (!isRecord(value)) {
    return { ok: false, diagnostics: [diagnostic('$', 'invalid_document', 'MCP 配置必须是对象')] }
  }
  const diagnostics: McpConfigDiagnostic[] = []
  reportUnknownFields('$', value, new Set(['version', 'servers']), diagnostics)
  if (value.version !== MCP_PROJECT_CONFIG_VERSION) {
    diagnostics.push(diagnostic('$.version', 'unsupported_version', `MCP 配置版本必须是 ${MCP_PROJECT_CONFIG_VERSION}`))
  }
  if (!isRecord(value.servers)) {
    diagnostics.push(diagnostic('$.servers', 'invalid_document', 'servers 必须是对象'))
    return { ok: false, diagnostics }
  }
  const entries = Object.entries(value.servers)
  if (entries.length > MAX_SERVERS) {
    diagnostics.push(diagnostic('$.servers', 'too_many_servers', `一个项目最多配置 ${MAX_SERVERS} 个 MCP 服务器`))
  }
  const servers: Record<string, McpServerConfig> = {}
  for (const [name, rawServer] of entries.slice(0, MAX_SERVERS)) {
    const path = `$.servers.${name}`
    if (!SERVER_NAME_PATTERN.test(name)) {
      diagnostics.push(diagnostic(path, 'invalid_server_name', '服务器名称必须是 1 到 64 位小写 kebab-case'))
      continue
    }
    if (!isRecord(rawServer)) {
      diagnostics.push(diagnostic(path, 'invalid_server', '服务器配置必须是对象'))
      continue
    }
    let server: McpServerConfig | undefined
    if (rawServer.type === 'stdio') server = parseStdioServer(path, rawServer, diagnostics)
    else if (rawServer.type === 'http') server = parseHttpServer(path, rawServer, diagnostics)
    else diagnostics.push(diagnostic(`${path}.type`, 'invalid_transport', 'type 只能是 stdio 或 http'))
    if (server) servers[name] = server
  }
  return diagnostics.length > 0
    ? { ok: false, diagnostics }
    : { ok: true, config: { version: MCP_PROJECT_CONFIG_VERSION, servers } }
}
