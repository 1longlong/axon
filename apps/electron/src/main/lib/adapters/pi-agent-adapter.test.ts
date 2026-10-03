import { describe, expect, test } from 'bun:test'
import { resolve } from 'node:path'
import type {
  AgentCustomToolDefinition,
  AgentHostToolExecutionPort,
  AgentSandboxShellCommandRequest,
  AgentSandboxPolicy,
  SDKAssistantMessage,
  SDKMessage,
} from '@axon/shared'
import { AgentSandboxEscalationError } from '@axon/shared'
import {
  convertPiMessage,
  convertPiCompactionEnd,
  convertResultMessage,
  createPiSandboxedBashOperations,
  createPiSandboxedFileToolOptions,
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

const DEFAULT_EXECUTION_POLICY = {
  sandboxMode: 'workspaceWrite',
  approvalPolicy: 'onRequest', approvalReviewer: 'user',
} as const

const SANDBOX_POLICY: AgentSandboxPolicy = {
  platform: 'macos',
  mode: 'workspaceWrite',
  workingDirectory: '/tmp/project',
  readAccess: { type: 'fullAccess' },
  writableRoots: ['/tmp/project'],
  protectedReadOnlyRoots: ['/tmp/project/.git'],
  networkAccess: false,
}

function hostToolPort(
  overrides: Partial<AgentHostToolExecutionPort> = {},
): AgentHostToolExecutionPort {
  const port: AgentHostToolExecutionPort = {
    getSandboxCapability: () => ({
      supported: true, modes: ['readOnly', 'workspaceWrite'],
      sandboxedTools: ['bash', 'read', 'write', 'edit', 'grep', 'glob', 'ls'],
    }),
    initializeShellEnvironment: () => ({
      executeShellCommand: (request, handlers) => port.executeShellCommand(request, handlers),
      dispose: () => {},
    }),
    executeShellCommand: async () => ({
      exitCode: 0, timedOut: false, aborted: false, stdout: '', stderr: '',
      stdoutTruncated: false, stderrTruncated: false,
    }),
    executeCommand: async () => ({
      exitCode: 0, timedOut: false, aborted: false, stdout: '', stderr: '',
      stdoutTruncated: false, stderrTruncated: false,
    }),
    readFile: async () => Buffer.from(''),
    assertFileAccess: async () => {},
    writeFile: async () => {},
    createDirectory: async () => {},
    pathExists: async () => true,
    statPath: async () => ({ isDirectory: false, size: 0 }),
    readDirectory: async () => [],
    glob: async () => [],
    searchText: async () => ({ matches: [], limitReached: false }),
    detectImageMimeType: async () => undefined,
    ...overrides,
  }
  return port
}

describe('Agent 模型思考能力', () => {
  test('Seatbelt 执行器接管工具前不宣称支持 OS 沙箱', () => {
    const adapter = new PiAgentAdapter()
    expect(adapter.getSandboxCapability({ platform: 'macos' })).toEqual({
      supported: false,
      modes: [],
      sandboxedTools: [],
      limitation: 'hostExecutorUnavailable',
    })
    adapter.dispose()
  })

  test('宿主端口覆盖全部内置工具时才报告完整支持', () => {
    const hostTools = hostToolPort()
    const adapter = new PiAgentAdapter(undefined, hostTools)
    expect(adapter.getSandboxCapability({ platform: 'macos' })).toEqual({
      supported: true,
      modes: ['readOnly', 'workspaceWrite'],
      sandboxedTools: ['bash', 'read', 'write', 'edit', 'grep', 'glob', 'ls'],
    })
    adapter.dispose()
  })

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

describe('Pi Bash 宿主委托', () => {
  test('SDK 完整环境与运行时 PATH 前缀被拆开，继承值不变成显式覆盖', async () => {
    let received: AgentSandboxShellCommandRequest | undefined
    const bin = '/tmp/pi-managed-bin'
    const operations = createPiSandboxedBashOperations(hostToolPort({
      executeShellCommand: async (request) => {
        received = request
        return { exitCode: 0, timedOut: false, aborted: false, stdout: '', stderr: '', stdoutTruncated: false, stderrTruncated: false }
      },
    }), SANDBOX_POLICY, undefined, bin)
    const env = { ...process.env, PATH: [bin, process.env.PATH].filter(Boolean).join(':'), AXON_TEST_EXPLICIT: '覆盖', PI_MODEL: 'current-model' }
    await operations.exec('true', '/tmp/project', { onData: () => {}, env })
    expect(received?.environment?.PATH).toBe(env.PATH)
    expect(received?.pathPrepend).toEqual([bin])
    expect(received?.environmentOverrides).not.toHaveProperty('PATH')
    expect(received?.environmentOverrides).toMatchObject({ AXON_TEST_EXPLICIT: '覆盖', PI_MODEL: 'current-model', PI_SESSION_FILE: undefined })
    await operations.exec('true', '/tmp/project', { onData: () => {}, env: { ...env, PATH: '/explicit/bin' } })
    expect(received?.environmentOverrides?.PATH).toBe('/explicit/bin')
    expect(received?.pathPrepend).toBeUndefined()
  })

  test('adapter 只提交原始 Shell 命令，并保留流、环境、超时和取消', async () => {
    let received: AgentSandboxShellCommandRequest | undefined
    const output: string[] = []
    const controller = new AbortController()
    const operations = createPiSandboxedBashOperations(hostToolPort({
      executeShellCommand: async (request, handlers) => {
        received = request
        handlers?.onStdout?.('标准输出')
        handlers?.onStderr?.('错误输出')
        return {
          exitCode: 0, timedOut: false, aborted: false, stdout: '', stderr: '',
          stdoutTruncated: false, stderrTruncated: false,
        }
      },
    }), SANDBOX_POLICY)

    expect(await operations.exec('printf ok', '/tmp/project', {
      onData: (chunk) => output.push(chunk.toString('utf8')),
      signal: controller.signal,
      timeout: 2,
      env: { AXON_TEST: '1' },
    })).toEqual({ exitCode: 0 })
    expect(received).toMatchObject({
      command: 'printf ok',
      cwd: '/tmp/project',
      policy: SANDBOX_POLICY,
      grants: [],
      timeoutMs: 2_000,
      environment: { AXON_TEST: '1' },
      abortSignal: controller.signal,
    })
    expect(received).not.toHaveProperty('argv')
    expect(output).toEqual(['标准输出', '错误输出'])
  })

  test('把宿主超时和中止还原为 Pi Bash 工具认识的错误', async () => {
    const result = (timedOut: boolean, aborted: boolean) => ({
      exitCode: null, timedOut, aborted, stdout: '', stderr: '',
      stdoutTruncated: false, stderrTruncated: false,
    })
    const timeout = createPiSandboxedBashOperations(hostToolPort({
      executeShellCommand: async () => result(true, false),
    }), SANDBOX_POLICY)
    await expect(timeout.exec('sleep 5', '/tmp/project', { onData: () => {}, timeout: 3 }))
      .rejects.toThrow('timeout:3')

    const aborted = createPiSandboxedBashOperations(hostToolPort({
      executeShellCommand: async () => result(false, true),
    }), SANDBOX_POLICY)
    await expect(aborted.exec('sleep 5', '/tmp/project', { onData: () => {} }))
      .rejects.toThrow('aborted')
  })
})

describe('Pi 文件工具宿主委托', () => {
  test('官方文件 operations 只做字段映射，所有实际 IO 都进入中立宿主端口', async () => {
    const calls: string[] = []
    const options = createPiSandboxedFileToolOptions(hostToolPort({
      readFile: async (path) => { calls.push(`read:${path}`); return Buffer.from('content') },
      assertFileAccess: async (path, access) => { calls.push(`access:${access}:${path}`) },
      writeFile: async (path, content) => { calls.push(`write:${path}:${content}`) },
      createDirectory: async (path) => { calls.push(`mkdir:${path}`) },
      glob: async (pattern, cwd) => { calls.push(`glob:${cwd}:${pattern}`); return ['/project/a.ts'] },
      readDirectory: async (path) => { calls.push(`ls:${path}`); return ['a.ts'] },
    }), SANDBOX_POLICY)

    expect((await options.read?.operations?.readFile('/project/a.ts'))?.toString()).toBe('content')
    await options.edit?.operations?.access('/project/a.ts')
    await options.write?.operations?.mkdir('/project/src')
    await options.write?.operations?.writeFile('/project/a.ts', 'next')
    expect(await options.find?.operations?.glob('**/*.ts', '/project', { ignore: [], limit: 10 }))
      .toEqual(['/project/a.ts'])
    expect(await options.ls?.operations?.readdir('/project')).toEqual(['a.ts'])
    expect(calls).toEqual([
      'read:/project/a.ts',
      'access:read:/project/a.ts',
      'mkdir:/project/src',
      'write:/project/a.ts:next',
      'glob:/project:**/*.ts',
      'ls:/project',
    ])
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
    expect(terminalError.error).toMatchObject({ code: 'network_error', category: 'network', retryable: true })
  })

  test('只有明确的永久域名解析错误才归为渠道配置错误', () => {
    const terminalError = convertPiMessage({
      role: 'assistant', content: [], stopReason: 'error',
      errorMessage: 'getaddrinfo ENOTFOUND nonexistent.invalid',
    } as unknown as RuntimeMessage, 'session-1') as { error?: { code?: string; category?: string; retryable?: boolean } }
    const temporaryDnsError = convertPiMessage({
      role: 'assistant', content: [], stopReason: 'error',
      errorMessage: 'getaddrinfo EAI_AGAIN api.example.test',
    } as unknown as RuntimeMessage, 'session-1') as { error?: { code?: string; category?: string; retryable?: boolean } }

    expect(terminalError.error).toMatchObject({
      code: 'provider_endpoint_not_found', category: 'configuration', retryable: false,
    })
    expect(temporaryDnsError.error).toMatchObject({
      code: 'network_error', category: 'network', retryable: true,
    })
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
    sandboxedToolOptionsSeen?: boolean
    settingsOverrides: unknown[]
  }
}

interface RuntimeHarnessOptions {
  executeTool?: string
  toolInput?: Record<string, unknown>
  waitForAbort?: boolean
  emitCompaction?: boolean
  errorMessage?: string
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
  const state: RuntimeHarness['state'] = { disposed: false, settingsOverrides: [] }
  const assistant = runtimeMessage(options.errorMessage ? {
    role: 'assistant', content: [], stopReason: 'error',
    errorMessage: options.errorMessage, model: 'test-model',
  } : {
    role: 'assistant', content: [{ type: 'text', text: '完成' }], stopReason: 'stop', model: 'test-model',
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
      if (!options.errorMessage) {
        const partial = runtimeMessage({ role: 'assistant', content: [{ type: 'text', text: '完' }] })
        for (const listener of listeners) listener({
          type: 'message_update',
          message: partial,
          assistantMessageEvent: { type: 'text_delta', contentIndex: 0, delta: '完', partial },
        })
      }
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
    getAgentDir: () => '/tmp/pi-test-agent',
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
    SettingsManager: {
      inMemory() {
        return { applyOverrides: (value: unknown) => state.settingsOverrides.push(value) }
      },
    },
    DefaultResourceLoader: class {
      constructor(config: Record<string, unknown>) { state.resourceLoaderConfig = config }
      async reload() {}
    },
    createCodingTools() { return [] },
    createReadTool(cwd: string, toolOptions?: {
      operations?: { readFile(path: string): Promise<Buffer> }
    }) {
      state.sandboxedToolOptionsSeen ||= Boolean(toolOptions)
      return { name: 'read', execute: async (_id: string, input: { path: string }) => ({
        content: [{ type: 'text', text: (await toolOptions?.operations?.readFile(resolve(cwd, input.path)))?.toString() ?? '' }],
      }) }
    },
    createBashTool(cwd: string, toolOptions?: {
      operations?: {
        exec(command: string, cwd: string, options: { onData(data: Buffer): void; signal?: AbortSignal }): Promise<{
          exitCode: number | null
        }>
      }
    }) {
      state.sandboxedToolOptionsSeen ||= Boolean(toolOptions)
      return {
        name: 'bash',
        execute: async (_toolUseId: string, input: { command: string }, signal?: AbortSignal) => {
          await toolOptions?.operations?.exec(input.command, cwd, { onData: () => {}, signal })
          return { content: [] }
        },
      }
    },
    createEditTool(_cwd: string, toolOptions?: unknown) {
      state.sandboxedToolOptionsSeen ||= Boolean(toolOptions)
      return { name: 'edit', execute: async () => ({ content: [] }) }
    },
    createWriteTool(_cwd: string, toolOptions?: {
      operations?: { writeFile(path: string, content: string): Promise<void> }
    }) {
      state.sandboxedToolOptionsSeen ||= Boolean(toolOptions)
      return {
        name: 'write',
        execute: async (_toolUseId: string, input: { path: string; content?: string }) => {
          await toolOptions?.operations?.writeFile(input.path, input.content ?? '')
          return { content: [] }
        },
      }
    },
    createFindTool(_cwd: string, toolOptions?: unknown) {
      state.sandboxedToolOptionsSeen ||= Boolean(toolOptions)
      return { name: 'find', execute: async () => ({ content: [] }) }
    },
    createLsTool(_cwd: string, toolOptions?: unknown) {
      state.sandboxedToolOptionsSeen ||= Boolean(toolOptions)
      return { name: 'ls', execute: async () => ({ content: [] }) }
    },
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
  test('缺少宿主、探测失败或策略缺失/不一致时，在加载 SDK 前拒绝，不使用原生工具回退', async () => {
    const harness = createRuntimeHarness()
    let loads = 0
    let initializations = 0
    const load = async () => { loads += 1; return harness.load() }
    const port = hostToolPort({
      initializeShellEnvironment: () => { initializations += 1; throw new Error('不应预热') },
    })
    const unavailable = hostToolPort({
      getSandboxCapability: () => ({ supported: false, modes: [], sandboxedTools: [], limitation: 'hostExecutorUnavailable' }),
    })
    const input: PiAgentQueryOptions = {
      sessionId: 'blocked', prompt: '执行', model: 'test-model', apiKey: 'secret',
      baseUrl: 'https://example.test', provider: 'openai', systemPrompt: '',
      executionPolicy: DEFAULT_EXECUTION_POLICY, sandboxPolicy: SANDBOX_POLICY,
      runtimeAgentDir: '/tmp/axon-blocked-agent', runtimeSessionDir: '/tmp/axon-blocked-sessions',
    }
    const cases = [
      { adapter: new PiAgentAdapter(load), input },
      { adapter: new PiAgentAdapter(load, unavailable), input },
      { adapter: new PiAgentAdapter(load, port), input: { ...input, sandboxPolicy: undefined } },
      { adapter: new PiAgentAdapter(load, port), input: { ...input, sandboxPolicy: { ...SANDBOX_POLICY, mode: 'readOnly' as const } } },
    ]
    for (const scenario of cases) {
      try {
        await expect((async () => { for await (const _event of scenario.adapter.query(scenario.input)) {} })())
          .rejects.toThrow('当前运行已拒绝')
      } finally { scenario.adapter.dispose() }
    }
    expect(loads).toBe(0)
    expect(initializations).toBe(0)
  })

  test('会话环境在加载 runtime 前预热，无 Bash 的多轮查询也只初始化一次，cwd 改变才释放', async () => {
    const { mkdtempSync, rmSync } = await import('node:fs')
    const { tmpdir } = await import('node:os')
    const { join } = await import('node:path')
    const directory = mkdtempSync(join(tmpdir(), 'axon-pi-shell-environment-'))
    const harness = createRuntimeHarness()
    const events: string[] = []
    const port = hostToolPort({
      initializeShellEnvironment: ({ sessionId, cwd }) => {
        events.push(`initialize:${sessionId}:${cwd}`)
        return {
          executeShellCommand: (request, handlers) => port.executeShellCommand(request, handlers),
          dispose: () => { events.push(`dispose:${cwd}`) },
        }
      },
    })
    const adapter = new PiAgentAdapter(async () => {
      events.push('load')
      return harness.load()
    }, port)
    const query: PiAgentQueryOptions = {
      sessionId: 'prewarm', prompt: 'hi', model: 'test-model',
      apiKey: 'secret', baseUrl: 'https://example.test/v1', provider: 'openai',
      cwd: directory, systemPrompt: '测试', executionPolicy: DEFAULT_EXECUTION_POLICY,
      sandboxPolicy: { ...SANDBOX_POLICY, workingDirectory: directory },
      runtimeAgentDir: join(directory, 'agent'), runtimeSessionDir: join(directory, 'sessions'),
    }
    try {
      for await (const _payload of adapter.query(query)) {}
      for await (const _payload of adapter.query(query)) {}
      expect(events).toEqual([`initialize:prewarm:${directory}`, 'load', 'load'])
      // 每轮 runtime 都释放，但宿主环境仍由应用会话持有。
      expect(harness.state.disposed).toBe(true)
      for await (const _payload of adapter.query({ ...query, cwd: join(directory, 'other') })) {}
      expect(events.slice(-3)).toEqual([`dispose:${directory}`, `initialize:prewarm:${join(directory, 'other')}`, 'load'])
      adapter.releaseSession('prewarm')
      expect(events.at(-1)).toBe(`dispose:${join(directory, 'other')}`)
      const countAfterRelease = events.length
      adapter.releaseSession('prewarm')
      expect(events).toHaveLength(countAfterRelease)
      for await (const _payload of adapter.query(query)) {}
      expect(events.slice(-2)).toEqual([`initialize:prewarm:${directory}`, 'load'])
      adapter.dispose()
      expect(events.at(-1)).toBe(`dispose:${directory}`)
    } finally { adapter.dispose(); rmSync(directory, { recursive: true, force: true }) }
  })

  test('进入查询前已经取消时不启动宿主初始化', async () => {
    const { mkdtempSync, rmSync } = await import('node:fs')
    const { tmpdir } = await import('node:os')
    const { join } = await import('node:path')
    const directory = mkdtempSync(join(tmpdir(), 'axon-pi-shell-cancel-'))
    let initialized = false
    const adapter = new PiAgentAdapter(createRuntimeHarness().load, hostToolPort({
      initializeShellEnvironment: () => { initialized = true; throw new Error('不应初始化') },
    }))
    const controller = new AbortController()
    controller.abort()
    const query: PiAgentQueryOptions = {
      sessionId: 'cancel', prompt: 'hi', model: 'test-model', apiKey: 'secret', provider: 'openai',
      baseUrl: 'https://example.test/v1', systemPrompt: '测试',
      cwd: directory, executionPolicy: DEFAULT_EXECUTION_POLICY, sandboxPolicy: SANDBOX_POLICY,
      abortSignal: controller.signal,
      runtimeAgentDir: join(directory, 'agent'), runtimeSessionDir: join(directory, 'sessions'),
    }
    try {
      for await (const _payload of adapter.query(query)) {}
      expect(initialized).toBe(false)
    } finally { adapter.dispose(); rmSync(directory, { recursive: true, force: true }) }
  })

  test('泛化连接错误只做终态归类，不覆盖 runtime 自身的重试设置', async () => {
    const { mkdtempSync, rmSync } = await import('node:fs')
    const { tmpdir } = await import('node:os')
    const { join } = await import('node:path')
    const directory = mkdtempSync(join(tmpdir(), 'axon-pi-connection-error-'))
    const harness = createRuntimeHarness({ errorMessage: 'Connection error.' })
    const adapter = new PiAgentAdapter(harness.load, hostToolPort())
    try {
      const payloads = []
      const query: PiAgentQueryOptions = {
        sessionId: 'connection-error', prompt: '继续', model: 'test-model',
        apiKey: 'secret', baseUrl: 'https://example.test/v1', provider: 'openai',
        systemPrompt: '测试', executionPolicy: DEFAULT_EXECUTION_POLICY, sandboxPolicy: SANDBOX_POLICY, allowedBuiltinTools: [],
        runtimeAgentDir: join(directory, 'agent'), runtimeSessionDir: join(directory, 'sessions'),
      }
      for await (const payload of adapter.query(query)) payloads.push(payload)

      expect(harness.state.settingsOverrides).toEqual([])
      expect(payloads.at(-1)).toMatchObject({
        kind: 'sdk_message',
        message: {
          type: 'result', subtype: 'error_during_execution',
          error: { code: 'network_error', category: 'network', retryable: true },
        },
      })
    } finally {
      adapter.dispose()
      rmSync(directory, { recursive: true, force: true })
    }
  })

  test('宿主端口存在时注册七个受控内置工具，Grep 不再调用 Pi 的直接 rg 路径', async () => {
    const { mkdtempSync, rmSync } = await import('node:fs')
    const { tmpdir } = await import('node:os')
    const { join } = await import('node:path')
    const directory = mkdtempSync(join(tmpdir(), 'axon-pi-sandboxed-tools-'))
    const harness = createRuntimeHarness({
      executeTool: 'grep',
      toolInput: { pattern: 'Axon', path: '.' },
    })
    let searchedPath = ''
    const adapter = new PiAgentAdapter(harness.load, hostToolPort({
      searchText: async (path) => {
        searchedPath = path
        return {
          matches: [{ path: 'src/a.ts', line: 2, text: 'Axon', before: [], after: [] }],
          limitReached: false,
        }
      },
    }))
    try {
      const sandboxPolicy: AgentSandboxPolicy = {
        ...SANDBOX_POLICY,
        workingDirectory: directory,
        writableRoots: [directory],
        protectedReadOnlyRoots: [join(directory, '.git')],
      }
      const query: PiAgentQueryOptions = {
        sessionId: 'sandboxed-tools', prompt: '搜索', model: 'test-model',
        apiKey: 'secret', baseUrl: 'https://example.test/v1', provider: 'openai',
        cwd: directory, systemPrompt: '测试', executionPolicy: DEFAULT_EXECUTION_POLICY, sandboxPolicy,
        canUseTool: async (_name, _input, permission) => {
          expect(permission.toolExecution).toEqual({ kind: 'sandbox', mode: 'workspaceWrite' })
          return { behavior: 'allow' }
        },
        runtimeAgentDir: join(directory, 'agent'), runtimeSessionDir: join(directory, 'sessions'),
      }
      for await (const _payload of adapter.query(query)) {}
      expect(harness.state.initialToolNames).toEqual(['read', 'bash', 'edit', 'write', 'grep', 'find', 'ls'])
      expect(harness.state.sandboxedToolOptionsSeen).toBe(true)
      expect(searchedPath).toBe(directory)
      expect(harness.state.toolResult).toMatchObject({
        content: [{ type: 'text', text: 'src/a.ts:2: Axon' }],
      })
    } finally {
      adapter.dispose()
      rmSync(directory, { recursive: true, force: true })
    }
  })

  test('文件越界由宿主升级请求进入审批，批准 Grant 只注入同一次工具重试', async () => {
    const { mkdtempSync, rmSync } = await import('node:fs')
    const { tmpdir } = await import('node:os')
    const { join } = await import('node:path')
    const directory = mkdtempSync(join(tmpdir(), 'axon-pi-sandbox-grant-'))
    const outside = join(directory, '..', 'outside.txt')
    const harness = createRuntimeHarness({
      executeTool: 'write',
      toolInput: { path: outside, content: 'approved' },
    })
    const receivedGrants: unknown[] = []
    const adapter = new PiAgentAdapter(harness.load, hostToolPort({
      writeFile: async (_path, _content, context) => {
        receivedGrants.push(context.grants)
        if (context.grants.length === 0) {
          throw new AgentSandboxEscalationError({
            reason: 'filesystemWriteOutsideWorkspace',
            permission: { type: 'filesystemWrite', roots: [outside] },
            target: outside,
            message: '文件写入目标越过沙箱可写根',
          })
        }
      },
    }))
    const permissionCalls: Array<{ escalation?: unknown }> = []
    try {
      const query: PiAgentQueryOptions = {
        sessionId: 'sandbox-grant', prompt: '写入', model: 'test-model',
        apiKey: 'secret', baseUrl: 'https://example.test/v1', provider: 'openai',
        cwd: directory, systemPrompt: '测试', executionPolicy: DEFAULT_EXECUTION_POLICY,
        sandboxPolicy: {
          ...SANDBOX_POLICY,
          workingDirectory: directory,
          writableRoots: [directory],
          protectedReadOnlyRoots: [join(directory, '.git')],
        },
        runtimeAgentDir: join(directory, 'agent'), runtimeSessionDir: join(directory, 'sessions'),
        canUseTool: async (_name, input, permission) => {
          expect(input.file_path).toBe(outside)
          permissionCalls.push({ escalation: permission.sandboxEscalation })
          return permission.sandboxEscalation
            ? {
                behavior: 'allow',
                sandboxGrants: [{ scope: 'once', permission: permission.sandboxEscalation.permission }],
              }
            : { behavior: 'allow' }
        },
      }
      for await (const _payload of adapter.query(query)) {}
      expect(permissionCalls).toEqual([
        { escalation: undefined },
        { escalation: expect.objectContaining({ reason: 'filesystemWriteOutsideWorkspace', target: outside }) },
      ])
      expect(receivedGrants).toEqual([
        [],
        [{ scope: 'once', permission: { type: 'filesystemWrite', roots: [outside] } }],
      ])
      expect(harness.state.toolResult).toMatchObject({ content: [] })
    } finally {
      adapter.dispose()
      rmSync(directory, { recursive: true, force: true })
    }
  })

  test('Bash Seatbelt 拒绝沿用结构化审批，并携带网络 Grant 重试原命令', async () => {
    const { mkdtempSync, rmSync } = await import('node:fs')
    const { tmpdir } = await import('node:os')
    const { join } = await import('node:path')
    const directory = mkdtempSync(join(tmpdir(), 'axon-pi-bash-grant-'))
    const harness = createRuntimeHarness({
      executeTool: 'bash',
      toolInput: { command: 'curl https://example.com' },
    })
    const receivedGrants: unknown[] = []
    const escalation = new AgentSandboxEscalationError({
      reason: 'networkAccess', permission: { type: 'network' },
      message: '命令的网络访问被基础沙箱拒绝',
    })
    const adapter = new PiAgentAdapter(harness.load, hostToolPort({
      executeShellCommand: async (request) => {
        receivedGrants.push(request.grants)
        if (request.grants.length === 0) throw escalation
        return {
          exitCode: 0, timedOut: false, aborted: false, stdout: '', stderr: '',
          stdoutTruncated: false, stderrTruncated: false,
        }
      },
    }))
    const permissionCalls: Array<{ escalation?: unknown }> = []
    try {
      const query: PiAgentQueryOptions = {
        sessionId: 'bash-grant', prompt: '联网', model: 'test-model',
        apiKey: 'secret', baseUrl: 'https://example.test/v1', provider: 'openai',
        cwd: directory, systemPrompt: '测试', executionPolicy: DEFAULT_EXECUTION_POLICY,
        sandboxPolicy: {
          ...SANDBOX_POLICY, workingDirectory: directory, writableRoots: [directory],
          protectedReadOnlyRoots: [join(directory, '.git')],
        },
        runtimeAgentDir: join(directory, 'agent'), runtimeSessionDir: join(directory, 'sessions'),
        canUseTool: async (_name, input, permission) => {
          expect(input.command).toBe('curl https://example.com')
          permissionCalls.push({ escalation: permission.sandboxEscalation })
          return permission.sandboxEscalation
            ? { behavior: 'allow', sandboxGrants: [{ scope: 'once', permission: { type: 'network' } }] }
            : { behavior: 'allow' }
        },
      }
      for await (const _payload of adapter.query(query)) {}
      expect(permissionCalls).toEqual([
        { escalation: undefined },
        { escalation: expect.objectContaining({ reason: 'networkAccess' }) },
      ])
      expect(receivedGrants).toEqual([[], [{ scope: 'once', permission: { type: 'network' } }]])
      expect(harness.state.toolResult).toMatchObject({ content: [] })
    } finally {
      adapter.dispose()
      rmSync(directory, { recursive: true, force: true })
    }
  })

  test('压缩开始和结束进入瞬时 UI 状态流，完成边界仍作为系统消息落盘', async () => {
    const { mkdtempSync, rmSync } = await import('node:fs')
    const { tmpdir } = await import('node:os')
    const { join } = await import('node:path')
    const directory = mkdtempSync(join(tmpdir(), 'axon-pi-compaction-status-'))
    const adapter = new PiAgentAdapter(createRuntimeHarness({ emitCompaction: true }).load, hostToolPort())
    try {
      const payloads = []
      const query: PiAgentQueryOptions = {
        sessionId: 'compaction-session', prompt: '继续', model: 'test-model',
        apiKey: 'secret', baseUrl: 'https://example.test/v1', provider: 'openai',
        systemPrompt: '测试', executionPolicy: DEFAULT_EXECUTION_POLICY, sandboxPolicy: SANDBOX_POLICY, allowedBuiltinTools: [],
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
    const adapter = new PiAgentAdapter(harness.load, hostToolPort())
    try {
      const query: PiAgentQueryOptions = {
        sessionId: 'tool-search-session', prompt: '查询问题', model: 'gpt-5.4',
        apiKey: 'secret', baseUrl: 'https://api.openai.com/v1', provider: 'openai-responses',
        systemPrompt: '测试延迟工具', executionPolicy: DEFAULT_EXECUTION_POLICY, sandboxPolicy: SANDBOX_POLICY, allowedBuiltinTools: [],
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
    const adapter = new PiAgentAdapter(harness.load, hostToolPort())
    try {
      const query: PiAgentQueryOptions = {
        sessionId: 'anthropic-tool-search', prompt: '查询问题', model: 'claude-sonnet-4-6',
        apiKey: 'secret', baseUrl: 'https://api.anthropic.com', provider: 'anthropic',
        systemPrompt: '测试延迟工具', executionPolicy: DEFAULT_EXECUTION_POLICY, sandboxPolicy: SANDBOX_POLICY, allowedBuiltinTools: [],
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
      const adapter = new PiAgentAdapter(harness.load, hostToolPort())
      const query: PiAgentQueryOptions = {
        sessionId: 'deepseek-session', prompt: '你好', model: 'deepseek-v4-pro',
        apiKey: 'test', baseUrl: 'https://example.test', provider: 'anthropic-compatible',
        systemPrompt: '测试', executionPolicy: DEFAULT_EXECUTION_POLICY, sandboxPolicy: SANDBOX_POLICY, allowedBuiltinTools: [], thinkingLevel: 'xhigh',
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
      const adapter = new PiAgentAdapter(harness.load, hostToolPort())
      const query: PiAgentQueryOptions = {
        sessionId: 'thinking-session', prompt: '你好', model: 'gpt-5.6-smoke',
        apiKey: 'test', baseUrl: 'https://example.test/v1', provider: 'openai-responses',
        systemPrompt: '测试', executionPolicy: DEFAULT_EXECUTION_POLICY, sandboxPolicy: SANDBOX_POLICY, allowedBuiltinTools: [], thinkingLevel: 'minimal',
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
    const adapter = new PiAgentAdapter(harness.load, hostToolPort())
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
        executionPolicy: DEFAULT_EXECUTION_POLICY, sandboxPolicy: SANDBOX_POLICY, allowedBuiltinTools: [],
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
    const adapter = new PiAgentAdapter(harness.load, hostToolPort())
    try {
      const query: PiAgentQueryOptions = {
        sessionId: 'app-session-1',
        prompt: '继续',
        model: 'test-model',
        apiKey: 'secret',
        baseUrl: 'https://example.test/v1',
        provider: 'openai-responses',
        systemPrompt: '继续任务',
        executionPolicy: DEFAULT_EXECUTION_POLICY, sandboxPolicy: SANDBOX_POLICY, allowedBuiltinTools: [],
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

  test('同名自定义 Read 在缺少授权能力时拒绝执行，不借用内置读取权限', async () => {
    const { mkdtempSync, rmSync } = await import('node:fs')
    const { tmpdir } = await import('node:os')
    const { join } = await import('node:path')
    const directory = mkdtempSync(join(tmpdir(), 'axon-pi-custom-read-'))
    const harness = createRuntimeHarness({ executeTool: 'read' })
    const adapter = new PiAgentAdapter(harness.load, hostToolPort())
    let executions = 0
    try {
      const query: PiAgentQueryOptions = {
        sessionId: 'no-auth', prompt: '读文件', model: 'test-model', apiKey: 'secret',
        baseUrl: 'https://example.test/v1', provider: 'openai', systemPrompt: '',
        executionPolicy: DEFAULT_EXECUTION_POLICY, sandboxPolicy: SANDBOX_POLICY, allowedBuiltinTools: [],
        runtimeAgentDir: join(directory, 'agent'), runtimeSessionDir: join(directory, 'sessions'),
        customTools: [{ name: 'read', description: '自定义读取', inputSchema: { type: 'object' },
          execute: async () => { executions += 1; return { content: '不应执行' } } }],
      }
      for await (const _payload of adapter.query(query)) {}
      expect(executions).toBe(0)
      expect(harness.state.toolResult).toMatchObject({ isError: true, content: [{ text: '当前会话没有工具授权能力' }] })
    } finally { adapter.dispose(); rmSync(directory, { recursive: true, force: true }) }
  })

  test('权限拒绝时不执行自定义工具，并输出 permission_denied 系统消息', async () => {
    const { mkdtempSync, rmSync } = await import('node:fs')
    const { tmpdir } = await import('node:os')
    const { join } = await import('node:path')
    const directory = mkdtempSync(join(tmpdir(), 'axon-pi-permission-'))
    const harness = createRuntimeHarness({ executeTool: 'lookup' })
    const adapter = new PiAgentAdapter(harness.load, hostToolPort())
    let executions = 0
    const query: PiAgentQueryOptions = {
      sessionId: 'app-session-1',
      prompt: '查找',
      model: 'test-model',
      apiKey: 'secret',
      baseUrl: 'https://example.test/v1',
      provider: 'custom',
      systemPrompt: '测试工具',
      executionPolicy: DEFAULT_EXECUTION_POLICY, sandboxPolicy: SANDBOX_POLICY, allowedBuiltinTools: [],
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
    const adapter = new PiAgentAdapter(harness.load, hostToolPort())
    let received: Record<string, unknown> | undefined
    const query: PiAgentQueryOptions = {
      sessionId: 'app-session-1',
      prompt: '读取',
      model: 'test-model',
      apiKey: 'secret',
      baseUrl: 'https://example.test',
      provider: 'anthropic-compatible',
      systemPrompt: '测试权限参数',
      executionPolicy: DEFAULT_EXECUTION_POLICY, sandboxPolicy: SANDBOX_POLICY, allowedBuiltinTools: [],
      runtimeAgentDir: join(directory, 'agent'),
      runtimeSessionDir: join(directory, 'sessions'),
      canUseTool: async (_name, input, permission) => {
        expect(input.file_path).toBe('before.txt')
        expect(permission.executionPolicy).toEqual(DEFAULT_EXECUTION_POLICY)
        expect(permission.toolExecution).toEqual({ kind: 'host', permissionMode: 'ask' })
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
    let executions = 0
    const adapter = new PiAgentAdapter(harness.load, hostToolPort({
      readFile: async (path) => {
        expect(path).toBe(join(directory, 'frontend', 'App.tsx'))
        executions += 1
        return Buffer.from('文件内容')
      },
    }))
    const query: PiAgentQueryOptions = {
      sessionId: 'app-session-1',
      prompt: '读取前端文件',
      cwd: directory,
      model: 'test-model',
      apiKey: 'secret',
      baseUrl: 'https://example.test/v1',
      provider: 'openai',
      systemPrompt: '当前系统提示词\n根规则',
      executionPolicy: DEFAULT_EXECUTION_POLICY,
      sandboxPolicy: { ...SANDBOX_POLICY, workingDirectory: directory, writableRoots: [directory] },
      allowedBuiltinTools: ['Read'],
      runtimeAgentDir: join(directory, '.runtime'),
      runtimeSessionDir: join(directory, '.runtime', 'sessions'),
      projectInstructionScope: { projectRoot: directory, initialSources: initial.sources },
      canUseTool: async () => ({ behavior: 'allow' }),
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
    const adapter = new PiAgentAdapter(harness.load, hostToolPort())
    const query: PiAgentQueryOptions = {
      sessionId: 'app-session-1',
      prompt: '长任务',
      model: 'test-model',
      apiKey: 'secret',
      baseUrl: 'https://example.test/v1',
      provider: 'openai',
      systemPrompt: '测试停止',
      executionPolicy: DEFAULT_EXECUTION_POLICY, sandboxPolicy: SANDBOX_POLICY, allowedBuiltinTools: [],
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
    const adapter = new PiAgentAdapter(harness.load, hostToolPort())
    const query: PiAgentQueryOptions = {
      sessionId: 'app-session-1',
      prompt: '本地任务',
      model: 'local-model',
      apiKey: '',
      baseUrl: 'http://127.0.0.1:11434/v1',
      provider: 'custom',
      systemPrompt: '',
      executionPolicy: DEFAULT_EXECUTION_POLICY, sandboxPolicy: SANDBOX_POLICY, allowedBuiltinTools: [],
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
