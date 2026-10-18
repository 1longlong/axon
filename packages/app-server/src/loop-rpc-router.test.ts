/** 真实 core 与双端协议，验证 Loop 只由主窗口管理且通知晚于持久化。 */
import { expect, test } from 'bun:test'
import { mkdtempSync, readFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { PassThrough } from 'node:stream'
import { createBackend, createBackendPaths } from '@axon/core'
import { createFixtureCredentialCodec } from '../../core/test-support/credential-codec'
import { APP_SERVER_METHODS as methods, APP_SERVER_NOTIFICATIONS as notices } from '@axon/shared'
import type { AppServerClient, LoopSummary, RpcJsonObject, RpcJsonValue } from '@axon/shared'
import { AppServerConnection, JsonRpcPeer } from './index'

test('拒绝快捷入口/伪造身份/路径与凭据注入，合法保存后再通知', async () => {
  const root = mkdtempSync(join(tmpdir(), 'axon-loop-rpc-'))
  const backend = createBackend({ paths: createBackendPaths({ dataDir: join(root, 'data'), homeDir: root }),
    applicationVersion: '0.1.5', credentialCodec: createFixtureCredentialCodec(), resolveAdapter: () => ({
      query: async function* () { throw new Error('本项不执行模型') }, abort() {}, dispose() {}, async drain() {},
    }), connectMcpServer: () => ({ ready: Promise.resolve(), client: {
      listTools: async () => ({ tools: [{ name: 'lookup', inputSchema: { type: 'object', properties: {} } }] }),
      callTool: async () => ({ content: [] }), close: async () => {},
    } }) })
  const upstream = new PassThrough(), downstream = new PassThrough()
  const parent = new JsonRpcPeer(downstream, upstream), child = new JsonRpcPeer(upstream, downstream)
  const connection = new AppServerConnection({ peer: child, bootstrap: () => ({ backend, applicationVersion: '0.1.5',
    capabilities: { runtimes: [], credentialStorage: 'unavailable', channelTargetConfirmation: false } }) })
  try {
    await parent.request(methods.INITIALIZE, { protocolVersion: 1, client: { name: 'axon-loop-test', version: '0.1.5' },
      hostCapabilities: { credentialStorage: 'unavailable', channelTargetConfirmation: false } })
    const main = await parent.request(methods.REGISTER_CLIENT, { kind: 'main' }) as unknown as AppServerClient
    const quick = await parent.request(methods.REGISTER_CLIENT, { kind: 'quick' }) as unknown as AppServerClient
    const request = (method: string, input?: RpcJsonValue, client = main) => parent.request(method,
      { clientId: client.clientId, ...(input === undefined ? {} : { input }) })
    const channel = await backend.channels.create({ name: '测试渠道', provider: 'openai', apiKey: '',
      models: [{ id: 'fixture', name: '模型', enabled: true }] })
    const project = backend.projects.create({ name: '测试项目' })
    const input = { name: '协议验收', workspacePath: root, channelId: channel.id, modelId: 'fixture', task: '检查', cron: '0 0 1 1 *' }
    backend.loops.start({ commandDirectory: '/controlled/bin', socketPath: '/controlled/socket' })
    const persisted: boolean[] = []
    parent.handleNotification(notices.LOOP_CHANGED, (params) => {
      const packet = params as unknown as { clientId: string; event: { loopId: string } }
      persisted.push(packet.clientId === main.clientId && readFileSync(join(backend.paths.dataDir, 'loops', packet.event.loopId, 'journal.jsonl'), 'utf8').includes('协议验收'))
    })
    await expect(request(methods.LOOP_LIST, undefined, quick)).rejects.toMatchObject({ code: -32602 })
    const rejected: RpcJsonObject[] = [{ projectId: project.id }, { owner: main.clientId }, { token: 'secret' }, { runtimeId: 'zima' }, { ui: '<p>页面不能创作</p>' }, { workflow: 'return {}' }, { stateSchema: [] }]
    for (const extra of rejected) {
      await expect(request(methods.LOOP_CREATE, { ...input, ...extra })).rejects.toMatchObject({ code: -32030, data: { code: 'invalid_input' } })
    }
    await expect(request(methods.LOOP_CREATE, { ...input, cron: 'not cron' })).rejects.toMatchObject({ code: -32030, data: { code: 'invalid_input' } })
    const job = await request(methods.LOOP_CREATE, input) as unknown as LoopSummary
    await request(methods.LOOP_LIST)
    expect(persisted.length).toBeGreaterThan(0)
    expect(persisted.every(Boolean)).toBe(true)
    expect(backend.loops.get(job.id).job.task).toBe('检查')
    for (let attempt = 0; attempt < 200 && backend.loops.get(job.id).job.running; attempt++) await Bun.sleep(2)
    const config: RpcJsonObject = { version: 1, servers: { local: { type: 'stdio', command: 'fixture', env: { TOKEN: 'private-loop-rpc-secret' } } } }
    expect(await request(methods.LOOP_MCP_GET_CONFIG, job.id)).toEqual({ version: 1, servers: {} })
    await request(methods.LOOP_UPDATE, { loopId: job.id, update: { allowedMcpTools: ['mcp__local__lookup'] } })
    await request(methods.LOOP_MCP_SAVE_CONFIG, { loopId: job.id, config })
    expect(backend.loops.get(job.id).job.allowedMcpTools).toEqual([])
    expect(readFileSync(join(backend.paths.dataDir, 'loops', job.id, 'mcp.json'), 'utf8')).not.toContain('private-loop-rpc-secret')
    expect(readFileSync(join(backend.paths.dataDir, 'loops', job.id, 'journal.jsonl'), 'utf8')).not.toContain('private-loop-rpc-secret')
    expect(await request(methods.LOOP_MCP_TOOLS, { target: { loopId: job.id } })).toMatchObject([{ name: 'mcp__local__lookup' }])
    expect(await request(methods.LOOP_MCP_TOOLS, { target: { workspacePath: root }, config })).toMatchObject([{ name: 'mcp__local__lookup' }])
    expect(await request(methods.LOOP_MCP_TEST_CONNECTION, { target: { workspacePath: root }, serverName: 'draft', server: { type: 'stdio', command: 'fixture' } })).toMatchObject({ ok: true, tools: [{ name: 'lookup', inputSchema: { type: 'object' } }] })
    await expect(request(methods.LOOP_MCP_GET_CONFIG, job.id, quick)).rejects.toMatchObject({ code: -32602 })
    await expect(request(methods.LOOP_MCP_TOOLS, { target: { loopId: job.id, workspacePath: root } })).rejects.toMatchObject({ code: -32030 })
    await expect(request(methods.LOOP_MCP_TOOLS, { target: { projectId: project.id } })).rejects.toMatchObject({ code: -32030 })
    await expect(request(methods.LOOP_MCP_SAVE_CONFIG, { loopId: job.id, config, directory: '/tmp' })).rejects.toMatchObject({ code: -32030 })
    await expect(request(methods.LOOP_UPDATE, { loopId: job.id, update: { workspacePath: root } })).rejects.toMatchObject({ code: -32030 })
    await expect(request(methods.LOOP_UPDATE, { loopId: job.id, update: { projectId: 'foreign' } })).rejects.toMatchObject({ code: -32030 })
    await expect(request(methods.LOOP_STOP, { loopId: job.id, runId: 'old', token: 'secret' })).rejects.toMatchObject({ code: -32030 })
    expect(await request(methods.LOOP_STOP, { loopId: job.id, runId: 'old' })).toBe(false)
    await expect(request(methods.LOOP_READ_ARTIFACT, { loopId: job.id, path: '/etc/passwd' })).rejects.toMatchObject({ code: -32030 })
    const foreign = backend.clients.register()
    await expect(parent.request(methods.LOOP_LIST, { clientId: foreign })).rejects.toMatchObject({ code: -32004 })
    backend.clients.detach(foreign)
    await parent.request(methods.DETACH_CLIENT, { clientId: main.clientId })
    await expect(request(methods.LOOP_LIST)).rejects.toMatchObject({ code: -32004 })
  } finally {
    connection.close(); parent.close(); upstream.destroy(); downstream.destroy()
    backend.dispose(); await Promise.all([backend.drain(), connection.drain()]); rmSync(root, { recursive: true })
  }
})
