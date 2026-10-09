import { afterEach, describe, expect, test } from 'bun:test'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { PassThrough } from 'node:stream'
import { createBackend, createBackendPaths, createCredentialCodec } from '@axon/core'
import type { AxonBackend } from '@axon/core'
import { APP_SERVER_METHODS as methods, APP_SERVER_CLIENT_METHODS as reverse, APP_SERVER_NOTIFICATIONS as notices } from '@axon/shared'
import type { AgentProviderAdapter, AgentQueryInput, AgentStreamPayload, AgentSessionMeta,
  AppServerClient, AppServerAgentRunEvent, AppServerAgentQueueEvent, AppServerAgentMetadataEvent,
  AgentToolPermissionResult, RpcJsonObject, RpcJsonValue } from '@axon/shared'
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
  yield { kind: 'sdk_message', message: { type: 'assistant', message: { content: [{ type: 'text', text: '真实 core 回复' }] } } }
  yield { kind: 'sdk_message', message: { type: 'result', subtype: 'success' } }
}
async function waitForAbort(signal: AbortSignal): Promise<void> {
  if (signal.aborted) return
  await new Promise<void>((resolve) => signal.addEventListener('abort', () => resolve(), { once: true }))
}

/** 双端实际协议 + 真实 core/文件；模型用中立 adapter 夹具，不打开用户目录。 */
async function open(options: { validateCreate?: () => Promise<void>; titleGate?: Promise<void> } = {}) {
  const directory = mkdtempSync(join(tmpdir(), 'axon-agent-rpc-'))
  const upstream = new PassThrough()
  const downstream = new PassThrough()
  const parent = new JsonRpcPeer(downstream, upstream, { requestTimeoutMs: 2_000 })
  const child = new JsonRpcPeer(upstream, downstream, { requestTimeoutMs: 2_000 })
  const adapter = new Adapter()
  let backend: AxonBackend
  const connection = new AppServerConnection({ peer: child, bootstrap: () => {
    backend = createBackend({ paths: createBackendPaths({ dataDir: join(directory, 'data'), homeDir: directory }),
      applicationVersion: '0.1.3', credentialCodec: createCredentialCodec(), resolveAdapter: () => adapter,
      validateCreate: options.validateCreate,
      providerStream: async function* () {
        await options.titleGate
        yield { type: 'text_delta', delta: '自动标题' }
        yield { type: 'finish', reason: 'stop' }
      },
    })
    return { backend, applicationVersion: '0.1.3', capabilities: {
      runtimes: [], credentialStorage: 'unavailable', channelTargetConfirmation: false,
    } }
  } })
  cleanups.push(() => {
    connection.close(); parent.close(); upstream.destroy(); downstream.destroy()
    rmSync(directory, { recursive: true, force: true })
  })
  await parent.request(methods.INITIALIZE, { protocolVersion: 1, client: { name: 'axon-test', version: '0.1.3' },
    hostCapabilities: { credentialStorage: 'unavailable', channelTargetConfirmation: false } })
  const main = await parent.request(methods.REGISTER_CLIENT, { kind: 'main' }) as unknown as AppServerClient
  const quick = await parent.request(methods.REGISTER_CLIENT, { kind: 'quick' }) as unknown as AppServerClient
  const channel = await backend!.channels.create({ name: '隔离渠道', provider: 'openai', apiKey: '',
    baseUrl: 'https://example.test/v1', models: [{ id: 'fixture-model', name: '模型', enabled: true }] })
  const project = backend!.projects.create({ name: '隔离项目' })
  const events: AppServerAgentRunEvent[] = []
  const persisted: boolean[] = []
  const queues: AppServerAgentQueueEvent[] = []
  const metadata: AppServerAgentMetadataEvent[] = []
  parent.handleNotification(notices.AGENT_RUN, (params) => {
    const packet = params as unknown as AppServerAgentRunEvent
    const event = packet.event.event
    if (event.type === 'stream' && event.payload.kind === 'sdk_message'
      && ['user', 'assistant', 'result'].includes(event.payload.message.type)) {
      const message = event.payload.message
      const id = 'uuid' in message ? message.uuid : undefined
      persisted.push(Boolean(id) && backend!.sessions.getMessages(packet.event.run.sessionId)
        .some((stored) => 'uuid' in stored && stored.uuid === id))
    }
    events.push(packet)
  })
  parent.handleNotification(notices.AGENT_QUEUE, (params) => { queues.push(params as unknown as AppServerAgentQueueEvent) })
  parent.handleNotification(notices.AGENT_METADATA, (params) => { metadata.push(params as unknown as AppServerAgentMetadataEvent) })
  const request = (method: string, input?: RpcJsonValue, client = main, signal?: AbortSignal) => parent.request(method,
    { clientId: client.clientId, ...(input === undefined ? {} : { input }) }, { timeoutMs: 0, signal })
  const create = async (title?: string) => await request(methods.AGENT_CREATE_SESSION, {
    projectId: project.id, channelId: channel.id, modelId: 'fixture-model', ...(title ? { title } : {}),
  }) as unknown as AgentSessionMeta
  return { parent, child, backend: backend!, adapter, main, quick, request, create, events, queues, metadata, persisted }
}

describe('Agent 应用命令与原始轮次路由', () => {
  test('会话 CRUD 通过协议；拒绝自报 owner、恢复 artifact 和运行上下文，失败不改持久化', async () => {
    const f = await open()
    const session = await f.create('协议会话')
    expect(await f.request(methods.AGENT_LIST_SESSIONS)).toEqual(toWireValue([session]))
    expect(await f.request(methods.AGENT_GET_SESSION, session.id)).toEqual(toWireValue(session))
    expect(await f.request(methods.AGENT_UPDATE_SESSION, { sessionId: session.id, update: { title: '更新标题' } }))
      .toMatchObject({ title: '更新标题' })
    await expect(f.parent.request(methods.AGENT_LIST_SESSIONS, { clientId: f.main.clientId, input: {} })).rejects.toMatchObject({ code: -32602 })
    await expect(f.parent.request(methods.AGENT_GET_SESSION, { clientId: f.main.clientId, input: session.id, owner: f.quick.clientId }))
      .rejects.toMatchObject({ code: -32602 })
    await expect(f.request(methods.AGENT_UPDATE_SESSION, { sessionId: session.id, update: { runtimeSessionFile: '/private/fake' } }))
      .rejects.toMatchObject({ code: -32020, data: { code: 'invalid_input' } })
    expect(await f.request(methods.AGENT_SEND, { sessionId: session.id, text: '伪造', synthetic: true }))
      .toMatchObject({ success: false, code: 'invalid_input' })
    for (const field of ['owner', 'source', 'inputOrigin']) {
      expect(await f.request(methods.AGENT_SEND, { sessionId: session.id, text: '伪造来源', [field]: f.quick.clientId }))
        .toMatchObject({ success: false, code: 'invalid_input' })
    }
    expect(f.backend.sessions.getMessages(session.id)).toHaveLength(0)
    expect(await f.request(methods.AGENT_DELETE_SESSION, session.id)).toMatchObject({ id: session.id })
    expect(await f.request(methods.AGENT_GET_SESSION, session.id)).toBeNull()
  })

  test('一次发送先落盘后通知；主/快捷共享历史，来源由登记身份决定，发送结果不冒充模型终态', async () => {
    const f = await open()
    const session = await f.create('固定标题')
    expect(await f.request(methods.AGENT_SEND, { sessionId: session.id, text: '主入口' })).toEqual({ success: true, disposition: 'started' })
    expect(await f.request(methods.AGENT_SEND, { sessionId: session.id, text: '快捷入口' }, f.quick))
      .toEqual({ success: true, disposition: 'started' })
    const history = f.backend.sessions.getMessages(session.id)
    const users = history.filter((message) => message.type === 'user')
    expect(users).toHaveLength(2)
    expect(users[1]).toMatchObject({ inputOrigin: 'quick' })
    expect(history.filter((message) => message.type === 'result')).toHaveLength(2)
    expect(f.persisted).toHaveLength(6)
    expect(f.persisted.every(Boolean)).toBe(true)
    const starts = f.events.filter((item) => item.event.event.type === 'run_started')
    expect(starts.map((item) => item.clientId)).toEqual([f.main.clientId, f.quick.clientId])
    expect(starts[0]!.event.run.runId).not.toBe(starts[1]!.event.run.runId)
    for (const item of f.events) {
      expect(item.event.run.sessionId).toBe(session.id)
      expect(item.event.visibleSessionId).toBe(session.id)
    }
    expect(await f.request(methods.AGENT_GET_RUN, session.id)).toBeNull()
  })

  test('长发送仍可入队/调整/停止；清空快照只交给 owner，跨入口或旧 runId 不生效', async () => {
    const f = await open()
    const session = await f.create('队列')
    const started = Promise.withResolvers<void>()
    f.adapter.handler = async function* (input) { started.resolve(); await waitForAbort(input.abortSignal!); yield* success() }
    const running = f.request(methods.AGENT_SEND, { sessionId: session.id, text: '运行' })
    await started.promise
    const run = await f.request(methods.AGENT_GET_RUN, session.id) as RpcJsonObject
    expect(await f.request(methods.AGENT_GET_RUN, session.id, f.quick)).toBeNull()
    expect(await f.request(methods.AGENT_IS_ACTIVE, session.id, f.quick)).toBe(true)
    expect(await f.request(methods.AGENT_LIST_ACTIVE_RUNS, undefined, f.quick)).toEqual([
      { sessionId: session.id, runStartedAt: run.runStartedAt!, source: 'renderer' },
    ])
    await expect(f.request(methods.AGENT_IS_ACTIVE, { sessionId: session.id })).rejects.toMatchObject({ code: -32602 })
    await expect(f.request(methods.AGENT_LIST_ACTIVE_RUNS, {})).rejects.toMatchObject({ code: -32602 })
    const first = await f.request(methods.AGENT_SEND, { sessionId: session.id, text: '等待 A' }) as RpcJsonObject
    const second = await f.request(methods.AGENT_SEND, { sessionId: session.id, text: '等待 B' }) as RpcJsonObject
    const a = first.queuedMessage as RpcJsonObject
    const b = second.queuedMessage as RpcJsonObject
    expect(await f.request(methods.AGENT_MOVE_QUEUE, { sessionId: session.id, sourceId: b.id!, targetId: a.id!, placement: 'before' })).toBe(true)
    expect(await f.request(methods.AGENT_CANCEL_QUEUE, { sessionId: session.id, messageId: a.id! }, f.quick)).toBe(false)
    expect(await f.request(methods.AGENT_STOP, { sessionId: session.id, runId: run.runId! }, f.quick)).toBe(false)
    expect(await f.request(methods.AGENT_STOP, { sessionId: session.id, runId: 'old' })).toBe(false)
    expect(await f.request(methods.AGENT_STOP, { sessionId: session.id, runId: run.runId! })).toBe(true)
    await running
    expect(await f.request(methods.AGENT_IS_ACTIVE, session.id, f.quick)).toBe(false)
    expect(await f.request(methods.AGENT_LIST_ACTIVE_RUNS, undefined, f.quick)).toEqual([])
    expect(f.queues.every((item) => item.clientId === f.main.clientId)).toBe(true)
    expect(f.queues.at(-1)?.snapshot.messages).toEqual([])
    expect(f.backend.sessions.getMessages(session.id).filter((message) => message.type === 'user')).toHaveLength(1)
  })

  test('取消发送 RPC 只取消传输等待，不猜测业务交付；用真实轮次停止，不重发用户消息', async () => {
    const f = await open()
    const session = await f.create('取消等待')
    const started = Promise.withResolvers<AbortSignal>()
    f.adapter.handler = async function* (input) { started.resolve(input.abortSignal!); await waitForAbort(input.abortSignal!); yield* success() }
    const controller = new AbortController()
    const running = f.request(methods.AGENT_SEND, { sessionId: session.id, text: '只执行一次' }, f.main, controller.signal)
    const rejected = running.catch((error: unknown) => error)
    const signal = await started.promise
    controller.abort()
    expect(await rejected).toMatchObject({ code: 'canceled' })
    expect(signal.aborted).toBe(false)
    const run = await f.request(methods.AGENT_GET_RUN, session.id) as RpcJsonObject
    const finished = Promise.withResolvers<void>()
    const release = f.backend.agentRuns.subscribeRunEvents(f.main.clientId, (event) => { if (event.event.type === 'run_finished') finished.resolve() })
    expect(await f.request(methods.AGENT_STOP, { sessionId: session.id, runId: run.runId! })).toBe(true)
    await finished.promise
    release()
    expect(f.backend.sessions.getMessages(session.id).filter((message) => message.type === 'user')).toHaveLength(1)
  })

  test('标题晚于 send 返回仍向两个登记入口广播，注销后的入口不再收到', async () => {
    const gate = Promise.withResolvers<void>()
    const f = await open({ titleGate: gate.promise })
    const session = await f.create()
    await f.request(methods.AGENT_SEND, { sessionId: session.id, text: '生成标题' })
    expect(f.metadata).toHaveLength(0)
    await f.parent.request(methods.DETACH_CLIENT, { clientId: f.quick.clientId })
    const title = Promise.withResolvers<void>()
    const release = f.backend.agentRuns.subscribeSessionMetadata(() => title.resolve())
    gate.resolve()
    await title.promise
    release()
    expect(f.metadata.map((item) => item.clientId)).toEqual([f.main.clientId])
    expect(f.backend.sessions.get(session.id)?.title).toBe('自动标题')
  })

  test('创建的异步预检被取消或入口注销后，迟到成功不创建会话', async () => {
    for (const detach of [false, true]) {
      const gate = Promise.withResolvers<void>()
      const entered = Promise.withResolvers<void>()
      const f = await open({ validateCreate: async () => { entered.resolve(); await gate.promise } })
      const controller = new AbortController()
      const creating = f.request(methods.AGENT_CREATE_SESSION, {}, f.main, controller.signal)
      const rejected = creating.catch((error: unknown) => error)
      await entered.promise
      if (detach) await f.parent.request(methods.DETACH_CLIENT, { clientId: f.main.clientId })
      else controller.abort()
      gate.resolve()
      expect(await rejected).toBeDefined()
      await Bun.sleep(0)
      expect(f.backend.sessions.list()).toHaveLength(0)
    }
  })
})

describe('Agent 反向审批与追问', () => {
  test('反向请求允许/回答直接回到工具；只包含一次交互，结果照常保存', async () => {
    const f = await open()
    const session = await f.create('交互')
    const targets: AppServerAgentRunEvent[] = []
    f.parent.handle(reverse.AGENT_PERMISSION, (params) => {
      const packet = params as unknown as AppServerAgentRunEvent
      targets.push(packet)
      const event = packet.event.event
      if (event.type !== 'permission_request') throw new Error('错误请求')
      return { requestId: event.request.requestId, behavior: 'allow' }
    })
    f.parent.handle(reverse.AGENT_ASK_USER, (params) => {
      const packet = params as unknown as AppServerAgentRunEvent
      targets.push(packet)
      const event = packet.event.event
      if (event.type !== 'ask_user_request') throw new Error('错误请求')
      return { requestId: event.request.requestId, behavior: 'answer', answers: { '选择目录？': '使用当前目录' } }
    })
    f.adapter.handler = async function* (input) {
      expect(await input.canUseTool?.('Write', { path: 'result.txt' }, { toolUseId: 'write',
        executionPolicy: input.executionPolicy!, toolExecution: { kind: 'runtime' } })).toMatchObject({ behavior: 'allow' })
      const ask = input.customTools!.find((tool) => tool.name === 'AskUserQuestion')!
      expect(await ask.execute({ questions: [{ question: '选择目录？', options: [] }] }, { toolUseId: 'ask' }))
        .toMatchObject({ content: { answers: { '选择目录？': '使用当前目录' } } })
      yield* success()
    }
    await f.request(methods.AGENT_SEND, { sessionId: session.id, text: '交互' })
    expect(targets).toHaveLength(2)
    expect(targets.every((packet) => packet.clientId === f.main.clientId && packet.event.run.sessionId === session.id)).toBe(true)
    expect(f.events.some((packet) => ['permission_request', 'ask_user_request'].includes(packet.event.event.type))).toBe(false)
    expect(f.events.filter((packet) => ['permission_resolved', 'ask_user_resolved'].includes(packet.event.event.type))).toHaveLength(2)
    expect(f.backend.sessions.getMessages(session.id).at(-1)).toMatchObject({ type: 'result', subtype: 'success' })
  })

  test('缺少反向方法/异常/错误 requestId 或非法响应均拒绝，不悬挂也不透传宿主异常', async () => {
    for (const behavior of ['missing', 'error', 'wrong-id', 'invalid']) {
      const f = await open()
      const session = await f.create('失败交互')
      if (behavior !== 'missing') f.parent.handle(reverse.AGENT_PERMISSION, (params) => {
        if (behavior === 'error') throw new Error('sk-private')
        const packet = params as unknown as AppServerAgentRunEvent
        const event = packet.event.event
        if (event.type !== 'permission_request') throw new Error('错误请求')
        return { requestId: behavior === 'wrong-id' ? 'foreign' : event.request.requestId,
          behavior: 'allow', ...(behavior === 'invalid' ? { owner: f.quick.clientId } : {}) }
      })
      f.adapter.handler = async function* (input) {
        expect(await input.canUseTool?.('Write', {}, { toolUseId: 'write', executionPolicy: input.executionPolicy!,
          toolExecution: { kind: 'runtime' } })).toMatchObject({ behavior: 'deny' })
        // 父端未实现追问方法时也应及时取消，不能留下永久等待的工具 Promise。
        const ask = input.customTools!.find((tool) => tool.name === 'AskUserQuestion')!
        expect(await ask.execute({ questions: [{ question: '缺失交互能力？', options: [] }] }, { toolUseId: 'missing-ask' }))
          .toMatchObject({ isError: true })
        yield* success()
      }
      await f.request(methods.AGENT_SEND, { sessionId: session.id, text: '交互失败' })
      expect(JSON.stringify(f.events)).not.toContain('sk-private')
    }
  })

  test('注销撤销父端等待，迟到批准不执行；只取消所属交互，不影响另一个入口', async () => {
    const f = await open()
    const first = await f.create('第一会话')
    const second = await f.create('第二会话')
    const requests = new Map([first.id, second.id].map((id) => [id, Promise.withResolvers<AbortSignal>()]))
    const gates = new Map([first.id, second.id].map((id) => [id, Promise.withResolvers<void>()]))
    const results: AgentToolPermissionResult[] = []
    f.parent.handle(reverse.AGENT_PERMISSION, async (params, { signal }) => {
      const packet = params as unknown as AppServerAgentRunEvent
      const event = packet.event.event
      if (event.type !== 'permission_request') throw new Error('错误请求')
      requests.get(packet.event.run.sessionId)!.resolve(signal)
      await gates.get(packet.event.run.sessionId)!.promise
      return { requestId: event.request.requestId, behavior: 'allow' }
    })
    f.adapter.handler = async function* (input) {
      results.push((await input.canUseTool?.('Write', {}, { toolUseId: 'write', executionPolicy: input.executionPolicy!,
        toolExecution: { kind: 'runtime' } }))!)
      yield* success()
    }
    const a = f.request(methods.AGENT_SEND, { sessionId: first.id, text: '第一' })
    const b = f.request(methods.AGENT_SEND, { sessionId: second.id, text: '第二' }, f.quick)
    const firstSignal = await requests.get(first.id)!.promise
    const secondSignal = await requests.get(second.id)!.promise
    await f.parent.request(methods.DETACH_CLIENT, { clientId: f.main.clientId })
    expect(firstSignal.aborted).toBe(true)
    expect(secondSignal.aborted).toBe(false)
    gates.get(first.id)!.resolve()
    await a
    gates.get(second.id)!.resolve()
    await b
    expect(results.map((result) => result.behavior)).toEqual(['deny', 'allow'])
    expect(f.backend.sessions.getMessages(first.id).some((message) => message.type === 'result' && message.subtype === 'success')).toBe(false)
  })

  test('追问等待期间可精确停止，父端收到取消信号；迟到答案不能进入下一轮', async () => {
    const f = await open()
    const session = await f.create('停止追问')
    const asked = Promise.withResolvers<AbortSignal>()
    const gate = Promise.withResolvers<void>()
    f.parent.handle(reverse.AGENT_ASK_USER, async (params, { signal }) => {
      const packet = params as unknown as AppServerAgentRunEvent
      const event = packet.event.event
      if (event.type !== 'ask_user_request') throw new Error('错误请求')
      asked.resolve(signal)
      await gate.promise
      return { requestId: event.request.requestId, behavior: 'answer', answers: { '继续吗？': '过期答案' } }
    })
    f.adapter.handler = async function* (input) {
      const ask = input.customTools!.find((tool) => tool.name === 'AskUserQuestion')!
      expect(await ask.execute({ questions: [{ question: '继续吗？', options: [] }] }, { toolUseId: 'ask' }))
        .toMatchObject({ isError: true })
      yield* success()
    }
    const running = f.request(methods.AGENT_SEND, { sessionId: session.id, text: '等待回答' })
    const signal = await asked.promise
    const run = await f.request(methods.AGENT_GET_RUN, session.id) as RpcJsonObject
    expect(await f.request(methods.AGENT_STOP, { sessionId: session.id, runId: run.runId! })).toBe(true)
    await running
    expect(signal.aborted).toBe(true)
    f.adapter.handler = async function* () { yield* success() }
    await f.request(methods.AGENT_SEND, { sessionId: session.id, text: '新一轮' })
    gate.resolve()
    await Bun.sleep(0)
    expect(JSON.stringify(f.backend.sessions.getMessages(session.id))).not.toContain('过期答案')
    expect(f.backend.sessions.getMessages(session.id).filter((message) => message.type === 'result' && message.subtype === 'success')).toHaveLength(1)
  })

  test('父发送已结束后，后台子结果触发新轮，定向回原入口而非另一个已登记窗口', async () => {
    const f = await open()
    const root = await f.create('后台父会话')
    const childStarted = Promise.withResolvers<void>()
    const gate = Promise.withResolvers<void>()
    const notified = Promise.withResolvers<void>()
    const release = f.backend.agentRuns.subscribeRunEvents(f.main.clientId, (packet) => {
      if (packet.event.type === 'run_finished' && packet.event.source === 'background_notification') notified.resolve()
    })
    let rootCalls = 0
    f.adapter.handler = async function* (input) {
      if (input.sessionId !== root.id) { childStarted.resolve(); await gate.promise }
      else if (++rootCalls === 1) {
        const tool = input.customTools!.find((item) => item.name === 'Agent')!
        expect(await tool.execute({ description: '后台任务', prompt: '独立只读检查', subagent_type: 'explore', run_in_background: true },
          { toolUseId: 'background', signal: input.abortSignal })).not.toMatchObject({ isError: true })
      }
      yield* success()
    }
    await f.request(methods.AGENT_SEND, { sessionId: root.id, text: '派生后台任务' })
    await childStarted.promise
    expect(await f.request(methods.AGENT_GET_RUN, root.id)).toBeNull()
    gate.resolve()
    await notified.promise
    release()
    expect(rootCalls).toBe(2)
    const packets = f.events.filter((packet) => 'source' in packet.event.event && packet.event.event.source === 'background_notification')
    expect(packets.length).toBeGreaterThan(0)
    expect(packets.every((packet) => packet.clientId === f.main.clientId)).toBe(true)
    expect(f.backend.tasks.list(root.id)[0]?.status).toBe('completed')
  })

  test('子 Agent 审批包保留 child runId，页面归属为 root，答复回到 child 不改写父身份', async () => {
    const f = await open()
    const root = await f.create('主会话')
    const requests: AppServerAgentRunEvent[] = []
    f.parent.handle(reverse.AGENT_PERMISSION, (params) => {
      const packet = params as unknown as AppServerAgentRunEvent
      requests.push(packet)
      const event = packet.event.event
      if (event.type !== 'permission_request') throw new Error('错误请求')
      return { requestId: event.request.requestId, behavior: 'allow' }
    })
    f.adapter.handler = async function* (input) {
      if (input.sessionId === root.id) {
        const tool = input.customTools!.find((item) => item.name === 'Agent')!
        expect(await tool.execute({ description: '写子文件', prompt: '单一任务', subagent_type: 'coder' },
          { toolUseId: 'delegate', signal: input.abortSignal })).not.toMatchObject({ isError: true })
      } else {
        expect(await input.canUseTool?.('Write', {}, { toolUseId: 'child-write', executionPolicy: input.executionPolicy!,
          toolExecution: { kind: 'runtime' } })).toMatchObject({ behavior: 'allow' })
      }
      yield* success()
    }
    await f.request(methods.AGENT_SEND, { sessionId: root.id, text: '委派' })
    expect(requests).toHaveLength(1)
    const packet = requests[0]!
    expect(packet.clientId).toBe(f.main.clientId)
    expect(packet.event.run.sessionId).not.toBe(root.id)
    expect(packet.event.visibleSessionId).toBe(root.id)
    const rootStart = f.events.find((item) => item.event.event.type === 'run_started' && item.event.run.sessionId === root.id)!
    expect(packet.event.run.runId).not.toBe(rootStart.event.run.runId)
    expect(f.backend.tasks.list(root.id)[0]?.status).toBe('completed')
  })
})
