/** MCP 项目配置 IPC：校验项目标识，并在保存后淘汰对应连接缓存。 */

import { MCP_PROJECT_CONFIG_VERSION } from '@axon/shared'
import type { BuiltinMcpPresetSummary, MaterializedMcpPreset, McpConnectionTestResult, McpProjectConfig } from '@axon/shared'
import type { AgentProjectManager } from '../project/agent-project-manager'
import { getBuiltinMcpCatalog } from './builtin-mcp/catalog'
import { materializeBuiltinMcpPreset } from './builtin-mcp/baseline'
import type { McpProjectConfigManager } from './mcp-project-config-manager'
import { McpProjectConfigManagerError } from './mcp-project-config-manager'
import { parseMcpProjectConfig } from './mcp-validator'
import type { McpToolProvider } from './mcp-tool-provider'

export interface McpProjectIpcControllerOptions {
  configs: Pick<McpProjectConfigManager, 'get' | 'save'>
  tools: Pick<McpToolProvider, 'disposeProject' | 'testConnection'>
  projects: Pick<AgentProjectManager, 'resolveProjectCwd'>
}

function parseProjectId(value: unknown): string {
  if (typeof value !== 'string' || !value.trim()) {
    throw new McpProjectConfigManagerError('invalid_input', 'MCP 项目标识无效')
  }
  return value.trim()
}

/** 只给配置页返回可操作的错误类别，避免 SDK 异常中混入 URL、请求头或环境变量。 */
function connectionFailureMessage(cause: unknown): string {
  const message = cause instanceof Error ? cause.message : ''
  if (/ENOENT|not found|spawn /i.test(message)) return '启动命令不存在，请检查命令及运行环境'
  if (/ETIMEDOUT|timed out|timeout/i.test(message)) return '连接或工具发现超时，请检查超时设置和服务状态'
  if (/ENOTFOUND|EAI_AGAIN|DNS/i.test(message)) return '无法解析服务器域名，请检查 URL 和网络'
  if (/ECONNREFUSED|ECONNRESET|fetch failed/i.test(message)) return '无法连接服务器，请检查地址、端口和服务状态'
  if (/\b401\b|unauthorized/i.test(message)) return '服务器拒绝认证，请检查请求头或凭据'
  if (/\b403\b|forbidden/i.test(message)) return '服务器拒绝访问，请检查权限配置'
  return 'MCP 握手或工具发现失败，请检查服务配置和运行日志'
}

export class McpProjectIpcController {
  constructor(private readonly options: McpProjectIpcControllerOptions) {}

  get(projectId: unknown): McpProjectConfig {
    return this.options.configs.get(parseProjectId(projectId))
  }

  /** 先完成严格校验和原子落盘，再淘汰旧连接；保存失败时运行状态保持不变。 */
  save(projectId: unknown, config: unknown): McpProjectConfig {
    const normalizedProjectId = parseProjectId(projectId)
    const saved = this.options.configs.save(normalizedProjectId, config)
    this.options.tools.disposeProject(normalizedProjectId)
    return saved
  }

  /** 校验当前草稿后临时连接；不落盘、不受 enabled 开关影响，也不改动 Agent 连接缓存。 */
  async testConnection(projectId: unknown, serverName: unknown, server: unknown): Promise<McpConnectionTestResult> {
    const normalizedProjectId = parseProjectId(projectId)
    this.options.projects.resolveProjectCwd(normalizedProjectId)
    if (typeof serverName !== 'string') throw new McpProjectConfigManagerError('invalid_input', 'MCP 服务器名称无效')
    const parsed = parseMcpProjectConfig({ version: MCP_PROJECT_CONFIG_VERSION, servers: { [serverName]: server } })
    if (!parsed.ok) throw new McpProjectConfigManagerError('invalid_input', parsed.diagnostics[0]?.message ?? 'MCP 服务器配置无效', parsed.diagnostics)
    try {
      const tools = await this.options.tools.testConnection(parsed.config.servers[serverName]!)
      return { ok: true, tools }
    } catch (cause) {
      return { ok: false, message: connectionFailureMessage(cause) }
    }
  }

  listBuiltinPresets(): BuiltinMcpPresetSummary[] {
    return getBuiltinMcpCatalog()
  }

  /** 动态工作区占位只在主进程展开；返回草稿，不在用户确认保存前修改项目配置。 */
  materializeBuiltinPreset(projectId: unknown, presetId: unknown): MaterializedMcpPreset {
    const normalizedProjectId = parseProjectId(projectId)
    if (typeof presetId !== 'string' || !presetId.trim()) {
      throw new McpProjectConfigManagerError('invalid_input', 'MCP 预设标识无效')
    }
    return materializeBuiltinMcpPreset(
      presetId.trim(),
      this.options.projects.resolveProjectCwd(normalizedProjectId),
    )
  }
}
