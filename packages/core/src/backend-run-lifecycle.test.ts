import { afterEach, expect, test } from 'bun:test'
import { existsSync, mkdtempSync, readFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { DEFAULT_AGENT_SESSION_TITLE, DEFAULT_CONVERSATION_TITLE, MAX_AGENT_DELEGATION_CONCURRENCY } from '@axon/shared'
import type { AgentProviderAdapter, AgentQueryInput, AgentReasoningCapability, AgentStreamPayload } from '@axon/shared'
import { createBackend } from './backend'
import type { AxonBackend, BackendOptions } from './backend'
import { createBackendPaths } from './settings/backend-paths'
import { createFixtureCredentialCodec } from '../test-support/credential-codec'

const releaseGates: Array<() => void> = []
function deferred() {
  let resolve!: () => void
  const promise = new Promise<void>((done) => { resolve = done })
  releaseGates.push(resolve)
  return { promise, resolve }
}
class LifecycleAdapter implements AgentProviderAdapter {
  handler: (input: AgentQueryInput) => AsyncIterable<AgentStreamPayload> = async function* () {
    yield { kind: 'sdk_message', message: { type: 'assistant', message: { content: [{ type: 'text', text: '完成' }] }, parent_tool_use_id: null } }
    yield { kind: 'sdk_message', message: { type: 'result', subtype: 'success' } }
  }
  query(input: AgentQueryInput): AsyncIterable<AgentStreamPayload> { return this.handler(input) }
  abort(): void {}
  dispose(): void {}
  async drain(): Promise<void> {}
}
const opened: Array<{ backend: AxonBackend; directory: string }> = []
afterEach(async () => {
  for (const finish of releaseGates.splice(0)) finish()
  for (const { backend, directory } of opened.splice(0)) {
    backend.dispose()
    await backend.drain()
    rmSync(directory, { recursive: true, force: true })
  }
})

/** 实际工厂/协调器/存储，中立 adapter 只控制取消后的真实返回时机。 */
async function open(adapter: LifecycleAdapter, overrides: Partial<BackendOptions> = {}, defaultTitles = false) {
  const directory = mkdtempSync(join(tmpdir(), 'axon-backend-run-drain-'))
  const backend = createBackend({ paths: createBackendPaths({ dataDir: join(directory, 'data'), homeDir: directory }),
    applicationVersion: '0.1.3', credentialCodec: createFixtureCredentialCodec(), resolveAdapter: () => adapter, ...overrides })
  opened.push({ backend, directory })
  const channel = await backend.channels.create({ name: '离线渠道', provider: 'custom', apiKey: 'sk-drain-fixture',
    baseUrl: 'http://127.0.0.1:1/v1', models: [{ id: 'fixture', name: '离线', enabled: true }] })
  const project = backend.projects.create({ name: '隔离项目' })
  const agent = backend.sessions.create({ projectId: project.id, channelId: channel.id, modelId: 'fixture',
    ...(defaultTitles ? {} : { title: '已命名 Agent' }) })
  const chat = backend.conversations.create({ channelId: channel.id, modelId: 'fixture',
    ...(defaultTitles ? {} : { title: '已命名 Chat' }) })
  return { backend, channel, project, agent, chat, owner: backend.clients.register() }
}
async function assertPending(work: Promise<void>): Promise<void> {
  expect(await Promise.race([work.then(() => '结束'), Bun.sleep(10).then(() => '等待')])).toBe('等待')
}
async function aborted(signal: AbortSignal): Promise<void> {
  if (signal.aborted) return
  await new Promise<void>((done) => signal.addEventListener('abort', () => done(), { once: true }))
}

test('统一 drain 等待运行和全部自有资源，未使用的 adapter 也释放，相同实例只处理一次', async () => {
  const flow = deferred(), entered = deferred(), piDone = deferred(), zimaDone = deferred(), hostDone = deferred()
  const calls: string[] = []
  class OwnedAdapter extends LifecycleAdapter {
    constructor(private readonly name: string, private readonly finish: Promise<void>) { super() }
    override dispose(): void { calls.push(`dispose:${this.name}`) }
    override async drain(): Promise<void> { calls.push(`drain:${this.name}`); await this.finish }
  }
  const pi = new OwnedAdapter('pi', piDone.promise), unused = new OwnedAdapter('zima', zimaDone.promise)
  pi.handler = async function* () { entered.resolve(); await flow.promise }
  const host = { dispose: () => { calls.push('dispose:host') },
    drain: async () => { calls.push('drain:host'); await hostDone.promise } }
  const resolved: string[] = []
  const f = await open(pi, { ownedResources: [pi, unused, host, unused],
    resolveAdapter: (runtime) => { resolved.push(runtime); return pi } })
  await expect(f.backend.drain()).rejects.toThrow('必须先释放')
  const sending = f.backend.agentRuns.send(f.owner, { sessionId: f.agent.id, text: '等待真实运行' }, () => {})
  await entered.promise
  f.backend.dispose()
  f.backend.dispose()
  const draining = f.backend.drain()
  expect(f.backend.drain()).toBe(draining)
  await assertPending(draining)
  piDone.resolve(); zimaDone.resolve(); hostDone.resolve()
  await assertPending(draining)
  flow.resolve()
  await Promise.all([sending, draining])
  expect(resolved).toEqual(['pi'])
  expect(calls).toEqual(['dispose:pi', 'dispose:zima', 'dispose:host', 'drain:pi', 'drain:zima', 'drain:host'])
  expect(() => f.backend.getAdapter('zima')).toThrow('后端已释放')
})

test('同步和异步清理失败仍等待其他资源，聚合诊断不携带底层敏感原因', async () => {
  const directory = mkdtempSync(join(tmpdir(), 'axon-backend-drain-failure-'))
  const slow = deferred(), entered = deferred()
  const calls: string[] = []
  const backend = createBackend({ paths: createBackendPaths({ dataDir: join(directory, 'data'), homeDir: directory }),
    applicationVersion: '0.1.3', credentialCodec: createFixtureCredentialCodec(), resolveAdapter: () => new LifecycleAdapter(),
    ownedResources: [
      { dispose: () => { calls.push('dispose-failed'); throw new Error('sk-sync-secret') }, drain: async () => {} },
      { dispose: () => { calls.push('dispose-next') }, drain: () => { calls.push('drain-failed'); throw new Error('sk-async-secret') } },
      { dispose: () => { calls.push('dispose-slow') }, drain: async () => { entered.resolve(); await slow.promise; calls.push('drain-slow') } },
    ] })
  try {
    expect(() => backend.dispose()).toThrow(AggregateError)
    const draining = backend.drain()
    const outcome = draining.catch((error: unknown) => error)
    await entered.promise
    await assertPending(outcome.then(() => {}))
    slow.resolve()
    const error = await outcome
    expect(error).toBeInstanceOf(AggregateError)
    expect((error as AggregateError).errors).toHaveLength(2)
    expect((error as AggregateError).errors.map((item: Error) => item.message).join()).not.toContain('sk-')
    expect(calls).toEqual(['dispose-failed', 'dispose-next', 'dispose-slow', 'drain-failed', 'drain-slow'])
    expect(backend.drain()).toBe(draining)
    expect(() => backend.dispose()).not.toThrow()
  } finally {
    slow.resolve()
    backend.dispose()
    await backend.drain().catch(() => {})
    rmSync(directory, { recursive: true, force: true })
  }
})

test('实际工厂退出取消能力/环境/Skills 等待，仍登记底层工作；迟到目录不安装', async () => {
  const finishReasoning = deferred(), finishProbe = deferred(), finishCatalog = deferred(), entered = deferred()
  let starts = 0
  const started = (): void => { if (++starts === 4) entered.resolve() }
  let probeSignal: AbortSignal | undefined
  const adapter = new class extends LifecycleAdapter {
    async getReasoningCapability(): Promise<AgentReasoningCapability> {
      started(); await finishReasoning.promise
      return { levels: ['off', 'high'], defaultLevel: 'high' }
    }
  }()
  const f = await open(adapter, {
    skillCatalog: { getCatalog: async () => { started(); await finishCatalog.promise; return { packages: [] } } },
    checkEnvironment: async (input, signal) => {
      probeSignal = signal; started(); await finishProbe.promise
      return { cwd: input.cwd ?? '/fixture', directory: { available: true, writable: true, message: '可用' },
        git: { available: false, message: '夹具' }, node: { available: false, message: '夹具' }, bun: { available: false, message: '夹具' } }
    },
  })
  const hadInstallationState = existsSync(f.backend.paths.skillInstallationsPath)
  const operations = [f.backend.agentCapabilities.getReasoningCapability(f.agent.id),
    f.backend.agentCapabilities.checkEnvironment({ projectId: f.project.id }),
    f.backend.skills.getSnapshot(), f.backend.skills.apply([])].map((work) => work.catch((error: unknown) => error))
  await entered.promise
  f.backend.dispose()
  expect(probeSignal?.aborted).toBe(true)
  for (const result of await Promise.all(operations)) expect(result).toMatchObject({ name: 'AbortError' })
  await expect(f.backend.skills.apply([])).rejects.toMatchObject({ name: 'AbortError' })
  await expect(f.backend.agentCapabilities.checkEnvironment({})).rejects.toMatchObject({ name: 'AbortError' })
  const drain = f.backend.drain()
  await assertPending(drain)
  finishReasoning.resolve()
  await assertPending(drain)
  finishCatalog.resolve()
  await assertPending(drain)
  finishProbe.resolve()
  await drain
  expect(starts).toBe(4)
  expect(existsSync(f.backend.paths.skillInstallationsPath)).toBe(hadInstallationState)
  expect(f.backend.settings.get().agentSkillCatalogIds).toEqual([])
})

test('实际渠道退出拒绝新配置操作，等待已接纳加密完成并原子落盘，不伪装回滚', async () => {
  const entered = deferred(), finishEncryption = deferred()
  const codec = createFixtureCredentialCodec()
  let delayed = false, encryptions = 0
  const f = await open(new LifecycleAdapter(), { credentialCodec: { ...codec, encrypt: async (value) => {
    if (delayed) { if (++encryptions === 2) entered.resolve(); await finishEncryption.promise }
    return codec.encrypt(value)
  } } })
  delayed = true
  const creating = f.backend.channelController.create({ name: '退出前已接纳', provider: 'custom', baseUrl: f.channel.baseUrl, apiKey: 'fixture-new' })
  const updating = f.backend.channelController.update(f.channel.id, { name: '退出前更新', apiKey: 'fixture-updated' })
  await entered.promise
  f.backend.dispose()
  await expect(f.backend.channelController.create({ name: '退出后', provider: 'custom', apiKey: '' })).rejects.toThrow('已释放')
  expect(() => f.backend.channelController.delete(f.channel.id)).toThrow('已释放')
  const drain = f.backend.drain()
  await assertPending(drain)
  finishEncryption.resolve()
  const [created, updated] = await Promise.all([creating, updating])
  await drain
  expect(f.backend.channels.list().map((channel) => channel.name).sort()).toEqual(['退出前已接纳', '退出前更新'])
  const stored = readFileSync(f.backend.paths.channelsPath, 'utf8')
  expect(stored).toContain(created.id)
  expect(stored).toContain(updated.id)
  expect(stored).not.toContain('fixture-updated')
  expect(encryptions).toBe(2)
})

test('实际后端退出也封住 MCP 配置与旧工具，独立等待 MCP 的底层调用及关闭', async () => {
  const callEntered = deferred(), finishCall = deferred(), finishClose = deferred()
  let closes = 0
  const f = await open(new LifecycleAdapter(), { connectMcpServer: () => ({ ready: Promise.resolve(), client: {
    listTools: async () => ({ tools: [{ name: 'work', inputSchema: { type: 'object' } }] }),
    callTool: async (_input, options) => {
      callEntered.resolve()
      await finishCall.promise
      expect(options.signal?.aborted).toBe(true)
      return { content: [] }
    },
    close: async () => { closes += 1; await finishClose.promise },
  } }) })
  await f.backend.mcp.save(f.project.id, { version: 1, servers: { local: { type: 'stdio', command: 'fixture' } } })
  const [tool] = await f.backend.mcpTools.getTools(f.project.id)
  const call = tool!.execute({}, { toolUseId: 'call' }).catch((error: unknown) => error)
  await callEntered.promise
  f.backend.dispose()
  expect(await call).toMatchObject({ name: 'AbortError' })
  await expect(f.backend.mcp.get(f.project.id)).rejects.toMatchObject({ name: 'AbortError' })
  await expect(tool!.execute({}, { toolUseId: 'late' })).rejects.toMatchObject({ name: 'AbortError' })
  const drain = f.backend.drain()
  await assertPending(drain)
  finishClose.resolve()
  await assertPending(drain)
  finishCall.resolve()
  await drain
  expect(closes).toBe(1)
})

test('dispose 禁止新发送和队列，drainRuns 等待 Agent/Chat 清理后唯一终态落盘', async () => {
  const agentEntered = deferred(), chatEntered = deferred()
  const agentCleanup = deferred(), chatCleanup = deferred()
  const adapter = new LifecycleAdapter()
  adapter.handler = async function* (input) {
    yield { kind: 'sdk_message', message: { type: 'assistant', message: { content: [{ type: 'text', text: '局部内容' }] }, parent_tool_use_id: null } }
    agentEntered.resolve()
    await aborted(input.abortSignal!)
    await agentCleanup.promise
  }
  const f = await open(adapter, { providerStream: async function* (input) {
    yield { type: 'text_delta', delta: 'Chat 局部内容' }
    chatEntered.resolve()
    await aborted(input.signal!)
    await chatCleanup.promise
  } })
  const agentRun = f.backend.agentRuns.send(f.owner, { sessionId: f.agent.id, text: '开始' }, () => {})
  const chatRun = f.backend.chatRuns.send(f.owner, { conversationId: f.chat.id, text: '开始' }, () => {})
  await Promise.all([agentEntered.promise, chatEntered.promise])
  expect(await f.backend.agentRuns.send(f.owner, { sessionId: f.agent.id, text: '不可执行的排队消息' }, () => {}))
    .toMatchObject({ disposition: 'queued' })
  await expect(f.backend.drainRuns()).rejects.toThrow('必须先释放')
  f.backend.dispose()
  const drain = f.backend.drainRuns()
  expect(f.backend.drainRuns()).toBe(drain)
  expect(f.backend.agent.isActive(f.agent.id)).toBe(true)
  expect(f.backend.chat.isActive(f.chat.id)).toBe(true)
  await expect(f.backend.agent.sendMessage({ sessionId: f.agent.id, text: '退出后' })).rejects.toThrow('已释放')
  await expect(f.backend.chat.sendMessage({ conversationId: f.chat.id, text: '退出后' })).rejects.toThrow('已释放')
  await assertPending(drain)
  agentCleanup.resolve()
  await agentRun
  await assertPending(drain)
  chatCleanup.resolve()
  expect(await chatRun).toMatchObject({ success: false, code: 'cancelled' })
  await drain
  const agentHistory = f.backend.sessions.getMessages(f.agent.id)
  expect(agentHistory.filter((message) => message.type === 'result')).toMatchObject([{ terminal_reason: 'stopped', stopped_by_user: true }])
  expect(JSON.stringify(agentHistory)).not.toContain('不可执行的排队消息')
  expect(f.backend.conversations.getMessages(f.chat.id).map((message) => message.status)).toEqual(['complete', 'stopped'])
  expect(f.backend.agent.isActive(f.agent.id)).toBe(false)
  expect(f.backend.chat.isActive(f.chat.id)).toBe(false)
})

test('已完成轮次的后台标题也被取消并等待，忽略取消的迟到结果不覆盖标题', async () => {
  const titlesReady = deferred(), finishTitles = deferred()
  const titleSignals: AbortSignal[] = []
  const f = await open(new LifecycleAdapter(), { providerStream: async function* (input) {
    if (!input.chatRequest.systemPrompt?.startsWith('请为这段对话生成')) {
      yield { type: 'text_delta', delta: 'Chat 完成' }
      yield { type: 'finish', reason: 'stop' }
      return
    }
    titleSignals.push(input.signal!)
    if (titleSignals.length === 2) titlesReady.resolve()
    await finishTitles.promise
    yield { type: 'text_delta', delta: '不应保存的迟到标题' }
    yield { type: 'finish', reason: 'stop' }
  } }, true)
  await Promise.all([
    f.backend.agent.sendMessage({ sessionId: f.agent.id, text: '标题' }),
    f.backend.chat.sendMessage({ conversationId: f.chat.id, text: '标题' }),
  ])
  await titlesReady.promise
  expect(f.backend.agent.isActive(f.agent.id)).toBe(false)
  expect(f.backend.chat.isActive(f.chat.id)).toBe(false)
  f.backend.dispose()
  expect(titleSignals.every((signal) => signal.aborted)).toBe(true)
  const drain = f.backend.drainRuns()
  await assertPending(drain)
  finishTitles.resolve()
  await drain
  expect(f.backend.sessions.get(f.agent.id)?.title).toBe(DEFAULT_AGENT_SESSION_TITLE)
  expect(f.backend.conversations.get(f.chat.id)?.title).toBe(DEFAULT_CONVERSATION_TITLE)
})

test('取消预检等待不等于预检已结束，迟到凭据/创建校验不会建会话或启动模型', async () => {
  const decodeEntered = deferred(), validateEntered = deferred()
  const finishDecode = deferred(), finishValidate = deferred()
  const codec = createFixtureCredentialCodec()
  const adapter = new LifecycleAdapter()
  let queries = 0
  adapter.handler = async function* () { queries += 1 }
  const f = await open(adapter, {
    credentialCodec: { ...codec, decrypt: async (value) => { decodeEntered.resolve(); await finishDecode.promise; return codec.decrypt(value) } },
    validateCreate: async () => { validateEntered.resolve(); await finishValidate.promise },
  })
  const creating = f.backend.agentRuns.createSession({ title: '不能迟到创建' }).then(() => null, (error: unknown) => error)
  const chatRun = f.backend.chatRuns.send(f.owner, { conversationId: f.chat.id, text: '预检' }, () => {})
  await Promise.all([decodeEntered.promise, validateEntered.promise])
  f.backend.dispose()
  expect(await chatRun).toMatchObject({ success: false, code: 'cancelled' })
  const drain = f.backend.drainRuns()
  await assertPending(drain)
  finishDecode.resolve()
  await assertPending(drain)
  finishValidate.resolve()
  expect(await creating).toBeInstanceOf(Error)
  await drain
  expect(f.backend.sessions.list()).toHaveLength(1)
  expect(f.backend.conversations.getMessages(f.chat.id)).toEqual([])
  expect(queries).toBe(0)
})

test('取消子任务先保存 canceled，drain 等待真实子执行；排队任务和后台续跑不再启动', async () => {
  const parentEntered = deferred(), childrenEntered = deferred(), cleanup = deferred()
  const started: string[] = []
  let parentId = ''
  const adapter = new LifecycleAdapter()
  adapter.handler = async function* (input) {
    started.push(input.sessionId)
    if (input.sessionId === parentId) parentEntered.resolve()
    else if (started.length === MAX_AGENT_DELEGATION_CONCURRENCY + 1) childrenEntered.resolve()
    await aborted(input.abortSignal!)
    await cleanup.promise
  }
  const f = await open(adapter)
  parentId = f.agent.id
  const parentRun = f.backend.agentRuns.send(f.owner, { sessionId: parentId, text: '子任务' }, () => {})
  await parentEntered.promise
  for (let index = 0; index < MAX_AGENT_DELEGATION_CONCURRENCY + 2; index += 1) {
    f.backend.collaboration.delegate({ parentSessionId: parentId, parentToolUseId: `task-${index}`,
      title: '后台任务', objective: '等待', subagentType: 'coder', runInBackground: true })
  }
  await childrenEntered.promise
  expect(f.backend.tasks.list(parentId).filter((task) => task.status === 'queued')).toHaveLength(2)
  f.backend.dispose()
  expect(f.backend.tasks.list(parentId).every((task) => task.status === 'canceled')).toBe(true)
  const drain = f.backend.drainRuns()
  await assertPending(drain)
  cleanup.resolve()
  await Promise.all([parentRun, drain])
  expect(started).toHaveLength(MAX_AGENT_DELEGATION_CONCURRENCY + 1)
  expect(f.backend.tasks.list(parentId).every((task) => task.status === 'canceled')).toBe(true)
  expect(() => f.backend.collaboration.delegate({ parentSessionId: parentId, parentToolUseId: 'late',
    title: '退出后', objective: '不可开始', subagentType: 'coder', runInBackground: true })).toThrow('已释放')
})

test('已开始的后台完成回调也须真实返回，不能只等待任务 completed 状态', async () => {
  const parentEntered = deferred(), notificationEntered = deferred(), finishNotification = deferred()
  let parentId = ''
  const adapter = new LifecycleAdapter()
  adapter.handler = async function* (input) {
    if (input.sessionId === parentId) {
      parentEntered.resolve()
      await aborted(input.abortSignal!)
      return
    }
    yield { kind: 'sdk_message', message: { type: 'result', subtype: 'success' } }
  }
  const f = await open(adapter)
  parentId = f.agent.id
  f.backend.collaboration.setBackgroundCompletionHandler(async () => {
    notificationEntered.resolve()
    await finishNotification.promise
  })
  const parentRun = f.backend.agentRuns.send(f.owner, { sessionId: parentId, text: '后台完成' }, () => {})
  await parentEntered.promise
  const task = f.backend.collaboration.delegate({ parentSessionId: parentId, parentToolUseId: 'completed-task',
    title: '快速完成', objective: '完成', subagentType: 'coder', runInBackground: true })
  await notificationEntered.promise
  expect(f.backend.tasks.get(task.id)?.status).toBe('completed')
  f.backend.dispose()
  await parentRun
  const drain = f.backend.drainRuns()
  await assertPending(drain)
  finishNotification.resolve()
  await drain
  expect(f.backend.tasks.get(task.id)?.status).toBe('completed')
})
