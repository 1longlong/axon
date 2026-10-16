import { expect, test } from 'bun:test'
import { existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync } from 'node:fs'
import { spawnSync } from 'node:child_process'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { AgentEventBus, AgentService, AgentSessionManager, AgentRunCoordinator, BackendClientRegistry, buildAgentSandboxPolicy } from '@axon/core'
import type { AgentContinueQueryInput, AgentHostToolExecutionPort, AgentProviderAdapter, AgentQueryInput, AgentStreamPayload } from '@axon/shared'
import { PiAgentAdapter, ZimaAgentAdapter } from './index'

/** 禁用全部内置工具，端口一旦被调用便拒绝；此夹具不模拟实际 OS 沙箱。 */
function closedHost(executeShellCommand?: AgentHostToolExecutionPort['executeShellCommand']): AgentHostToolExecutionPort {
  const reject = async (): Promise<never> => { throw new Error('集成夹具禁止宿主 IO') }
  return {
    getSandboxCapability: () => ({ supported: true, modes: ['workspaceWrite'],
      sandboxedTools: ['bash', 'read', 'write', 'edit', 'grep', 'glob', 'ls'] }),
    initializeShellEnvironment: () => ({ executeShellCommand: executeShellCommand ?? reject, dispose: () => {}, drain: async () => {} }),
    executeShellCommand: executeShellCommand ?? reject, executeCommand: reject, readFile: reject, assertFileAccess: reject,
    writeFile: reject, createDirectory: reject, pathExists: reject, statPath: reject,
    readDirectory: reject, glob: reject, searchText: reject, detectImageMimeType: reject,
  }
}

interface CompletionRequest {
  messages: Array<{ role: string; content?: string | Array<{ type: string; text?: string }> | null; tool_call_id?: string }>
  tools?: Array<{ function: { name: string; parameters: Record<string, unknown> } }>
}

test('真实 Pi SDK：保留 assistant 尾部，以宿主中断背景继续，工具执行与限流重试保持原链', async () => {
  const directory = mkdtempSync(join(tmpdir(), 'axon-pi-native-continue-'))
  const requests: CompletionRequest[] = []
  let executions = 0, sessionFile = '', runtimeSessionId = ''
  const server = Bun.serve({ hostname: '127.0.0.1', port: 0, async fetch(request) {
    requests.push(await request.json() as CompletionRequest)
    const count = requests.length
    if (count === 3) return Response.json({ error: { message: '本机临时限流' } }, { status: 429, headers: { 'retry-after': '0' } })
    const delta = count === 2
      ? { role: 'assistant', tool_calls: [{ index: 0, id: 'continue-probe', type: 'function', function: { name: 'AxonProbe', arguments: '{}' } }] }
      : { role: 'assistant', content: count === 1 ? '此前已经保存的助手正文' : '继续完成' }
    const frame = (value: unknown) => `data: ${JSON.stringify(value)}\n\n`
    return new Response(frame({ id: 'continue-fixture', model: 'axon-fixture', choices: [{ index: 0, delta, finish_reason: null }] })
      + frame({ id: 'continue-fixture', model: 'axon-fixture', choices: [{ index: 0, delta: {}, finish_reason: count === 2 ? 'tool_calls' : 'stop' }],
        usage: { prompt_tokens: 30, completion_tokens: 3, total_tokens: 33 } }) + 'data: [DONE]\n\n',
    { headers: { 'content-type': 'text/event-stream' } })
  } })
  let adapter = new PiAgentAdapter(undefined, closedHost())
  const input: AgentQueryInput = {
    sessionId: 'native-continue', prompt: '原用户任务', cwd: directory, model: 'axon-fixture',
    connection: { provider: 'custom', baseUrl: `http://127.0.0.1:${server.port}/v1`, apiKey: '' },
    runtimeConfigDir: join(directory, 'config'), runtimeSessionDir: join(directory, 'sessions'),
    executionPolicy: { sandboxMode: 'workspaceWrite', approvalPolicy: 'onRequest', approvalReviewer: 'user' },
    sandboxPolicy: buildAgentSandboxPolicy({ projectRoot: directory, mode: 'workspaceWrite' }),
    allowedBuiltinTools: [], systemPrompt: '隔离继续测试', abortSignal: AbortSignal.timeout(12_000),
    customTools: [{ name: 'AxonProbe', description: '隔离回显', permissionMode: 'managed', inputSchema: { type: 'object', properties: {} },
      execute: async () => { executions++; return { content: '真实工具回传' } } }],
    onRuntimeSession: (id, file) => { runtimeSessionId = id; sessionFile = file ?? '' },
  }
  try {
    for await (const _payload of adapter.query(input)) { /* 先保存以 assistant 结尾的真实 artifact。 */ }
    expect(requests).toHaveLength(1)
    expect(readFileSync(sessionFile, 'utf8')).toContain('此前已经保存的助手正文')
    adapter.dispose(); await adapter.drain()
    adapter = new PiAgentAdapter(undefined, closedHost())
    const { prompt: _prompt, ...common } = input
    const continuing: AgentContinueQueryInput = { ...common, resumeSessionId: runtimeSessionId, runtimeSessionFile: sessionFile,
      interruptionId: 'pause-fixture', interruptionContext: '<system-reminder>上一轮被中断，工具可能部分执行。</system-reminder>' }
    const events: AgentStreamPayload[] = []
    for await (const event of adapter.continueQuery(continuing)) events.push(event)
    expect(requests).toHaveLength(4)
    expect(executions).toBe(1)
    expect(JSON.stringify(requests[1]?.messages)).toContain('此前已经保存的助手正文')
    expect(JSON.stringify(requests[1]?.messages)).toContain('上一轮被中断')
    expect(requests[3]?.messages.some((message) => message.role === 'tool' && message.tool_call_id === 'continue-probe')).toBe(true)
    expect(events.some((event) => event.kind === 'retry_status' && event.status.phase === 'scheduled')).toBe(true)
    expect(events.filter((event) => event.kind === 'sdk_message' && event.message.type === 'result'))
      .toEqual([expect.objectContaining({ message: expect.objectContaining({ terminal_reason: 'completed' }) })])
    const entries = readFileSync(sessionFile, 'utf8').trim().split('\n').map((line) => JSON.parse(line) as {
      type: string; customType?: string; message?: { role?: string }; details?: { interruptionId?: string }
    })
    expect(entries.filter((entry) => entry.type === 'message' && entry.message?.role === 'user')).toHaveLength(1)
    expect(entries.filter((entry) => entry.type === 'custom_message' && entry.customType === 'axon_interruption'))
      .toMatchObject([{ details: { interruptionId: 'pause-fixture' } }])
  } finally {
    adapter.dispose()
    try { await adapter.drain() } finally { server.stop(true); rmSync(directory, { recursive: true, force: true }) }
  }
}, 20_000)

// 真实 SDK 只请求本机模型；内置 IO 禁用，实际 OS 执行另由宿主/生产入口验收。
for (const stage of ['stream', 'parameters', 'retry', 'compact'] as const) {
  test(`真实 Pi SDK/core：${stage} 阶段暂停关闭请求/重试，保存唯一停止终态和继续凭据`, async () => {
    const directory = mkdtempSync(join(tmpdir(), 'axon-pi-pause-'))
    const ready = Promise.withResolvers<void>(), connected = Promise.withResolvers<void>(), closed = Promise.withResolvers<void>()
    let requests = 0, executions = 0
    let continuing = false
    const requestBodies: CompletionRequest[] = []
    const server = Bun.serve({ hostname: '127.0.0.1', port: 0, async fetch(request) {
      const body = await request.json() as CompletionRequest; requests++
      requestBodies.push(body)
      const frame = (delta: unknown, finish: string | null = null, usage?: unknown): string => `data: ${JSON.stringify({
        id: 'pause-fixture', model: 'axon-fixture', choices: [{ index: 0, delta, finish_reason: finish }], ...(usage ? { usage } : {}),
      })}\n\n`
      if (continuing) return new Response(frame({ role: 'assistant', content: '原任务继续完成' })
        + frame({}, 'stop', { prompt_tokens: 20, completion_tokens: 3 }) + 'data: [DONE]\n\n',
      { headers: { 'content-type': 'text/event-stream' } })
      if (stage === 'retry') return Response.json({ error: { message: '本机限流夹具' } }, { status: 429 })
      if (stage === 'compact' && body.tools?.length) return new Response(
        frame({ role: 'assistant', content: '压缩前原文' }) + frame({}, 'stop', { prompt_tokens: requests === 1 ? 12 : 190000, completion_tokens: 3 }) + 'data: [DONE]\n\n',
        { headers: { 'content-type': 'text/event-stream' } },
      )
      return new Response(new ReadableStream<Uint8Array>({
        start(controller) {
          controller.enqueue(new TextEncoder().encode(frame(stage === 'parameters'
            ? { role: 'assistant', tool_calls: [{ index: 0, id: 'half-tool', type: 'function', function: { name: 'AxonUnused', arguments: '{"value":"half' } }] }
            : { role: 'assistant', content: stage === 'compact' ? '尚未完成的摘要' : '尚未完成的正文' })))
          connected.resolve()
        },
        cancel() { closed.resolve() },
      }), { headers: { 'content-type': 'text/event-stream' } })
    } })
    const adapter = new PiAgentAdapter(undefined, closedHost())
    const clients = new BackendClientRegistry(), owner = clients.register()
    const events = new AgentEventBus(), sessions = new AgentSessionManager({ indexPath: join(directory, 'index.json'), sessionsDir: join(directory, 'history') })
    const session = sessions.create({ projectId: 'project', channelId: 'local', modelId: 'axon-fixture' })
    const agent = new AgentService({ adapter, sessionManager: sessions, eventBus: events, resolveProjectCwd: () => directory,
      runtimeConfigDir: join(directory, 'config'), runtimeSessionDir: join(directory, 'runtime'),
      channelManager: { resolve: async () => ({ id: 'local', name: '本机', provider: 'custom',
        baseUrl: `http://127.0.0.1:${server.port}/v1`, apiKey: '', enabled: true, createdAt: 1, updatedAt: 1,
        models: [{ id: 'axon-fixture', name: '模型', enabled: true }] }) },
      // 不产生副作用；半截参数即使被容错解析，也不得进入此执行函数。
      getCustomTools: () => [{ name: 'AxonUnused', description: '禁止实际调用的测试工具', permissionMode: 'managed',
        inputSchema: { type: 'object', properties: { value: { type: 'string' } }, required: ['value'] },
        execute: async () => { executions++; return { content: '不应执行' } } }],
    })
    const coordinator = new AgentRunCoordinator({ clients, agent, sessions, events, resolveCreationWorkspace: () => directory })
    const release = events.subscribe((event) => {
      if (event.type !== 'stream') return
      if ((stage === 'retry' && event.payload.kind === 'retry_status' && event.payload.status.phase === 'scheduled')
        || (stage === 'compact' && event.payload.kind === 'compaction_status' && event.payload.status.phase === 'started')
        || (event.payload.kind === 'sdk_delta' && event.payload.delta.deltas.some((delta) =>
          stage === 'stream' ? delta.type === 'text_delta' : stage === 'parameters' && delta.type === 'toolcall_delta'))) ready.resolve()
    })
    let sending: Promise<unknown> | undefined
    let guard: ReturnType<typeof setTimeout> | undefined
    try {
      if (stage === 'compact') {
        expect(await coordinator.send(owner, { sessionId: session.id, text: '旧原文\n' + 'old '.repeat(21000) }, () => {})).toMatchObject({ success: true })
      }
      sending = coordinator.send(owner, { sessionId: session.id, text: stage === 'compact' ? '测试暂停\n' + 'new '.repeat(21000) : '测试暂停' }, () => {})
      await Promise.race([Promise.all([ready.promise, ...(stage === 'retry' ? [] : [connected.promise])]),
        sending.then(() => { throw new Error('模型未进入目标暂停阶段') }),
        new Promise<never>((_done, reject) => { guard = setTimeout(() => reject(new Error('目标暂停阶段未就绪')), 8000) }),
      ])
      clearTimeout(guard)
      const run = coordinator.getOwnedRun(owner, session.id)!
      const paused = await coordinator.pauseRun(owner, { sessionId: session.id, runId: run.runId })
      await sending
      expect(paused.state).toBe('paused')
      expect(coordinator.getPause(owner, session.id)).toEqual(paused)
      if (stage !== 'retry') await closed.promise
      expect(executions).toBe(0)
      expect(requests).toBe(stage === 'compact' ? 3 : 1)
      const history = sessions.getMessages(session.id)
      const results = history.filter((message) => message.type === 'result')
      expect(results).toHaveLength(stage === 'compact' ? 2 : 1)
      expect(results.at(-1)).toMatchObject({ terminal_reason: 'stopped', stopped_by_user: true })
      if (stage === 'stream') expect(history.some((message) => message.type === 'assistant' && message.isPartial === true)).toBe(true)
      if (stage === 'parameters') expect(JSON.stringify(history)).not.toContain('half-tool')
      if (stage === 'compact') expect(JSON.stringify(history)).toContain('压缩前原文')
      // 同一真实 core 链继续，不再向应用或 Runtime 追加固定用户输入。
      continuing = true
      expect(await coordinator.continueRun(owner, { sessionId: session.id, pauseId: paused.pauseId })).toMatchObject({ success: true })
      expect(coordinator.getPause(owner, session.id)).toBeNull()
      const after = sessions.getMessages(session.id)
      expect(after.filter((message) => message.type === 'user')).toHaveLength(stage === 'compact' ? 2 : 1)
      expect(after.findLast((message) => message.type === 'system' && message.subtype === 'axon_continued'))
        .toMatchObject({ turn_id: paused.turnId, resumed_pause_id: paused.pauseId, run_id: expect.not.stringMatching(`^${run.runId}$`) })
      expect(after.at(-1)).toMatchObject({ type: 'result', terminal_reason: 'completed' })
      expect(JSON.stringify(requestBodies.at(-1))).not.toContain('继续刚才被暂停的任务')
      expect(executions).toBe(0)
    } finally {
      clearTimeout(guard)
      release(); coordinator.dispose(); agent.dispose(); adapter.dispose(); clients.dispose()
      try { await Promise.allSettled([sending, coordinator.drain(), agent.drain(), adapter.drain()]) }
      finally { server.stop(true); rmSync(directory, { recursive: true, force: true }) }
    }
  }, 20000)
}

// Zima 源码位于独立仓库：显式提供现有解释器才运行真实接入，不自动安装或猜测路径。
for (const runtime of ['pi', 'zima'] as const) {
  const enabled = runtime === 'pi' || Boolean(process.env.AXON_TEST_ZIMA_PYTHON)
  ;(enabled ? test : test.skip)(`真实 ${runtime} Runtime：Bash workdir schema、审批、cwd 和下一次默认目录`, async () => {
    const directory = mkdtempSync(join(tmpdir(), 'axon-runtime-workdir-'))
    const outside = join(directory, 'outside')
    mkdirSync(outside)
    const workspace = join(directory, 'workspace')
    mkdirSync(workspace)
    mkdirSync(join(workspace, 'child'))
    const requests: CompletionRequest[] = []
    const toolName = runtime === 'pi' ? 'bash' : 'Bash'
    const server = Bun.serve({ hostname: '127.0.0.1', port: 0, async fetch(request) {
      const body = await request.json() as CompletionRequest
      requests.push(body)
      const step = requests.length
      const delta = step < 4 ? { role: 'assistant', tool_calls: [{ index: 0, id: `bash-${step}`, type: 'function',
        function: { name: toolName, arguments: JSON.stringify({ command: 'pwd', ...(step === 1 ? { workdir: 'child' } : step === 2 ? { workdir: '../outside' } : {}) }) } }] }
        : { role: 'assistant', content: '完成' }
      const frames = [
        { choices: [{ index: 0, delta, finish_reason: null }] },
        { choices: [{ index: 0, delta: {}, finish_reason: step < 4 ? 'tool_calls' : 'stop' }] },
      ]
      return new Response(`${frames.map((frame) => `data: ${JSON.stringify({ id: `fixture-${step}`, model: 'axon-fixture', ...frame })}\n\n`).join('')}data: [DONE]\n\n`, { headers: { 'content-type': 'text/event-stream' } })
    } })
    const approved: unknown[] = []
    const adapter: AgentProviderAdapter = runtime === 'pi'
      ? new PiAgentAdapter(undefined, closedHost(async (request, handlers) => {
        expect(request.policy.sandboxCwd).toBe(realpathSync(workspace))
        expect(request.policy.writableRoots).toEqual([realpathSync(workspace)])
        const result = spawnSync('/bin/sh', ['-c', request.command], { cwd: request.cwd, encoding: 'utf8' })
        if (result.error) throw result.error
        handlers?.onStdout?.(result.stdout)
        handlers?.onStderr?.(result.stderr)
        return { exitCode: result.status, stdout: result.stdout, stderr: result.stderr,
          timedOut: false, aborted: false, stdoutTruncated: false, stderrTruncated: false }
      })) : new ZimaAgentAdapter(process.env.AXON_TEST_ZIMA_PYTHON!, 'test')
    const events: AgentStreamPayload[] = []
    try {
      for await (const event of adapter.query({
        sessionId: 'workdir-session', prompt: '测试工作目录', model: 'axon-fixture', cwd: workspace,
        connection: { provider: 'custom', baseUrl: `http://127.0.0.1:${server.port}/v1`, apiKey: 'local-test-key' },
        runtimeConfigDir: join(directory, 'config'), runtimeSessionDir: join(directory, 'sessions'),
        systemPrompt: '单次目录测试',
        allowedBuiltinTools: ['Bash'], executionPolicy: { sandboxMode: 'workspaceWrite', approvalPolicy: 'onRequest', approvalReviewer: 'user' },
        sandboxPolicy: buildAgentSandboxPolicy({ projectRoot: workspace, mode: 'workspaceWrite' }),
        abortSignal: AbortSignal.timeout(8_000),
        canUseTool: async (_name, args) => { approved.push(args.workdir); return { behavior: 'allow' } },
      })) events.push(event)
      expect(requests).toHaveLength(4)
      expect(requests[0]?.tools?.[0]?.function.parameters).toMatchObject({ properties: { workdir: { type: 'string' } } })
      expect(approved).toEqual([realpathSync(join(workspace, 'child')), realpathSync(outside), realpathSync(workspace)])
      const firstResult = requests[1]?.messages.find((message) => message.role === 'tool')
      expect(runtime === 'zima' ? JSON.parse(String(firstResult?.content)).text.trim() : String(firstResult?.content).trim())
        .toBe(realpathSync(join(workspace, 'child')))
      const secondResult = requests[2]?.messages.filter((message) => message.role === 'tool').at(-1)
      expect(runtime === 'zima' ? JSON.parse(String(secondResult?.content)).text.trim() : String(secondResult?.content).trim())
        .toBe(realpathSync(outside))
      const thirdResult = requests[3]?.messages.filter((message) => message.role === 'tool').at(-1)
      expect(runtime === 'zima' ? JSON.parse(String(thirdResult?.content)).text.trim() : String(thirdResult?.content).trim())
        .toBe(realpathSync(workspace))
      expect(events.filter((event) => event.kind === 'sdk_message' && event.message.type === 'result'))
        .toEqual([expect.objectContaining({ message: expect.objectContaining({ terminal_reason: 'completed' }) })])
    } finally {
      adapter.dispose()
      try { await adapter.drain() } finally { server.stop(true); rmSync(directory, { recursive: true, force: true }) }
    }
  }, 20_000)
}

/** 使用真实 Pi SDK，仅替换模型 HTTP 返回；验证工具循环及 artifact 在包入口搬移后仍工作。 */
test('真实 Pi SDK：流式工具循环、精确 artifact 恢复及唯一中立终态', async () => {
  const directory = mkdtempSync(join(tmpdir(), 'axon-pi-package-'))
  const requests: CompletionRequest[] = []
  const server = Bun.serve({ hostname: '127.0.0.1', port: 0, async fetch(request) {
    if (new URL(request.url).pathname !== '/v1/chat/completions') return new Response('', { status: 404 })
    const body = await request.json() as CompletionRequest
    requests.push(body)
    const first = requests.length === 1
    const deltas = first
      ? [{ role: 'assistant', tool_calls: [{ index: 0, id: 'echo-1', type: 'function',
          function: { name: 'AxonEcho', arguments: '{"value":"回显"}' } }] }]
      : [{ role: 'assistant', content: '完成' }]
    const frames: Array<{ choices: Array<{ index: number; delta: Record<string, unknown>; finish_reason: string | null }> }> =
      deltas.map((delta) => ({ choices: [{ index: 0, delta, finish_reason: null }] }))
    frames.push({ choices: [{ index: 0, delta: {}, finish_reason: first ? 'tool_calls' : 'stop' }] })
    return new Response(`${frames.map((frame) => `data: ${JSON.stringify({
      id: 'completion-fixture', object: 'chat.completion.chunk', model: 'axon-fixture', ...frame,
    })}\n\n`).join('')}data: [DONE]\n\n`, { headers: { 'content-type': 'text/event-stream' } })
  } })
  let adapter = new PiAgentAdapter(undefined, closedHost())
  let sessionId = ''
  let sessionFile = ''
  let executions = 0
  const input: AgentQueryInput = {
    sessionId: 'package-session', prompt: '调用回显工具', model: 'axon-fixture', cwd: directory,
    connection: { provider: 'custom', baseUrl: `http://127.0.0.1:${server.port}/v1`, apiKey: '' },
    runtimeConfigDir: join(directory, 'config'), runtimeSessionDir: join(directory, 'sessions'),
    executionPolicy: { sandboxMode: 'workspaceWrite', approvalPolicy: 'onRequest', approvalReviewer: 'user' },
    sandboxPolicy: buildAgentSandboxPolicy({ projectRoot: directory, mode: 'workspaceWrite' }),
    allowedBuiltinTools: [], systemPrompt: '包入口测试', abortSignal: AbortSignal.timeout(8_000),
    customTools: [{ name: 'AxonEcho', description: '隔离测试回显', permissionMode: 'managed',
      inputSchema: { type: 'object', properties: { value: { type: 'string' } }, required: ['value'] },
      execute: async (args) => { executions += 1; return { content: String(args.value) } },
    }],
    onRuntimeSession: (id, file) => { sessionId = id; sessionFile = file ?? '' },
  }
  const collect = async (query: AgentQueryInput): Promise<AgentStreamPayload[]> => {
    const events: AgentStreamPayload[] = []
    for await (const event of adapter.query(query)) events.push(event)
    return events
  }
  try {
    const events = await collect(input)
    expect(requests).toHaveLength(2)
    expect(requests[0]?.tools?.map((tool) => tool.function.name)).toEqual(['AxonEcho'])
    expect(requests[1]?.messages).toContainEqual(expect.objectContaining({ role: 'tool', tool_call_id: 'echo-1', content: '回显' }))
    expect(executions).toBe(1)
    expect(events.some((event) => event.kind === 'sdk_delta')).toBe(true)
    expect(events.filter((event) => event.kind === 'sdk_message' && event.message.type === 'result'))
      .toEqual([expect.objectContaining({ message: expect.objectContaining({ terminal_reason: 'completed' }) })])
    expect(existsSync(sessionFile)).toBe(true)
    expect(readFileSync(sessionFile, 'utf8')).toContain('回显')
    // 重建 adapter 后只传中立 artifact 引用，恢复不得再次执行上一轮工具。
    adapter.dispose()
    await adapter.drain()
    adapter = new PiAgentAdapter(undefined, closedHost())
    const resumed = await collect({ ...input, prompt: '继续回答', resumeSessionId: sessionId,
      runtimeSessionFile: sessionFile, abortSignal: AbortSignal.timeout(8_000) })
    expect(requests).toHaveLength(3)
    expect(requests[2]?.messages).toContainEqual(expect.objectContaining({ role: 'user',
      content: [{ type: 'text', text: '调用回显工具' }] }))
    expect(requests[2]?.messages).toContainEqual(expect.objectContaining({ role: 'user',
      content: [{ type: 'text', text: '继续回答' }] }))
    expect(executions).toBe(1)
    expect(resumed.filter((event) => event.kind === 'sdk_message' && event.message.type === 'result')).toHaveLength(1)
  } finally {
    adapter.dispose()
    try { await adapter.drain() } finally {
      server.stop(true)
      rmSync(directory, { recursive: true, force: true })
    }
  }
}, 20_000)

/** 模型只用本机 SSE；工具故意不响应取消，以真实 SDK 验证停止和实际完成不是一回事。 */
test('真实 Pi SDK：退出等待尚未完成的自定义工具，不再请求下一轮模型', async () => {
  const directory = mkdtempSync(join(tmpdir(), 'axon-pi-drain-'))
  let finishTool!: () => void
  let toolEntered!: () => void
  const toolWork = new Promise<void>((done) => { finishTool = done })
  const entered = new Promise<void>((done) => { toolEntered = done })
  let toolFinished = false
  let requests = 0
  const server = Bun.serve({ hostname: '127.0.0.1', port: 0, async fetch(request) {
    if (new URL(request.url).pathname !== '/v1/chat/completions') return new Response('', { status: 404 })
    await request.json()
    requests += 1
    const frames = [
      { choices: [{ index: 0, delta: { role: 'assistant', tool_calls: [{ index: 0,
        id: 'wait-1', type: 'function', function: { name: 'AxonWait', arguments: '{}' } }] }, finish_reason: null }] },
      { choices: [{ index: 0, delta: {}, finish_reason: 'tool_calls' }] },
    ]
    return new Response(`${frames.map((frame) => `data: ${JSON.stringify({
      id: 'drain-fixture', object: 'chat.completion.chunk', model: 'axon-fixture', ...frame,
    })}\n\n`).join('')}data: [DONE]\n\n`, { headers: { 'content-type': 'text/event-stream' } })
  } })
  const adapter = new PiAgentAdapter(undefined, closedHost())
  const events: AgentStreamPayload[] = []
  const collecting = (async () => {
    for await (const event of adapter.query({
      sessionId: 'drain-session', prompt: '执行等待工具', model: 'axon-fixture', cwd: directory,
      connection: { provider: 'custom', baseUrl: `http://127.0.0.1:${server.port}/v1`, apiKey: '' },
      runtimeConfigDir: join(directory, 'config'), runtimeSessionDir: join(directory, 'sessions'),
      executionPolicy: { sandboxMode: 'workspaceWrite', approvalPolicy: 'onRequest', approvalReviewer: 'user' },
      sandboxPolicy: buildAgentSandboxPolicy({ projectRoot: directory, mode: 'workspaceWrite' }),
      allowedBuiltinTools: [], systemPrompt: '', abortSignal: AbortSignal.timeout(8_000),
      customTools: [{ name: 'AxonWait', description: '隔离测试等待', permissionMode: 'managed',
        inputSchema: { type: 'object', properties: {} }, execute: async () => {
          toolEntered()
          await toolWork
          toolFinished = true
          return { content: '工具已完成' }
        } }],
    })) events.push(event)
  })()
  void collecting.catch(() => {})
  try {
    // 初始化/网络失败也要及时结束测试，不能一直等待不存在的工具调用。
    await Promise.race([entered, collecting.then(() => { throw new Error('工具没有进入') })])
    adapter.dispose()
    const draining = adapter.drain()
    let settled = false
    void draining.then(() => { settled = true }, () => { settled = true })
    await new Promise<void>((done) => setTimeout(done, 0))
    expect(settled).toBe(false)
    expect(toolFinished).toBe(false)
    finishTool()
    await Promise.all([collecting, draining])
    expect(toolFinished).toBe(true)
    expect(requests).toBe(1)
    expect(events.some((event) => event.kind === 'sdk_message'
      && event.message.type === 'result' && event.message.terminal_reason === 'completed')).toBe(false)
    await adapter.drain()
  } finally {
    finishTool()
    adapter.dispose()
    try { await Promise.allSettled([collecting, adapter.drain()]) } finally {
      server.stop(true)
      rmSync(directory, { recursive: true, force: true })
    }
  }
}, 20_000)
