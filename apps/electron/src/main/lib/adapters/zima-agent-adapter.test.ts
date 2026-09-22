import { afterEach, beforeEach, describe, expect, test } from 'bun:test'
import { chmodSync, existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type { AgentQueryInput, AgentStreamPayload, SDKAssistantMessage } from '@axon/shared'
import { ZimaAgentAdapter, ZimaRuntimeTransport } from './zima-agent-adapter'

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

afterEach(() => {
  adapter.dispose()
  rmSync(directory, { recursive: true, force: true })
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
      canUseTool: async (name) => { approved.push(name); return { behavior: 'allow' } },
    }))
    expect(approved).toEqual(['Write'])
    expect(messages(approval, 'user')).toHaveLength(1)
    expect(messages(approval, 'result')).toHaveLength(1)

    const calls: unknown[] = []
    const host = await collect(input('host', {
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
