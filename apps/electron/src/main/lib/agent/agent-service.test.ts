import { afterEach, beforeEach, describe, expect, test } from 'bun:test'
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type {
  AgentProviderAdapter,
  AgentCustomToolDefinition,
  AgentQueryInput,
  AgentStreamPayload,
  ResolvedChannel,
} from '@axon/shared'
import { AgentEventBus, type AgentServiceEvent } from './agent-event-bus'
import { AgentService, AgentServiceError } from './agent-service'
import { AgentSessionManager } from './agent-session-manager'
import { AgentRootStateStore } from './agent-root-state-store'
import {
  resolveProjectInstructions,
  type ProjectInstructionManifest,
} from '../project/project-instruction-resolver'
import { discoverProjectSkills, type AgentSkillCatalog } from '../project/project-skill-discovery'
import type { AgentMemoryContext } from '../memory/agent-memory-tools'
import type { AgentTitleGenerator } from './agent-title-generator'
import { withAgentToolSearch } from './agent-tool-search'

let directory: string
let sessions: AgentSessionManager
let sessionSequence: number
let rootStateStore: AgentRootStateStore

beforeEach(() => {
  directory = mkdtempSync(join(tmpdir(), 'axon-agent-service-'))
  sessionSequence = 0
  rootStateStore = new AgentRootStateStore(join(directory, 'messages'))
  sessions = new AgentSessionManager({
    indexPath: join(directory, 'agent-sessions.json'),
    sessionsDir: join(directory, 'messages'),
    stateStore: rootStateStore,
    createId: () => `session-${++sessionSequence}`,
    now: () => 10,
  })
})

afterEach(() => rmSync(directory, { recursive: true, force: true }))

function resolvedChannel(overrides: Partial<ResolvedChannel> = {}): ResolvedChannel {
  return {
    id: 'channel-1',
    name: '测试渠道',
    provider: 'openai',
    baseUrl: 'https://example.test/v1',
    apiKey: 'secret',
    models: [{ id: 'model-1', name: 'Model 1', enabled: true }],
    enabled: true,
    createdAt: 1,
    updatedAt: 1,
    ...overrides,
  }
}

class FakeAdapter implements AgentProviderAdapter {
  input?: AgentQueryInput
  aborted: string[] = []
  stream: AgentStreamPayload[] = []
  waitForAbort = false
  deferredToolsSupported = false
  onQuery?: (input: AgentQueryInput) => void | Promise<void>
  emitRuntimeSession = true

  supportsDeferredTools(): boolean {
    return this.deferredToolsSupported
  }

  async *query(input: AgentQueryInput): AsyncIterable<AgentStreamPayload> {
    this.input = input
    await this.onQuery?.(input)
    if (this.emitRuntimeSession) {
      input.onRuntimeSession?.('runtime-1', join(directory, 'runtime', 'sessions', 'runtime-1.jsonl'))
    }
    if (this.waitForAbort) {
      await new Promise<void>((resolve) => input.abortSignal?.addEventListener('abort', () => resolve(), { once: true }))
      return
    }
    for (const payload of this.stream) yield payload
  }

  abort(sessionId: string): void {
    this.aborted.push(sessionId)
  }

  dispose(): void {}
}

function createService(
  adapter: FakeAdapter,
  channel = resolvedChannel(),
  overrides: {
    now?: () => number
    createId?: () => string
    resolveProjectCwd?: (id: string) => string
    resolveProjectInstructions?: (root: string) => ProjectInstructionManifest
    discoverAgentSkills?: (root: string) => AgentSkillCatalog
    getCustomTools?: (context: { projectId: string; runSignal: AbortSignal }) => Promise<AgentCustomToolDefinition[]>
    getProjectMemoryContext?: (
      projectId: string,
      previous: Record<string, { updatedAt: number; size: number }> | undefined,
    ) => AgentMemoryContext | undefined
    generateTitle?: AgentTitleGenerator
    resolveAdapter?: (runtimeId: 'pi' | 'zima') => AgentProviderAdapter
    validateRuntimeSession?: (session: { runtimeId: 'pi' | 'zima' }) => void
  } = {},
) {
  const eventBus = new AgentEventBus()
  const events: AgentServiceEvent[] = []
  eventBus.subscribe((event) => events.push(event))
  const service = new AgentService({
    adapter,
    ...(overrides.resolveAdapter ? { resolveAdapter: overrides.resolveAdapter } : {}),
    ...(overrides.validateRuntimeSession ? { validateRuntimeSession: overrides.validateRuntimeSession } : {}),
    eventBus,
    sessionManager: sessions,
    channelManager: { resolve: () => channel },
    runtimeConfigDir: join(directory, 'runtime'),
    runtimeSessionDir: join(directory, 'runtime', 'sessions'),
    getSystemPrompt: () => '全局规则',
    resolveProjectCwd: overrides.resolveProjectCwd ?? (() => directory),
    ...(overrides.resolveProjectInstructions
      ? { resolveProjectInstructions: overrides.resolveProjectInstructions }
      : {}),
    ...(overrides.discoverAgentSkills
      ? { discoverAgentSkills: overrides.discoverAgentSkills }
      : {}),
    ...(overrides.getCustomTools ? { getCustomTools: overrides.getCustomTools } : {}),
    ...(overrides.getProjectMemoryContext
      ? { getProjectMemoryContext: overrides.getProjectMemoryContext }
      : {}),
    ...(overrides.generateTitle ? { generateTitle: overrides.generateTitle } : {}),
    createId: overrides.createId ?? (() => 'user-1'),
    now: overrides.now ?? (() => 100),
  })
  return { service, events }
}

async function expectServiceError(action: () => Promise<unknown>, code: AgentServiceError['code']): Promise<void> {
  try {
    await action()
    throw new Error('expected AgentServiceError')
  } catch (error) {
    expect(error).toBeInstanceOf(AgentServiceError)
    expect((error as AgentServiceError).code).toBe(code)
  }
}

async function expectTerminalError(action: () => Promise<unknown>, code: AgentServiceError['code']): Promise<void> {
  await action()
  const result = sessions.getMessages('session-1').at(-1) as { error?: { code?: string } } | undefined
  expect(result?.error?.code).toBe(code)
}

describe('AgentService 消息编排主链', () => {
  test('Zima 发送前校验失败不写半轮消息，成功时只分派给所属 adapter', async () => {
    sessions.create({ runtimeId: 'zima', channelId: 'channel-1', modelId: 'model-1', projectId: 'project-1' })
    const piAdapter = new FakeAdapter()
    const zimaAdapter = new FakeAdapter()
    zimaAdapter.stream = [{
      kind: 'sdk_message',
      message: { type: 'result', subtype: 'success', usage: { input_tokens: 1, output_tokens: 1 } },
    }]
    let ready = false
    const { service } = createService(piAdapter, resolvedChannel(), {
      resolveAdapter: (runtimeId) => runtimeId === 'zima' ? zimaAdapter : piAdapter,
      validateRuntimeSession: () => { if (!ready) throw new Error('Zima 未配置') },
    })
    await expectServiceError(() => service.sendMessage({ sessionId: 'session-1', text: '第一次' }), 'runtime_error')
    expect(sessions.getMessages('session-1')).toEqual([])
    ready = true
    await service.sendMessage({ sessionId: 'session-1', text: '第二次' })
    expect(piAdapter.input).toBeUndefined()
    expect(zimaAdapter.input).toMatchObject({ prompt: '第二次', model: 'model-1' })
    expect(zimaAdapter.input?.thinkingLevel).toBe('medium')
  })

  test('首轮成功后异步生成标题，并且不覆盖生成期间的手动改名', async () => {
    sessions.create({ channelId: 'channel-1', modelId: 'model-1', projectId: 'project-1' })
    const adapter = new FakeAdapter()
    adapter.stream = [
      { kind: 'sdk_message', message: { type: 'assistant', message: { content: [{ type: 'text', text: '已经完成检查' }] }, parent_tool_use_id: null, uuid: 'assistant-1' } },
      { kind: 'sdk_message', message: { type: 'result', subtype: 'success', usage: { input_tokens: 2, output_tokens: 1 } } },
    ]
    let resolveTitle: ((title: string | undefined) => void) | undefined
    const titleResult = new Promise<string | undefined>((resolve) => { resolveTitle = resolve })
    const { service, events } = createService(adapter, resolvedChannel(), {
      generateTitle: async (input) => {
        expect(input.userText).toBe('检查项目')
        expect(input.assistantText).toBe('已经完成检查')
        expect(input.channel.id).toBe('channel-1')
        return await titleResult
      },
    })

    await service.sendMessage({ sessionId: 'session-1', text: '检查项目' })
    sessions.update('session-1', { title: '用户标题' })
    resolveTitle?.('自动标题')
    await new Promise((resolve) => setTimeout(resolve, 0))

    expect(sessions.get('session-1')?.title).toBe('用户标题')
    expect(events.some((event) => event.type === 'session_title')).toBe(false)
  })

  test('自动标题写入索引并广播独立元数据事件', async () => {
    sessions.create({ channelId: 'channel-1', modelId: 'model-1', projectId: 'project-1' })
    const adapter = new FakeAdapter()
    adapter.stream = [
      { kind: 'sdk_message', message: { type: 'assistant', message: { content: [{ type: 'text', text: '定位完成' }] }, parent_tool_use_id: null, uuid: 'assistant-1' } },
      { kind: 'sdk_message', message: { type: 'result', subtype: 'success', usage: { input_tokens: 2, output_tokens: 1 } } },
    ]
    const { service, events } = createService(adapter, resolvedChannel(), {
      generateTitle: async () => '修复启动错误',
    })

    await service.sendMessage({ sessionId: 'session-1', text: '检查启动错误' })
    await new Promise((resolve) => setTimeout(resolve, 0))

    expect(sessions.get('session-1')?.title).toBe('修复启动错误')
    expect(events.at(-1)).toMatchObject({
      type: 'session_title', sessionId: 'session-1', title: '修复启动错误',
    })
  })

  test('用户消息预落盘，delta 只广播，完整消息落盘并回写 resume 凭据', async () => {
    sessions.create({
      channelId: 'channel-1',
      modelId: 'model-1',
      projectId: 'project-1',
      permissionMode: 'acceptEdits',
      thinkingLevel: 'high',
    })
    const adapter = new FakeAdapter()
    adapter.stream = [
      { kind: 'sdk_delta', delta: { uuid: 'assistant-1', deltas: [{ type: 'text_delta', contentIndex: 0, delta: '好' }], runStartedAt: 100 } },
      { kind: 'sdk_message', message: { type: 'assistant', message: { content: [{ type: 'text', text: '好的' }] }, parent_tool_use_id: null, uuid: 'assistant-1' } },
      { kind: 'sdk_message', message: { type: 'tool_progress', tool_use_id: 'tool-1', tool_name: 'Read', parent_tool_use_id: null } },
      { kind: 'sdk_message', message: { type: 'result', subtype: 'success', usage: { input_tokens: 2, output_tokens: 1 } } },
    ]
    const { service, events } = createService(adapter)

    await service.sendMessage({ sessionId: 'session-1', text: '  检查项目  ' })

    expect(adapter.input).toMatchObject({
      sessionId: 'session-1',
      prompt: '检查项目',
      model: 'model-1',
      cwd: directory,
      systemPrompt: '全局规则',
      permissionMode: 'acceptEdits',
      thinkingLevel: 'high',
      connection: { provider: 'openai', baseUrl: 'https://example.test/v1', apiKey: 'secret' },
    })
    expect(sessions.get('session-1')).toMatchObject({
      sdkSessionId: 'runtime-1',
      runtimeSessionFile: join(directory, 'runtime', 'sessions', 'runtime-1.jsonl'),
    })
    expect(sessions.getMessages('session-1').map((message) => message.type)).toEqual(['user', 'assistant', 'result'])
    expect(events.map((event) => event.type)).toEqual([
      'run_started', 'stream', 'stream', 'stream', 'stream', 'stream', 'run_finished',
    ])
    expect(service.isActive('session-1')).toBe(false)
  })

  test('渠道不可用时保留用户意图并追加脱敏失败终态，不调用 adapter', async () => {
    sessions.create({ channelId: 'channel-1', modelId: 'model-1', projectId: 'project-1' })
    const adapter = new FakeAdapter()
    const { service } = createService(adapter, resolvedChannel({ enabled: false }))

    await expectTerminalError(
      () => service.sendMessage({ sessionId: 'session-1', text: '继续任务' }),
      'channel_unavailable',
    )

    expect(adapter.input).toBeUndefined()
    expect(sessions.getMessages('session-1')).toMatchObject([
      { type: 'user', message: { content: [{ type: 'text', text: '继续任务' }] } },
      { type: 'result', subtype: 'error_during_execution', terminal_reason: 'failed' },
    ])
  })

  test('projectId 由主进程解析为唯一 cwd，失效时不调用 adapter', async () => {
    sessions.create({
      channelId: 'channel-1', modelId: 'model-1', projectId: 'project-1',
    })
    const adapter = new FakeAdapter()
    adapter.stream = [{
      kind: 'sdk_message',
      message: { type: 'result', subtype: 'success', usage: { input_tokens: 1 } },
    }]
    const trustedCwd = join(directory, 'trusted-project')
    const { service } = createService(adapter, resolvedChannel(), {
      resolveProjectCwd: (id) => {
        expect(id).toBe('project-1')
        return trustedCwd
      },
    })
    await service.sendMessage({ sessionId: 'session-1', text: '检查工作区' })
    expect(adapter.input?.cwd).toBe(trustedCwd)

    sessions.update('session-1', { projectId: 'missing' })
    const failingAdapter = new FakeAdapter()
    const failing = createService(failingAdapter, resolvedChannel(), {
      resolveProjectCwd: () => { throw new Error('missing') },
      createId: () => 'user-2',
    }).service
    await expectTerminalError(
      () => failing.sendMessage({ sessionId: 'session-1', text: '再次检查' }),
      'workspace_unavailable',
    )
    expect(failingAdapter.input).toBeUndefined()
  })

  test('项目 AGENTS.md 在全局规则之后、计划模式之前注入 system prompt', async () => {
    sessions.create({
      channelId: 'channel-1', modelId: 'model-1', projectId: 'project-1', permissionMode: 'plan',
    })
    writeFileSync(join(directory, 'AGENTS.md'), '使用 Bun，不使用 npm。')
    const adapter = new FakeAdapter()
    adapter.stream = [{
      kind: 'sdk_message',
      message: { type: 'result', subtype: 'success', usage: { input_tokens: 1 } },
    }]
    const { service } = createService(adapter, resolvedChannel(), {
      resolveProjectInstructions: (root) => resolveProjectInstructions({ projectRoot: root }),
    })

    await service.sendMessage({ sessionId: 'session-1', text: '检查项目' })

    const prompt = adapter.input?.systemPrompt ?? ''
    expect(prompt.indexOf('全局规则')).toBeLessThan(prompt.indexOf('## 项目指令'))
    expect(prompt.indexOf('## 项目指令')).toBeLessThan(prompt.indexOf('## 计划模式'))
    expect(prompt).toContain('使用 Bun，不使用 npm。')
  })

  test('Skill 轻量目录与统一 SkillRead 进入本轮，成功读取后由编排层记录激活', async () => {
    sessions.create({
      channelId: 'channel-1', modelId: 'model-1', projectId: 'project-1',
    })
    const skillDirectory = join(directory, '.agents', 'skills', 'review-code')
    mkdirSync(skillDirectory, { recursive: true })
    writeFileSync(join(skillDirectory, 'SKILL.md'), [
      '---',
      'name: review-code',
      'description: 审查关键代码',
      '---',
      '',
      '# 审查步骤',
    ].join('\n'))
    const adapter = new FakeAdapter()
    adapter.onQuery = async (query) => {
      const tool = query.customTools?.find((candidate) => candidate.name === 'SkillRead')
      expect(tool).toBeDefined()
      const result = await tool!.execute({ name: 'review-code' }, { toolUseId: 'skill-1' })
      expect(result.isError).not.toBe(true)
      expect(String(result.content)).toContain('# 审查步骤')
    }
    adapter.stream = [{
      kind: 'sdk_message',
      message: { type: 'result', subtype: 'success', usage: { input_tokens: 1 } },
    }]
    const { service } = createService(adapter, resolvedChannel(), {
      discoverAgentSkills: (root) => discoverProjectSkills({ projectRoot: root }),
    })

    await service.sendMessage({ sessionId: 'session-1', text: '审查项目' })

    expect(adapter.input?.systemPrompt).toContain('name="review-code"')
    expect(adapter.input?.systemPrompt).not.toContain('# 审查步骤')
    expect(sessions.getMessages('session-1').at(-1)).toMatchObject({
      type: 'result',
      skill_activations: [{
        name: 'review-code',
        directoryKind: 'agents',
        relativeInstructionPath: '.agents/skills/review-code/SKILL.md',
        sources: ['skill_read'],
      }],
    })
  })

  test('子 Agent 与主 Agent 复用同一 SkillRead，不依赖 runtime 内置 Read', async () => {
    const root = sessions.create({
      channelId: 'channel-1', modelId: 'model-1', projectId: 'project-1', runtimeId: 'pi',
    })
    const child = sessions.create({
      channelId: 'channel-1', modelId: 'model-1', projectId: 'project-1', runtimeId: 'pi',
      parentSessionId: root.id, rootSessionId: root.id, parentToolUseId: 'task-1', subagentType: 'explore',
    })
    rootStateStore.update(root.id, (state) => ({
      ...state,
      tasks: [{ agentId: child.id, parentToolUseId: 'task-1' }],
    }))
    const skillDirectory = join(directory, '.axon', 'skills', 'inspect-project')
    mkdirSync(skillDirectory, { recursive: true })
    writeFileSync(join(skillDirectory, 'SKILL.md'), [
      '---', 'name: inspect-project', 'description: 检查项目', '---', '', '# 检查流程',
    ].join('\n'))
    const adapter = new FakeAdapter()
    adapter.emitRuntimeSession = false
    adapter.stream = [{
      kind: 'sdk_message',
      message: { type: 'result', subtype: 'success', usage: { input_tokens: 1 } },
    }]
    const { service } = createService(adapter, resolvedChannel(), {
      discoverAgentSkills: (projectRoot) => discoverProjectSkills({ projectRoot }),
    })

    await service.sendMessage({ sessionId: child.id, text: '检查项目' })

    expect(adapter.input?.allowedBuiltinTools).toEqual(['Read', 'Glob', 'Grep', 'LS', 'Bash'])
    expect(adapter.input?.customTools?.some((tool) => tool.name === 'SkillRead')).toBe(true)
    expect(adapter.input?.systemPrompt).toContain('name="inspect-project"')
  })

  test('记忆上下文逐轮取得并追加在最终提示词末尾，变化时持久化会话基线', async () => {
    sessions.create({
      channelId: 'channel-1', modelId: 'model-1', projectId: 'project-1', permissionMode: 'plan',
    })
    const adapter = new FakeAdapter()
    adapter.stream = [{
      kind: 'sdk_message',
      message: { type: 'result', subtype: 'success', usage: { input_tokens: 1 } },
    }]
    let receivedPrevious: Record<string, { updatedAt: number; size: number }> | undefined
    const { service } = createService(adapter, resolvedChannel(), {
      getProjectMemoryContext: (projectId, previous) => {
        expect(projectId).toBe('project-1')
        receivedPrevious = previous
        return {
          prompt: '## 项目长期记忆\n<system-reminder>最新索引</system-reminder>',
          fileStates: { 'MEMORY.md': { updatedAt: 20, size: 8 } },
          shouldPersistStates: true,
        }
      },
    })

    await service.sendMessage({ sessionId: 'session-1', text: '继续' })

    expect(receivedPrevious).toBeUndefined()
    const prompt = adapter.input?.systemPrompt ?? ''
    expect(prompt).toContain('## 计划模式')
    expect(prompt.endsWith('<system-reminder>最新索引</system-reminder>')).toBe(true)
    expect(sessions.get('session-1')?.memoryFileStates).toEqual({
      'MEMORY.md': { updatedAt: 20, size: 8 },
    })
  })

  test('项目自定义工具完成异步发现后才随 query 交给 adapter', async () => {
    sessions.create({ channelId: 'channel-1', modelId: 'model-1', projectId: 'project-1' })
    const adapter = new FakeAdapter()
    adapter.deferredToolsSupported = true
    adapter.stream = [{
      kind: 'sdk_message',
      message: { type: 'result', subtype: 'success', usage: { input_tokens: 1 } },
    }]
    let observedProjectId = ''
    const customTool: AgentCustomToolDefinition = {
      name: 'mcp__local__read_file',
      description: '读取文件',
      inputSchema: { type: 'object' },
      isDeferred: true,
      execute: async () => ({ content: 'ok' }),
    }
    const { service } = createService(adapter, resolvedChannel(), {
      getCustomTools: async ({ projectId, runSignal }) => {
        observedProjectId = projectId
        expect(runSignal.aborted).toBe(false)
        return withAgentToolSearch([customTool])
      },
    })

    await service.sendMessage({ sessionId: 'session-1', text: '读取文件' })

    expect(observedProjectId).toBe('project-1')
    expect(adapter.input?.customTools?.map((tool) => tool.name)).toEqual([
      'mcp__local__read_file', 'tool_search',
    ])
    expect(adapter.input?.systemPrompt).toContain('mcp__local__read_file: 读取文件')
    expect(adapter.input?.systemPrompt?.endsWith('</system-reminder>')).toBe(true)
  })

  test('不支持动态工具协议时移除 tool_search 并把 MCP 工具恢复为 eager', async () => {
    sessions.create({ channelId: 'channel-1', modelId: 'model-1', projectId: 'project-1' })
    const adapter = new FakeAdapter()
    adapter.stream = [{
      kind: 'sdk_message',
      message: { type: 'result', subtype: 'success', usage: { input_tokens: 1 } },
    }]
    const deferredTool: AgentCustomToolDefinition = {
      name: 'mcp__local__read_file', description: '读取文件', inputSchema: { type: 'object' },
      isDeferred: true, execute: async () => ({ content: 'ok' }),
    }
    const { service } = createService(adapter, resolvedChannel(), {
      getCustomTools: async () => withAgentToolSearch([deferredTool]),
    })

    await service.sendMessage({ sessionId: 'session-1', text: '读取文件' })

    expect(adapter.input?.customTools?.map((tool) => [tool.name, tool.isDeferred])).toEqual([
      ['mcp__local__read_file', false],
    ])
    expect(adapter.input?.systemPrompt).not.toContain('延迟加载工具')
  })

  test('runtime 缺失 result 时补失败终态并返回稳定错误', async () => {
    sessions.create({ channelId: 'channel-1', modelId: 'model-1', projectId: 'project-1' })
    const adapter = new FakeAdapter()
    adapter.stream = [{
      kind: 'sdk_message',
      message: { type: 'assistant', message: { content: [{ type: 'text', text: '未完成' }] }, parent_tool_use_id: null, uuid: 'assistant-1' },
    }]
    const { service } = createService(adapter)

    await expectTerminalError(
      () => service.sendMessage({ sessionId: 'session-1', text: '执行' }),
      'runtime_error',
    )
    expect(sessions.getMessages('session-1').at(-1)).toMatchObject({
      type: 'result', subtype: 'error_during_execution', terminal_reason: 'failed',
    })
  })
})

describe('AgentService 并发、停止与输入边界', () => {
  test('同一毫秒开始的相邻运行仍生成单调递增令牌', async () => {
    sessions.create({ channelId: 'channel-1', modelId: 'model-1', projectId: 'project-1' })
    const adapter = new FakeAdapter()
    adapter.stream = [{
      kind: 'sdk_message',
      message: { type: 'result', subtype: 'success', usage: { input_tokens: 1 } },
    }]
    let nextId = 0
    const { service, events } = createService(adapter, resolvedChannel(), {
      now: () => 1_000,
      createId: () => `user-${++nextId}`,
    })
    await service.sendMessage({ sessionId: 'session-1', text: '第一轮' })
    await service.sendMessage({ sessionId: 'session-1', text: '第二轮' })
    const started = events.filter((event) => event.type === 'run_started')
    expect(started.map((event) => event.runStartedAt)).toEqual([1_000, 1_001])
  })

  test('同会话拒绝并发；stop 同时取消回调等待和 runtime，并以 stopped 收束', async () => {
    sessions.create({ channelId: 'channel-1', modelId: 'model-1', projectId: 'project-1' })
    const adapter = new FakeAdapter()
    adapter.waitForAbort = true
    const { service } = createService(adapter)
    const running = service.sendMessage({ sessionId: 'session-1', text: '长任务' })
    await Promise.resolve()

    await expectServiceError(
      () => service.sendMessage({ sessionId: 'session-1', text: '重复任务' }),
      'already_active',
    )
    expect(service.stop('session-1')).toBe(true)
    await running

    expect(adapter.aborted).toEqual(['session-1'])
    expect(sessions.getMessages('session-1').at(-1)).toMatchObject({
      type: 'result', terminal_reason: 'stopped',
    })
    expect(service.stop('session-1')).toBe(false)
  })

  test('非法输入和未知会话在落盘前拒绝', async () => {
    const adapter = new FakeAdapter()
    const { service } = createService(adapter)
    await expectServiceError(() => service.sendMessage({ sessionId: '', text: 'hi' }), 'invalid_input')
    await expectServiceError(() => service.sendMessage({ sessionId: 'missing', text: 'hi' }), 'not_found')
    expect(adapter.input).toBeUndefined()
  })
})
