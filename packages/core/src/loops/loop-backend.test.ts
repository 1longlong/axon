/** 真实后端装配验证 MCP Schema 与无人值守策略；模型和 MCP 传输为中立夹具。 */
import { expect, test } from 'bun:test'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type { AgentProviderAdapter } from '@axon/shared'
import { createBackend } from '../backend'
import type { AxonBackend } from '../backend'
import { createBackendPaths } from '../settings/backend-paths'
import { createFixtureCredentialCodec } from '../../test-support/credential-codec'

test('Loop 实际执行使用 never/reject；MCP 错参在调用前拒绝，token 不进入历史', async () => {
  const root = mkdtempSync(join(tmpdir(), 'axon-loop-backend-'))
  let backend!: AxonBackend, calls = 0, token = '', checked = false
  const adapter: AgentProviderAdapter = {
    async *query(input) {
      token = input.toolEnvironment!.environmentOverrides.AXON_LOOP_TOKEN!
      expect(input.executionPolicy?.approvalPolicy).toBe('never')
      expect(input.executionPolicy?.userInputPolicy).toBe('reject')
      const log = JSON.parse(backend.loops.cli(token, ['log']).text) as Array<{ id: string; phase: string; trigger: string }>
      expect(log[0]).toMatchObject({ phase: 'running', trigger: 'manual' })
      const trace = backend.loops.cli(token, ['trace', '--run', log[0]!.id]).text
      expect(trace).toContain('任务文档'); expect(trace).not.toContain(token)
      expect(() => backend.loops.cli(token, ['trace', '--run', 'foreign-run'])).toThrow('不存在')
      expect(() => backend.loops.cli(token, ['trace', '--run', log[0]!.id, '--offset', '-1'])).toThrow('消息位置')
      await expect(backend.loops.dispatchCli(token, ['mcp-call', '--name', 'mcp__local__lookup', '--args', '{"count":"wrong"}']))
        .rejects.toThrow('尚未执行')
      expect(calls).toBe(0)
      const result = await backend.loops.dispatchCli(token, ['mcp-call', '--name', 'mcp__local__lookup', '--args', '{"count":1}'])
      expect(result.text).toContain('夹具结果'); expect(calls).toBe(1)
      backend.loops.cli(token, ['finish', '--message', '验证完成', '--reason', '校验调用链'])
      checked = true
      yield { kind: 'sdk_message', message: { type: 'assistant', message: { content: [{ type: 'text', text: '完成' }] } } }
      yield { kind: 'sdk_message', message: { type: 'result', subtype: 'success' } }
    }, abort() {}, dispose() {}, async drain() {},
  }
  backend = createBackend({ paths: createBackendPaths({ dataDir: join(root, 'data'), homeDir: root }),
    applicationVersion: '0.1.5', credentialCodec: createFixtureCredentialCodec(), resolveAdapter: () => adapter,
    connectMcpServer: () => ({ ready: Promise.resolve(), client: {
      listTools: async () => ({ tools: [{ name: 'lookup', inputSchema: { type: 'object', properties: { count: { type: 'integer' } }, required: ['count'], additionalProperties: false } }] }),
      callTool: async () => { calls++; return { content: [{ type: 'text', text: '夹具结果' }] } }, close: async () => {},
    } }), providerStream: async function* () { yield { type: 'text_delta', delta: '任务' }; yield { type: 'finish', reason: 'stop' } },
  })
  try {
    const channel = await backend.channels.create({ name: '测试', provider: 'custom', apiKey: 'fixture', baseUrl: 'http://localhost:8123/v1',
      models: [{ id: 'fixture', name: '模型', enabled: true }] })
    const project = backend.projects.create({ name: '任务项目' })
    backend.loops.start({ commandDirectory: '/controlled/bin', socketPath: '/controlled/socket' })
    const job = backend.loops.create({ name: '后端验收', workspacePath: backend.projects.resolveProjectCwd(project.id), channelId: channel.id, modelId: 'fixture',
      task: '验证', goal: '完成校验', cron: '0 0 1 1 *', allowedMcpTools: ['mcp__local__lookup'] })
    await backend.loopMcp.save(job.id, { version: 1, servers: { local: { type: 'stdio', command: 'fixture', enabled: true,
      required: true, startupTimeoutMs: 1000, requestTimeoutMs: 1000 } } })
    const runId = backend.loops.run(job.id).runId!
    const deadline = Date.now() + 3000
    while (backend.loops.get(job.id).job.running && Date.now() < deadline) await Bun.sleep(2)
    const run = backend.loops.getRun(job.id, runId)
    expect(checked).toBe(true); expect(run.phase).toBe('done')
    expect(JSON.stringify(backend.sessions.getMessages(run.sessionId!))).not.toContain(token)
    expect(backend.loops.get(job.id).job.completedAt).not.toBeNull()
  } finally { backend.dispose(); await backend.drain(); rmSync(root, { recursive: true }) }
})

test('首次创作使用完整工作流的独立提示，由 CLI 保存配置而非执行普通业务', async () => {
  const root = mkdtempSync(join(tmpdir(), 'axon-loop-authoring-backend-'))
  let backend!: AxonBackend, checked = false, prechecks = 0
  const adapter: AgentProviderAdapter = {
    async *query(input) {
      expect(input.prompt).toContain('这是首次配置准备轮')
      expect(input.prompt).toContain('不要求用户编写 HTML、JavaScript 或 JSON')
      expect(input.prompt).toContain('不改变计划，不调用 finish')
      expect(input.executionPolicy?.approvalPolicy).toBe('never')
      expect(input.executionPolicy?.userInputPolicy).toBe('reject')
      const token = input.toolEnvironment!.environmentOverrides.AXON_LOOP_TOKEN!
      backend.loops.cli(token, ['set-ui', '--body', '<axon-embed file="report.md"></axon-embed>'])
      backend.loops.cli(token, ['set-workflow', '--body', 'agent("检查最新报告");'])
      backend.loops.cli(token, ['report', '--status', 'resolved', '--message', '已准备报告面板与预检'])
      checked = true
      yield { kind: 'sdk_message', message: { type: 'assistant', message: { content: [{ type: 'text', text: '准备完成' }] } } }
      yield { kind: 'sdk_message', message: { type: 'result', subtype: 'success' } }
    }, abort() {}, dispose() {}, async drain() {},
  }
  backend = createBackend({ paths: createBackendPaths({ dataDir: join(root, 'data'), homeDir: root }),
    applicationVersion: '0.1.5', credentialCodec: createFixtureCredentialCodec(), resolveAdapter: () => adapter,
    loopPrecheck: async () => { prechecks++; throw new Error('创作轮不得运行预检') },
    providerStream: async function* () { yield { type: 'text_delta', delta: '配置准备' }; yield { type: 'finish', reason: 'stop' } },
  })
  try {
    const channel = await backend.channels.create({ name: '准备模型', provider: 'custom', apiKey: 'fixture', baseUrl: 'http://localhost:8123/v1',
      models: [{ id: 'fixture', name: '模型', enabled: true }] })
    const project = backend.projects.create({ name: '准备项目' })
    backend.loops.start({ commandDirectory: '/controlled/bin', socketPath: '/controlled/socket' })
    const job = await backend.loops.createWithAgent({ name: '准备验收', workspacePath: backend.projects.resolveProjectCwd(project.id), channelId: channel.id, modelId: 'fixture',
      task: '整理报告并展示', cron: '0 0 1 1 *', enabled: false })
    const deadline = Date.now() + 3000
    while (backend.loops.get(job.id).job.running && Date.now() < deadline) await Bun.sleep(2)
    expect(checked).toBe(true); expect(prechecks).toBe(0)
    expect(backend.loops.get(job.id).job).toMatchObject({ preparation: 'ready', enabled: false,
      workflow: 'agent("检查最新报告");', ui: '<axon-embed file="report.md"></axon-embed>' })
    const run = backend.loops.get(job.id).runs[0]!
    expect(run).toMatchObject({ role: 'setup', phase: 'done', status: 'resolved' })
    expect(backend.loops.getRun(job.id, run.id).query).toContain('只读检查核实项目中的真实文件')
  } finally { backend.dispose(); await backend.drain(); rmSync(root, { recursive: true }) }
})
