import { afterEach, describe, expect, spyOn, test } from 'bun:test'
import { mkdtempSync, readFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { PassThrough } from 'node:stream'
import { AgentDelegationManager, createBackend, createBackendPaths, createCredentialCodec } from '@axon/core'
import type { AxonBackend } from '@axon/core'
import { APP_SERVER_METHODS as methods, APP_SERVER_NOTIFICATIONS as notices, APP_SERVER_CLIENT_METHODS as reverse,
  APP_SERVER_RPC_OPTIONS } from '@axon/shared'
import type { AgentDelegation, AgentProviderAdapter, AgentQueryInput, AgentSessionMeta, AgentStreamPayload, AgentTaskEvent,
  AppServerAgentRunEvent, AppServerClient, AppServerTaskEvent, AppServerTaskSubscription, RpcJsonObject, RpcJsonValue } from '@axon/shared'
import { AppServerConnection, JsonRpcPeer } from './index'
import { toWireValue } from './wire-value'

const cleanups: Array<() => void> = []
afterEach(() => { for (const cleanup of cleanups.splice(0).reverse()) cleanup() })

class Adapter implements AgentProviderAdapter {
  handler: (input: AgentQueryInput) => AsyncIterable<AgentStreamPayload> = async function* () { yield* success() }
  query(input: AgentQueryInput) { return this.handler(input) }
  abort(): void {}
  dispose(): void {}
  async drain(): Promise<void> {}
}
function* success(): Iterable<AgentStreamPayload> {
  yield { kind: 'sdk_message', message: { type: 'assistant', message: { content: [{ type: 'text', text: '任务结果' }] } } }
  yield { kind: 'sdk_message', message: { type: 'result', subtype: 'success' } }
}

/** 真实工厂与根/子会话文件经双端协议读取；模型夹具不启动 SDK 或外部服务。 */
async function open() {
  const directory = mkdtempSync(join(tmpdir(), 'axon-task-rpc-'))
  const upstream = new PassThrough(), downstream = new PassThrough()
  const parent = new JsonRpcPeer(downstream, upstream, { ...APP_SERVER_RPC_OPTIONS, requestTimeoutMs: 2_000 })
  const child = new JsonRpcPeer(upstream, downstream, { ...APP_SERVER_RPC_OPTIONS, requestTimeoutMs: 2_000 })
  const adapter = new Adapter()
  let backend: AxonBackend
  const connection = new AppServerConnection({ peer: child, bootstrap: () => {
    backend = createBackend({ paths: createBackendPaths({ dataDir: join(directory, 'data'), homeDir: directory }),
      applicationVersion: '0.1.3', credentialCodec: createCredentialCodec(), resolveAdapter: () => adapter,
      providerStream: async function* () { yield { type: 'text_delta', delta: '固定标题' }; yield { type: 'finish', reason: 'stop' } } })
    return { backend, applicationVersion: '0.1.3', capabilities: { runtimes: [], credentialStorage: 'unavailable', channelTargetConfirmation: false } }
  } })
  cleanups.push(() => { connection.close(); parent.close(); upstream.destroy(); downstream.destroy(); rmSync(directory, { recursive: true, force: true }) })
  await parent.request(methods.INITIALIZE, { protocolVersion: 1, client: { name: 'axon-task-fixture', version: '0.1.3' },
    hostCapabilities: { credentialStorage: 'unavailable', channelTargetConfirmation: false } })
  const main = await parent.request(methods.REGISTER_CLIENT, { kind: 'main' }) as unknown as AppServerClient
  const quick = await parent.request(methods.REGISTER_CLIENT, { kind: 'quick' }) as unknown as AppServerClient
  const request = (method: string, input?: RpcJsonValue, client = main, signal?: AbortSignal) => parent.request(method,
    { clientId: client.clientId, ...(input === undefined ? {} : { input }) }, { timeoutMs: 0, signal })
  const packets: AppServerTaskEvent[] = [], persisted: boolean[] = []
  parent.handleNotification(notices.TASK_EVENT, (params) => {
    const packet = params as unknown as AppServerTaskEvent
    packets.push(packet)
    if (packet.event.type === 'changed') {
      const stored = readFileSync(join(backend!.paths.agentSessionsDir, packet.event.rootSessionId, 'state.json'), 'utf8')
      persisted.push(stored.includes(packet.event.task.id) && stored.includes(`"${packet.event.task.status}"`))
    } else if (packet.event.event.type === 'stream' && packet.event.event.payload.kind === 'sdk_message') {
      const message = packet.event.event.payload.message
      if (['user', 'assistant', 'result'].includes(message.type)) {
        persisted.push('uuid' in message && backend!.sessions.getMessages(packet.event.agentId)
          .some((stored) => 'uuid' in stored && stored.uuid === message.uuid))
      }
    }
  })
  const subscribe = async (client = main) => await request(methods.TASK_SUBSCRIBE, undefined, client) as unknown as AppServerTaskSubscription
  const root = backend!.sessions.create({ title: '根会话' }), otherRoot = backend!.sessions.create({ title: '另一根会话' })
  const createTask = () => {
    const agent = backend!.sessions.create({ parentSessionId: root.id, rootSessionId: root.id, parentToolUseId: 'delegate', subagentType: 'coder' })
    return backend!.tasks.create({ rootSessionId: root.id, parentSessionId: root.id, childSessionId: agent.id,
      parentToolUseId: 'delegate', title: '子任务', objective: '检查目录', subagentType: 'coder', runInBackground: false, depth: 1 })
  }
  return { directory, parent, child, connection, backend: backend!, adapter, main, quick, request, packets, persisted, subscribe, root, otherRoot,
    createTask, disconnect() { upstream.destroy(); downstream.destroy() } }
}

describe('子任务只读应用协议', () => {
  test('读取实际根任务聚合与重建后的状态；根/子范围和固定字段不可绕过', async () => {
    const f = await open(), task = f.createTask()
    expect(await f.request(methods.TASK_LIST, f.root.id)).toEqual(toWireValue([task]))
    expect(await f.request(methods.TASK_GET, { rootSessionId: f.root.id, taskId: task.id }, f.quick)).toEqual(toWireValue(task))
    expect(await f.request(methods.TASK_GET, { rootSessionId: f.otherRoot.id, taskId: task.id })).toBeNull()
    expect(await f.request(methods.TASK_GET, { rootSessionId: f.root.id, taskId: 'missing' })).toBeNull()
    expect(new AgentDelegationManager({ sessionsDir: f.backend.paths.agentSessionsDir }).get(task.id)).toEqual(task)
    for (const input of ['', null, 1, {}, '../escape', 'a'.repeat(201)]) {
      await expect(f.request(methods.TASK_LIST, input)).rejects.toMatchObject({ code: -32602, data: { code: 'invalid_input' } })
    }
    for (const input of ['missing', task.childSessionId]) {
      await expect(f.request(methods.TASK_LIST, input)).rejects.toMatchObject({ code: -32027, data: { code: 'not_found' } })
    }
    await expect(f.request(methods.TASK_GET, { rootSessionId: f.root.id, taskId: task.id, owner: f.main.clientId }))
      .rejects.toMatchObject({ code: -32602 })
    await expect(f.request(methods.TASK_SUBSCRIBE, { rootSessionId: f.root.id })).rejects.toMatchObject({ code: -32602 })
    await expect(f.request(methods.TASK_UNSUBSCRIBE, null)).rejects.toMatchObject({ code: -32602 })
    const foreign = f.backend.clients.register()
    await expect(f.parent.request(methods.TASK_LIST, { clientId: foreign, input: f.root.id })).rejects.toMatchObject({ code: -32004 })
    await expect(f.parent.request(methods.TASK_LIST, { clientId: f.main.clientId, input: f.root.id, owner: f.quick.clientId }))
      .rejects.toMatchObject({ code: -32602 })
    expect(f.packets).toEqual([])
  })

  test('状态先落盘后双入口通知；新子任务与实际子轮次对应，元数据不虚构 runId', async () => {
    const f = await open()
    const a = await f.subscribe(), b = await f.subscribe(f.quick), task = f.createTask()
    f.backend.tasks.transition(task.id, { status: 'running' })
    const run = { sessionId: task.childSessionId, runId: 'actual-child-run', runStartedAt: 10 }
    f.backend.events.emit({ type: 'run_started', sessionId: task.childSessionId, runStartedAt: 10, source: 'delegation' }, run)
    f.backend.events.emit({ type: 'session_title', sessionId: task.childSessionId, runStartedAt: 10, title: '子标题', updatedAt: 11 })
    f.backend.events.emit({ type: 'run_started', sessionId: 'unrelated', runStartedAt: 12, source: 'delegation' })
    // 一个只读请求作为同向通知的处理屏障，不使用固定延时推测交付。
    await f.request(methods.TASK_LIST, f.root.id)
    expect(f.packets.map((packet) => packet.clientId)).toEqual(Array.from({ length: 4 }, () => [f.main.clientId, f.quick.clientId]).flat())
    expect(f.packets.filter((packet) => packet.clientId === f.main.clientId).every((packet) => packet.subscriptionId === a.subscriptionId)).toBe(true)
    expect(f.packets.filter((packet) => packet.clientId === f.quick.clientId).every((packet) => packet.subscriptionId === b.subscriptionId)).toBe(true)
    const projected = f.packets.filter((packet) => packet.event.type === 'agent_event')
    expect(projected[0]!.event).toMatchObject({ taskId: task.id, agentId: task.childSessionId, rootSessionId: f.root.id, run })
    expect(projected[2]!.event).not.toHaveProperty('run')
    expect(f.persisted).toEqual([true, true, true, true])
  })

  test('替换/旧取消/跨入口取消与迟到回调；每入口始终一个投影，清理失败不复活', async () => {
    const f = await open(), callbacks: Array<(event: AgentTaskEvent) => void> = []
    const original = f.backend.taskController.subscribe.bind(f.backend.taskController)
    let live = 0, failRelease = false
    f.backend.taskController.subscribe = (client, callback) => {
      callbacks.push(callback); live += 1
      const release = original(client, callback)
      return () => { release(); live -= 1; if (failRelease) throw new Error('私有清理路径') }
    }
    const a = await f.subscribe(), b = await f.subscribe(f.quick)
    let latest = a
    for (let i = 0; i < 10; i++) latest = await f.subscribe()
    expect(live).toBe(2); expect(latest.subscriptionId).not.toBe(a.subscriptionId)
    expect(await f.request(methods.TASK_UNSUBSCRIBE, a.subscriptionId)).toBe(false)
    expect(await f.request(methods.TASK_UNSUBSCRIBE, latest.subscriptionId, f.quick)).toBe(false)
    const task = f.createTask(), event: AgentTaskEvent = { type: 'changed', rootSessionId: f.root.id, task }
    await f.request(methods.TASK_LIST, f.root.id)
    f.packets.length = 0
    callbacks[0]!(event)
    await f.request(methods.TASK_LIST, f.root.id)
    expect(f.packets).toEqual([])
    const warn = spyOn(console, 'warn').mockImplementation(() => {})
    try {
      failRelease = true
      expect(await f.request(methods.TASK_UNSUBSCRIBE, latest.subscriptionId)).toBe(true)
      expect(await f.request(methods.TASK_UNSUBSCRIBE, latest.subscriptionId)).toBe(false)
      callbacks.at(-1)!(event)
      f.backend.tasks.transition(task.id, { status: 'running' })
      await f.request(methods.TASK_LIST, f.root.id)
      expect(live).toBe(1)
      expect(f.packets).toHaveLength(1)
      expect(f.packets[0]).toMatchObject({ clientId: f.quick.clientId, subscriptionId: b.subscriptionId })
      expect(warn).toHaveBeenCalledWith('[子任务协议] 订阅清理失败')
      failRelease = false
    } finally { warn.mockRestore() }
  })

  test('入口注销/物理断开释放实际订阅；失败装配与未知存储异常脱敏，不留下路由', async () => {
    const f = await open(), original = f.backend.taskController.subscribe.bind(f.backend.taskController)
    const callbacks: Array<(event: AgentTaskEvent) => void> = []
    let live = 0
    f.backend.taskController.subscribe = (client, callback) => {
      const release = original(client, callback); live += 1; callbacks.push(callback)
      return () => { release(); live -= 1 }
    }
    await f.subscribe(); await f.subscribe(f.quick)
    const task = f.createTask()
    await f.request(methods.TASK_LIST, f.root.id); f.packets.length = 0
    // core 直接注销也要撤销连接自己的代次，不能只覆盖显式 detach RPC 路径。
    f.backend.clients.detach(f.main.clientId)
    callbacks[0]!({ type: 'changed', rootSessionId: f.root.id, task })
    f.backend.tasks.transition(task.id, { status: 'running' })
    await f.request(methods.TASK_LIST, f.root.id, f.quick)
    expect(live).toBe(1); expect(f.packets.map((packet) => packet.clientId)).toEqual([f.quick.clientId])
    await expect(f.subscribe()).rejects.toMatchObject({ code: -32004 })
    const closed = [f.parent, f.child].map((peer) => new Promise<void>((resolve) => peer.onClose(() => resolve())))
    f.disconnect(); await Promise.all(closed)
    expect(live).toBe(0); expect(f.connection.closed).toBe(true)
    callbacks[1]!({ type: 'changed', rootSessionId: f.root.id, task })
    expect(f.packets).toHaveLength(1)
    const broken = await open()
    broken.backend.taskController.subscribe = () => { throw new Error(`sk-private ${broken.directory}`) }
    await expect(broken.subscribe()).rejects.toMatchObject({ code: -32603, message: 'RPC 请求处理失败' })
    expect(await broken.request(methods.TASK_UNSUBSCRIBE, 'missing')).toBe(false)
    broken.backend.taskController.list = () => { throw new Error(`sk-private ${broken.directory}`) }
    await expect(broken.request(methods.TASK_LIST, broken.root.id)).rejects.toMatchObject({ code: -32603, message: 'RPC 请求处理失败' })
  })

  test('真实前台子 Agent 审批只回原 owner；只读观察者即使知道 runId 也不能停止或答复', async () => {
    const f = await open()
    const channel = await f.backend.channels.create({ name: '隔离模型', provider: 'openai', apiKey: '', baseUrl: 'https://example.test/v1',
      models: [{ id: 'fixture', name: '夹具', enabled: true }] })
    const project = f.backend.projects.create({ name: '隔离项目' })
    const root = await f.request(methods.AGENT_CREATE_SESSION, { title: '派生任务', projectId: project.id, channelId: channel.id,
      modelId: 'fixture' }) as unknown as AgentSessionMeta
    await f.subscribe(f.quick)
    const requested = Promise.withResolvers<AppServerAgentRunEvent>(), approval = Promise.withResolvers<void>()
    let reverseCalls = 0
    f.parent.handle(reverse.AGENT_PERMISSION, async (params) => {
      const packet = params as unknown as AppServerAgentRunEvent
      reverseCalls += 1; requested.resolve(packet)
      await approval.promise
      const event = packet.event.event
      if (event.type !== 'permission_request') throw new Error('无效交互')
      return { requestId: event.request.requestId, behavior: 'allow' }
    })
    f.adapter.handler = async function* (input) {
      if (input.sessionId === root.id) {
        const delegate = input.customTools!.find((tool) => tool.name === 'Agent')!
        expect(await delegate.execute({ description: '子写任务', prompt: '写文件', subagent_type: 'coder' },
          { toolUseId: 'actual-delegate', signal: input.abortSignal })).not.toMatchObject({ isError: true })
      } else {
        expect(await input.canUseTool?.('Write', { path: 'result.txt' }, { toolUseId: 'child-write', executionPolicy: input.executionPolicy!,
          toolExecution: { kind: 'runtime' } })).toMatchObject({ behavior: 'allow' })
      }
      yield* success()
    }
    const pending = f.request(methods.AGENT_SEND, { sessionId: root.id, text: '委派任务' })
    const packet = await requested.promise
    await f.request(methods.TASK_LIST, root.id)
    expect(packet.clientId).toBe(f.main.clientId); expect(packet.event.run.sessionId).not.toBe(root.id)
    const observer = f.packets.find((item) => item.event.type === 'agent_event' && item.event.event.type === 'run_started')!
    expect(observer).toMatchObject({ clientId: f.quick.clientId, event: { run: packet.event.run, agentId: packet.event.run.sessionId } })
    expect(f.packets.some((item) => item.event.type === 'changed' && item.event.task.status === 'blocked'
      && item.event.task.blockedReason === 'permission')).toBe(true)
    expect(f.packets.some((item) => item.event.type === 'agent_event' && item.event.event.type === 'permission_request')).toBe(false)
    expect(await f.request(methods.AGENT_GET_RUN, packet.event.run.sessionId, f.quick)).toBeNull()
    expect(await f.request(methods.AGENT_STOP, { sessionId: packet.event.run.sessionId, runId: packet.event.run.runId }, f.quick)).toBe(false)
    const event = packet.event.event
    if (event.type !== 'permission_request') throw new Error('无效交互')
    expect(f.backend.agentRuns.respondRunPermission(f.quick.clientId, { ...packet.event.run,
      response: { requestId: event.request.requestId, behavior: 'deny' } })).toBe(false)
    await f.parent.request(methods.DETACH_CLIENT, { clientId: f.quick.clientId })
    expect(await f.request(methods.AGENT_GET_RUN, packet.event.run.sessionId)).toEqual(toWireValue(packet.event.run))
    approval.resolve()
    await pending
    expect(reverseCalls).toBe(1)
    expect((await f.request(methods.TASK_LIST, root.id) as unknown as AgentDelegation[])[0]?.status).toBe('completed')
    expect(f.persisted.length).toBeGreaterThan(0); expect(f.persisted.every(Boolean)).toBe(true)
  })

  test('后台子结果和后续主轮仍定向原入口；观察者收到完整子流与完成状态但不接管', async () => {
    const f = await open(), project = f.backend.projects.create({ name: '后台项目' })
    const channel = await f.backend.channels.create({ name: '隔离模型', provider: 'openai', apiKey: '',
      baseUrl: 'https://example.test/v1', models: [{ id: 'fixture', name: '夹具', enabled: true }] })
    const root = await f.request(methods.AGENT_CREATE_SESSION, { title: '后台派生', projectId: project.id,
      channelId: channel.id, modelId: 'fixture' }) as unknown as AgentSessionMeta
    await f.subscribe(f.quick)
    const started = Promise.withResolvers<void>(), finish = Promise.withResolvers<void>(), notified = Promise.withResolvers<void>()
    let calls = 0
    const runs: AppServerAgentRunEvent[] = []
    f.parent.handleNotification(notices.AGENT_RUN, (params) => {
      const packet = params as unknown as AppServerAgentRunEvent
      runs.push(packet)
      if (packet.event.event.type === 'run_finished' && packet.event.event.source === 'background_notification') notified.resolve()
    })
    f.adapter.handler = async function* (input) {
      if (input.sessionId !== root.id) { started.resolve(); await finish.promise }
      else if (++calls === 1) {
        const tool = input.customTools!.find((item) => item.name === 'Agent')!
        expect(await tool.execute({ description: '后台检查', prompt: '读取目录', subagent_type: 'explore', run_in_background: true },
          { toolUseId: 'background', signal: input.abortSignal })).not.toMatchObject({ isError: true })
      }
      yield* success()
    }
    await f.request(methods.AGENT_SEND, { sessionId: root.id, text: '后台委派' }); await started.promise
    expect(await f.request(methods.AGENT_GET_RUN, root.id)).toBeNull()
    finish.resolve(); await notified.promise
    const tasks = await f.request(methods.TASK_LIST, root.id) as unknown as AgentDelegation[]
    expect(tasks[0]?.status).toBe('completed'); expect(calls).toBe(2)
    expect(f.packets.every((packet) => packet.clientId === f.quick.clientId)).toBe(true)
    const events = f.packets.flatMap((packet) => packet.event.type === 'agent_event' ? [packet.event] : [])
    expect(events.some((item) => item.event.type === 'run_started' && item.run?.sessionId === tasks[0]!.childSessionId)).toBe(true)
    expect(events.some((item) => item.event.type === 'stream' && item.event.payload.kind === 'sdk_message'
      && item.event.payload.message.type === 'result')).toBe(true)
    expect(runs.every((packet) => packet.clientId === f.main.clientId)).toBe(true)
    expect(f.persisted.every(Boolean)).toBe(true)
  })

  test('已接纳订阅后取消响应等待不重建或回滚；下一次显式替换释放未知代次', async () => {
    const f = await open(), abort = new AbortController()
    const original = f.backend.taskController.subscribe.bind(f.backend.taskController)
    let created = 0, released = 0
    f.backend.taskController.subscribe = (client, listener) => {
      const release = original(client, listener)
      if (++created === 1) abort.abort()
      return () => { released += 1; release() }
    }
    const outcome = f.request(methods.TASK_SUBSCRIBE, undefined, f.main, abort.signal).catch((error: unknown) => error)
    expect(await outcome).toMatchObject({ code: 'canceled' })
    const task = f.createTask()
    await f.request(methods.TASK_LIST, f.root.id)
    expect(created).toBe(1); expect(released).toBe(0)
    expect(f.packets).toHaveLength(1)
    const unknown = f.packets[0]!.subscriptionId
    const current = await f.subscribe()
    expect(created).toBe(2); expect(released).toBe(1)
    expect(current.subscriptionId).not.toBe(unknown)
    expect(await f.request(methods.TASK_UNSUBSCRIBE, unknown)).toBe(false)
    f.packets.length = 0
    f.backend.tasks.transition(task.id, { status: 'running' })
    await f.request(methods.TASK_LIST, f.root.id)
    expect(f.packets).toHaveLength(1)
    expect(f.packets[0]!.subscriptionId).toBe(current.subscriptionId)
    expect(await f.request(methods.TASK_UNSUBSCRIBE, current.subscriptionId)).toBe(true)
    expect(released).toBe(2)
  })

  test('上游同步注销入口后取得的清理函数立即释放；旧回调不能进入新入口', async () => {
    const f = await open(), original = f.backend.taskController.subscribe.bind(f.backend.taskController)
    let late: ((event: AgentTaskEvent) => void) | undefined
    let released = 0
    f.backend.taskController.subscribe = (client, listener) => {
      late = listener
      const release = original(client, listener)
      f.backend.clients.detach(client)
      return () => { released += 1; release() }
    }
    await expect(f.subscribe()).rejects.toMatchObject({ code: -32004 })
    expect(released).toBe(1)
    const task = f.createTask()
    late!({ type: 'changed', rootSessionId: f.root.id, task })
    await f.request(methods.TASK_LIST, f.root.id, f.quick)
    expect(f.packets).toEqual([])
    expect(await f.request(methods.TASK_UNSUBSCRIBE, 'missing', f.quick)).toBe(false)
  })
})
