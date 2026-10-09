import { expect, test } from 'bun:test'
import { existsSync, mkdtempSync, readFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { buildAgentSandboxPolicy } from '@axon/core'
import type { AgentHostToolExecutionPort, AgentQueryInput, AgentStreamPayload } from '@axon/shared'
import { PiAgentAdapter } from './index'

/** 禁用全部内置工具，端口一旦被调用便拒绝；此夹具不模拟实际 OS 沙箱。 */
function closedHost(): AgentHostToolExecutionPort {
  const reject = async (): Promise<never> => { throw new Error('集成夹具禁止宿主 IO') }
  return {
    getSandboxCapability: () => ({ supported: true, modes: ['workspaceWrite'],
      sandboxedTools: ['bash', 'read', 'write', 'edit', 'grep', 'glob', 'ls'] }),
    initializeShellEnvironment: () => ({ executeShellCommand: reject, dispose: () => {}, drain: async () => {} }),
    executeShellCommand: reject, executeCommand: reject, readFile: reject, assertFileAccess: reject,
    writeFile: reject, createDirectory: reject, pathExists: reject, statPath: reject,
    readDirectory: reject, glob: reject, searchText: reject, detectImageMimeType: reject,
  }
}

interface CompletionRequest {
  messages: Array<{ role: string; content?: string | Array<{ type: string; text?: string }> | null; tool_call_id?: string }>
  tools?: Array<{ function: { name: string; parameters: Record<string, unknown> } }>
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
