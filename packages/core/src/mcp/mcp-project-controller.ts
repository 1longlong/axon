/** MCP 项目配置编排：校验项目标识，并在保存后淘汰对应连接缓存。 */

import { MCP_PROJECT_CONFIG_VERSION } from '@axon/shared'
import type { BuiltinMcpPresetSummary, MaterializedMcpPreset, McpConnectionTestResult, McpProjectConfig } from '@axon/shared'
import type { AgentProjectManager } from '../project/agent-project-manager'
import { getBuiltinMcpCatalog } from './builtin-mcp/catalog'
import { materializeBuiltinMcpPreset } from './builtin-mcp/baseline'
import type { McpProjectConfigManager } from './mcp-project-config-manager'
import { McpProjectConfigManagerError } from './mcp-project-config-manager'
import { parseMcpProjectConfig } from './mcp-validator'
import type { McpToolProvider } from './mcp-tool-provider'
import { AsyncWorkTracker } from '../async/async-work-tracker'

export interface McpProjectControllerOptions {
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

export class McpProjectController {
  private readonly lifetime = new AbortController()
  private readonly work = new AsyncWorkTracker()

  constructor(private readonly options: McpProjectControllerOptions) {}

  /** 读取登记实际解密/恢复链；退出后拒绝新请求，也不交付迟到配置。 */
  get(projectId: unknown): Promise<McpProjectConfig> {
    return this.work.run(async () => {
      this.ensureOpen()
      const config = await this.options.configs.get(parseProjectId(projectId))
      this.ensureOpen()
      return config
    })
  }

  /** 先完成严格校验和原子落盘，再淘汰旧连接；保存失败时运行状态保持不变。 */
  save(projectId: unknown, config: unknown): Promise<McpProjectConfig> {
    return this.work.run(async () => {
      this.ensureOpen()
      const normalizedProjectId = parseProjectId(projectId)
      // 已接纳保存允许完成原子写，退出等待它结束，不把取消伪装为写盘回滚。
      const saved = await this.options.configs.save(normalizedProjectId, config)
      this.options.tools.disposeProject(normalizedProjectId)
      return saved
    })
  }

  /** 校验草稿后临时连接；信号只取消本次测试，不保存或淘汰 Agent 的连接缓存。 */
  testConnection(projectId: unknown, serverName: unknown, server: unknown, signal?: AbortSignal): Promise<McpConnectionTestResult> {
    const combined = signal ? AbortSignal.any([signal, this.lifetime.signal]) : this.lifetime.signal
    return this.work.run(() => this.executeTestConnection(projectId, serverName, server, combined))
  }

  /** 先校验可信项目和草稿，再等待连接关闭；退出不把迟到工具列表交付为成功。 */
  private async executeTestConnection(projectId: unknown, serverName: unknown, server: unknown, signal: AbortSignal): Promise<McpConnectionTestResult> {
    if (signal.aborted) throw new DOMException('MCP 测试已取消', 'AbortError')
    const normalizedProjectId = parseProjectId(projectId)
    this.options.projects.resolveProjectCwd(normalizedProjectId)
    if (typeof serverName !== 'string') throw new McpProjectConfigManagerError('invalid_input', 'MCP 服务器名称无效')
    const parsed = parseMcpProjectConfig({ version: MCP_PROJECT_CONFIG_VERSION, servers: { [serverName]: server } })
    if (!parsed.ok) throw new McpProjectConfigManagerError('invalid_input', parsed.diagnostics[0]?.message ?? 'MCP 服务器配置无效', parsed.diagnostics)
    try {
      const tools = await this.options.tools.testConnection(parsed.config.servers[serverName]!, signal)
      if (signal.aborted) throw new DOMException('MCP 测试已取消', 'AbortError')
      return { ok: true, tools }
    } catch (cause) {
      if (signal?.aborted || cause instanceof Error && cause.name === 'AbortError') throw cause
      return { ok: false, message: connectionFailureMessage(cause) }
    }
  }

  listBuiltinPresets(): BuiltinMcpPresetSummary[] {
    this.ensureOpen()
    return getBuiltinMcpCatalog()
  }

  /** 只以可信项目 cwd 展开工作区占位；返回草稿，用户确认保存前不修改配置。 */
  materializeBuiltinPreset(projectId: unknown, presetId: unknown): MaterializedMcpPreset {
    this.ensureOpen()
    const normalizedProjectId = parseProjectId(projectId)
    if (typeof presetId !== 'string' || !presetId.trim()) {
      throw new McpProjectConfigManagerError('invalid_input', 'MCP 预设标识无效')
    }
    return materializeBuiltinMcpPreset(
      presetId.trim(),
      this.options.projects.resolveProjectCwd(normalizedProjectId),
    )
  }

  /** 关闭配置入口并取消草稿测试；已接纳保存和底层读取仍由 drain 等待。 */
  dispose(): void {
    this.lifetime.abort(new DOMException('MCP 配置服务已释放', 'AbortError'))
  }

  /** 不用取消响应代替真实完成，覆盖配置读写与测试 finally。 */
  drain(): Promise<void> { return this.work.drain() }

  private ensureOpen(): void {
    if (this.lifetime.signal.aborted) throw new DOMException('MCP 配置服务已释放', 'AbortError')
  }
}
