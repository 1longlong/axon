import { describe, expect, test } from 'bun:test'
import { getBuiltinMcpCatalog } from './catalog'
import { materializeBuiltinMcpPreset } from './baseline'

describe('内置 MCP 预设', () => {
  test('目录只暴露安全摘要', () => {
    const catalog = getBuiltinMcpCatalog()
    expect(catalog.map((item) => item.id)).toEqual(['filesystem', 'mcp-docs'])
    expect(catalog.every((item) => !('config' in item))).toBe(true)
  })

  test('文件系统预设只展开可信项目目录', () => {
    const preset = materializeBuiltinMcpPreset('filesystem', '/trusted/project')
    expect(preset.name).toBe('filesystem')
    expect(preset.config.type).toBe('stdio')
    if (preset.config.type !== 'stdio') return
    expect(preset.config.args?.at(-1)).toBe('/trusted/project')
    expect(preset.config.args).not.toContain('${workspace}')
  })

  test('未知预设不能物化', () => {
    expect(() => materializeBuiltinMcpPreset('missing', '/project')).toThrow('预设不存在')
  })
})
