import { describe, expect, test } from 'bun:test'
import type { AgentCustomToolDefinition, SDKAssistantMessage, SDKMessage } from '@axon/shared'
import {
  convertPiMessage,
  convertPiCompactionEnd,
  convertResultMessage,
  dropTrailingAbortedAssistant,
  getPiAssistantErrorDetails,
  getPiReasoningCapability,
  hasPiAssistantTextContent,
  isSessionNotFoundError,
  PiAgentAdapter,
  supportsPiDeferredTools,
  stripPiAssistantError,
} from './pi-agent-adapter'
import type { PiAgentQueryOptions } from './pi-agent-adapter'
import { resolveProjectInstructions } from '../project/project-instruction-resolver'
import { createAgentToolSearchTool } from '../agent/agent-tool-search'

describe('Agent 模型思考能力', () => {
  test('Pi adapter 通过自身模型目录回答能力', async () => {
    const adapter = new PiAgentAdapter()
    expect(await adapter.getReasoningCapability({ provider: 'custom', model: 'axon-unknown-model' })).toBeUndefined()
    adapter.dispose()
  })

  test('已验证模型按实际协议展示专属等级', async () => {
    expect(await getPiReasoningCapability('openai-responses', 'gpt-5.6-smoke')).toEqual({
      levels: ['off', 'low', 'medium', 'high', 'xhigh', 'max'], defaultLevel: 'high',
    })
    expect(await getPiReasoningCapability('anthropic-compatible', 'glm-5.3')).toEqual({
      levels: ['low', 'high', 'max'], defaultLevel: 'max',
    })
  })

  test('未知模型不伪装为已知支持思考', async () => {
    expect(await getPiReasoningCapability('custom', 'axon-unknown-model')).toBeUndefined()
  })

  test('未命中专属规则时从 Pi 模型目录读取能力', async () => {
    expect(await getPiReasoningCapability('anthropic', 'claude-sonnet-4-6')).toEqual({
      levels: ['off', 'minimal', 'low', 'medium', 'high', 'max'], defaultLevel: 'high',
    })
    expect(await getPiReasoningCapability('openai', 'gpt-4o')).toBeUndefined()
  })
})

describe('Pi 动态工具能力', () => {
  test('只启用官方 Anthropic 与明确支持的 OpenAI Responses 模型', async () => {
    expect(await supportsPiDeferredTools('anthropic', 'claude-sonnet-4-6')).toBe(true)
    expect(await supportsPiDeferredTools('anthropic', 'claude-haiku-4-5')).toBe(false)
    expect(await supportsPiDeferredTools('anthropic-compatible', 'claude-sonnet-4-6')).toBe(false)
    expect(await supportsPiDeferredTools('openai-responses', 'gpt-5.4')).toBe(true)
    expect(await supportsPiDeferredTools('openai-responses', 'gpt-4o')).toBe(false)
    expect(await supportsPiDeferredTools('openai', 'gpt-5.4')).toBe(false)
  })
})

type RuntimeMessage = Parameters<typeof convertPiMessage>[0]

function runtimeMessage(value: unknown): RuntimeMessage {
  return value as RuntimeMessage
}

function writeToolCall(content: string): RuntimeMessage {
  return {
    role: 'assistant',
    content: [{
      type: 'toolCall',
      id: 'tool-call-1',
      name: 'write',
      arguments: {
        path: 'C:\\Users\\WNI10\\.axon\\agent-workspaces\\demo\\workspace-files\\large.md',
        content,
      },
    }],
  } as unknown as RuntimeMessage
}

describe('convertPiMessage', () => {
  test('最终 toolCall 帧保留完整写入参数，并归一为 Claude 风格字段', () => {
    const content = 'x'.repeat(10_240)
    const message = convertPiMessage(writeToolCall(content), 'session-1') as {
      message: { content: Array<{ input?: Record<string, unknown> }> }
    }

    expect(message.message.content[0]?.input).toEqual({
      path: 'C:\\Users\\WNI10\\.axon\\agent-workspaces\\demo\\workspace-files\\large.md',
      file_path: 'C:\\Users\\WNI10\\.axon\\agent-workspaces\\demo\\workspace-files\\large.md',
      content,
    })
    expect(JSON.stringify(message).length).toBeGreaterThan(content.length)
  })

  test('只把终态 Pi 错误提升为 error 字段', () => {
    const providerError = 'Connection error. Failed to fetch'
    const nonTerminal = convertPiMessage({
      role: 'assistant', content: [], stopReason: 'stop', errorMessage: providerError,
    } as unknown as RuntimeMessage, 'session-1') as { error?: unknown }
    const terminalError = convertPiMessage({
      role: 'assistant', content: [], stopReason: 'error', errorMessage: providerError,
    } as unknown as RuntimeMessage, 'session-1') as { error?: { message?: string; errorType?: string } }

    expect(nonTerminal.error).toBeUndefined()
    expect(terminalError.error).toMatchObject({ code: 'provider_endpoint_not_found', category: 'configuration', retryable: false })
  })

  test('上游 JSON 解析失败归类为 service_error', () => {
    const errorMessage = 'Unexpected non-whitespace character after JSON at position 199 (line 2 column 1)'
    const terminalError = convertPiMessage({
      role: 'assistant', content: [], stopReason: 'error', errorMessage,
    } as unknown as RuntimeMessage, 'session-1') as { error?: { message?: string; errorType?: string } }

    expect(terminalError.error).toMatchObject({ code: 'protocol_error', category: 'protocol', retryable: false })
  })

  test('非网络类终态错误保持 provider_error', () => {
    const terminalError = convertPiMessage({
      role: 'assistant', content: [], stopReason: 'error', errorMessage: '529 overloaded',
    } as unknown as RuntimeMessage, 'session-1') as { error?: { message?: string; errorType?: string } }

    expect(terminalError.error).toMatchObject({ code: 'provider_unavailable', category: 'provider', retryable: true })
  })

  test.each([
    'peer closed connection',
    'incomplete chunked read',
    'peer closed connection without sending complete message body (incomplete chunked read)',
  ])('传输类终态错误 "%s" 归类为 network_error', (errorMessage) => {
    const terminalError = convertPiMessage({
      role: 'assistant', content: [], stopReason: 'error', errorMessage,
    } as unknown as RuntimeMessage, 'session-1') as { error?: { message?: string; errorType?: string } }

    expect(terminalError.error).toMatchObject({ code: 'network_error', category: 'network', retryable: true })
  })

  test('终态传输错误与已生成正文分离保留', () => {
    const body = 'Generated assistant output must not appear inside the error card.'
    const transportError = 'peer closed connection without sending complete message body (incomplete chunked read)'
    const terminalError = convertPiMessage({
      role: 'assistant',
      content: [{ type: 'text', text: body }],
      stopReason: 'error',
      errorMessage: transportError,
    } as unknown as RuntimeMessage, 'session-1') as SDKAssistantMessage

    expect(getPiAssistantErrorDetails(terminalError)).toEqual({
      detailedMessage: '网络连接中断，请检查网络或渠道地址后重试',
      originalError: '网络连接中断，请检查网络或渠道地址后重试',
    })
    expect(hasPiAssistantTextContent(terminalError)).toBe(true)
    expect(stripPiAssistantError(terminalError).error).toBeUndefined()
    expect(terminalError.message.content).toEqual([{ type: 'text', text: body }])
    expect(terminalError.error).toEqual({
      code: 'network_error',
      category: 'network',
      message: '网络连接中断，请检查网络或渠道地址后重试',
      retryable: true,
    })
  })

  test('非终态 errorMessage 不影响 result 成功判定', () => {
    const providerError = 'stream ended before a terminal response event'
    const partialStop = convertResultMessage([{
      role: 'assistant', content: [], stopReason: 'stop', errorMessage: providerError,
    } as unknown as RuntimeMessage], 'session-1') as { subtype?: string; errors?: string[] }
    const terminalError = convertResultMessage([{
      role: 'assistant', content: [], stopReason: 'error', errorMessage: providerError,
    } as unknown as RuntimeMessage], 'session-1') as { subtype?: string; errors?: string[] }

    expect(partialStop.subtype).toBe('success')
    expect(partialStop.errors).toBeUndefined()
    expect(terminalError.subtype).toBe('error_during_execution')
    expect(terminalError.errors).toEqual(['网络连接中断，请检查网络或渠道地址后重试'])
  })

  test('user 与 toolResult 消息转换为 SDK 形状并携带会话 ID', () => {
    const user = convertPiMessage({
      role: 'user', content: '帮我修复构建', timestamp: 1_234,
    } as unknown as RuntimeMessage, 'session-1') as { type: string; createdAt?: number; session_id?: string; message?: { content?: Array<{ type: string; text?: string }> } }
    expect(user.type).toBe('user')
    expect(user.createdAt).toBe(1_234)
    expect(user.session_id).toBe('session-1')
    expect(user.message?.content?.[0]).toEqual({ type: 'text', text: '帮我修复构建' })

    const toolResult = convertPiMessage({
      role: 'toolResult', toolCallId: 'call-1', content: '输出', isError: false,
    } as unknown as RuntimeMessage, 'session-1') as {
      type: string
      message?: { content?: Array<{ type: string; tool_use_id?: string; is_error?: boolean }> }
    }
    expect(toolResult.message?.content?.[0]).toMatchObject({
      type: 'tool_result', tool_use_id: 'call-1', is_error: false,
    })
  })

  test('无法识别的角色返回 null，不猜测消息形状', () => {
    expect(convertPiMessage(runtimeMessage({ role: 'telemetry' }), 'session-1')).toBeNull()
    expect(convertPiMessage(runtimeMessage(null), 'session-1')).toBeNull()
  })
})

describe('Pi 压缩边界转换', () => {
  test('成功时保留原因、摘要和压缩后上下文估算', () => {
    expect(convertPiCompactionEnd({
      type: 'compaction_end', reason: 'threshold', aborted: false, willRetry: false,
      result: {
        summary: '历史摘要', firstKeptEntryId: 'entry-1',
        tokensBefore: 190_000, estimatedTokensAfter: 28_000,
      },
    }, 'runtime-session-1')).toEqual({
      type: 'system', subtype: 'compact_boundary', session_id: 'runtime-session-1',
      compact_result: 'success', compact_reason: 'threshold', summary: '历史摘要',
      context_tokens_before: 190_000, context_tokens_after: 28_000,
    })
  })

  test('失败与取消不会伪装成成功边界', () => {
    expect(convertPiCompactionEnd({
      type: 'compaction_end', reason: 'overflow', result: undefined,
      aborted: false, willRetry: false, errorMessage: '摘要失败',
    }, 'runtime-session-1')).toMatchObject({ compact_result: 'failed', compact_error: '摘要失败' })
    expect(convertPiCompactionEnd({
      type: 'compaction_end', reason: 'manual', result: undefined,
      aborted: true, willRetry: false,
    }, 'runtime-session-1')).toMatchObject({ compact_result: 'noop' })
  })
})

describe('abort 半截 assistant 处理（陷阱 #2）', () => {
  test('丢弃尾部 aborted assistant，保留其余消息', () => {
    const normal = runtimeMessage({ role: 'assistant', content: [], stopReason: 'stop' })
    const aborted = runtimeMessage({ role: 'assistant', content: [{ type: 'text', text: '半截' }], stopReason: 'aborted' })
    const user = runtimeMessage({ role: 'user', content: 'hi' })

    expect(dropTrailingAbortedAssistant([user, normal, aborted])).toEqual([user, normal])
    // 非 aborted 尾部不动；空数组安全。
    expect(dropTrailingAbortedAssistant([user, normal])).toEqual([user, normal])
    expect(dropTrailingAbortedAssistant([])).toEqual([])
  })
})

describe('Pi resume 会话不存在识别', () => {
  test.each([
    'No conversation found with session ID: abc',
    'No conversation found withsessionID: abc',
  ])('识别缺失空格的变体：%s', (message) => {
    expect(isSessionNotFoundError(message)).toBe(true)
    expect(isSessionNotFoundError('some other error')).toBe(false)
    expect(isSessionNotFoundError(undefined)).toBe(false)
  })
})

describe('convertPiMessage 集成：转换为可持久化的 SDKMessage', () => {
  test('转换结果满足 AgentSessionManager 的落盘要求', async () => {
    const { AgentSessionManager } = await import('../agent/agent-session-manager')
    const { mkdtempSync, rmSync } = await import('node:fs')
    const { tmpdir } = await import('node:os')
    const { join } = await import('node:path')
    const directory = mkdtempSync(join(tmpdir(), 'axon-pi-adapter-'))
    try {
      const sessions = new AgentSessionManager({
        indexPath: join(directory, 'index.json'),
        sessionsDir: join(directory, 'sessions'),
      })
      const session = sessions.create()
      const converted = convertPiMessage(writeToolCall('内容'), 'sdk-session-1') as SDKMessage
      const persisted = sessions.appendMessage(session.id, converted)
      expect(sessions.getMessages(session.id)).toHaveLength(1)
      expect((persisted as { session_id?: string }).session_id).toBe('sdk-session-1')
    } finally {
      rmSync(directory, { recursive: true, force: true })
    }
  })
})

interface RuntimeHarness {
  load: NonNullable<ConstructorParameters<typeof PiAgentAdapter>[0]>
  state: {
    prompt?: string
    disposed: boolean
    openedSessionFile?: string
    toolResult?: unknown
    aborted?: boolean
    providerConfig?: Record<string, unknown>
    resourceLoaderConfig?: Record<string, unknown>
    nextSystemPrompt?: string
    initialToolNames?: string[]
    nextToolNames?: string[]
    thinkingLevel?: string
  }
}

interface RuntimeHarnessOptions {
  executeTool?: string
  toolInput?: Record<string, unknown>
  waitForAbort?: boolean
  emitCompaction?: boolean
}

interface RuntimeHarnessTool {
  name: string
  execute: (...args: unknown[]) => Promise<unknown>
}

function createRuntimeHarness(options: RuntimeHarnessOptions = {}): RuntimeHarness {
  type Listener = (event: unknown) => void
  const listeners = new Set<Listener>()
  let tools: RuntimeHarnessTool[] = []
  let finishPrompt: (() => void) | undefined
  const state: RuntimeHarness['state'] = { disposed: false }
  const assistant = runtimeMessage({
    role: 'assistant',
    content: [{ type: 'text', text: '完成' }],
    stopReason: 'stop',
    model: 'test-model',
  })
  const agentState = { tools: [] as RuntimeHarnessTool[], messages: [] as unknown[] }
  const session = {
    agent: { toolExecution: 'parallel', state: agentState },
    sessionId: 'runtime-session-1',
    sessionFile: '/tmp/runtime-session-1.jsonl',
    model: { id: 'test-model' },
    subscribe(listener: Listener) {
      listeners.add(listener)
      return () => listeners.delete(listener)
    },
    async prompt(prompt: string) {
      state.prompt = prompt
      state.initialToolNames = agentState.tools.map((tool) => tool.name)
      const selectedTool = tools.find((tool) => tool.name === options.executeTool)
      if (selectedTool) {
        state.toolResult = await selectedTool.execute(
          'tool-1', options.toolInput ?? { path: 'before.txt' }, undefined, undefined, {},
        )
        const prepare = (session.agent as {
          prepareNextTurnWithContext?: (
            context: {
              context: { systemPrompt: string; tools: RuntimeHarnessTool[] }
              toolResults: Array<{ addedToolNames?: string[] }>
            }, signal?: AbortSignal,
          ) => Promise<{ context: { systemPrompt: string; tools: RuntimeHarnessTool[] } } | undefined>
        }).prepareNextTurnWithContext
        const prepared = await prepare?.({
          context: { systemPrompt: '当前系统提示词', tools: agentState.tools },
          toolResults: [state.toolResult as { addedToolNames?: string[] }],
        })
        state.nextSystemPrompt = prepared?.context.systemPrompt
        state.nextToolNames = prepared?.context.tools.map((tool) => tool.name)
      }
      if (options.waitForAbort) {
        await new Promise<void>((resolve) => { finishPrompt = resolve })
        return
      }
      if (options.emitCompaction) {
        for (const listener of listeners) listener({ type: 'compaction_start', reason: 'threshold' })
        for (const listener of listeners) listener({
          type: 'compaction_end', reason: 'threshold', aborted: false, willRetry: false,
          result: {
            summary: '历史摘要', firstKeptEntryId: 'entry-1',
            tokensBefore: 100, estimatedTokensAfter: 20,
          },
        })
      }
      const partial = runtimeMessage({ role: 'assistant', content: [{ type: 'text', text: '完' }] })
      for (const listener of listeners) listener({
        type: 'message_update',
        message: partial,
        assistantMessageEvent: { type: 'text_delta', contentIndex: 0, delta: '完', partial },
      })
      for (const listener of listeners) listener({ type: 'message_end', message: assistant })
      for (const listener of listeners) listener({ type: 'agent_end', messages: [assistant], willRetry: false })
      for (const listener of listeners) listener({ type: 'agent_settled', messages: [assistant] })
    },
    async abort() {
      state.aborted = true
      const aborted = runtimeMessage({ role: 'assistant', content: [{ type: 'text', text: '半截' }], stopReason: 'aborted' })
      for (const listener of listeners) listener({ type: 'message_end', message: aborted })
      for (const listener of listeners) listener({ type: 'agent_end', messages: [aborted], willRetry: false })
      for (const listener of listeners) listener({ type: 'agent_settled', messages: [aborted] })
      finishPrompt?.()
    },
    dispose() { state.disposed = true },
  }
  const runtime = {
    ModelRuntime: {
      async create() {
        return {
          registerProvider(_id: string, config: unknown) { state.providerConfig = config as Record<string, unknown> },
          getModel(_provider: string, model: string) { return { id: model } },
        }
      },
    },
    SessionManager: {
      create() { return {} },
      open(path: string) { state.openedSessionFile = path; return {} },
    },
    SettingsManager: { inMemory() { return {} } },
    DefaultResourceLoader: class {
      constructor(config: Record<string, unknown>) { state.resourceLoaderConfig = config }
      async reload() {}
    },
    createCodingTools() { return [] },
    async createAgentSession(input: { customTools?: RuntimeHarnessTool[]; thinkingLevel?: string }) {
      tools = input.customTools ?? []
      agentState.tools = [...tools]
      state.thinkingLevel = input.thinkingLevel
      return { session }
    },
  }
  return {
    state,
    load: async () => runtime as unknown as Awaited<ReturnType<RuntimeHarness['load']>>,
  }
}

describe('PiAgentAdapter 查询主链', () => {
  test('压缩开始和结束进入瞬时 UI 状态流，完成边界仍作为系统消息落盘', async () => {
    const { mkdtempSync, rmSync } = await import('node:fs')
    const { tmpdir } = await import('node:os')
    const { join } = await import('node:path')
    const directory = mkdtempSync(join(tmpdir(), 'axon-pi-compaction-status-'))
    const adapter = new PiAgentAdapter(createRuntimeHarness({ emitCompaction: true }).load)
    try {
      const payloads = []
      const query: PiAgentQueryOptions = {
        sessionId: 'compaction-session', prompt: '继续', model: 'test-model',
        apiKey: 'secret', baseUrl: 'https://example.test/v1', provider: 'openai',
        systemPrompt: '测试', permissionMode: 'default',
        runtimeAgentDir: join(directory, 'agent'), runtimeSessionDir: join(directory, 'sessions'),
      }
      for await (const payload of adapter.query(query)) payloads.push(payload)

      expect(payloads.filter((payload) => payload.kind === 'compaction_status')).toEqual([
        { kind: 'compaction_status', status: { phase: 'started', reason: 'threshold' } },
        { kind: 'compaction_status', status: { phase: 'finished', reason: 'threshold', result: 'success' } },
      ])
      expect(payloads).toContainEqual({
        kind: 'sdk_message',
        message: expect.objectContaining({ type: 'system', subtype: 'compact_boundary', compact_result: 'success' }),
      })
    } finally {
      adapter.dispose()
      rmSync(directory, { recursive: true, force: true })
    }
  })

  test('首个请求排除 deferred 工具，tool_search 后的下一次请求加载完整定义', async () => {
    const { mkdtempSync, rmSync } = await import('node:fs')
    const { tmpdir } = await import('node:os')
    const { join } = await import('node:path')
    const directory = mkdtempSync(join(tmpdir(), 'axon-pi-tool-search-'))
    const deferredTool = {
      name: 'mcp__github__issues',
      description: '查询仓库问题',
      inputSchema: {
        type: 'object', required: ['repository'],
        properties: { repository: { type: 'string', description: '仓库名称' } },
      },
      isDeferred: true,
      execute: async () => ({ content: 'ok' }),
    } satisfies AgentCustomToolDefinition
    const harness = createRuntimeHarness({
      executeTool: 'tool_search',
      toolInput: { query: 'github repository' },
    })
    const adapter = new PiAgentAdapter(harness.load)
    try {
      const query: PiAgentQueryOptions = {
        sessionId: 'tool-search-session', prompt: '查询问题', model: 'gpt-5.4',
        apiKey: 'secret', baseUrl: 'https://api.openai.com/v1', provider: 'openai-responses',
        systemPrompt: '测试延迟工具', permissionMode: 'default',
        runtimeAgentDir: join(directory, 'agent'), runtimeSessionDir: join(directory, 'sessions'),
        customTools: [deferredTool, createAgentToolSearchTool([deferredTool])],
      }
      for await (const _payload of adapter.query(query)) {}
      expect(harness.state.initialToolNames).toEqual(['tool_search'])
      expect(harness.state.toolResult).toMatchObject({
        addedToolNames: ['mcp__github__issues'],
        content: [{ type: 'text', text: expect.stringContaining('input_schema') }],
      })
      expect(harness.state.nextToolNames).toEqual(['mcp__github__issues', 'tool_search'])
      const model = (harness.state.providerConfig?.models as Array<Record<string, unknown>>)[0]
      expect(model?.compat).toMatchObject({ supportsAdditionalTools: true, supportsToolSearch: true })
    } finally {
      adapter.dispose()
      rmSync(directory, { recursive: true, force: true })
    }
  })

  test('Anthropic 官方模型注册 tool_reference 能力并沿用同一动态加载链', async () => {
    const { mkdtempSync, rmSync } = await import('node:fs')
    const { tmpdir } = await import('node:os')
    const { join } = await import('node:path')
    const directory = mkdtempSync(join(tmpdir(), 'axon-pi-anthropic-tool-search-'))
    const deferredTool = {
      name: 'mcp__github__issues', description: '查询仓库问题',
      inputSchema: { type: 'object', properties: { repository: { type: 'string' } } },
      isDeferred: true, execute: async () => ({ content: 'ok' }),
    } satisfies AgentCustomToolDefinition
    const harness = createRuntimeHarness({ executeTool: 'tool_search', toolInput: { query: 'github' } })
    const adapter = new PiAgentAdapter(harness.load)
    try {
      const query: PiAgentQueryOptions = {
        sessionId: 'anthropic-tool-search', prompt: '查询问题', model: 'claude-sonnet-4-6',
        apiKey: 'secret', baseUrl: 'https://api.anthropic.com', provider: 'anthropic',
        systemPrompt: '测试延迟工具', permissionMode: 'default',
        runtimeAgentDir: join(directory, 'agent'), runtimeSessionDir: join(directory, 'sessions'),
        customTools: [deferredTool, createAgentToolSearchTool([deferredTool])],
      }
      for await (const _payload of adapter.query(query)) {}
      expect(harness.state.initialToolNames).toEqual(['tool_search'])
      expect(harness.state.nextToolNames).toEqual(['mcp__github__issues', 'tool_search'])
      const model = (harness.state.providerConfig?.models as Array<Record<string, unknown>>)[0]
      expect(model?.compat).toMatchObject({ supportsToolReferences: true })
    } finally {
      adapter.dispose()
      rmSync(directory, { recursive: true, force: true })
    }
  })

  test('DeepSeek 兼容请求用 output_config.effort 表达强度', async () => {
    const { mkdtempSync, rmSync } = await import('node:fs')
    const { tmpdir } = await import('node:os')
    const { join } = await import('node:path')
    const directory = mkdtempSync(join(tmpdir(), 'axon-pi-deepseek-'))
    const harness = createRuntimeHarness()
    try {
      const adapter = new PiAgentAdapter(harness.load)
      const query: PiAgentQueryOptions = {
        sessionId: 'deepseek-session', prompt: '你好', model: 'deepseek-v4-pro',
        apiKey: 'test', baseUrl: 'https://example.test', provider: 'anthropic-compatible',
        systemPrompt: '测试', permissionMode: 'default', thinkingLevel: 'xhigh',
        runtimeAgentDir: join(directory, 'agent'), runtimeSessionDir: join(directory, 'sessions'),
      }
      for await (const _payload of adapter.query(query)) { /* 创建资源加载器后再检查扩展。 */ }
      let beforeRequest: ((event: { payload: unknown }) => unknown) | undefined
      const factories = harness.state.resourceLoaderConfig?.extensionFactories as Array<(pi: {
        on: (name: string, handler: (event: { payload: unknown }) => unknown) => void
      }) => void>
      factories[0]?.({ on: (_name, handler) => { beforeRequest = handler } })
      expect(beforeRequest?.({ payload: { model: 'deepseek-v4-pro', thinking: { budget_tokens: 4096 } } })).toEqual({
        model: 'deepseek-v4-pro', thinking: { type: 'enabled' }, output_config: { effort: 'max' },
      })
    } finally {
      rmSync(directory, { recursive: true, force: true })
    }
  })

  test('专属模型能力同时用于注册和本轮等级收窄', async () => {
    const { mkdtempSync, rmSync } = await import('node:fs')
    const { tmpdir } = await import('node:os')
    const { join } = await import('node:path')
    const directory = mkdtempSync(join(tmpdir(), 'axon-pi-thinking-'))
    const harness = createRuntimeHarness()
    try {
      const adapter = new PiAgentAdapter(harness.load)
      const query: PiAgentQueryOptions = {
        sessionId: 'thinking-session', prompt: '你好', model: 'gpt-5.6-smoke',
        apiKey: 'test', baseUrl: 'https://example.test/v1', provider: 'openai-responses',
        systemPrompt: '测试', permissionMode: 'default', thinkingLevel: 'minimal',
        runtimeAgentDir: join(directory, 'agent'), runtimeSessionDir: join(directory, 'sessions'),
      }
      for await (const _payload of adapter.query(query)) { /* 消费完整查询流，断言注册结果。 */ }
      const model = (harness.state.providerConfig?.models as Array<Record<string, unknown>>)[0]
      expect(model?.reasoning).toBe(true)
      expect(model?.thinkingLevelMap).toMatchObject({ off: 'none', max: 'max' })
      expect(model?.compat).toMatchObject({ supportsReasoningEffort: true })
      expect(harness.state.thinkingLevel).toBe('low')
    } finally {
      rmSync(directory, { recursive: true, force: true })
    }
  })

  test('把 runtime delta、完整消息和 result 按顺序转换，并回传 resume 凭据', async () => {
    const { mkdtempSync, rmSync } = await import('node:fs')
    const { tmpdir } = await import('node:os')
    const { join } = await import('node:path')
    const directory = mkdtempSync(join(tmpdir(), 'axon-pi-query-'))
    const harness = createRuntimeHarness()
    const adapter = new PiAgentAdapter(harness.load)
    const sessions: Array<{ id: string; file?: string }> = []
    try {
      const payloads = []
      const query: PiAgentQueryOptions = {
        sessionId: 'app-session-1',
        prompt: '检查项目',
        model: 'test-model',
        apiKey: 'secret',
        baseUrl: 'https://example.test/v1',
        provider: 'openai',
        systemPrompt: '你是工程助手',
        permissionMode: 'default',
        thinkingLevel: 'xhigh',
        runtimeAgentDir: join(directory, 'agent'),
        runtimeSessionDir: join(directory, 'sessions'),
        onSessionId: (id, file) => sessions.push({ id, file }),
      }
      for await (const payload of adapter.query(query)) payloads.push(payload)

      expect(harness.state.prompt).toBe('检查项目')
      expect(harness.state.thinkingLevel).toBe('xhigh')
      expect(payloads.map((payload) => payload.kind)).toEqual([
        'sdk_message', 'sdk_delta', 'sdk_message', 'sdk_message',
      ])
      const delta = payloads[1]
      const message = payloads[2]
      expect(delta?.kind).toBe('sdk_delta')
      expect(message?.kind).toBe('sdk_message')
      if (delta?.kind === 'sdk_delta' && message?.kind === 'sdk_message' && message.message.type === 'assistant') {
        expect(delta.delta.uuid).toBe((message.message as SDKAssistantMessage).uuid ?? '')
      }
      expect(payloads[3]).toMatchObject({
        kind: 'sdk_message',
        message: { type: 'result', subtype: 'success' },
      })
      expect(sessions).toEqual([{ id: 'runtime-session-1', file: '/tmp/runtime-session-1.jsonl' }])
      expect(harness.state.disposed).toBe(true)
    } finally {
      adapter.dispose()
      rmSync(directory, { recursive: true, force: true })
    }
  })

  test('resume 使用元数据保存的精确 artifact 路径', async () => {
    const { mkdtempSync, rmSync, writeFileSync } = await import('node:fs')
    const { tmpdir } = await import('node:os')
    const { join } = await import('node:path')
    const directory = mkdtempSync(join(tmpdir(), 'axon-pi-resume-'))
    const artifact = join(directory, 'sessions', 'runtime-session-1.jsonl')
    const { mkdirSync } = await import('node:fs')
    mkdirSync(join(directory, 'sessions'), { recursive: true })
    writeFileSync(artifact, '{}\n')
    const harness = createRuntimeHarness()
    const adapter = new PiAgentAdapter(harness.load)
    try {
      const query: PiAgentQueryOptions = {
        sessionId: 'app-session-1',
        prompt: '继续',
        model: 'test-model',
        apiKey: 'secret',
        baseUrl: 'https://example.test/v1',
        provider: 'openai-responses',
        systemPrompt: '继续任务',
        permissionMode: 'default',
        runtimeAgentDir: join(directory, 'agent'),
        runtimeSessionDir: join(directory, 'sessions'),
        resumeSessionId: 'runtime-session-1',
        runtimeSessionFile: artifact,
      }
      for await (const _payload of adapter.query(query)) {}
      expect(harness.state.openedSessionFile).toBe(artifact)
    } finally {
      adapter.dispose()
      rmSync(directory, { recursive: true, force: true })
    }
  })

  test('权限拒绝时不执行自定义工具，并输出 permission_denied 系统消息', async () => {
    const { mkdtempSync, rmSync } = await import('node:fs')
    const { tmpdir } = await import('node:os')
    const { join } = await import('node:path')
    const directory = mkdtempSync(join(tmpdir(), 'axon-pi-permission-'))
    const harness = createRuntimeHarness({ executeTool: 'lookup' })
    const adapter = new PiAgentAdapter(harness.load)
    let executions = 0
    const query: PiAgentQueryOptions = {
      sessionId: 'app-session-1',
      prompt: '查找',
      model: 'test-model',
      apiKey: 'secret',
      baseUrl: 'https://example.test/v1',
      provider: 'custom',
      systemPrompt: '测试工具',
      permissionMode: 'default',
      runtimeAgentDir: join(directory, 'agent'),
      runtimeSessionDir: join(directory, 'sessions'),
      canUseTool: async () => ({ behavior: 'deny', message: '本次不允许' }),
      customTools: [{
        name: 'lookup',
        description: '查找内容',
        inputSchema: { type: 'object', properties: { path: { type: 'string' } } },
        execute: async () => { executions += 1; return { content: '不应执行' } },
      }],
    }
    try {
      const payloads = []
      for await (const payload of adapter.query(query)) payloads.push(payload)
      expect(executions).toBe(0)
      expect(payloads).toContainEqual({
        kind: 'sdk_message',
        message: expect.objectContaining({
          type: 'system', subtype: 'permission_denied', tool_use_id: 'tool-1', message: '本次不允许',
        }),
      })
      expect(harness.state.toolResult).toMatchObject({ isError: true })
    } finally {
      adapter.dispose()
      rmSync(directory, { recursive: true, force: true })
    }
  })

  test('权限允许后把修改过的中立路径参数还原给 runtime 工具', async () => {
    const { mkdtempSync, rmSync } = await import('node:fs')
    const { tmpdir } = await import('node:os')
    const { join } = await import('node:path')
    const directory = mkdtempSync(join(tmpdir(), 'axon-pi-updated-input-'))
    const harness = createRuntimeHarness({ executeTool: 'read' })
    const adapter = new PiAgentAdapter(harness.load)
    let received: Record<string, unknown> | undefined
    const query: PiAgentQueryOptions = {
      sessionId: 'app-session-1',
      prompt: '读取',
      model: 'test-model',
      apiKey: 'secret',
      baseUrl: 'https://example.test',
      provider: 'anthropic-compatible',
      systemPrompt: '测试权限参数',
      permissionMode: 'acceptEdits',
      runtimeAgentDir: join(directory, 'agent'),
      runtimeSessionDir: join(directory, 'sessions'),
      canUseTool: async (_name, input, permission) => {
        expect(input.file_path).toBe('before.txt')
        expect(permission.permissionMode).toBe('acceptEdits')
        return { behavior: 'allow', updatedInput: { file_path: 'after.txt' } }
      },
      customTools: [{
        name: 'read',
        description: '读取内容',
        inputSchema: { type: 'object', properties: { path: { type: 'string' } } },
        execute: async (input) => { received = input; return { content: 'ok' } },
      }],
    }
    try {
      for await (const _payload of adapter.query(query)) {}
      expect(received).toMatchObject({ path: 'after.txt', file_path: 'after.txt' })
    } finally {
      adapter.dispose()
      rmSync(directory, { recursive: true, force: true })
    }
  })

  test('read 直接执行，并在下一次模型上下文中激活子目录 AGENTS.md', async () => {
    const { mkdirSync, mkdtempSync, rmSync, writeFileSync } = await import('node:fs')
    const { tmpdir } = await import('node:os')
    const { join } = await import('node:path')
    const directory = mkdtempSync(join(tmpdir(), 'axon-pi-read-instructions-'))
    mkdirSync(join(directory, 'frontend'), { recursive: true })
    writeFileSync(join(directory, 'AGENTS.md'), '根规则')
    writeFileSync(join(directory, 'frontend', 'AGENTS.md'), '前端规则')
    writeFileSync(join(directory, 'frontend', 'App.tsx'), 'export {}')
    const initial = resolveProjectInstructions({ projectRoot: directory })
    const harness = createRuntimeHarness({
      executeTool: 'read',
      toolInput: { path: 'frontend/App.tsx' },
    })
    const adapter = new PiAgentAdapter(harness.load)
    let executions = 0
    const query: PiAgentQueryOptions = {
      sessionId: 'app-session-1',
      prompt: '读取前端文件',
      model: 'test-model',
      apiKey: 'secret',
      baseUrl: 'https://example.test/v1',
      provider: 'openai',
      systemPrompt: '当前系统提示词\n根规则',
      permissionMode: 'default',
      runtimeAgentDir: join(directory, '.runtime'),
      runtimeSessionDir: join(directory, '.runtime', 'sessions'),
      projectInstructionScope: { projectRoot: directory, initialSources: initial.sources },
      canUseTool: async () => ({ behavior: 'allow' }),
      customTools: [{
        name: 'read',
        description: '读取内容',
        inputSchema: { type: 'object', properties: { path: { type: 'string' } } },
        execute: async () => { executions += 1; return { content: '文件内容' } },
      }],
    }
    try {
      for await (const _payload of adapter.query(query)) {}
      expect(executions).toBe(1)
      expect(harness.state.toolResult).toMatchObject({ content: [{ type: 'text', text: '文件内容' }] })
      expect(harness.state.nextSystemPrompt).toContain('前端规则')
      expect(harness.state.nextSystemPrompt).not.toContain('根规则')
    } finally {
      adapter.dispose()
      rmSync(directory, { recursive: true, force: true })
    }
  })

  test('abort 丢弃半截 assistant，并以 stopped result 收束流', async () => {
    const { mkdtempSync, rmSync } = await import('node:fs')
    const { tmpdir } = await import('node:os')
    const { join } = await import('node:path')
    const directory = mkdtempSync(join(tmpdir(), 'axon-pi-abort-'))
    const harness = createRuntimeHarness({ waitForAbort: true })
    const adapter = new PiAgentAdapter(harness.load)
    const query: PiAgentQueryOptions = {
      sessionId: 'app-session-1',
      prompt: '长任务',
      model: 'test-model',
      apiKey: 'secret',
      baseUrl: 'https://example.test/v1',
      provider: 'openai',
      systemPrompt: '测试停止',
      permissionMode: 'default',
      runtimeAgentDir: join(directory, 'agent'),
      runtimeSessionDir: join(directory, 'sessions'),
    }
    const iterator = adapter.query(query)[Symbol.asyncIterator]()
    try {
      const init = await iterator.next()
      expect(init.value).toMatchObject({ kind: 'sdk_message', message: { type: 'system', subtype: 'init' } })
      adapter.abort('app-session-1')
      const remaining = []
      while (true) {
        const next = await iterator.next()
        if (next.done) break
        remaining.push(next.value)
      }
      expect(harness.state.aborted).toBe(true)
      expect(remaining.some((payload) =>
        payload.kind === 'sdk_message' && payload.message.type === 'assistant')).toBe(false)
      expect(remaining).toContainEqual({
        kind: 'sdk_message',
        message: expect.objectContaining({ type: 'result', terminal_reason: 'stopped' }),
      })
    } finally {
      await iterator.return?.()
      adapter.dispose()
      rmSync(directory, { recursive: true, force: true })
    }
  })

  test('无密钥本地端点关闭认证头，但仍能注册 runtime Provider', async () => {
    const { mkdtempSync, rmSync } = await import('node:fs')
    const { tmpdir } = await import('node:os')
    const { join } = await import('node:path')
    const directory = mkdtempSync(join(tmpdir(), 'axon-pi-keyless-'))
    const harness = createRuntimeHarness()
    const adapter = new PiAgentAdapter(harness.load)
    const query: PiAgentQueryOptions = {
      sessionId: 'app-session-1',
      prompt: '本地任务',
      model: 'local-model',
      apiKey: '',
      baseUrl: 'http://127.0.0.1:11434/v1',
      provider: 'custom',
      systemPrompt: '',
      permissionMode: 'default',
      runtimeAgentDir: join(directory, 'agent'),
      runtimeSessionDir: join(directory, 'sessions'),
    }
    try {
      for await (const _payload of adapter.query(query)) {}
      expect(harness.state.providerConfig).toMatchObject({
        authHeader: false,
        apiKey: 'axon-keyless-app-session-1',
      })
    } finally {
      adapter.dispose()
      rmSync(directory, { recursive: true, force: true })
    }
  })
})
