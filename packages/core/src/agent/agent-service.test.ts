import { afterEach, beforeEach, describe, expect, test } from 'bun:test'
import { mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type {
  AgentGenerationEvent,
  AgentProviderAdapter,
  AgentSandboxCapability,
  AgentCustomToolDefinition,
  AgentQueryInput,
  AgentStreamPayload,
  ResolvedChannel,
  SDKAssistantMessage,
  SDKToolResultBlock,
  SDKUserMessage,
  AgentImageCapability,
  AgentInputPart,
} from '@axon/shared'
import { AgentRuntimeCleanupError } from '@axon/shared'
import { AgentEventBus } from './agent-event-bus'
import { AgentService, AgentServiceError } from './agent-service'
import { resolveBackendAgentContext } from '../backend-agent-session-context'
import { AgentSessionManager, AgentSessionManagerError } from './agent-session-manager'
import { AgentRootStateStore } from './agent-root-state-store'
import {
  resolveProjectInstructions,
  type ProjectInstructionManifest,
} from '../project/project-instruction-resolver'
import { discoverProjectSkills, type AgentSkillCatalog } from '../project/project-skill-discovery'
import type { AgentMemoryContext } from '../memory/agent-memory-tools'
import type { AgentTitleGenerator } from './agent-title-generator'
import { withAgentToolSearch } from './agent-tool-search'
import { AgentAttachmentService } from './agent-attachment-service'
import { BackendClientRegistry } from '../backend-client-registry'
import { AgentInputSkills } from '../project/agent-input-skills'
import { buildRecoveryPrompt } from './agent-session-context-prompt'
import type { AgentAttachmentDraft, AgentAttachmentUpload } from '@axon/shared'

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
  imageCapability: AgentImageCapability = { support: 'unknown' }
  getImageCapability(): AgentImageCapability { return this.imageCapability }
  input?: AgentQueryInput
  aborted: string[] = []
  stream: AgentStreamPayload[] = []
  waitForAbort = false
  deferredToolsSupported = false
  sandboxCapability: AgentSandboxCapability = {
    supported: false,
    modes: [],
    sandboxedTools: [],
    limitation: 'runtimeToolDelegationUnavailable',
  }
  onQuery?: (input: AgentQueryInput) => void | Promise<void>
  emitRuntimeSession = true

  supportsDeferredTools(): boolean {
    return this.deferredToolsSupported
  }

  getSandboxCapability(): AgentSandboxCapability {
    return this.sandboxCapability
  }

  async *query(input: AgentQueryInput): AsyncIterable<AgentStreamPayload> {
    this.input = input
    await this.onQuery?.(input)
    if (this.emitRuntimeSession) {
      input.onRuntimeSession?.('runtime-1', join(directory, 'runtime', 'sessions', 'runtime-1.jsonl'))
    }
    if (this.waitForAbort) {
      // 信号可能在 onQuery 的异步边界期间取消；夹具同样遵守已取消信号立即收束的契约。
      if (input.abortSignal?.aborted) return
      await new Promise<void>((resolve) => input.abortSignal?.addEventListener('abort', () => resolve(), { once: true }))
      return
    }
    for (const payload of this.stream) yield payload
  }

  abort(sessionId: string): void {
    this.aborted.push(sessionId)
  }

  dispose(): void {}
  async drain(): Promise<void> {}
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
    getCustomTools?: (context: { workspacePath: string; runSignal: AbortSignal }) => Promise<AgentCustomToolDefinition[]>
    getProjectMemoryContext?: (
      projectId: string,
      previous: Record<string, { updatedAt: number; size: number }> | undefined,
    ) => AgentMemoryContext | undefined
    generateTitle?: AgentTitleGenerator
    resolveAdapter?: (runtimeId: 'pi' | 'zima') => AgentProviderAdapter
    validateRuntimeSession?: (session: { runtimeId: 'pi' | 'zima' }) => void | Promise<void>
    resolveChannel?: (id: string) => Promise<ResolvedChannel>
  } = {},
) {
  const eventBus = new AgentEventBus()
  const events: AgentGenerationEvent[] = []
  eventBus.subscribe((event) => events.push(event))
  const service = new AgentService({
    adapter,
    ...(overrides.resolveAdapter ? { resolveAdapter: overrides.resolveAdapter } : {}),
    ...(overrides.validateRuntimeSession ? { validateRuntimeSession: overrides.validateRuntimeSession } : {}),
    eventBus,
    sessionManager: sessions,
    channelManager: { resolve: overrides.resolveChannel ?? (async () => channel) },
    runtimeConfigDir: join(directory, 'runtime'),
    runtimeSessionDir: join(directory, 'runtime', 'sessions'),
    getSystemPrompt: () => '全局规则',
    resolveExecutionContext: (session) => resolveBackendAgentContext(session, { getSession: (id) => sessions.get(id),
      resolveProjectCwd: overrides.resolveProjectCwd ?? (() => directory) }),
    ...(overrides.resolveProjectInstructions
      ? { resolveProjectInstructions: overrides.resolveProjectInstructions }
      : {}),
    ...(overrides.discoverAgentSkills
      ? { discoverAgentSkills: overrides.discoverAgentSkills }
      : {}),
    ...(overrides.getCustomTools ? { getCustomTools: overrides.getCustomTools } : {}),
    ...(overrides.getProjectMemoryContext
      ? { getMemoryContext: (session) => session.projectId ? overrides.getProjectMemoryContext!(session.projectId, session.memoryFileStates) : undefined }
      : {}),
    ...(overrides.generateTitle ? { generateTitle: overrides.generateTitle } : {}),
    createId: overrides.createId ?? (() => 'user-1'),
    now: overrides.now ?? (() => 100),
  })
  return { service, events }
}

describe('Agent 附件请求编排', () => {
  test('混合顺序校验先于落盘/模型，重启使用原顺序和当时 Skill 正文', async () => {
    const session = sessions.create({ channelId: 'channel-1', modelId: 'model-1', projectId: 'project-1' })
    for (const name of ['first', 'second']) {
      const root = join(directory, '.axon', 'skills', name)
      mkdirSync(root, { recursive: true })
      writeFileSync(join(root, 'SKILL.md'), `---\nname: ${name}\ndescription: 顺序验证\n---\n原始-${name}`)
    }
    const skills = new AgentInputSkills(() => discoverProjectSkills({ projectRoot: realpathSync(directory) }))
    const clients = new BackendClientRegistry(), owner = clients.register()
    const attachments = new AgentAttachmentService({ attachmentsDir: join(directory, 'attachments'), clients, skills,
      getSession: (id) => sessions.get(id), getMessages: (id) => sessions.getMessages(id) })
    const adapter = new FakeAdapter()
    adapter.stream = [{ kind: 'sdk_message', message: { type: 'result', subtype: 'success' } }]
    const { service } = createService(adapter)
    let lease: ReturnType<AgentAttachmentService['takeDraft']> | undefined
    try {
      let draft = attachments.command(owner, { action: 'createDraft', sessionId: session.id }) as AgentAttachmentDraft
      for (const name of ['second', 'first']) draft = attachments.command(owner, { action: 'addSkill', draftId: draft.id,
        sourceId: skills.list(session).find((item) => item.name === name)!.sourceId }) as AgentAttachmentDraft
      const first = draft.attachments.find((item) => item.name === 'first')!.id
      const second = draft.attachments.find((item) => item.name === 'second')!.id
      const inputParts: AgentInputPart[] = [{ type: 'text', text: '前' }, { type: 'skill', attachmentId: first },
        { type: 'text', text: '中' }, { type: 'skill', attachmentId: second }, { type: 'text', text: '后' }]
      lease = attachments.takeDraft(owner, session.id, draft.id)
      for (const invalid of [undefined, inputParts.filter((part) => part.type !== 'skill'),
        [...inputParts, { type: 'skill' as const, attachmentId: first }],
        inputParts.map((part) => part.type === 'skill' ? { ...part, attachmentId: 'foreign' } : part)]) {
        await expectServiceError(() => service.sendMessage({ sessionId: session.id, text: '前中后', inputParts: invalid, attachmentDraftId: draft.id }, { attachmentLease: lease }), 'invalid_input')
        expect(sessions.getMessages(session.id)).toEqual([])
        expect(adapter.input).toBeUndefined()
      }
      await service.sendMessage({ sessionId: session.id, text: '前中后', inputParts, attachmentDraftId: draft.id }, { attachmentLease: lease })
      expect(adapter.input?.prompt).toStartWith(`前【Skill ${JSON.stringify({ attachmentId: first, name: 'first' })}】中【Skill ${JSON.stringify({ attachmentId: second, name: 'second' })}】后`)
      writeFileSync(join(directory, '.axon', 'skills', 'first', 'SKILL.md'), '后续修改，不得改写历史')
      const restarted = new AgentSessionManager({ indexPath: join(directory, 'agent-sessions.json'), sessionsDir: join(directory, 'messages') })
      const users = restarted.getMessages(session.id).filter((item): item is SDKUserMessage => item.type === 'user')
      expect(users[0]?.inputParts).toEqual(inputParts)
      expect(users[0]?.message?.content).toEqual([{ type: 'text', text: '前中后' }])
      const recovery = buildRecoveryPrompt(users)
      expect(recovery).toContain(`前【Skill ${JSON.stringify({ attachmentId: first, name: 'first' })}】中`)
      expect(recovery).toContain('原始-first')
      expect(recovery).not.toContain('后续修改，不得改写历史')
    } finally { lease?.settle(); service.dispose(); await service.drain(); attachments.dispose(); await attachments.drain(); clients.dispose() }
  })
  test('仅显式 Skill 输入只落一条用户消息，正文不进 system，不伪造 SkillRead', async () => {
    const session = sessions.create({ channelId: 'channel-1', modelId: 'model-1', projectId: 'project-1' })
    const skillRoot = join(directory, '.axon', 'skills', 'selected')
    mkdirSync(skillRoot, { recursive: true }); writeFileSync(join(skillRoot, 'SKILL.md'), '---\nname: selected\ndescription: 本轮指引\n---\n# 明确选择的正文')
    const inputSkills = new AgentInputSkills(() => discoverProjectSkills({ projectRoot: realpathSync(directory) }))
    const clients = new BackendClientRegistry(), owner = clients.register()
    const attachments = new AgentAttachmentService({ attachmentsDir: join(directory, 'attachments'), clients, skills: inputSkills,
      getSession: (id) => sessions.get(id), getMessages: (id) => sessions.getMessages(id) })
    const adapter = new FakeAdapter()
    adapter.stream = [{ kind: 'sdk_message', message: { type: 'result', subtype: 'success', usage: {} } }]
    const { service } = createService(adapter, resolvedChannel(), { discoverAgentSkills: (root) => discoverProjectSkills({ projectRoot: root }) })
    let lease: ReturnType<AgentAttachmentService['takeDraft']> | undefined
    try {
      const draft = attachments.command(owner, { action: 'createDraft', sessionId: session.id }) as AgentAttachmentDraft
      const choice = inputSkills.list(session)[0]!
      const selected = attachments.command(owner, { action: 'addSkill', draftId: draft.id, sourceId: choice.sourceId }) as AgentAttachmentDraft
      lease = attachments.takeDraft(owner, session.id, draft.id)
      const inputParts = [{ type: 'skill' as const, attachmentId: selected.attachments[0]!.id }]
      await service.sendMessage({ sessionId: session.id, text: '', inputParts, attachmentDraftId: draft.id }, { attachmentLease: lease })
      const history = sessions.getMessages(session.id), users = history.filter((message) => message.type === 'user') as SDKUserMessage[]
      expect(users).toHaveLength(1); expect(users[0]?.message?.content).toEqual([{ type: 'text', text: '' }])
      expect(users[0]?.attachmentContext).toContain('# 明确选择的正文')
      expect(adapter.input?.prompt).toContain('<skill>'); expect(adapter.input?.systemPrompt).not.toContain('# 明确选择的正文')
      expect(history.some((message) => message.type === 'assistant')).toBe(false)
      expect(history.at(-1)).toMatchObject({ type: 'result', skill_activations: [{ name: 'selected', sources: ['explicit'] }] })
      expect(users[0]?.explicitSkillActivations?.[0]?.sources).toEqual(['explicit'])
      expect(users[0]?.inputParts).toEqual(inputParts)
    } finally { lease?.settle(); service.dispose(); await service.drain(); attachments.dispose(); await attachments.drain(); clients.dispose() }
  })
  test('图片未知确认与已知拒绝都在用户落盘前校验，成功才传中立图片', async () => {
    const session = sessions.create({ channelId: 'channel-1', modelId: 'model-1', projectId: 'project-1' })
    const clients = new BackendClientRegistry(), owner = clients.register()
    const attachments = new AgentAttachmentService({ attachmentsDir: join(directory, 'attachments'), clients,
      getSession: (id) => sessions.get(id), prepareImage: async () => ({ bytes: Buffer.from('prepared'), originalMediaType: 'image/png', mediaType: 'image/png', width: 1, height: 1,
        thumbnail: { bytes: Buffer.from('thumb'), width: 1, height: 1 } }) })
    const adapter = new FakeAdapter(); adapter.stream = [{ kind: 'sdk_message', message: { type: 'result', subtype: 'success', usage: {} } }]
    const { service } = createService(adapter)
    const draft = attachments.command(owner, { action: 'createDraft', sessionId: session.id }) as AgentAttachmentDraft
    const pending = attachments.command(owner, { action: 'beginUpload', draftId: draft.id, kind: 'image', name: 'image.png', mediaType: 'image/png', size: 1 }) as AgentAttachmentUpload
    attachments.command(owner, { action: 'uploadChunk', uploadId: pending.id, offset: 0, data: 'eA==' })
    await attachments.command(owner, { action: 'finishUpload', uploadId: pending.id })
    let lease: ReturnType<AgentAttachmentService['takeDraft']> | undefined
    try {
      for (const support of ['unsupported', 'unknown'] as const) {
        adapter.imageCapability = { support }; lease = attachments.takeDraft(owner, session.id, draft.id)
        await expectServiceError(() => service.sendMessage({ sessionId: session.id, text: '看图', attachmentDraftId: draft.id }, { attachmentLease: lease }), 'invalid_input')
        expect(sessions.getMessages(session.id)).toEqual([]); expect(adapter.input).toBeUndefined()
        lease.settle()
      }
      lease = attachments.takeDraft(owner, session.id, draft.id)
      await service.sendMessage({ sessionId: session.id, text: '  看图\n', attachmentDraftId: draft.id,
        imageModelConsent: { channelId: 'channel-1', modelId: 'model-1' } }, { attachmentLease: lease })
      expect(adapter.input?.images).toEqual([{ attachmentId: pending.id, data: Buffer.from('prepared').toString('base64'), mediaType: 'image/png' }])
      const user = sessions.getMessages(session.id)[0] as SDKUserMessage
      expect(user.message?.content).toEqual([{ type: 'text', text: '  看图\n' }])
      expect(user.imageModelSelection).toEqual({ channelId: 'channel-1', modelId: 'model-1' })
      expect(JSON.stringify(user)).not.toContain(Buffer.from('prepared').toString('base64'))
    } finally { lease?.settle(); service.dispose(); await service.drain(); attachments.dispose(); await attachments.drain(); clients.dispose() }
  })
})

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
  test('宿主能力失效时持久化明确错误，模型和原生工具均不启动', async () => {
    for (const limitation of ['hostExecutorUnavailable', 'platformUnsupported'] as const) {
      const session = sessions.create({ channelId: 'channel-1', modelId: 'model-1', projectId: 'project-1' })
      const adapter = new FakeAdapter()
      adapter.sandboxCapability = { supported: false, modes: [], sandboxedTools: [], limitation }
      const outcome = await createService(adapter).service.sendMessage({ sessionId: session.id, text: '运行' })
      expect(adapter.input).toBeUndefined()
      expect(outcome.result).toMatchObject({
        type: 'result', subtype: 'error_during_execution', error: {
          code: 'sandbox_unavailable', retryable: false, message: expect.stringContaining('不会切换为无沙箱执行'),
        },
      })
      expect(sessions.getMessages(session.id)).toHaveLength(2)
      expect(sessions.getMessages(session.id).at(-1)).toMatchObject({ error: { code: 'sandbox_unavailable' } })
    }
  })

  test('已有 explore/plan 会话逐轮收紧为真正只读，Bash 只在明确受保护时提供', async () => {
    for (const role of ['explore', 'plan'] as const) {
      const root = sessions.create({ channelId: 'channel-1', modelId: 'model-1', projectId: 'project-1' })
      const child = sessions.create({
        channelId: 'channel-1', modelId: 'model-1', projectId: 'project-1', sandboxMode: 'workspaceWrite',
        parentSessionId: root.id, rootSessionId: root.id, parentToolUseId: `task-${role}`, subagentType: role,
      })
      rootStateStore.update(root.id, (state) => ({ ...state, tasks: [{ agentId: child.id, parentToolUseId: `task-${role}` }] }))
      const adapter = new FakeAdapter()
      adapter.sandboxCapability = { supported: true, modes: ['readOnly', 'workspaceWrite'], sandboxedTools: ['bash', 'read', 'write'] }
      adapter.emitRuntimeSession = false
      adapter.stream = [{ kind: 'sdk_message', message: { type: 'result', subtype: 'success', usage: { input_tokens: 0 } } }]
      let nextMessage = 0
      const { service } = createService(adapter, resolvedChannel(), { createId: () => `${role}-${++nextMessage}` })
      await service.sendMessage({ sessionId: child.id, text: '检查' })
      expect(adapter.input?.executionPolicy?.sandboxMode).toBe('readOnly')
      expect(adapter.input?.sandboxPolicy).toMatchObject({ mode: 'readOnly', writableRoots: [] })
      expect(adapter.input?.allowedBuiltinTools).toEqual(['Read', 'Glob', 'Grep', 'LS', ...(role === 'explore' ? ['Bash'] : [])])
      adapter.sandboxCapability = { supported: false, modes: [], sandboxedTools: [], limitation: 'runtimeToolDelegationUnavailable' }
      await service.sendMessage({ sessionId: child.id, text: '再次检查' })
      expect(adapter.input?.sandboxPolicy).toBeUndefined()
      expect(adapter.input?.allowedBuiltinTools).not.toContain('Bash')
    }
  })

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
      sandboxMode: 'workspaceWrite',
      approvalPolicy: 'onRequest',
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
      prompt: '  检查项目  ',
      model: 'model-1',
      cwd: directory,
      systemPrompt: '全局规则',
      executionPolicy: {
        sandboxMode: 'workspaceWrite',
        approvalPolicy: 'onRequest', approvalReviewer: 'user',
      },
      thinkingLevel: 'high',
      connection: { provider: 'openai', baseUrl: 'https://example.test/v1', apiKey: 'secret' },
    })
    expect(adapter.input?.sandboxPolicy).toBeUndefined()
    expect(sessions.get('session-1')).toMatchObject({
      sdkSessionId: 'runtime-1',
      runtimeSessionFile: join(directory, 'runtime', 'sessions', 'runtime-1.jsonl'),
    })
    expect(sessions.getMessages('session-1').map((message) => message.type)).toEqual(['user', 'assistant', 'result'])
    expect(sessions.getMessages('session-1')[0]).toMatchObject({ message: { content: [{ type: 'text', text: '  检查项目  ' }] } })
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

  test('runtime 明确接管部分工具时也接收策略，但能力仍不能标记完整支持', async () => {
    sessions.create({
      channelId: 'channel-1', modelId: 'model-1', projectId: 'project-1',
      sandboxMode: 'workspaceWrite',
    })
    const adapter = new FakeAdapter()
    adapter.sandboxCapability = {
      supported: false,
      modes: ['readOnly', 'workspaceWrite'],
      sandboxedTools: ['bash'],
      limitation: 'partialToolDelegation',
    }
    adapter.stream = [{
      kind: 'sdk_message',
      message: { type: 'result', subtype: 'success', usage: { input_tokens: 1 } },
    }]
    const { service } = createService(adapter)

    await service.sendMessage({ sessionId: 'session-1', text: '检查沙箱策略' })
    const canonicalDirectory = realpathSync(directory)

    expect(adapter.input?.sandboxPolicy).toEqual({
      platform: 'macos',
      mode: 'workspaceWrite',
      sandboxCwd: canonicalDirectory,
      readAccess: { type: 'fullAccess' },
      writableRoots: [canonicalDirectory],
      protectedReadOnlyRoots: [
        join(canonicalDirectory, '.git'),
        join(canonicalDirectory, '.axon'),
        join(canonicalDirectory, '.agents'),
      ],
      networkAccess: false,
    })
  })

  test('项目 AGENTS.md 在全局规则之后注入 system prompt', async () => {
    sessions.create({
      channelId: 'channel-1', modelId: 'model-1', projectId: 'project-1',
      sandboxMode: 'readOnly', approvalPolicy: 'onRequest',
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

    expect(adapter.input?.allowedBuiltinTools).toEqual(['Read', 'Glob', 'Grep', 'LS'])
    expect(adapter.input?.customTools?.some((tool) => tool.name === 'SkillRead')).toBe(true)
    expect(adapter.input?.systemPrompt).toContain('name="inspect-project"')
  })

  test('记忆上下文逐轮取得并追加在最终提示词末尾，变化时持久化会话基线', async () => {
    sessions.create({
      channelId: 'channel-1', modelId: 'model-1', projectId: 'project-1',
      sandboxMode: 'readOnly', approvalPolicy: 'onRequest',
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
    let observedWorkspacePath: string | undefined
    const customTool: AgentCustomToolDefinition = {
      name: 'mcp__local__read_file',
      description: '读取文件',
      inputSchema: { type: 'object' },
      isDeferred: true,
      execute: async () => ({ content: 'ok' }),
    }
    const { service } = createService(adapter, resolvedChannel(), {
      getCustomTools: async ({ workspacePath, runSignal }) => {
        observedWorkspacePath = workspacePath
        expect(runSignal.aborted).toBe(false)
        return withAgentToolSearch([customTool])
      },
    })

    await service.sendMessage({ sessionId: 'session-1', text: '读取文件' })

    expect(observedWorkspacePath).toBe(directory)
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
  test('Pi/Zima 中立链保存停止前部分内容，既有真实工具回传优先，其余未知；重建历史可恢复', async () => {
    for (const runtimeId of ['pi', 'zima'] as const) {
      const session = sessions.create({ runtimeId, channelId: 'channel-1', modelId: 'model-1', projectId: 'project-1' })
      class InterruptedAdapter extends FakeAdapter {
        override async *query(): AsyncIterable<AgentStreamPayload> {
          yield { kind: 'sdk_message', message: {
            type: 'assistant', uuid: `calls-${runtimeId}`, parent_tool_use_id: null, message: { content: ['done', 'late', 'unknown'].map((id) => ({
              type: 'tool_use', id, name: 'Bash', input: { command: 'pwd' },
            })) },
          } }
          yield { kind: 'sdk_message', message: { type: 'user', parent_tool_use_id: null, message: { content: [{
            type: 'tool_result', tool_use_id: 'done', content: '停止前真实结果',
          }] } } }
          yield { kind: 'sdk_delta', delta: { uuid: `partial-${runtimeId}`, deltas: [
            { type: 'thinking_delta', contentIndex: 0, delta: '先思考' },
            { type: 'text_delta', contentIndex: 1, delta: ' 部分回复\n' },
            { type: 'toolcall_delta', contentIndex: 2, delta: '{"command":"不要执行', toolCall: { id: 'half', name: 'Bash' } },
            { type: 'thinking_delta', contentIndex: 3, delta: '后思考' },
          ] } }
          service.stop(session.id)
          yield { kind: 'sdk_delta', delta: { uuid: `partial-${runtimeId}`, deltas: [{ type: 'text_delta', contentIndex: 1, delta: '迟到文字' }] } }
          yield { kind: 'sdk_message', message: { type: 'assistant', parent_tool_use_id: null, message: { content: [{ type: 'text', text: '迟到完整消息' }] } } }
          yield { kind: 'sdk_message', message: { type: 'user', parent_tool_use_id: null, message: { content: [
            { type: 'text', text: '迟到用户文本' }, { type: 'tool_result', tool_use_id: 'old', content: '旧轮结果' },
            { type: 'tool_result', tool_use_id: 'late', content: '取消期间真实完成', is_error: false },
          ] } } }
          yield { kind: 'sdk_message', message: { type: 'result', subtype: 'success', usage: { input_tokens: 1 } } }
        }
      }
      const adapter = new InterruptedAdapter()
      let messageId = 0
      const { service, events } = createService(adapter, resolvedChannel(), { resolveAdapter: () => adapter, createId: () => `${runtimeId}-${++messageId}` })
      const outcome = await service.sendMessage({ sessionId: session.id, text: '执行任务' })
      expect(outcome.result.terminal_reason).toBe('stopped')
      const manager = new AgentSessionManager({ indexPath: join(directory, 'agent-sessions.json'), sessionsDir: join(directory, 'messages'), stateStore: rootStateStore })
      const history = manager.getMessages(session.id)
      const partial = history.find((message) => message.type === 'assistant' && (message as SDKAssistantMessage).isPartial) as SDKAssistantMessage
      expect(partial.uuid).toBe(`partial-${runtimeId}`)
      expect(partial.message.content).toEqual([
        { type: 'thinking', thinking: '先思考' }, { type: 'text', text: ' 部分回复\n' }, { type: 'thinking', thinking: '后思考' },
      ])
      const results = history.filter((message) => message.type === 'user').flatMap((message) => (message as SDKUserMessage).message?.content ?? [])
        .filter((block): block is SDKToolResultBlock => block.type === 'tool_result')
      expect(results).toHaveLength(3)
      expect(results.find((block) => block.tool_use_id === 'done')?.content).toBe('停止前真实结果')
      expect(results.find((block) => block.tool_use_id === 'late')).toMatchObject({ content: '取消期间真实完成', is_error: false })
      expect(results.find((block) => block.tool_use_id === 'unknown')).toMatchObject({ execution_status: 'unknown', is_error: true })
      expect(JSON.stringify(history)).not.toContain('迟到')
      expect(JSON.stringify(history)).not.toContain('不要执行')
      expect(history.at(-1)?.type).toBe('result')
      expect(history.filter((message) => message.type === 'result')).toHaveLength(1)
      expect(events.filter((event) => event.type === 'stream' && event.payload.kind === 'sdk_message' && (event.payload.message as SDKAssistantMessage).isPartial)).toHaveLength(1)
    }
  })

  test('无 result 的取消/清理故障也保存部分正文；落盘失败不报告已保存停止', async () => {
    for (const failure of ['abort', 'cleanup', 'persistence'] as const) {
      const session = sessions.create({ channelId: 'channel-1', modelId: 'model-1', projectId: 'project-1' })
      class PartialAdapter extends FakeAdapter {
        override async *query(): AsyncIterable<AgentStreamPayload> {
          yield { kind: 'sdk_delta', delta: { uuid: `draft-${failure}`, deltas: [{ type: 'text_delta', contentIndex: 0, delta: '部分正文' }] } }
          service.stop(session.id)
          if (failure === 'cleanup') throw new AgentRuntimeCleanupError()
          throw new DOMException('取消', 'AbortError')
        }
      }
      const { service, events } = createService(new PartialAdapter())
      const originalAppend = sessions.appendMessage.bind(sessions)
      if (failure === 'persistence') sessions.appendMessage = (id, message) => {
        if (message.type === 'assistant') throw new AgentSessionManagerError('storage_error', '测试保存失败')
        return originalAppend(id, message)
      }
      try {
        if (failure === 'persistence') await expectServiceError(() => service.sendMessage({ sessionId: session.id, text: '任务' }), 'persistence_error')
        else await service.sendMessage({ sessionId: session.id, text: '任务' })
      } finally { sessions.appendMessage = originalAppend }
      const history = sessions.getMessages(session.id)
      const finished = events.find((event) => event.type === 'run_finished')
      expect(finished).toMatchObject({ completion: { persisted: failure !== 'persistence' } })
      if (failure === 'persistence') expect(history.filter((message) => message.type === 'result')).toHaveLength(0)
      else {
        expect(history.at(-2)).toMatchObject({ type: 'assistant', isPartial: true, message: { content: [{ type: 'text', text: '部分正文' }] } })
        expect(history.at(-1)).toMatchObject({ terminal_reason: failure === 'cleanup' ? 'failed' : 'stopped' })
      }
    }
  })
  test('用户取消不能覆盖 adapter 清理故障；提前 result 的故障也阻止可继续完成包', async () => {
    for (const earlyResult of [false, true]) {
      const session = sessions.create({ channelId: 'channel-1', modelId: 'model-1', projectId: 'project-1' })
      const adapter = new FakeAdapter()
      const { service, events } = createService(adapter)
      adapter.query = async function* () {
        service.stop(session.id)
        if (earlyResult) yield { kind: 'sdk_message', message: { type: 'result', subtype: 'success', usage: { input_tokens: 1 } } }
        throw new AgentRuntimeCleanupError()
      }
      if (earlyResult) await expect(service.sendMessage({ sessionId: session.id, text: '暂停任务' })).rejects.toMatchObject({ code: 'runtime_error' })
      else await service.sendMessage({ sessionId: session.id, text: '暂停任务' })
      const finished = events.findLast((event) => event.type === 'run_finished')
      expect(finished).toMatchObject({ completion: {
        terminalReason: 'failed', error: { code: 'runtime_cleanup_failed', retryable: false },
        stoppedByUser: false, persisted: !earlyResult,
      } })
      expect(sessions.getMessages(session.id).filter((message) => message.type === 'result')).toHaveLength(1)
    }
  })

  test('停止落盘后重建服务，Pi/Zima 下一轮获得中断提醒；原输入不重投且完成后不再提醒', async () => {
    let nextMessage = 0
    for (const runtimeId of ['pi', 'zima'] as const) {
      const session = sessions.create({ runtimeId, channelId: 'channel-1', modelId: 'model-1', projectId: 'project-1' })
      const adapter = new FakeAdapter()
      adapter.waitForAbort = true
      // 分别覆盖有 Runtime 引用和无引用的中立背景；夹具不执行真实 SDK/模型。
      adapter.emitRuntimeSession = runtimeId === 'pi'
      let entered!: () => void
      const ready = new Promise<void>((resolve) => { entered = resolve })
      adapter.onQuery = () => { entered() }
      const options = { resolveAdapter: () => adapter, createId: () => `pause-${++nextMessage}` }
      const original = createService(adapter, resolvedChannel(), options).service
      const running = original.sendMessage({ sessionId: session.id, text: '原任务只投递一次' })
      await ready
      expect(adapter.input?.systemPrompt).not.toContain('上一轮执行被用户停止')
      expect(original.stop(session.id)).toBe(true)
      await running
      await original.drain()

      // 新实例重新读取磁盘，提醒来源是应用 JSONL，而非旧服务的内存取消标志。
      sessions = new AgentSessionManager({
        indexPath: join(directory, 'agent-sessions.json'), sessionsDir: join(directory, 'messages'),
        stateStore: new AgentRootStateStore(join(directory, 'messages')),
      })
      adapter.waitForAbort = false
      adapter.onQuery = undefined
      adapter.stream = [{ kind: 'sdk_message', message: { type: 'result', subtype: 'success', usage: { input_tokens: 1 } } }]
      const resumed = createService(adapter, resolvedChannel(), options).service
      await resumed.sendMessage({ sessionId: session.id, text: '继续剩余工作' })
      expect(adapter.input?.prompt).toBe('继续剩余工作')
      expect(adapter.input?.systemPrompt).toStartWith('全局规则')
      expect(adapter.input?.systemPrompt).toContain('上一轮执行被用户停止')
      expect(adapter.input?.systemPrompt).not.toContain('原任务只投递一次')
      expect(adapter.input?.resumeSessionId).toBe(runtimeId === 'pi' ? 'runtime-1' : undefined)
      const originalInputs = sessions.getMessages(session.id).filter((message) => message.type === 'user'
        && JSON.stringify(message).includes('原任务只投递一次'))
      expect(originalInputs).toHaveLength(1)

      await resumed.sendMessage({ sessionId: session.id, text: '新的任务' })
      expect(adapter.input?.systemPrompt).not.toContain('上一轮执行被用户停止')
    }
  })

  test('异步运行条件校验期间可停止、拒绝重复运行，失败清理还会释放空闲等待者', async () => {
    sessions.create({ channelId: 'channel-1', modelId: 'model-1', projectId: 'project-1' })
    let finish: () => void = () => { throw new Error('校验未启动') }
    const delayed = new Promise<void>((resolve) => { finish = resolve })
    const adapter = new FakeAdapter()
    const { service, events } = createService(adapter, resolvedChannel(), {
      validateRuntimeSession: () => delayed,
    })
    const pending = service.sendMessage({ sessionId: 'session-1', text: '执行' })
    const idle = service.waitUntilIdle('session-1')
    expect(service.isActive('session-1')).toBe(true)
    await expect(service.sendMessage({ sessionId: 'session-1', text: '重复' })).rejects.toMatchObject({ code: 'already_active' })
    expect(service.stop('session-1')).toBe(true)
    await expect(pending).rejects.toMatchObject({ code: 'runtime_error' })
    await idle
    finish()
    expect(adapter.input).toBeUndefined()
    expect(service.isActive('session-1')).toBe(false)
    expect(sessions.getMessages('session-1')).toEqual([])
    expect(events).toEqual([])
  })

  test('用户消息落盘后的渠道解密可被取消，不调用模型并持久化唯一 stopped 终态', async () => {
    sessions.create({ channelId: 'channel-1', modelId: 'model-1', projectId: 'project-1' })
    let finish: (value: ResolvedChannel) => void = () => { throw new Error('解密未启动') }
    const delayed = new Promise<ResolvedChannel>((resolve) => { finish = resolve })
    let entered: () => void = () => { throw new Error('解密未启动') }
    const ready = new Promise<void>((resolve) => { entered = resolve })
    const adapter = new FakeAdapter()
    const { service } = createService(adapter, resolvedChannel(), {
      resolveChannel: () => { entered(); return delayed },
    })
    const pending = service.sendMessage({ sessionId: 'session-1', text: '执行' })
    await ready
    expect(service.stop('session-1')).toBe(true)
    const outcome = await pending
    finish(resolvedChannel())
    expect(outcome.result.terminal_reason).toBe('stopped')
    expect(adapter.input).toBeUndefined()
    expect(sessions.getMessages('session-1').map((message) => message.type)).toEqual(['user', 'result'])
    expect(service.isActive('session-1')).toBe(false)
  })

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

  test('自动审批执行器未接入时在落盘前失败关闭', async () => {
    sessions.create({
      channelId: 'channel-1', modelId: 'model-1', projectId: 'project-1',
      approvalReviewer: 'autoReview',
    })
    const adapter = new FakeAdapter()
    const { service } = createService(adapter)
    await expectServiceError(
      () => service.sendMessage({ sessionId: 'session-1', text: '执行修改' }),
      'runtime_error',
    )
    expect(sessions.getMessages('session-1')).toEqual([])
    expect(adapter.input).toBeUndefined()
  })
})
