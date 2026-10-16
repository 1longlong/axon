import { afterEach, describe, expect, spyOn, test } from 'bun:test'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { PassThrough, Writable } from 'node:stream'
import { AppServerConnection, JsonRpcPeer } from './index'
import { AgentSessionManagerError, createBackend, createBackendPaths, createCredentialCodec } from '@axon/core'
import type { AxonBackend } from '@axon/core'
import { APP_SERVER_METHODS as methods } from '@axon/shared'
import type { AgentProviderAdapter, AgentQueryInput, AgentStreamPayload, AppServerClient, ExecEvent, RpcJsonValue } from '@axon/shared'
import { ExecOutputStream } from '../../../apps/exec/src/output-stream'
import { ExecRunStream } from '../../../apps/exec/src/run-stream'

const cleanups: Array<() => Promise<void>> = []
afterEach(async () => { for (const cleanup of cleanups.splice(0).reverse()) await cleanup() })

/** 真正 RPC 路由/core/文件持久化接收中立 adapter，隔离宿主目录，不发外部模型请求。 */
async function open(json: boolean, handler: (input: AgentQueryInput) => AsyncIterable<AgentStreamPayload>, tasks = false) {
  const directory = mkdtempSync(join(tmpdir(), 'axon-exec-stream-'))
  const up = new PassThrough(), down = new PassThrough()
  const parent = new JsonRpcPeer(down, up), child = new JsonRpcPeer(up, down)
  const adapter: AgentProviderAdapter = { query: handler, abort() {}, dispose() {}, async drain() {} }
  const chunks: string[] = [], publicEvents: ExecEvent[] = []
  const initialFinished = Promise.withResolvers<void>()
  const output = new Writable({ write(chunk: Buffer, _encoding, callback) { chunks.push(chunk.toString('utf8')); callback() } })
  const sink = new ExecOutputStream(output, json)
  const collector = new ExecRunStream({ executionId: 'integration', emit: (event) => {
    publicEvents.push(event); sink.emit(event)
    if (event.type === 'agent_event' && event.event.type === 'run_finished' && event.event.source === 'external') initialFinished.resolve()
  } })
  collector.attach(parent)
  let backend!: AxonBackend
  const connection = new AppServerConnection({ peer: child, bootstrap() {
    backend = createBackend({ paths: createBackendPaths({ dataDir: join(directory, 'data'), homeDir: directory }),
      applicationVersion: '0.1.4', credentialCodec: createCredentialCodec(), resolveAdapter: () => adapter,
      agentConfiguration: { systemPrompt: '', generateTitle: false, features: { skills: false, mcp: false, memory: false, tasks } },
    })
    return { backend, applicationVersion: '0.1.4', capabilities: { runtimes: [], credentialStorage: 'unavailable', channelTargetConfirmation: false } }
  } })
  cleanups.push(async () => {
    connection.close(); parent.close(); await connection.drain()
    collector.dispose(); sink.dispose(); output.destroy(); up.destroy(); down.destroy()
    rmSync(directory, { recursive: true, force: true })
  })
  await parent.request(methods.INITIALIZE, { protocolVersion: 1, client: { name: 'axon-exec-fixture', version: '0.1.4' },
    hostCapabilities: { credentialStorage: 'unavailable', channelTargetConfirmation: false } })
  const client = await parent.request(methods.REGISTER_CLIENT, { kind: 'external' }) as unknown as AppServerClient
  const channel = await backend.channels.create({ name: '隔离渠道', provider: 'openai', apiKey: '', baseUrl: 'https://example.test/v1',
    models: [{ id: 'fixture', name: '模型', enabled: true }] })
  const project = backend.projects.create({ name: '隔离项目' })
  const session = backend.sessions.create({ runtimeId: 'pi', channelId: channel.id, modelId: 'fixture', projectId: project.id,
    approvalPolicy: 'never', userInputPolicy: 'reject' })
  collector.bind(client.clientId, session.id)
  const execute = (text: string) => parent.request(methods.AGENT_EXECUTE_WORKFLOW, { clientId: client.clientId, input: { sessionId: session.id, text } }, { timeoutMs: 0 })
  const cancel = () => parent.request(methods.AGENT_CANCEL_WORKFLOW, { clientId: client.clientId,
    input: { sessionId: session.id, workflowId: collector.activeWorkflow()!.workflowId } })
  return { backend, session, collector, sink, execute, cancel, chunks, publicEvents, initialFinished }
}

async function* success(text: string): AsyncIterable<AgentStreamPayload> {
  yield { kind: 'sdk_message', message: { type: 'assistant', parent_tool_use_id: null, message: { content: [{ type: 'text', text }] } } }
  yield { kind: 'sdk_message', message: { type: 'result', subtype: 'success', usage: { input_tokens: 1 } } }
}

describe('exec 事件经实际 core/RPC/历史链', () => {
  test('发送应答前 result 与 run_finished 有序到达，最终正文与落盘消息对应', async () => {
    const f = await open(true, async function* (input) {
      expect(input.prompt).toBe('  用户任务\n\n')
      expect(input.executionPolicy).toMatchObject({ approvalPolicy: 'never', userInputPolicy: 'reject' })
      yield { kind: 'sdk_delta', delta: { uuid: 'draft', deltas: [{ type: 'text_delta', contentIndex: 0, delta: '思考后草稿' }] } }
      yield { kind: 'sdk_message', message: { type: 'assistant', parent_tool_use_id: null,
        message: { content: [{ type: 'thinking', thinking: '私有思考' }, { type: 'text', text: '  完整回复\n' }] } } }
      yield { kind: 'sdk_message', message: { type: 'result', subtype: 'success', usage: { input_tokens: 12, output_tokens: 3 } } }
    })
    const snapshot = f.collector.confirm(await f.execute('  用户任务\n\n'))
    expect(snapshot).toMatchObject({ success: true, finalText: '  完整回复\n', result: { completion: { persisted: true } } })
    expect(snapshot.result.lastRun?.runId).toBeString()
    await f.sink.writeFinal(snapshot.finalText)
    expect(f.publicEvents[0]?.type).toBe('workflow_started')
    expect(f.publicEvents.at(-1)?.type).toBe('workflow_finished')
    const stored = f.backend.sessions.getMessages(f.session.id)
    expect(stored.filter((message) => message.type === 'result')).toHaveLength(1)
    for (const event of f.publicEvents) {
      if (event.type !== 'agent_event' || event.event.type !== 'stream' || event.event.payload.kind !== 'sdk_message') continue
      const message = event.event.payload.message
      expect('uuid' in message && stored.some((item) => 'uuid' in item && item.uuid === message.uuid)).toBe(true)
    }
    const parsed = f.chunks.map((line) => JSON.parse(line) as RpcJsonValue)
    expect(parsed).toHaveLength(f.publicEvents.length)
    expect(f.chunks.join('')).not.toContain('clientId')
    expect(f.chunks.every((line) => line.endsWith('\n') && line.split('\n').length === 2)).toBe(true)
  })
  test('RPC 接管成功不冒充模型成功；失败终态保留中立事件而非 stdout 成功正文', async () => {
    const f = await open(false, async function* () {
      yield { kind: 'sdk_message', message: { type: 'assistant', parent_tool_use_id: null,
        message: { content: [{ type: 'text', text: '失败前局部正文' }] } } }
      yield { kind: 'sdk_message', message: { type: 'result', subtype: 'error', usage: { input_tokens: 7 },
        error: { code: 'provider_error', category: 'provider', message: '模型请求失败', retryable: false } } }
    })
    const snapshot = f.collector.confirm(await f.execute('任务'))
    expect(snapshot).toMatchObject({ success: false, finalText: '', result: { status: 'failed', completion: { persisted: true, resultSubtype: 'error' } } })
    await f.sink.flush()
    expect(f.chunks).toEqual([])
    expect(f.backend.sessions.getMessages(f.session.id).some((message) => message.type === 'result')).toBe(true)
  })

  test('后台结果合成续跑结束、通知和 RPC 一致后才选最终正文，JSONL 唯一工作流终态', async () => {
    const gate = Promise.withResolvers<void>()
    let roots = 0, completed = false
    const f = await open(true, async function* (input) {
      if (input.sessionId !== f.session.id) { await gate.promise; yield* success('后台子结果'); return }
      roots++
      if (roots === 1) {
        await input.customTools!.find((tool) => tool.name === 'Agent')!.execute({ description: '后台检查', prompt: '检查', subagent_type: 'explore', run_in_background: true },
          { toolUseId: 'background', signal: input.abortSignal })
        yield* success('初步回复')
      } else { expect(input.prompt).toContain('后台子结果'); yield* success('最终回复\n') }
    }, true)
    const pending = f.execute('任务').then((value) => { completed = true; return value })
    try {
      await f.initialFinished.promise
      expect(f.collector.latest()?.finalText).toBe('初步回复')
      expect(f.collector.activeWorkflow()).toBeDefined(); expect(completed).toBe(false)
      expect(f.publicEvents.some((event) => event.type === 'workflow_finished')).toBe(false)
      gate.resolve()
      const snapshot = f.collector.confirm(await pending)
      expect(snapshot).toMatchObject({ success: true, finalText: '最终回复\n' }); expect(roots).toBe(2)
      await f.sink.writeFinal(snapshot.finalText)
      const records = f.chunks.map((line) => JSON.parse(line) as ExecEvent)
      expect(records.filter((event) => event.type === 'workflow_started')).toHaveLength(1)
      expect(records.filter((event) => event.type === 'workflow_finished')).toHaveLength(1)
      expect(records.some((event) => event.type === 'agent_event' && event.run.sessionId !== f.session.id)).toBe(true)
      expect(records.map((event) => event.sequence)).toEqual(records.map((_, index) => index + 1))
      expect(f.chunks.join('')).not.toContain('clientId')
      expect(f.backend.sessions.getMessages(f.session.id).filter((message) => message.type === 'result')).toHaveLength(2)
    } finally { gate.resolve(); await pending }
  })

  test('主轮空隙取消，真实子清理结束后才报告 canceled，普通 stdout 不输出初步回复', async () => {
    const aborted = Promise.withResolvers<void>(), gate = Promise.withResolvers<void>()
    let roots = 0
    const f = await open(false, async function* (input) {
      if (input.sessionId !== f.session.id) {
        if (!input.abortSignal!.aborted) await new Promise<void>((resolve) => input.abortSignal!.addEventListener('abort', () => resolve(), { once: true }))
        aborted.resolve(); await gate.promise; yield* success('迟到子结果'); return
      }
      roots++
      await input.customTools!.find((tool) => tool.name === 'Agent')!.execute({ description: '后台检查', prompt: '检查', subagent_type: 'explore', run_in_background: true },
        { toolUseId: 'cancel-background', signal: input.abortSignal })
      yield* success('初步回复')
    }, true)
    const pending = f.execute('任务')
    try {
      await f.initialFinished.promise; expect(await f.cancel()).toBe(true); await aborted.promise
      expect(f.publicEvents.some((event) => event.type === 'workflow_finished')).toBe(false)
      gate.resolve()
      const snapshot = f.collector.confirm(await pending)
      expect(snapshot).toMatchObject({ success: false, finalText: '', result: { status: 'canceled' } })
      await f.sink.flush(); expect(f.chunks).toEqual([]); expect(roots).toBe(1)
    } finally { gate.resolve(); await pending }
  })

  test('子会话原文无法保存时不能靠父模型正常回复判工作流成功', async () => {
    const f = await open(false, async function* (input) {
      const task = await input.customTools!.find((tool) => tool.name === 'Agent')!.execute({ description: '子检查', prompt: '检查', subagent_type: 'explore' },
        { toolUseId: 'failed-child-storage', signal: input.abortSignal })
      expect(JSON.stringify(task)).toContain('failed')
      yield* success('已看到子任务错误')
    }, true)
    const append = f.backend.sessions.appendMessage.bind(f.backend.sessions)
    const fault = spyOn(f.backend.sessions, 'appendMessage').mockImplementation((sessionId, message) => {
      if (sessionId !== f.session.id) throw new AgentSessionManagerError('storage_error', '夹具存储故障')
      return append(sessionId, message)
    })
    try {
      const result = await f.execute('任务')
      expect(result).toMatchObject({ status: 'failed', error: { code: 'persistence_error' } })
      expect(f.collector.confirm(result)).toMatchObject({ success: false, finalText: '' })
      await f.sink.flush(); expect(f.chunks).toEqual([])
    } finally { fault.mockRestore() }
  })
})
