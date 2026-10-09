import { afterEach, describe, expect, spyOn, test } from 'bun:test'
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type { AgentCustomToolDefinition, AgentProviderAdapter, AgentQueryInput, AgentStreamPayload, AgentTaskEvent } from '@axon/shared'
import { createBackend, createBackendPaths, writeTextFileAtomic } from './index'
import type { AxonBackend, BackendOptions, BackendPaths, ProviderStreamRequest } from './index'
import { createFixtureCredentialCodec } from '../test-support/credential-codec'

const directories: string[] = []
const backends: AxonBackend[] = []
afterEach(() => {
  for (const backend of backends.splice(0)) backend.dispose()
  for (const directory of directories.splice(0)) rmSync(directory, { recursive: true, force: true })
})

class ScriptedAdapter implements AgentProviderAdapter {
  readonly inputs: AgentQueryInput[] = []
  readonly released: string[] = []
  disposals = 0
  handler: (input: AgentQueryInput) => AsyncIterable<AgentStreamPayload> = async function* () { yield* success('完成') }
  query(input: AgentQueryInput): AsyncIterable<AgentStreamPayload> {
    this.inputs.push(input)
    return this.handler(input)
  }
  abort(): void {}
  releaseSession(id: string): void { this.released.push(id) }
  dispose(): void { this.disposals += 1 }
  async drain(): Promise<void> {}
}

async function* success(text: string): AsyncIterable<AgentStreamPayload> {
  yield { kind: 'sdk_message', message: {
    type: 'assistant', message: { content: [{ type: 'text', text }] }, parent_tool_use_id: null,
  } }
  yield { kind: 'sdk_message', message: { type: 'result', subtype: 'success' } }
}

function isolatedPaths(): BackendPaths {
  const directory = mkdtempSync(join(tmpdir(), 'axon-backend-factory-'))
  directories.push(directory)
  return createBackendPaths({ dataDir: join(directory, 'data'), homeDir: directory })
}

function open(paths: BackendPaths, adapter: ScriptedAdapter, overrides: Partial<BackendOptions> = {}) {
  const backend = createBackend({ paths, applicationVersion: '0.1.3',
    credentialCodec: createFixtureCredentialCodec(), resolveAdapter: () => adapter,
    ...overrides,
  })
  backends.push(backend)
  return { backend }
}

async function prepare(backend: AxonBackend) {
  const channel = await backend.channels.create({ name: '隔离渠道', provider: 'openai',
    baseUrl: 'https://example.test/v1', apiKey: 'fixture-secret',
    models: [{ id: 'fixture-model', name: '测试模型', enabled: true }],
  })
  const project = backend.projects.create({ name: '隔离项目' })
  return { channel, project }
}

function tool(input: AgentQueryInput, name: string): AgentCustomToolDefinition {
  const found = input.customTools?.find((item) => item.name === name)
  if (!found) throw new Error(`未装配工具 ${name}`)
  return found
}

describe('显式后端装配工厂', () => {
  test.each(['pi', 'zima'] as const)('%s：组合上下文和工具，Chat 隔离提示词，整体重建保留历史', async (runtimeId) => {
    expect(process.versions.electron).toBeUndefined()
    const paths = isolatedPaths()
    const adapter = new ScriptedAdapter()
    const requests: ProviderStreamRequest[] = []
    let mcpCloses = 0
    const { backend } = open(paths, adapter, {
      providerStream: async function* (input) {
        requests.push(input)
        yield { type: 'text_delta', delta: 'Chat 回复' }
        yield { type: 'finish', reason: 'stop' }
      },
      connectMcpServer: () => ({ ready: Promise.resolve(), client: {
        listTools: async () => ({ tools: [{ name: 'lookup', inputSchema: { type: 'object' } }] }),
        callTool: async () => ({ content: [{ type: 'text', text: 'MCP 查询结果' }] }),
        close: async () => { mcpCloses += 1 },
      } }),
    })
    const { channel, project } = await prepare(backend)
    backend.settings.update({ agentSystemPrompt: '仅 Agent 使用的规则', gitAttributionEnabled: false })
    backend.projects.update(project.id, { memoryEnabled: true })
    backend.memoryService.write(project.id, 'MEMORY.md', 'preferences.md 保存测试偏好')
    backend.memoryService.write(project.id, 'preferences.md', '使用中文解释')
    const cwd = backend.projects.resolveProjectCwd(project.id)
    writeTextFileAtomic(join(cwd, 'AGENTS.md'), '项目根指令')
    for (const [directory, name] of [[join(cwd, '.axon/skills/project'), 'project'],
      [join(cwd, '.agents/skills/project-agents'), 'project-agents'],
      [join(paths.managedSkillsDir, 'builtin'), 'builtin'], [join(paths.userSkillsDir, 'user'), 'user']] as const) {
      mkdirSync(directory, { recursive: true })
      writeTextFileAtomic(join(directory, 'SKILL.md'), `---\nname: ${name}\ndescription: 测试 ${name}\n---\n${name} 读取正文`)
    }
    await backend.mcp.save(project.id, { version: 1, servers: { fixture: {
      type: 'stdio', command: 'fixture', enabled: true, required: true,
      startupTimeoutMs: 1_000, requestTimeoutMs: 2_000,
    } } })
    const session = backend.sessions.create({ title: '命名 Agent', runtimeId, projectId: project.id,
      channelId: channel.id, modelId: 'fixture-model' })
    adapter.handler = async function* (input) {
      expect(input.connection?.apiKey).toBe('fixture-secret')
      expect(input.systemPrompt).toContain('仅 Agent 使用的规则')
      expect(input.systemPrompt).toContain('项目根指令')
      expect(input.systemPrompt).toContain('preferences.md 保存测试偏好')
      for (const name of ['project', 'project-agents', 'builtin', 'user']) {
        const result = await tool(input, 'SkillRead').execute({ name }, { toolUseId: name })
        expect(result.isError).not.toBe(true)
        expect(result.content).toContain(`${name} 读取正文`)
      }
      const result = await tool(input, 'MemoryRead').execute({ path: 'preferences.md' }, { toolUseId: 'memory' })
      expect(result.isError).not.toBe(true)
      expect(JSON.stringify(result.content)).toContain('使用中文解释')
      const mcp = await tool(input, 'mcp__fixture__lookup').execute({}, { toolUseId: 'mcp' })
      expect(mcp.content).toEqual([{ type: 'text', text: 'MCP 查询结果' }])
      const permission = await input.canUseTool?.('Write', {}, {
        toolUseId: 'permission', executionPolicy: input.executionPolicy!, toolExecution: { kind: 'runtime' },
      })
      expect(permission?.behavior).toBe('deny')
      input.onRuntimeSession?.('opaque-runtime-session', join(paths.runtimeSessionsDir, 'opaque-artifact'))
      yield { kind: 'sdk_message', message: { type: 'system', subtype: 'compact_boundary',
        compact_result: 'success', summary: '保留的压缩摘要' } }
      yield* success('Agent 回复')
    }
    const outcome = await backend.agent.sendMessage({ sessionId: session.id, text: '读取上下文' })
    expect(outcome.finalText).toBe('Agent 回复')
    expect(backend.sessions.get(session.id)?.memoryFileStates?.['preferences.md']).toBeDefined()
    const conversation = backend.conversations.create({ title: '命名 Chat', channelId: channel.id, modelId: 'fixture-model' })
    const attachment = backend.attachments.save({ conversationId: conversation.id, filename: '说明.md',
      mediaType: 'text/markdown', data: Buffer.from('文档正文').toString('base64') })
    await backend.chat.sendMessage({ conversationId: conversation.id, text: 'Chat 输入', attachments: [attachment] })
    expect(requests).toHaveLength(1)
    expect(requests[0]?.chatRequest.systemPrompt).toBeUndefined()
    expect(JSON.stringify(requests[0]?.chatRequest.messages)).toContain('文档正文')
    const history = backend.sessions.getMessages(session.id)
    const chatHistory = backend.conversations.getMessages(conversation.id)
    backend.dispose()
    await Promise.resolve()
    expect(mcpCloses).toBe(1)
    expect(() => backend.clients.register()).toThrow('客户端登记表已释放')
    expect(adapter.disposals).toBe(1)
    const next = new ScriptedAdapter()
    const reloaded = open(paths, next).backend
    expect(reloaded.settings.get().agentSystemPrompt).toBe('仅 Agent 使用的规则')
    expect(reloaded.sessions.getMessages(session.id)).toEqual(history)
    expect(reloaded.conversations.getMessages(conversation.id)).toEqual(chatHistory)
    expect(history[1]).toMatchObject({ summary: '保留的压缩摘要' })
    next.handler = async function* (input) {
      expect(input.resumeSessionId).toBe('opaque-runtime-session')
      expect(input.recoveryPrompt).toContain('Agent 回复')
      yield* success('恢复成功')
    }
    // 关闭已配置 MCP，确保重建测试不启动夹具以外的真实命令。
    await reloaded.mcp.save(project.id, { version: 1, servers: {} })
    expect((await reloaded.agent.sendMessage({ sessionId: session.id, text: '继续' })).finalText).toBe('恢复成功')
    expect(readFileSync(paths.channelsPath, 'utf8')).not.toContain('fixture-secret')
  })

  test('工厂内子 Agent 共享存储和可信 owner，但只读角色不获得写入、追问和再委派工具', async () => {
    const adapter = new ScriptedAdapter()
    const { backend } = open(isolatedPaths(), adapter)
    const owner = backend.clients.register()
    const { channel, project } = await prepare(backend)
    backend.projects.update(project.id, { memoryEnabled: true })
    const root = backend.sessions.create({ title: '命名主会话', projectId: project.id,
      channelId: channel.id, modelId: 'fixture-model' })
    const observer = backend.clients.register()
    const taskEvents: AgentTaskEvent[] = []
    const ownerEvents: AgentTaskEvent[] = []
    backend.taskController.subscribe(observer, (event) => taskEvents.push(event))
    backend.taskController.subscribe(owner, (event) => ownerEvents.push(event))
    adapter.handler = async function* (input) {
      if (input.sessionId !== root.id) {
        expect(backend.permissions.getOwner(input.sessionId)).toBe(owner)
        expect(input.executionPolicy?.sandboxMode).toBe('readOnly')
        const names = input.customTools?.map((item) => item.name) ?? []
        expect(names).toContain('MemoryRead')
        for (const name of ['MemoryWrite', 'AskUserQuestion', 'Agent', 'Task', 'mcp__fixture__lookup']) expect(names).not.toContain(name)
        yield* success('子会话结果')
        return
      }
      const result = await tool(input, 'Agent').execute({ description: '检查', prompt: '只读检查', subagent_type: 'explore' },
        { toolUseId: 'delegate', signal: input.abortSignal })
      expect(result.isError).not.toBe(true)
      expect(JSON.stringify(result.content)).toContain('子会话结果')
      yield* success('主会话结果')
    }
    expect(await backend.agentRuns.send(owner, { sessionId: root.id, text: '检查' }, () => {})).toMatchObject({ success: true })
    const task = backend.tasks.list(root.id)[0]!
    expect(task.status).toBe('completed')
    expect(taskEvents.some((event) => event.type === 'changed' && event.task.status === 'completed')).toBe(true)
    expect(taskEvents.some((event) => event.type === 'agent_event' && event.agentId === task.childSessionId)).toBe(true)
    expect(backend.taskController.list(root.id)).toEqual([task])
    expect(backend.taskController.getMessages(root.id, task.id)).toEqual(backend.sessions.getMessages(task.childSessionId))
    const otherRoot = backend.sessions.create({ title: '另一根会话' })
    expect(() => backend.taskController.getMessages(otherRoot.id, task.id)).toThrow('子任务不存在')
    const beforeDetach = taskEvents.length
    const beforeOwner = ownerEvents.length
    backend.clients.detach(observer)
    backend.events.emit({ type: 'run_started', sessionId: task.childSessionId, runStartedAt: 99, source: 'delegation' })
    expect(taskEvents).toHaveLength(beforeDetach)
    expect(ownerEvents).toHaveLength(beforeOwner + 1)
    expect(backend.permissions.getOwner(task.childSessionId)).toBeUndefined()
    expect(backend.askUsers.bindOwner(task.childSessionId, '释放后的检查入口')).toBe(true)
    backend.askUsers.unbindOwner(task.childSessionId, '释放后的检查入口')
    expect(backend.sessions.getMessages(task.childSessionId)).toHaveLength(3)
  })

  test('删除未使用 Runtime 的会话不初始化 adapter；相同 adapter 只回收一次', async () => {
    const adapter = new ScriptedAdapter()
    const runtimes: string[] = []
    const { backend } = open(isolatedPaths(), adapter, { resolveAdapter: (id) => { runtimes.push(id); return adapter } })
    const { channel, project } = await prepare(backend)
    const session = backend.sessions.create({ runtimeId: 'zima', projectId: project.id, channelId: channel.id, modelId: 'fixture-model' })
    backend.sessions.delete(session.id)
    expect(runtimes).toEqual(['pi'])
    expect(adapter.released).toEqual([])
    backend.getAdapter('zima')
    backend.dispose()
    backend.dispose()
    expect(adapter.disposals).toBe(1)
    expect(() => backend.getAdapter('pi')).toThrow('后端已释放')
  })

  test('Agent 标题使用注入的 Provider 传输，事件发出前标题已经落盘', async () => {
    const requests: ProviderStreamRequest[] = []
    const { backend } = open(isolatedPaths(), new ScriptedAdapter(), {
      providerStream: async function* (input) {
        requests.push(input)
        yield { type: 'text_delta', delta: '自动生成标题' }
        yield { type: 'finish', reason: 'stop' }
      },
    })
    const { channel, project } = await prepare(backend)
    const session = backend.sessions.create({ projectId: project.id, channelId: channel.id, modelId: 'fixture-model' })
    let notifyTitle = (): void => {}
    const titleReady = new Promise<void>((resolve) => { notifyTitle = resolve })
    let persistedTitle: string | undefined
    const unsubscribe = backend.events.subscribe((event) => {
      if (event.type === 'session_title') {
        persistedTitle = backend.sessions.get(event.sessionId)?.title
        notifyTitle()
      }
    })
    expect((await backend.agent.sendMessage({ sessionId: session.id, text: '请解释目录' })).finalText).toBe('完成')
    await titleReady
    unsubscribe()
    expect(persistedTitle).toBe('自动生成标题')
    expect(requests).toHaveLength(1)
    expect(requests[0]).toMatchObject({ apiKey: 'fixture-secret', userAgent: 'Axon/0.1.3' })
    expect(backend.sessions.getMessages(session.id)).toHaveLength(3)
  })

  test('释放时索引读取失败也继续清理客户端与 adapter', () => {
    const adapter = new ScriptedAdapter()
    const paths = isolatedPaths()
    const { backend } = open(paths, adapter)
    const owner = backend.clients.register()
    const readFailure = spyOn(backend.sessions, 'list').mockImplementation(() => { throw new Error('索引读取失败') })
    expect(() => backend.dispose()).toThrow(AggregateError)
    expect(backend.clients.has(owner)).toBe(false)
    expect(adapter.disposals).toBe(1)
    expect(() => backend.dispose()).not.toThrow()
    readFailure.mockRestore()
  })

  test('工厂统一登记真实工作区/记忆订阅，断开和释放不会向旧入口投递或重建句柄', async () => {
    const { backend } = open(isolatedPaths(), new ScriptedAdapter())
    const project = backend.projectController.create({ name: '订阅项目' })
    const root = backend.projects.resolveProjectCwd(project.id)
    const first = backend.clients.register()
    const second = backend.clients.register()
    const firstEvents: string[] = []
    const secondEvents: string[] = []
    expect(() => backend.projectController.watchDirectory('未登记', project.id, () => {})).toThrow('未登记')
    expect(() => backend.memory.watch(first, project.id, () => {})).toThrow('尚未启用记忆')
    backend.projectController.update(project.id, { memoryEnabled: true })
    backend.memory.write(project.id, 'MEMORY.md', '# 索引')
    for (const [client, events] of [[first, firstEvents], [second, secondEvents]] as const) {
      backend.projectController.watchDirectory(client, project.id, () => { events.push('workspace') })
      backend.memory.watch(client, project.id, (_time, path) => { events.push(`memory:${path}`) })
    }
    /** 等待真实 fs.watch 的防抖通知，缺少事件时失败；不以脚本打包代替执行证据。 */
    const waitForChanges = async (ready: () => boolean): Promise<void> => {
      const deadline = Date.now() + 3_000
      while (!ready() && Date.now() < deadline) await Bun.sleep(20)
      expect({ ready: ready(), firstEvents, secondEvents }).toMatchObject({ ready: true })
    }
    // 原生订阅返回不代表 OS 已开始投递；用真实准备事件确认四个监听就绪，不靠固定延时。
    const subscribed = (): boolean => [firstEvents, secondEvents].every((events) => (
      events.includes('workspace') && events.some((event) => event.startsWith('memory:'))
    ))
    const prepareDeadline = Date.now() + 3_000
    let attempt = 0
    while (!subscribed() && Date.now() < prepareDeadline) {
      writeFileSync(join(root, 'memory', 'watch-ready.md'), `# 准备 ${attempt++}`)
      // 每次探针留出防抖结算时间，不能连续写入使监听永远无法结束防抖。
      const deadline = Math.min(prepareDeadline, Date.now() + 500)
      while (!subscribed() && Date.now() < deadline) await Bun.sleep(20)
    }
    expect({ ready: subscribed(), firstEvents, secondEvents }).toMatchObject({ ready: true })
    firstEvents.length = 0
    secondEvents.length = 0
    writeFileSync(join(root, 'memory', 'MEMORY.md'), '# 两个入口')
    // macOS 可合并目录创建和文件变化，记忆订阅契约允许批量刷新而不附单文件路径。
    await waitForChanges(() => [firstEvents, secondEvents].every((events) => events.includes('workspace') && events.some((event) => event.startsWith('memory:'))))
    backend.clients.detach(first)
    const firstCount = firstEvents.length
    secondEvents.length = 0
    writeFileSync(join(root, 'memory', 'MEMORY.md'), '# 仅第二入口')
    await waitForChanges(() => secondEvents.includes('workspace') && secondEvents.some((event) => event.startsWith('memory:')))
    expect(firstEvents).toHaveLength(firstCount)
    expect(() => backend.projectController.watchDirectory(first, project.id, () => {})).toThrow('已断开')
    expect(() => backend.memory.watch(first, project.id, () => {})).toThrow('已断开')
    // 注销后新身份可使用同一项目；旧身份和已关闭句柄不能复活。
    const reloaded = backend.clients.register()
    const reloadedEvents: string[] = []
    backend.projectController.watchDirectory(reloaded, project.id, () => { reloadedEvents.push('workspace') })
    backend.memory.watch(reloaded, project.id, () => { reloadedEvents.push('memory') })
    const secondCount = secondEvents.length
    backend.dispose()
    writeFileSync(join(root, 'memory', 'MEMORY.md'), '# 后端释放后')
    await Bun.sleep(180)
    expect(secondEvents).toHaveLength(secondCount)
    expect(reloadedEvents).toEqual([])
    expect(() => backend.projectController.watchDirectory(reloaded, project.id, () => {})).toThrow('已断开')
    expect(() => backend.memory.watch(reloaded, project.id, () => {})).toThrow('已断开')
  })
})
