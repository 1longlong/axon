import { describe, expect, test } from 'bun:test'
import type { McpProjectConfig } from '@axon/shared'
import { McpProjectIpcController } from './mcp-project-ipc-handlers'

const emptyConfig: McpProjectConfig = { version: 1, servers: {} }

describe('MCP 项目配置 IPC', () => {
  test('保存成功后才淘汰目标项目连接', () => {
    const disposed: string[] = []
    const controller = new McpProjectIpcController({
      configs: { get: () => emptyConfig, save: (_id, config) => config as McpProjectConfig },
      tools: { disposeProject: (projectId) => { disposed.push(projectId) }, testConnection: async () => [] },
      projects: { resolveProjectCwd: () => '/trusted/project' },
    })
    expect(controller.save(' project-1 ', emptyConfig)).toEqual(emptyConfig)
    expect(disposed).toEqual(['project-1'])
  })

  test('保存失败时保留当前连接', () => {
    let disposed = false
    const controller = new McpProjectIpcController({
      configs: { get: () => emptyConfig, save: () => { throw new Error('invalid') } },
      tools: { disposeProject: () => { disposed = true }, testConnection: async () => [] },
      projects: { resolveProjectCwd: () => '/trusted/project' },
    })
    expect(() => controller.save('project-1', {})).toThrow('invalid')
    expect(disposed).toBe(false)
  })

  test('物化预设时只采用项目管理器解析的 cwd', () => {
    const controller = new McpProjectIpcController({
      configs: { get: () => emptyConfig, save: () => emptyConfig },
      tools: { disposeProject: () => undefined, testConnection: async () => [] },
      projects: { resolveProjectCwd: (projectId) => `/trusted/${projectId}` },
    })
    const preset = controller.materializeBuiltinPreset('project-1', 'filesystem')
    expect(preset.config.type).toBe('stdio')
    if (preset.config.type === 'stdio') expect(preset.config.args).toContain('/trusted/project-1')
    expect(controller.listBuiltinPresets()).toHaveLength(2)
  })

  test('拒绝空项目或预设标识', () => {
    const controller = new McpProjectIpcController({
      configs: { get: () => emptyConfig, save: () => emptyConfig },
      tools: { disposeProject: () => undefined, testConnection: async () => [] },
      projects: { resolveProjectCwd: () => '/trusted/project' },
    })
    expect(() => controller.get('')).toThrow('项目标识无效')
    expect(() => controller.materializeBuiltinPreset('project-1', '')).toThrow('预设标识无效')
  })
})
