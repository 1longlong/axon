import { describe, expect, test } from 'bun:test'
import { createStore } from 'jotai/vanilla'
import type { AgentGenerationEvent, AgentProject, AgentSessionMeta, SDKMessage } from '@axon/shared'
import {
  AgentRendererController,
  agentStateAtom,
  createInitialAgentRendererState,
  reduceAgentGenerationEvent,
} from './agent-state'
import type { AgentRendererApi } from './agent-state'

function session(id = 'session-1', updatedAt = 1): AgentSessionMeta {
  return { id, runtimeId: 'pi', title: id, createdAt: 1, updatedAt }
}

function project(id = 'project-1', name = '项目'): AgentProject {
  return { id, name, slug: id, workspace: { kind: 'managed' }, memoryEnabled: false, createdAt: 1, updatedAt: 1 }
}

function assistant(text: string, uuid = 'assistant-1'): SDKMessage {
  return {
    type: 'assistant',
    message: { content: [{ type: 'text', text }] },
    parent_tool_use_id: null,
    uuid,
  }
}

const completion = {
  terminalReason: 'completed', resultSubtype: 'success' as const, stoppedByUser: false,
  usage: { input_tokens: 0, output_tokens: 0 }, completedAt: 11, durationMs: 1, persisted: true,
}

type WithoutRunIdentity<T> = T extends AgentGenerationEvent
  ? Omit<T, 'sessionId' | 'runStartedAt' | 'source'>
  : never

function event(
  value: WithoutRunIdentity<AgentGenerationEvent>,
  runStartedAt = 10,
): AgentGenerationEvent {
  return { ...value, sessionId: 'session-1', runStartedAt, source: 'renderer' } as AgentGenerationEvent
}

function createApi(overrides: Partial<AgentRendererApi> = {}): AgentRendererApi {
  return {
    listSessions: async () => [],
    listActiveRuns: async () => [],
    createSession: async () => session(),
    updateSession: async (id, input) => ({ ...session(id), ...(input.title ? { title: input.title } : {}) }),
    deleteSession: async (id) => session(id),
    getMessages: async () => [],
    send: async () => ({ success: true, disposition: 'started' }),
    stop: async () => false,
    respondAskUser: async () => false,
    respondExitPlan: async () => false,
    listQueuedMessages: async () => [],
    cancelQueuedMessage: async () => false,
    moveQueuedMessage: async () => false,
    onEvent: () => () => {},
    onQueueChanged: () => () => {},
    listProjects: async () => [],
    createProject: async (input) => project('project-1', input.name),
    updateProject: async (id, input) => project(id, input.name ?? '项目'),
    deleteProject: async (id) => project(id),
    pickLocalWorkspace: async () => ({ canceled: true }),
    listProjectDirectory: async (projectId) => ({ projectId, entries: [], truncated: false }),
    readProjectFile: async (projectId, relativePath) => ({
      projectId, relativePath, name: relativePath, size: 0, kind: 'text', content: '',
    }),
    watchProjectDirectory: async () => {},
    unwatchProjectDirectory: async () => {},
    onProjectDirectoryChanged: () => () => {},
    listProjectMemory: async (projectId) => ({ projectId, indexExists: false, totalBytes: 0, files: [] }),
    readProjectMemory: async (projectId, relativePath) => ({
      projectId, relativePath, content: '', size: 0, updatedAt: 1,
    }),
    writeProjectMemory: async (projectId, relativePath, content) => ({
      projectId, relativePath, content, size: content.length, updatedAt: 1,
    }),
    watchProjectMemory: async () => {},
    unwatchProjectMemory: async () => {},
    onProjectMemoryChanged: () => () => {},
    ...overrides,
  }
}

interface Deferred<T> { promise: Promise<T>; resolve(value: T): void }

function deferred<T>(): Deferred<T> {
  let settle: ((value: T) => void) | undefined
  return {
    promise: new Promise<T>((resolve) => { settle = resolve }),
    resolve: (value) => settle?.(value),
  }
}

describe('Agent renderer 运行事件 reducer', () => {
  test('同一工具的多个心跳不生成重复消息，结果与本轮终态会清除运行图标', () => {
    let state = reduceAgentGenerationEvent(createInitialAgentRendererState(), event({ type: 'run_started' }))
    const progress: SDKMessage = {
      type: 'tool_progress', tool_use_id: 'bash-1', tool_name: 'Bash', parent_tool_use_id: null,
    }
    for (let index = 0; index < 3; index += 1) {
      state = reduceAgentGenerationEvent(state, event({ type: 'stream', payload: { kind: 'sdk_message', message: progress } }))
    }
    expect(state.messagesBySession['session-1']).toBeUndefined()
    expect(state.activeToolUseIdsBySession['session-1']).toEqual(['bash-1'])
    state = reduceAgentGenerationEvent(state, event({
      type: 'stream', payload: { kind: 'sdk_message', message: {
        type: 'assistant', uuid: 'assistant-bash', parent_tool_use_id: null,
        message: { content: [{ type: 'tool_use', id: 'bash-1', name: 'Bash', input: { command: 'bun test' } }] },
      } },
    }))
    expect(state.messagesBySession['session-1']).toHaveLength(1)
    state = reduceAgentGenerationEvent(state, event({
      type: 'stream', payload: { kind: 'sdk_message', message: {
        type: 'user', parent_tool_use_id: null,
        message: { content: [{ type: 'tool_result', tool_use_id: 'bash-1', content: '通过' }] },
      } },
    }))
    expect(state.activeToolUseIdsBySession['session-1']).toEqual([])
    state = reduceAgentGenerationEvent(state, event({ type: 'run_finished', completion }))
    expect(state.activeToolUseIdsBySession['session-1']).toBeUndefined()
  })

  test('思考草稿收到完整 assistant 后停止运行图标', () => {
    let state = reduceAgentGenerationEvent(createInitialAgentRendererState(), event({ type: 'run_started' }))
    state = reduceAgentGenerationEvent(state, event({
      type: 'stream', payload: { kind: 'sdk_delta', delta: {
        uuid: 'thinking-1', deltas: [{ type: 'thinking_delta', contentIndex: 0, delta: '分析中' }],
      } },
    }))
    expect(state.streamingAssistantUuidBySession['session-1']).toBe('thinking-1')
    state = reduceAgentGenerationEvent(state, event({
      type: 'stream', payload: { kind: 'sdk_message', message: {
        type: 'assistant', uuid: 'thinking-1', parent_tool_use_id: null,
        message: { content: [{ type: 'thinking', thinking: '分析完成' }] },
      } },
    }))
    expect(state.streamingAssistantUuidBySession['session-1']).toBeUndefined()
  })

  test('压缩开始替换普通运行提示，压缩结束和本轮结束都会清理状态', () => {
    let state = reduceAgentGenerationEvent(createInitialAgentRendererState(), event({ type: 'run_started' }))
    state = reduceAgentGenerationEvent(state, event({
      type: 'stream', payload: {
        kind: 'compaction_status', status: { phase: 'started', reason: 'threshold' },
      },
    }))
    expect(state.compactionStatusBySession['session-1']).toEqual({ phase: 'started', reason: 'threshold' })
    state = reduceAgentGenerationEvent(state, event({
      type: 'stream', payload: {
        kind: 'compaction_status', status: { phase: 'finished', reason: 'threshold', result: 'success' },
      },
    }))
    expect(state.compactionStatusBySession['session-1']).toBeUndefined()

    state = reduceAgentGenerationEvent(state, event({
      type: 'stream', payload: {
        kind: 'compaction_status', status: { phase: 'started', reason: 'overflow' },
      },
    }))
    state = reduceAgentGenerationEvent(state, event({ type: 'run_finished', completion }))
    expect(state.compactionStatusBySession['session-1']).toBeUndefined()
  })

  test('标题事件不依赖活跃运行令牌，直接刷新会话索引', () => {
    const initial = { ...createInitialAgentRendererState(), sessions: [session()] }
    const updated = reduceAgentGenerationEvent(initial, {
      type: 'session_title', sessionId: 'session-1', runStartedAt: 10,
      title: '自动标题', updatedAt: 20,
    })

    expect(updated.sessions[0]).toMatchObject({ title: '自动标题', updatedAt: 20 })
    expect(updated.messagesBySession).toBe(initial.messagesBySession)
  })

  test('权限请求进入当前会话，答复或运行结束时清理', () => {
    let state = reduceAgentGenerationEvent(
      createInitialAgentRendererState(),
      event({ type: 'run_started' }),
    )
    state = reduceAgentGenerationEvent(state, event({
      type: 'permission_request',
      request: {
        requestId: 'request-1', sessionId: 'session-1', runStartedAt: 10,
        toolUseId: 'tool-1', toolName: 'Write', toolInput: { file_path: 'a' },
        description: '写入文件：a', dangerLevel: 'normal', allowAlways: true,
        createdAt: 10, expiresAt: 20,
      },
    }))
    expect(state.pendingPermissionsBySession['session-1']).toHaveLength(1)
    state = reduceAgentGenerationEvent(state, event({
      type: 'permission_resolved', requestId: 'request-1', behavior: 'allow', reason: 'response',
    }))
    expect(state.pendingPermissionsBySession['session-1']).toEqual([])
  })

  test('累计多类 delta，再由同 uuid 的完整消息原位替换草稿', () => {
    let state = { ...createInitialAgentRendererState(), sessions: [session()] }
    state = reduceAgentGenerationEvent(state, event({ type: 'run_started' }))
    state = reduceAgentGenerationEvent(state, event({
      type: 'stream',
      payload: {
        kind: 'sdk_delta',
        delta: {
          uuid: 'assistant-1',
          deltas: [
            { type: 'thinking_start', contentIndex: 0 },
            { type: 'thinking_delta', contentIndex: 0, delta: '分析' },
            { type: 'text_start', contentIndex: 1 },
            { type: 'text_delta', contentIndex: 1, delta: '正在' },
            { type: 'text_delta', contentIndex: 1, delta: '处理' },
            { type: 'toolcall_start', contentIndex: 2, toolCall: { id: 'call-1', name: 'read_file' } },
            { type: 'toolcall_delta', contentIndex: 2, delta: '{"path":"a"}' },
          ],
        },
      },
    }))
    expect(state.messagesBySession['session-1']).toEqual([expect.objectContaining({
      type: 'assistant',
      uuid: 'assistant-1',
      message: { content: [
        { type: 'thinking', thinking: '分析' },
        { type: 'text', text: '正在处理' },
        expect.objectContaining({ type: 'tool_use', name: 'read_file', argumentsText: '{"path":"a"}' }),
      ] },
    })])

    const complete = assistant('最终答案')
    state = reduceAgentGenerationEvent(state, event({
      type: 'stream', payload: { kind: 'sdk_message', message: complete },
    }))
    expect(state.messagesBySession['session-1']).toEqual([complete])
  })

  test('停止后忽略旧运行尾流，新运行不被旧 finished 清除', () => {
    let state = reduceAgentGenerationEvent(createInitialAgentRendererState(), event({ type: 'run_started' }, 10))
    state = reduceAgentGenerationEvent(state, event({ type: 'run_started' }, 20))
    const staleStream = reduceAgentGenerationEvent(state, event({
      type: 'stream', payload: { kind: 'sdk_message', message: assistant('旧消息') },
    }, 10))
    expect(staleStream).toBe(state)
    const staleFinished = reduceAgentGenerationEvent(state, event({ type: 'run_finished', completion }, 10))
    expect(staleFinished).toBe(state)
    expect(staleFinished.activeRunsBySession['session-1']).toBe(20)
    expect(reduceAgentGenerationEvent(state, event({ type: 'run_finished', completion }, 20)).activeRunsBySession)
      .toEqual({})
  })
})

describe('AgentRendererController preload 编排', () => {
  test('初始化先订阅再读取会话，清理后可重启', async () => {
    const order: string[] = []
    let subscriptions = 0
    const store = createStore()
    const controller = new AgentRendererController(createApi({
      onEvent: () => { order.push('subscribe'); subscriptions += 1; return () => {} },
      listSessions: async () => { order.push('list'); return [session('old', 1), session('new', 2)] },
    }), store)
    const cleanup = controller.start()
    await Promise.resolve()
    expect(order.slice(0, 2)).toEqual(['subscribe', 'list'])
    expect(store.get(agentStateAtom).sessions.map((item) => item.id)).toEqual(['new', 'old'])
    cleanup()
    controller.start()()
    expect(subscriptions).toBe(2)
  })

  test('事件使在途读取失效，run_finished 后以 JSONL 终态校准', async () => {
    const oldLoad = deferred<SDKMessage[]>()
    const complete = assistant('磁盘终态')
    let calls = 0
    let listener: ((incoming: AgentGenerationEvent) => void) | undefined
    const store = createStore()
    const controller = new AgentRendererController(createApi({
      onEvent: (callback) => { listener = callback; return () => {} },
      getMessages: () => (++calls === 1 ? oldLoad.promise : Promise.resolve([complete])),
    }), store)
    const cleanup = controller.start()
    const stale = controller.loadMessages('session-1')
    listener?.(event({ type: 'run_started' }))
    listener?.(event({
      type: 'stream',
      payload: { kind: 'sdk_delta', delta: { uuid: 'assistant-1', deltas: [
        { type: 'text_delta', contentIndex: 0, delta: '临时' },
      ] } },
    }))
    listener?.(event({ type: 'run_finished', completion }))
    oldLoad.resolve([assistant('过期')])
    await stale
    await Promise.resolve()
    expect(store.get(agentStateAtom).messagesBySession['session-1']).toEqual([complete])
    expect(store.get(agentStateAtom).activeRunsBySession).toEqual({})
    cleanup()
  })

  test('发送结束校准快照，CRUD 同步状态，传输异常不泄露细节', async () => {
    const complete = assistant('完成')
    const store = createStore()
    const controller = new AgentRendererController(createApi({
      listSessions: async () => [session('session-1', 20)],
      getMessages: async () => [complete],
    }), store)
    expect(await controller.send({ sessionId: 'session-1', text: '开始' })).toEqual({ success: true, disposition: 'started' })
    expect(store.get(agentStateAtom).messagesBySession['session-1']).toEqual([complete])
    const created = await controller.createSession({ title: '任务' })
    await controller.updateSession(created.id, { title: '更新' })
    expect(store.get(agentStateAtom).sessions.find((item) => item.id === created.id)?.title).toBe('更新')
    await controller.deleteSession(created.id)
    expect(store.get(agentStateAtom).sessions.some((item) => item.id === created.id)).toBe(false)

    const failing = new AgentRendererController(createApi({
      send: async () => { throw new Error('secret transport') },
      stop: async () => { throw new Error('closed') },
    }), store)
    expect(await failing.send({ sessionId: 'session-1', text: 'x' })).toMatchObject({
      success: false, code: 'internal_error',
    })
    expect(JSON.stringify(store.get(agentStateAtom))).not.toContain('secret transport')
    expect(await failing.stop('session-1')).toBe(false)
    expect(store.get(agentStateAtom).lastError?.message).toBe('停止 Agent 运行失败')
  })

  test('启动加载项目，项目 CRUD 保持同一状态快照', async () => {
    const store = createStore()
    const controller = new AgentRendererController(createApi({
      listProjects: async () => [project('project-2', '乙'), project('project-1', '甲')],
    }), store)
    const cleanup = controller.start()
    await Promise.resolve()
    expect(store.get(agentStateAtom).projects.map((item) => item.name)).toEqual(['甲', '乙'])
    const created = await controller.createProject({ name: '丙' })
    expect(store.get(agentStateAtom).projects.some((item) => item.id === created.id)).toBe(true)
    await controller.updateProject(created.id, { name: '丁' })
    expect(store.get(agentStateAtom).projects.find((item) => item.id === created.id)?.name).toBe('丁')
    await controller.deleteProject(created.id)
    expect(store.get(agentStateAtom).projects.some((item) => item.id === created.id)).toBe(false)
    cleanup()
  })

  test('原生目录选择区分用户取消与传输失败', async () => {
    const store = createStore()
    const canceled = new AgentRendererController(createApi(), store)
    expect(await canceled.pickLocalWorkspace()).toEqual({ canceled: true })
    expect(store.get(agentStateAtom).lastError).toBeNull()

    const failing = new AgentRendererController(createApi({
      pickLocalWorkspace: async () => { throw new Error('private path') },
    }), store)
    expect(await failing.pickLocalWorkspace()).toBeNull()
    expect(store.get(agentStateAtom).lastError).toEqual({
      scope: 'projects', message: '打开本地项目目录失败',
    })
    expect(JSON.stringify(store.get(agentStateAtom))).not.toContain('private path')
  })
})
