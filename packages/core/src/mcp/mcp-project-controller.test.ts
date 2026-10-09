import { describe, expect, test } from 'bun:test'
import type { McpProjectConfig } from '@axon/shared'
import { McpProjectController } from './mcp-project-controller'

const emptyConfig: McpProjectConfig = { version: 1, servers: {} }

describe('MCP 项目配置编排', () => {
  test('测试取消信号传入连接层，预取消不启动；迟到成功不作为连接成功返回', async () => {
    let calls = 0
    const abort = new AbortController()
    const controller = new McpProjectController({
      configs: { get: async () => emptyConfig, save: async () => emptyConfig },
      tools: { disposeProject: () => {}, testConnection: async (_server, signal) => {
        calls += 1
        expect(signal?.aborted).toBe(false)
        abort.abort()
        expect(signal?.aborted).toBe(true)
        return []
      } }, projects: { resolveProjectCwd: () => '/trusted/project' },
    })
    const server = { type: 'stdio', command: 'fixture' }
    await expect(controller.testConnection('project-1', 'local', server, abort.signal)).rejects.toMatchObject({ name: 'AbortError' })
    await expect(controller.testConnection('project-1', 'local', server, abort.signal)).rejects.toMatchObject({ name: 'AbortError' })
    expect(calls).toBe(1)
  })

  test('保存成功后才淘汰目标项目连接', async () => {
    const disposed: string[] = []
    const controller = new McpProjectController({
      configs: { get: async () => emptyConfig, save: async (_id, config) => config as McpProjectConfig },
      tools: { disposeProject: (projectId) => { disposed.push(projectId) }, testConnection: async () => [] },
      projects: { resolveProjectCwd: () => '/trusted/project' },
    })
    expect((await controller.save(' project-1 ', emptyConfig))).toEqual(emptyConfig)
    expect(disposed).toEqual(['project-1'])
  })

  test('保存失败时保留当前连接', async () => {
    let disposed = false
    const controller = new McpProjectController({
      configs: { get: async () => emptyConfig, save: async () => { throw new Error('invalid') } },
      tools: { disposeProject: () => { disposed = true }, testConnection: async () => [] },
      projects: { resolveProjectCwd: () => '/trusted/project' },
    })
    await expect(controller.save('project-1', {})).rejects.toThrow('invalid')
    expect(disposed).toBe(false)
  })

  test('异步保存真正落盘之前不淘汰连接', async () => {
    let finish: (value: McpProjectConfig) => void = () => { throw new Error('保存未启动') }
    const delayed = new Promise<McpProjectConfig>((resolve) => { finish = resolve })
    const disposed: string[] = []
    const controller = new McpProjectController({
      configs: { get: async () => emptyConfig, save: () => delayed },
      tools: { disposeProject: (id) => { disposed.push(id) }, testConnection: async () => [] },
      projects: { resolveProjectCwd: () => '/trusted/project' },
    })
    const pending = controller.save('project-1', emptyConfig)
    expect(disposed).toEqual([])
    finish(emptyConfig)
    await pending
    expect(disposed).toEqual(['project-1'])
  })

  test('物化预设时只采用项目管理器解析的 cwd', async () => {
    const controller = new McpProjectController({
      configs: { get: async () => emptyConfig, save: async () => emptyConfig },
      tools: { disposeProject: () => undefined, testConnection: async () => [] },
      projects: { resolveProjectCwd: (projectId) => `/trusted/${projectId}` },
    })
    const preset = controller.materializeBuiltinPreset('project-1', 'filesystem')
    expect(preset.config.type).toBe('stdio')
    if (preset.config.type === 'stdio') expect(preset.config.args).toContain('/trusted/project-1')
    expect(controller.listBuiltinPresets()).toHaveLength(2)
  })

  test('拒绝空项目或预设标识', async () => {
    const controller = new McpProjectController({
      configs: { get: async () => emptyConfig, save: async () => emptyConfig },
      tools: { disposeProject: () => undefined, testConnection: async () => [] },
      projects: { resolveProjectCwd: () => '/trusted/project' },
    })
    await expect(controller.get('')).rejects.toThrow('项目标识无效')
    expect(() => controller.materializeBuiltinPreset('project-1', '')).toThrow('预设标识无效')
  })

  test('测试草稿先解析可信项目与配置；不保存、不淘汰连接，也不受 enabled 开关影响', async () => {
    const received: unknown[] = []
    const controller = new McpProjectController({
      configs: { get: async () => emptyConfig, save: async () => { throw new Error('不能保存草稿') } },
      tools: {
        disposeProject: () => { throw new Error('不能淘汰连接') },
        testConnection: async (server) => { received.push(server); return [] },
      },
      projects: { resolveProjectCwd: (id) => { if (id !== 'project-1') throw new Error('项目不存在'); return '/trusted/project' } },
    })
    const server = { type: 'stdio', command: 'fixture', enabled: false }
    await expect(controller.testConnection('missing', 'local', server)).rejects.toThrow('项目不存在')
    await expect(controller.testConnection('project-1', 'Bad Name', server)).rejects.toMatchObject({ code: 'invalid_input' })
    expect(received).toEqual([])
    expect(await controller.testConnection('project-1', 'local', server)).toEqual({ ok: true, tools: [] })
    expect(received).toMatchObject([{ command: 'fixture', enabled: false }])
  })

  test('连接失败只返回稳定错误提示，不将 SDK 原因中的地址或凭据交给入口', async () => {
    const controller = new McpProjectController({
      configs: { get: async () => emptyConfig, save: async () => emptyConfig },
      tools: {
        disposeProject: () => undefined,
        testConnection: async () => { throw new Error('401 unauthorized https://private.invalid Authorization=private-secret') },
      },
      projects: { resolveProjectCwd: () => '/trusted/project' },
    })
    expect(await controller.testConnection('project-1', 'local', { type: 'http', url: 'https://fixture.invalid/mcp' }))
      .toEqual({ ok: false, message: '服务器拒绝认证，请检查请求头或凭据' })
  })
})
