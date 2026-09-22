/** 内置 MCP 目录只公开安全摘要，具体启动模板必须在主进程按项目物化。 */

import type { BuiltinMcpPresetSummary } from '@axon/shared'
import { listBuiltinMcpPresets } from './baseline'

export function getBuiltinMcpCatalog(): BuiltinMcpPresetSummary[] {
  return listBuiltinMcpPresets()
}
