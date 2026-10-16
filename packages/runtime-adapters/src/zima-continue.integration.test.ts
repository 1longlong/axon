import { expect, test } from 'bun:test'
import { mkdirSync, mkdtempSync, readFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { AgentEventBus, AgentRunCoordinator, AgentService, AgentSessionManager, BackendClientRegistry } from '@axon/core'
import type { SDKUserMessage } from '@axon/shared'
import { ZimaAgentAdapter } from './zima-agent-adapter'

interface ModelRequest {
  messages: Array<{ role: string; content?: unknown; tool_call_id?: string }>
}

// 独立源码 Runtime 必须由调用方显式指定，不依赖 PATH 或自动安装。
;(process.env.AXON_TEST_ZIMA_PYTHON ? test : test.skip)('真实 Zima/core：暂停后重建服务继续原轮，审批、重试与 artifact 不新增人类输入', async () => {
  const directory = mkdtempSync(join(tmpdir(), 'axon-zima-native-continue-'))
  const workspace = join(directory, 'workspace')
  mkdirSync(workspace)
  const requests: ModelRequest[] = [], approvals: string[] = []
  const ready = Promise.withResolvers<void>()
  const server = Bun.serve({ hostname: '127.0.0.1', port: 0, async fetch(request) {
    requests.push(await request.json() as ModelRequest)
    const count = requests.length
    const frame = (delta: unknown, finish: string | null = null): string => `data: ${JSON.stringify({
      id: `zima-fixture-${count}`, model: 'axon-fixture', choices: [{ index: 0, delta, finish_reason: finish }],
    })}\n\n`
    if (count === 2) return new Response(new ReadableStream<Uint8Array>({ start(controller) {
      controller.enqueue(new TextEncoder().encode(frame({ role: 'assistant', reasoning_content: '中断前思考', content: '中断前正文' })))
    } }), { headers: { 'content-type': 'text/event-stream' } })
    if (count === 3) return Response.json({ error: { message: '本机临时限流' } }, { status: 429, headers: { 'retry-after': '0' } })
    const tool = count === 1 || count === 4
    const delta = tool ? { role: 'assistant', tool_calls: [{ index: 0, id: `write-${count}`, type: 'function',
      function: { name: 'Write', arguments: JSON.stringify({ path: count === 1 ? 'before.txt' : 'after.txt', content: '只执行一次' }) } }] }
      : { role: 'assistant', content: '原任务已继续完成' }
    return new Response(frame(delta) + frame({}, tool ? 'tool_calls' : 'stop') + 'data: [DONE]\n\n',
      { headers: { 'content-type': 'text/event-stream' } })
  } })
  const paths = { indexPath: join(directory, 'index.json'), sessionsDir: join(directory, 'history') }
  /** 重建同一存储上的全新服务与 adapter，避免只测到旧对象的内存恢复。 */
  const open = () => {
    const adapter = new ZimaAgentAdapter(process.env.AXON_TEST_ZIMA_PYTHON!, 'test')
    const sessions = new AgentSessionManager(paths), events = new AgentEventBus()
    const clients = new BackendClientRegistry(), owner = clients.register()
    const agent = new AgentService({ adapter, resolveAdapter: () => adapter, sessionManager: sessions, eventBus: events,
      resolveProjectCwd: () => workspace, runtimeConfigDir: join(directory, 'config'), runtimeSessionDir: join(directory, 'runtime'),
      channelManager: { resolve: async () => ({ id: 'local', name: '本机', provider: 'custom', apiKey: 'local-fixture-key',
        baseUrl: `http://127.0.0.1:${server.port}/v1`, enabled: true, createdAt: 1, updatedAt: 1,
        models: [{ id: 'axon-fixture', name: '模型', enabled: true }] }) },
      createCanUseTool: () => async (name, args) => {
        expect(name).toBe('Write')
        approvals.push(String(args.file_path))
        return { behavior: 'allow' }
      },
    })
    const coordinator = new AgentRunCoordinator({ clients, sessions, agent, events, resolveCreationWorkspace: () => workspace })
    return { adapter, sessions, events, clients, owner, agent, coordinator }
  }
  const close = async (backend: ReturnType<typeof open>) => {
    backend.coordinator.dispose(); backend.agent.dispose(); backend.adapter.dispose(); backend.clients.dispose()
    await Promise.all([backend.coordinator.drain(), backend.agent.drain(), backend.adapter.drain()])
  }
  let backend = open(), sending: Promise<unknown> | undefined
  let guard: ReturnType<typeof setTimeout> | undefined
  try {
    const session = backend.sessions.create({ runtimeId: 'zima', projectId: 'project', channelId: 'local', modelId: 'axon-fixture' })
    const release = backend.events.subscribe((event) => {
      if (event.type === 'stream' && event.payload.kind === 'sdk_delta'
        && event.payload.delta.deltas.some((delta) => delta.type === 'text_delta' && delta.delta.includes('中断前正文'))) ready.resolve()
    })
    sending = backend.coordinator.send(backend.owner, { sessionId: session.id, text: '原用户任务' }, () => {})
    await Promise.race([ready.promise, sending.then(() => { throw new Error('未进入目标流阶段') }),
      new Promise<never>((_resolve, reject) => { guard = setTimeout(() => reject(new Error('目标暂停阶段未就绪')), 8000) })])
    clearTimeout(guard)
    const run = backend.coordinator.getOwnedRun(backend.owner, session.id)!
    const paused = await backend.coordinator.pauseRun(backend.owner, { sessionId: session.id, runId: run.runId })
    await sending
    release()
    expect(requests).toHaveLength(2)
    expect(approvals).toHaveLength(1)
    expect(backend.sessions.getMessages(session.id).some((message) => message.type === 'assistant' && message.isPartial === true)).toBe(true)
    await close(backend)
    backend = open()
    expect(backend.coordinator.getPause(backend.owner, session.id)).toEqual(paused)
    expect(await backend.coordinator.continueRun(backend.owner, { sessionId: session.id, pauseId: paused.pauseId })).toMatchObject({ success: true })
    const history = backend.sessions.getMessages(session.id)
    expect(history.filter((message) => message.type === 'user' && (message as SDKUserMessage).message?.content?.some((block) => block.type === 'text'))).toHaveLength(1)
    expect(history.findLast((message) => message.type === 'system' && message.subtype === 'axon_continued'))
      .toMatchObject({ turn_id: paused.turnId, resumed_pause_id: paused.pauseId })
    expect(history.at(-1)).toMatchObject({ type: 'result', terminal_reason: 'completed' })
    expect(backend.coordinator.getPause(backend.owner, session.id)).toBeNull()
    expect(requests).toHaveLength(5)
    expect(approvals).toEqual(['before.txt', 'after.txt'])
    expect(requests[2]?.messages.some((message) => message.role === 'tool' && message.tool_call_id === 'write-1')).toBe(true)
    expect(JSON.stringify(requests[2])).toContain('本任务此前被用户中断')
    expect(readFileSync(join(workspace, 'before.txt'), 'utf8')).toBe('只执行一次')
    expect(readFileSync(join(workspace, 'after.txt'), 'utf8')).toBe('只执行一次')
    const metadata = backend.sessions.get(session.id)!
    const stateFile = metadata.runtimeSessionFile!
    const state = JSON.parse(readFileSync(stateFile, 'utf8')) as { messages_file: string }
    const entries = readFileSync(join(stateFile, '..', state.messages_file), 'utf8').trim().split('\n')
      .map((line) => JSON.parse(line) as { message: { role: string; metadata?: { kind?: string } } })
    expect(entries.filter((entry) => entry.message.role === 'user')).toHaveLength(1)
    expect(entries.filter((entry) => entry.message.metadata?.kind === 'host_interruption')).toHaveLength(1)
  } finally {
    clearTimeout(guard)
    try { await close(backend); await sending } finally { server.stop(true); rmSync(directory, { recursive: true, force: true }) }
  }
}, 25000)
