import { afterEach, beforeEach, describe, expect, test } from 'bun:test'
import { chmodSync, existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type { AgentQueryInput, AgentStreamPayload, SDKAssistantMessage } from '@axon/shared'
import { ZimaAgentAdapter, ZimaRuntimeTransport } from './zima-agent-adapter'
import { AgentPermissionService } from '@axon/core'

let directory: string
let adapter: ZimaAgentAdapter

beforeEach(() => {
  directory = mkdtempSync(join(tmpdir(), 'axon-zima-contract-'))
  const fixture = join(import.meta.dir, 'fixtures', 'fake-zima-runtime.mjs')
  const executable = join(directory, 'fake-python')
  writeFileSync(executable, `#!/bin/sh\nexec "${process.execPath}" "${fixture}" "$@"\n`)
  chmodSync(executable, 0o755)
  adapter = new ZimaAgentAdapter(executable, '1.0-test')
})

afterEach(async () => {
  adapter.dispose()
  try { await adapter.drain() } finally { rmSync(directory, { recursive: true, force: true }) }
})

function input(prompt: string, overrides: Partial<AgentQueryInput> = {}): AgentQueryInput {
  return {
    sessionId: 'app-session', prompt, model: 'fake-model', cwd: directory,
    connection: { provider: 'custom', baseUrl: 'http://127.0.0.1:1/v1', apiKey: 'sk-contract-secret' },
    runtimeSessionDir: join(directory, 'runtime'), allowedBuiltinTools: [],
    ...overrides,
  }
}

async function collect(query: AgentQueryInput): Promise<AgentStreamPayload[]> {
  const events: AgentStreamPayload[] = []
  for await (const event of adapter.query(query)) events.push(event)
  return events
}

function messages(events: AgentStreamPayload[], type: string): AgentStreamPayload[] {
  return events.filter((event) => event.kind === 'sdk_message' && event.message.type === type)
}

describe('Zima adapter 离线协议契约', () => {
  test('未委托全部内置工具时明确报告不支持宿主 OS 沙箱', () => {
    expect(adapter.getSandboxCapability({ platform: 'macos' })).toEqual({
      supported: false,
      modes: [],
      sandboxedTools: [],
      limitation: 'runtimeToolDelegationUnavailable',
    })
  })

  test('思考等级由 Zima 协议能力提供，不依赖 Pi 模型目录', () => {
    expect(adapter.getReasoningCapability({ provider: 'custom', model: 'agnes-unknown-model' })).toEqual({
      levels: ['off', 'minimal', 'low', 'medium', 'high', 'xhigh', 'max'],
      defaultLevel: 'medium',
    })
  })

  test('握手、流式消息、唯一终态与受限恢复路径', async () => {
    let runtimeId = ''
    let stateFile = ''
    const events = await collect(input('success', {
      onRuntimeSession: (id, file) => { runtimeId = id; stateFile = file ?? '' },
    }))
    expect(events.some((event) => event.kind === 'sdk_delta')).toBe(true)
    expect(messages(events, 'system').map((event) => event.kind === 'sdk_message' ? event.message : null))
      .toContainEqual(expect.objectContaining({ subtype: 'init', model: 'fake-model', context_window_tokens: 128_000 }))
    expect(messages(events, 'assistant')).toHaveLength(1)
    expect(messages(events, 'result')).toHaveLength(1)
    expect(runtimeId).toBe('app-session')
    expect(existsSync(stateFile)).toBe(true)
    expect(stateFile.startsWith(join(directory, 'runtime', 'zima'))).toBe(true)
    const resumed = await collect(input('success', { resumeSessionId: runtimeId, runtimeSessionFile: stateFile }))
    expect(messages(resumed, 'result')).toHaveLength(1)
  })

  test('重试时先撤销失败草稿，再保留最终完整消息', async () => {
    const events = await collect(input('retry'))
    expect(events.some((event) => event.kind === 'discard_assistant' && event.uuid === 'draft-old')).toBe(true)
    expect(events.filter((event) => event.kind === 'retry_status').map((event) => event.kind === 'retry_status' ? event.status.phase : '')).toEqual(['scheduled', 'finished'])
    expect(messages(events, 'assistant')).toHaveLength(1)
    expect(messages(events, 'result')).toHaveLength(1)
  })

  test('压缩摘要正文随边界进入中立消息，缺少已提交摘要时不伪报成功', async () => {
    const events = await collect(input('compact'))
    expect(events.filter((event) => event.kind === 'compaction_status')).toEqual([
      { kind: 'compaction_status', status: { phase: 'started', reason: 'threshold' } },
      { kind: 'compaction_status', status: { phase: 'finished', reason: 'threshold', result: 'success' } },
    ])
    const boundary = messages(events, 'system').find((event) =>
      event.kind === 'sdk_message' && event.message.type === 'system' && event.message.subtype === 'compact_boundary')
    expect(boundary?.kind === 'sdk_message' ? boundary.message : null).toMatchObject({
      summary: '保留的会话摘要', runtime_summary_id: 'summary-contract-test',
      context_tokens_before: 100, context_tokens_after: 20,
    })
    await expect(collect(input('compact-missing', { sessionId: 'missing-summary' }))).rejects.toThrow('摘要未进入')
  })

  test('思考、正文和工具调用按流事件顺序展示并落入完整消息', async () => {
    const events = await collect(input('interleaved'))
    const deltaIndices = events.flatMap((event) => event.kind === 'sdk_delta'
      ? event.delta.deltas.flatMap((delta) => 'contentIndex' in delta ? [delta.contentIndex] : [])
      : [])
    expect(deltaIndices).toEqual([0, 1, 2, 2, 3, 4])
    const assistant = messages(events, 'assistant')[0]
    expect(assistant?.kind === 'sdk_message' && assistant.message.type === 'assistant'
      ? (assistant.message as SDKAssistantMessage).message.content
      : null).toEqual([
      { type: 'thinking', thinking: '先思考' },
      { type: 'text', text: '先回答' },
      { type: 'tool_use', id: expect.any(String), name: 'Read', input: { path: 'a.txt' } },
      { type: 'thinking', thinking: '再思考' },
      { type: 'text', text: '再回答' },
    ])
  })

  test('思考等级通过协议传给 Zima 模型配置', async () => {
    let stateFile = ''
    await collect(input('thinking-config', {
      thinkingLevel: 'high',
      onRuntimeSession: (_id, file) => { stateFile = file ?? '' },
    }))
    expect(JSON.parse(readFileSync(stateFile, 'utf8'))).toEqual({ thinking_level: 'high' })
  })

  test('内置工具授权和宿主工具都回传配对结果', async () => {
    const approved: string[] = []
    const approval = await collect(input('approval', {
      canUseTool: async (name, _args, permission) => {
        expect(permission.toolExecution).toEqual({ kind: 'runtime' })
        approved.push(name)
        return { behavior: 'allow' }
      },
    }))
    expect(approved).toEqual(['Write'])
    expect(messages(approval, 'user')).toHaveLength(1)
    expect(messages(approval, 'result')).toHaveLength(1)

    const calls: unknown[] = []
    const host = await collect(input('host', {
      canUseTool: async (_name, _args, permission) => {
        expect(permission.toolExecution).toEqual({ kind: 'host', permissionMode: 'ask' })
        return { behavior: 'allow' }
      },
      customTools: [{
        name: 'remote_echo', description: '回显',
        inputSchema: { type: 'object', properties: { value: { type: 'string' } } },
        execute: async (args) => { calls.push(args); return { content: { echo: args.value } } },
      }],
    }))
    expect(calls).toEqual([{ path: 'demo.txt', value: 'hello' }])
    expect(messages(host, 'user')).toHaveLength(1)
    expect(messages(host, 'result')).toHaveLength(1)
  })

  test('Zima 原生 Write 真正等待人工审批，不自动回复 allow', async () => {
    const permissions = new AgentPermissionService({ createId: () => 'zima-approval' })
    permissions.bindOwner('app-session', 'client-1')
    const run = new AbortController()
    let received: (() => void) | undefined
    const requested = new Promise<void>((resolve) => { received = resolve })
    permissions.subscribe((event) => {
      if (event.type === 'permission_request') {
        expect(event.request.toolName).toBe('Write')
        expect(event.request.sandboxEscalation).toBeUndefined()
        received?.()
      }
    })
    let completed = false
    const execution = collect(input('approval', {
      abortSignal: run.signal,
      canUseTool: permissions.createCanUseTool('app-session', 1, run.signal),
    })).then((events) => { completed = true; return events })
    try {
      await requested
      expect(completed).toBe(false)
      expect(permissions.respond('client-1', { requestId: 'zima-approval', behavior: 'deny' })).toBe(true)
      const events = await execution
      const result = messages(events, 'user')[0]
      expect(result?.kind === 'sdk_message' ? result.message : null).toMatchObject({
        message: { content: [{ type: 'tool_result', is_error: true }] },
      })
    } finally { run.abort() }
  })

  test('宿主工具缺少授权或被拒绝时不执行，已声明自行守卫的工具可正常执行', async () => {
    let executions = 0
    const tool = {
      name: 'remote_echo', description: '回显', inputSchema: { type: 'object' },
      execute: async () => { executions += 1; return { content: 'ok' } },
    }
    await collect(input('host', { customTools: [tool] }))
    expect(executions).toBe(0)
    await collect(input('host', { customTools: [tool], canUseTool: async () => ({ behavior: 'deny', message: '拒绝' }) }))
    expect(executions).toBe(0)
    await collect(input('host', { customTools: [{ ...tool, permissionMode: 'managed' }] }))
    expect(executions).toBe(1)
    let argumentsSeen: Record<string, unknown> | undefined
    await collect(input('host', {
      customTools: [{ ...tool, execute: async (args) => { argumentsSeen = args; return { content: 'ok' } } }],
      canUseTool: async () => ({ behavior: 'allow', updatedInput: { value: 'updated' } }),
    }))
    expect(argumentsSeen).toEqual({ value: 'updated' })
  })

  test('停止、进程崩溃和协议损坏都不产生重复终态', async () => {
    const aborted = await collect(input('abort', {
      onRuntimeSession: () => setTimeout(() => adapter.abort('app-session'), 20),
    }))
    expect(messages(aborted, 'result')).toHaveLength(1)
    const result = messages(aborted, 'result')[0]
    expect(result?.kind === 'sdk_message' ? result.message : null).toMatchObject({ terminal_reason: 'canceled', stopped_by_user: true })
    await expect(collect(input('crash'))).rejects.toThrow()
    await expect(collect(input('malformed'))).rejects.toThrow()
  })

  test('错误配置和越界恢复文件在启动子进程前拒绝', async () => {
    await expect(collect(input('success', {
      connection: { provider: 'custom', baseUrl: 'http://127.0.0.1:1/v1', apiKey: '' },
    }))).rejects.toThrow('API Key')
    await expect(collect(input('success', {
      resumeSessionId: 'other', runtimeSessionFile: join(directory, 'outside', 'state.json'),
    }))).rejects.toThrow()
  })
})

test('传输握手严格校验受控解释器路径', async () => {
  await expect(ZimaRuntimeTransport.connect({ pythonExecutable: 'python', clientVersion: 'test' })).rejects.toThrow()
})

interface ProcessTrace { method: string; pid: number }

/** 仅在隔离夹具设置行为与元信息轨迹，不把测试开关交给生产协议。 */
function traceRuntime(mode?: string): { executable: string; read: () => ProcessTrace[] } {
  const executable = join(directory, 'fake-python')
  const fixture = join(import.meta.dir, 'fixtures', 'fake-zima-runtime.mjs')
  const trace = join(directory, 'process-trace.jsonl')
  writeFileSync(executable, `#!/bin/sh\nexport AXON_ZIMA_TEST_TRACE="${trace}"\n`
    + (mode ? `export AXON_ZIMA_TEST_MODE="${mode}"\n` : '')
    + `exec "${process.execPath}" "${fixture}" "$@"\n`)
  return { executable, read: () => {
    if (!existsSync(trace)) return []
    // 进程正在追加时尾行可能尚未写完；只有换行结束的记录才进入就绪判断。
    return readFileSync(trace, 'utf8').split('\n').slice(0, -1).map((line) => JSON.parse(line) as ProcessTrace)
  } }
}

async function waitTrace(read: () => ProcessTrace[], method: string, queryStatus?: () => string): Promise<ProcessTrace> {
  const until = Date.now() + 3_000
  while (Date.now() < until) {
    const entry = read().find((item) => item.method === method)
    if (entry) return entry
    await new Promise<void>((done) => setTimeout(done, 5))
  }
  throw new Error(`测试进程没有进入 ${method}；已观察 ${read().map((item) => item.method).join(', ') || '无记录'}；查询 ${queryStatus?.() ?? '未监测'}`)
}

function expectProcessGone(pid: number): void {
  let code: string | undefined
  try { process.kill(pid, 0) } catch (error) { code = (error as NodeJS.ErrnoException).code }
  expect(code).toBe('ESRCH')
}

function gate(): { promise: Promise<void>; release: () => void } {
  let release!: () => void
  const promise = new Promise<void>((done) => { release = done })
  return { promise, release }
}

describe('Zima 真实资源等待', () => {
  for (const mode of ['handshake', 'accept'] as const) {
    test(`退出发生在 ${mode}：终止忽略 TERM 的进程，迟到初始化不发布 artifact`, async () => {
      const trace = traceRuntime(mode)
      let published = 0
      let status = '等待中'
      const querying = collect(input('success', { onRuntimeSession: () => { published += 1 } }))
        .then((events) => { status = '已完成'; return events }, (reason: unknown) => {
          // 离线夹具没有用户凭据；保留查询自身失败，避免把提前拒绝误诊成进程启动慢。
          status = reason instanceof Error ? reason.name + ': ' + reason.message : '未知失败'
          return reason
        })
      const pid = (await waitTrace(trace.read, mode === 'handshake' ? 'runtime.handshake' : 'session.run', () => status)).pid
      adapter.dispose()
      adapter.dispose()
      await Promise.all([querying, adapter.drain()])
      expect(published).toBe(0)
      expectProcessGone(pid)
      expect(trace.read().filter((item) => item.method === 'session.run')).toHaveLength(mode === 'handshake' ? 0 : 1)
      await adapter.drain()
    })
  }

  test('失败握手在 connect 拒绝前就已完成实际进程 close', async () => {
    const trace = traceRuntime('invalid-handshake')
    await expect(ZimaRuntimeTransport.connect({ pythonExecutable: trace.executable, clientVersion: 'test' }))
      .rejects.toThrow('握手版本')
    expectProcessGone(trace.read().find((item) => item.method === 'started')!.pid)
  })

  test('重复 close 共享等待，停止请求超时后才 TERM/KILL，禁止新业务请求', async () => {
    const trace = traceRuntime('shutdown')
    const transport = await ZimaRuntimeTransport.connect({ pythonExecutable: trace.executable, clientVersion: 'test' })
    try {
      const closing = transport.close()
      expect(transport.close()).toBe(closing)
      await expect(transport.request('session.run', {})).rejects.toThrow('已关闭')
      await closing
      expectProcessGone(trace.read().find((item) => item.method === 'started')!.pid)
      expect(trace.read().filter((item) => item.method === 'runtime.shutdown')).toHaveLength(1)
    } finally { transport.terminate(); await transport.drain() }
  }, 8_000)

  test('暂停在 init 的消费者不再拉取，退出仍等待进程组和持管道 helper 的实际关闭', async () => {
    const trace = traceRuntime('group')
    const iterator = adapter.query(input('abort'))
    expect((await iterator.next()).value).toMatchObject({ kind: 'sdk_message', message: { subtype: 'init' } })
    const parent = (await waitTrace(trace.read, 'started')).pid
    const helper = (await waitTrace(trace.read, 'helper')).pid
    adapter.dispose()
    await adapter.drain()
    expectProcessGone(parent)
    expectProcessGone(helper)
    expect((await iterator.next()).done).toBe(true)
  })

  test('忽略取消的授权返回后不能开始工具，也不回传迟到结果', async () => {
    const trace = traceRuntime()
    const decision = gate()
    const entered = gate()
    let executions = 0
    let signal: AbortSignal | undefined
    const querying = collect(input('host', {
      canUseTool: async (_name, _args, options) => {
        signal = options.signal; entered.release(); await decision.promise
        return { behavior: 'allow' }
      },
      customTools: [{ name: 'remote_echo', description: '测试', inputSchema: { type: 'object' },
        execute: async () => { executions += 1; return { content: '不应执行' } } }],
    })).catch((reason: unknown) => reason)
    try {
      await entered.promise
      adapter.dispose()
      const draining = adapter.drain()
      let done = false
      void draining.then(() => { done = true })
      await new Promise<void>((resolve) => setTimeout(resolve, 0))
      expect(signal?.aborted).toBe(true)
      expect(done).toBe(false)
      decision.release()
      await Promise.all([querying, draining])
      expect(executions).toBe(0)
      expect(trace.read().some((item) => item.method === 'host_tool.resolve')).toBe(false)
    } finally { decision.release(); await querying }
  })

  test('已经开始的宿主工具不配合取消，等待其真实结束，不回传迟到结果', async () => {
    const trace = traceRuntime()
    const tool = gate()
    const entered = gate()
    let completed = false
    let signal: AbortSignal | undefined
    const querying = collect(input('host', {
      customTools: [{ name: 'remote_echo', description: '测试', permissionMode: 'managed', inputSchema: { type: 'object' },
        execute: async (_args, options) => {
          signal = options.signal; entered.release(); await tool.promise
          completed = true; return { content: '迟到结果' }
        } }],
    })).catch((reason: unknown) => reason)
    try {
      await entered.promise
      adapter.dispose()
      const draining = adapter.drain()
      let done = false
      void draining.then(() => { done = true })
      await new Promise<void>((resolve) => setTimeout(resolve, 0))
      expect(signal?.aborted).toBe(true)
      expect(done).toBe(false)
      expect(completed).toBe(false)
      tool.release()
      await Promise.all([querying, draining])
      expect(completed).toBe(true)
      expect(trace.read().some((item) => item.method === 'host_tool.resolve')).toBe(false)
    } finally { tool.release(); await querying }
  })

  test('手动停止也取消宿主回调，等待真实工作后只产生一个 canceled 终态', async () => {
    const trace = traceRuntime()
    const tool = gate()
    const entered = gate()
    const querying = collect(input('host', {
      customTools: [{ name: 'remote_echo', description: '测试', permissionMode: 'managed', inputSchema: { type: 'object' },
        execute: async () => { entered.release(); await tool.promise; return { content: '迟到结果' } } }],
    }))
    void querying.catch(() => {})
    try {
      await entered.promise
      adapter.abort('app-session')
      adapter.abort('app-session')
      let finished = false
      void querying.then(() => { finished = true }, () => { finished = true })
      await waitTrace(trace.read, 'runtime.shutdown')
      expect(finished).toBe(false)
      tool.release()
      const events = await querying
      expect(messages(events, 'result')).toEqual([expect.objectContaining({ message: expect.objectContaining({ terminal_reason: 'canceled' }) })])
      expect(trace.read().filter((item) => item.method === 'session.abort')).toHaveLength(1)
      expect(trace.read().some((item) => item.method === 'host_tool.resolve')).toBe(false)
    } finally { tool.release(); await querying.catch(() => {}) }
  })

  test('追问回调的迟到答案也被等待并丢弃，不回传给已退出的 runtime', async () => {
    const trace = traceRuntime()
    const answer = gate()
    const entered = gate()
    let signal: AbortSignal | undefined
    const querying = collect(input('interaction', {
      customTools: [{ name: 'AskUserQuestion', description: '测试追问', permissionMode: 'managed', inputSchema: { type: 'object' },
        execute: async (_args, options) => {
          signal = options.signal; entered.release(); await answer.promise
          return { content: { answers: { test: '迟到答案' } } }
        } }],
    })).catch((reason: unknown) => reason)
    try {
      await entered.promise
      adapter.dispose()
      const draining = adapter.drain()
      let finished = false
      void draining.then(() => { finished = true })
      await new Promise<void>((done) => setTimeout(done, 0))
      expect(signal?.aborted).toBe(true)
      expect(finished).toBe(false)
      answer.release()
      await Promise.all([querying, draining])
      expect(trace.read().some((item) => item.method === 'interaction.resolve')).toBe(false)
    } finally { answer.release(); await querying }
  })

  test('启动失败没有 PID 也不挂住；未消费查询不启动，退出后能力和查询拒绝', async () => {
    await expect(ZimaRuntimeTransport.connect({ pythonExecutable: join(directory, 'missing-python'), clientVersion: 'test' }))
      .rejects.toThrow('进程启动失败')
    const trace = traceRuntime()
    const iterator = adapter.query(input('success'))
    adapter.dispose()
    await adapter.drain()
    expect(trace.read()).toHaveLength(0)
    await expect(iterator.next()).rejects.toMatchObject({ name: 'AbortError' })
    expect(() => adapter.getReasoningCapability({ provider: 'custom', model: 'test' })).toThrow('已释放')
  })
})
