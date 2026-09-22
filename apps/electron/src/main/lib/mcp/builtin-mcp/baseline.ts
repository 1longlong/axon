/** 内置 MCP 预设单一事实源：校验随应用发布的 manifest，并按项目展开动态值。 */

import type {
  BuiltinMcpPresetCategory,
  BuiltinMcpPresetSummary,
  MaterializedMcpPreset,
  McpServerConfig,
  McpTransportType,
} from '@axon/shared'
import manifest from './default-mcp.json' with { type: 'json' }
import { parseMcpProjectConfig } from '../mcp-validator'

interface BuiltinMcpPresetDefinition extends BuiltinMcpPresetSummary {
  config: McpServerConfig
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === 'object' && !Array.isArray(value)
}

function parseDefinition(value: unknown): BuiltinMcpPresetDefinition {
  if (!isRecord(value) || !isRecord(value.config)) throw new Error('内置 MCP 预设格式无效')
  const category = value.category as BuiltinMcpPresetCategory
  const transport = value.transport as McpTransportType
  if (
    typeof value.id !== 'string' || !value.id
    || typeof value.name !== 'string' || !value.name
    || typeof value.displayName !== 'string' || !value.displayName
    || typeof value.description !== 'string' || !value.description
    || !['workspace', 'reference'].includes(category)
    || !['stdio', 'http'].includes(transport)
    || value.config.type !== transport
  ) throw new Error('内置 MCP 预设元数据无效')
  const parsedConfig = parseMcpProjectConfig({ version: 1, servers: { [value.name]: value.config } })
  if (!parsedConfig.ok) throw new Error(`内置 MCP 预设配置无效：${value.id}`)
  return {
    id: value.id,
    name: value.name,
    displayName: value.displayName,
    description: value.description,
    category,
    transport,
    config: parsedConfig.config.servers[value.name]!,
  }
}

if (manifest.version !== 1 || !Array.isArray(manifest.presets)) {
  throw new Error('内置 MCP manifest 版本无效')
}
const definitions = manifest.presets.map(parseDefinition)
if (
  new Set(definitions.map((item) => item.id)).size !== definitions.length
  || new Set(definitions.map((item) => item.name)).size !== definitions.length
) throw new Error('内置 MCP 预设包含重复标识或服务器名称')
const definitionsById = new Map(definitions.map((item) => [item.id, item]))

export function listBuiltinMcpPresets(): BuiltinMcpPresetSummary[] {
  return definitions.map(({ config: _config, ...summary }) => structuredClone(summary))
}

/** 文件系统预设只允许展开为主进程解析出的项目 cwd，不接受 renderer 提供替换值。 */
export function materializeBuiltinMcpPreset(id: string, projectCwd: string): MaterializedMcpPreset {
  const definition = definitionsById.get(id)
  if (!definition) throw new Error('内置 MCP 预设不存在')
  const config = structuredClone(definition.config)
  if (config.type === 'stdio') {
    const args = (config.args ?? []).map((arg) => arg === '${workspace}' ? projectCwd : arg)
    if (process.platform === 'win32' && config.command === 'npx') {
      return { name: definition.name, config: { ...config, command: 'cmd', args: ['/c', 'npx', ...args] } }
    }
    return { name: definition.name, config: { ...config, args } }
  }
  return { name: definition.name, config }
}
