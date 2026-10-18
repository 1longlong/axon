/** 独立 Loop 目录、加密 MCP 与异步保存边界；不修改正式数据或调用外部模型。 */
import { expect, test } from 'bun:test'
import { existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, renameSync, rmSync, symlinkSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { createBackend } from '../backend'
import type { AxonBackend } from '../backend'
import { createBackendPaths } from '../settings/backend-paths'
import { createFixtureCredentialCodec } from '../../test-support/credential-codec'
import { LoopService } from './loop-service'
import type { LoopExecutionRequest } from './loop-service'
import type { McpProjectConfig } from '@axon/shared'

const config: McpProjectConfig = { version: 1, servers: { local: { type: 'stdio', command: 'loop-server', env: { TOKEN: 'private-loop-secret' },
  enabled: true, required: true, startupTimeoutMs: 1000, requestTimeoutMs: 1000 } } }

test('不创建项目；同目录项目/两个 Loop 的 MCP 配置、连接和删除相互独立', async () => {
  const root = realpathSync(mkdtempSync(join(tmpdir(), 'axon-loop-independent-'))), workspace = join(root, 'workspace')
  mkdirSync(workspace)
  const connections: string[] = []
  const backend: AxonBackend = createBackend({ paths: createBackendPaths({ dataDir: join(root, 'data'), homeDir: root }), applicationVersion: '0.1.5',
    credentialCodec: createFixtureCredentialCodec(), resolveAdapter: () => ({ query: async function* (input) {
      expect(input.cwd).toBe(workspace)
      backend.loops.cli(input.toolEnvironment!.environmentOverrides.AXON_LOOP_TOKEN!, ['finish', '--message', '完成', '--reason', '检查完成'])
      yield { kind: 'sdk_message', message: { type: 'assistant', message: { content: [{ type: 'text', text: '独立任务完成' }] } } }
      yield { kind: 'sdk_message', message: { type: 'result', subtype: 'success' } }
    }, abort() {}, dispose() {}, async drain() {} }),
    providerStream: async function* () { yield { type: 'text_delta', delta: '标题' }; yield { type: 'finish', reason: 'stop' } },
    connectMcpServer: (server) => {
      if (server.type !== 'stdio') throw new Error('夹具协议错误')
      connections.push(server.command)
      return { ready: Promise.resolve(), client: {
        listTools: async () => ({ tools: [{ name: 'lookup', inputSchema: { type: 'object' } }] }),
        callTool: async () => ({ content: [{ type: 'text', text: server.command }] }), close: async () => {},
      } }
    },
  })
  try {
    const channel = await backend.channels.create({ name: '夹具', provider: 'openai', apiKey: 'fixture', models: [{ id: 'model', name: '模型', enabled: true }] })
    const input = { name: '独立任务', workspacePath: workspace, channelId: channel.id, modelId: 'model', task: '检查', goal: '检查完成', cron: '0 0 1 1 *' }
    const first = backend.loops.create(input), second = backend.loops.create(input)
    expect(backend.projects.list()).toEqual([])
    expect('projectId' in first).toBe(false)
    const project = backend.projects.create({ name: '同目录项目', workspace: { kind: 'local', path: workspace } })
    await backend.mcp.save(project.id, { ...config, servers: { local: { ...config.servers.local!, command: 'project-server', type: 'stdio' } } })
    await backend.loops.configureMcp(first.id, () => backend.loopMcp.save(first.id, config))
    expect((await backend.loopMcp.get(second.id)).servers).toEqual({})
    await backend.mcpTools.getTools(project.id)
    await backend.loopMcpTools.getTools(first.id)
    expect(connections).toEqual(['project-server', 'loop-server'])
    const privateFile = join(root, 'data', 'loops', first.id, 'mcp.json')
    expect(readFileSync(privateFile, 'utf8')).not.toContain('private-loop-secret')
    expect(readFileSync(join(root, 'data', 'loops', first.id, 'journal.jsonl'), 'utf8')).not.toContain('private-loop-secret')
    backend.projects.delete(project.id)
    expect(backend.loops.resolveWorkspace(first.id)).toBe(workspace)
    expect((await backend.loopMcp.get(first.id)).servers.local).toMatchObject({ command: 'loop-server' })
    backend.loops.start({ commandDirectory: '/controlled/bin', socketPath: '/controlled/socket' })
    const runId = backend.loops.run(first.id).runId!
    for (let attempt = 0; attempt < 300 && backend.loops.get(first.id).job.running; attempt++) await Bun.sleep(2)
    const run = backend.loops.getRun(first.id, runId)
    expect(run.phase).toBe('done')
    expect(backend.sessions.get(run.sessionId!)?.projectId).toBeUndefined()
    backend.loops.delete(first.id)
    expect(existsSync(privateFile)).toBe(false)
    expect(existsSync(first.taskFile)).toBe(true)
    expect(backend.loops.get(second.id).job.workspacePath).toBe(workspace)
  } finally { backend.dispose(); await backend.drain(); rmSync(root, { recursive: true }) }
})

test('创建先保存独立 MCP，再运行准备；不会把草稿写入定义，保留用户本次白名单', async () => {
  const root = realpathSync(mkdtempSync(join(tmpdir(), 'axon-loop-create-config-')))
  const gate = Promise.withResolvers<void>(), order: string[] = []
  let service!: LoopService
  service = new LoopService({ directory: join(root, 'data'), validateDefinition: () => {},
    saveMcpConfig: async (_id, value) => { expect(value).toEqual(config); await gate.promise; order.push('saved') },
    execute: async (request) => {
      order.push('setup'); expect(request.definition.allowedMcpTools).toEqual(['mcp__local__lookup'])
      expect('mcpConfig' in request.definition).toBe(false)
      service.cli(request.control.token, ['report', '--status', 'resolved']); return { phase: 'done' }
    },
  })
  service.start({ commandDirectory: '/controlled/bin', socketPath: '/controlled/socket' })
  try {
    const promise = service.createWithAgent({ name: '任务', workspacePath: root, channelId: 'channel', modelId: 'model', task: '检查',
      cron: '0 0 1 1 *', mcpConfig: config, allowedMcpTools: ['mcp__local__lookup'] })
    const job = service.list()[0]!
    expect(job.preparation).toBe('failed'); expect(order).toEqual([])
    expect(() => service.prepare(job.id)).toThrow('正在保存')
    expect(() => service.update(job.id, { task: '不能覆盖' })).toThrow('正在保存')
    expect(() => service.delete(job.id)).toThrow('正在保存')
    gate.resolve(); await promise
    expect(order).toEqual(['saved', 'setup'])
    service.dispose(); await service.drain()
    expect(readFileSync(join(root, 'data', job.id, 'journal.jsonl'), 'utf8')).not.toContain('private-loop-secret')
  } finally { gate.resolve(); service.dispose(); await service.drain(); rmSync(root, { recursive: true }) }
})

test.each(['reject', 'exit'] as const)('MCP 保存失败或退出后的迟到保存，不自动准备/执行：%s', async (mode) => {
  const root = realpathSync(mkdtempSync(join(tmpdir(), 'axon-loop-config-exit-')))
  const gate = Promise.withResolvers<void>(); let executed = 0, drained = false
  const options = { directory: join(root, 'data'), validateDefinition: () => {},
    saveMcpConfig: async () => { await gate.promise; if (mode === 'reject') throw new Error('加密失败') }, execute: async () => { executed++; return { phase: 'done' as const } } }
  const service = new LoopService(options)
  service.start({ commandDirectory: '/controlled/bin', socketPath: '/controlled/socket' })
  let restored: LoopService | undefined
  try {
    const promise = service.createWithAgent({ name: '退出任务', workspacePath: root, channelId: 'channel', modelId: 'model', task: '检查', cron: '0 0 1 1 *', mcpConfig: config })
    const failure = promise.catch((error: unknown) => error)
    if (mode === 'exit') service.dispose()
    const drain = mode === 'exit' ? service.drain().then(() => { drained = true }) : Promise.resolve()
    await Promise.resolve(); expect(drained).toBe(false)
    gate.resolve(); expect(await failure).toBeInstanceOf(Error); expect(String(await failure)).toContain('已创建'); await drain
    service.dispose(); await service.drain()
    restored = new LoopService(options); restored.start({ commandDirectory: '/controlled/bin', socketPath: '/controlled/socket' })
    expect(executed).toBe(0); expect(restored.list()[0]?.preparation).toBe('failed')
  } finally { gate.resolve(); service.dispose(); await service.drain(); restored?.dispose(); await restored?.drain(); rmSync(root, { recursive: true }) }
})

test('目录固定且必须真实存在；别名创建规范化，后续改指向拒绝执行，不回退其他目录', async () => {
  const root = realpathSync(mkdtempSync(join(tmpdir(), 'axon-loop-dir-'))), workspace = join(root, 'workspace'), alias = join(root, 'alias')
  mkdirSync(workspace); symlinkSync(workspace, alias); writeFileSync(join(root, 'file'), 'x')
  const requests: LoopExecutionRequest[] = []
  const service = new LoopService({ directory: join(root, 'data'), validateDefinition: () => {}, execute: async (request) => { requests.push(request); return { phase: 'done' } } })
  try {
    service.start({ commandDirectory: '/controlled/bin', socketPath: '/controlled/socket' })
    const input = { name: '目录任务', workspacePath: alias, channelId: 'channel', modelId: 'model', task: '检查', cron: '0 0 1 1 *' }
    for (const path of ['.', join(root, 'missing'), join(root, 'file')]) expect(() => service.create({ ...input, workspacePath: path })).toThrow()
    const job = service.create(input)
    expect(job.workspacePath).toBe(workspace)
    expect(() => service.update(job.id, { workspacePath: root })).toThrow()
    renameSync(workspace, join(root, 'original')); symlinkSync(join(root, 'original'), workspace)
    const result = service.run(job.id)
    service.dispose(); await service.drain()
    expect(requests).toHaveLength(0)
    expect(service.getRun(job.id, result.runId!).error).toContain('工作目录')
  } finally { service.dispose(); await service.drain(); rmSync(root, { recursive: true }) }
})

test('配置变更先撤销授权且保存期间不能执行/更新/删除，失败不复活授权', async () => {
  const root = realpathSync(mkdtempSync(join(tmpdir(), 'axon-loop-mcp-grants-'))), gate = Promise.withResolvers<void>()
  const service = new LoopService({ directory: join(root, 'data'), validateDefinition: () => {}, execute: async () => ({ phase: 'done' }) })
  try {
    service.start({ commandDirectory: '/controlled/bin', socketPath: '/controlled/socket' })
    const job = service.create({ name: '授权任务', workspacePath: root, channelId: 'channel', modelId: 'model', task: '检查',
      cron: '0 0 1 1 *', allowedMcpTools: ['mcp__local__lookup'] })
    const save = service.configureMcp(job.id, async () => { await gate.promise; throw new Error('保存失败') }).catch((error: unknown) => error)
    expect(service.get(job.id).job.allowedMcpTools).toEqual([])
    expect(() => service.run(job.id)).toThrow('正在保存')
    expect(() => service.update(job.id, { allowedMcpTools: ['mcp__local__lookup'] })).toThrow('正在保存')
    expect(() => service.delete(job.id)).toThrow('正在保存')
    gate.resolve(); expect(await save).toBeInstanceOf(Error)
    expect(service.get(job.id).job.allowedMcpTools).toEqual([])
    expect(service.update(job.id, { allowedMcpTools: ['mcp__local__lookup'] }).allowedMcpTools).toEqual(['mcp__local__lookup'])
  } finally { gate.resolve(); service.dispose(); await service.drain(); rmSync(root, { recursive: true }) }
})
