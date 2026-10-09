import { afterEach, describe, expect, spyOn, test } from 'bun:test'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type { AgentGenerationEvent, AgentProviderAdapter, AgentQueryInput, AgentStreamPayload, BackendOwnedRun, BackendAgentRunEvent } from '@axon/shared'
import { createBackend, createBackendPaths } from '../index'
import type { BackendOptions } from '../index'
import { createFixtureCredentialCodec } from '../../test-support/credential-codec'

const cleanups: Array<() => void> = []
afterEach(() => { for (const cleanup of cleanups.splice(0).reverse()) cleanup() })

class ScriptedAdapter implements AgentProviderAdapter {
  handler: (input: AgentQueryInput) => AsyncIterable<AgentStreamPayload> = async function* () {}
  query(input: AgentQueryInput): AsyncIterable<AgentStreamPayload> { return this.handler(input) }
  abort(): void {}
  dispose(): void {}
  async drain(): Promise<void> {}
}

function deferred<T>() {
  let resolve: (value: T) => void = () => {}
  const promise = new Promise<T>((finish) => { resolve = finish })
  return { promise, resolve }
}

async function* success(text: string): AsyncIterable<AgentStreamPayload> {
  yield { kind: 'sdk_message', message: { type: 'assistant', message: { content: [{ type: 'text', text }] }, parent_tool_use_id: null } }
  yield { kind: 'sdk_message', message: { type: 'result', subtype: 'success' } }
}

/** 用真实后端和真实交互服务，只替换 Runtime；注册身份与业务负载分开传递。 */
async function open(validateRuntimeSession?: BackendOptions['validateRuntimeSession']) {
  const directory = mkdtempSync(join(tmpdir(), 'axon-core-coordinator-'))
  cleanups.push(() => rmSync(directory, { recursive: true, force: true }))
  const adapter = new ScriptedAdapter()
  const backend = createBackend({
    paths: createBackendPaths({ dataDir: join(directory, 'data'), homeDir: directory }), applicationVersion: '0.1.3',
    credentialCodec: createFixtureCredentialCodec(), resolveAdapter: () => adapter,
    validateRuntimeSession,
  })
  const { clients, permissions, askUsers, agentRuns: coordinator } = backend
  const owner = clients.register()
  const other = clients.register()
  cleanups.push(() => backend.dispose())
  const channel = await backend.channels.create({ name: '隔离渠道', provider: 'openai', baseUrl: 'https://example.test/v1',
    apiKey: 'fixture-secret', models: [{ id: 'fixture-model', name: '夹具模型', enabled: true }] })
  const project = backend.projects.create({ name: '隔离项目' })
  const session = backend.sessions.create({ title: '命名会话', projectId: project.id, channelId: channel.id, modelId: 'fixture-model' })
  return { backend, coordinator, clients, owner, other, permissions, askUsers, adapter, session }
}

describe('非 Electron 入口的 Agent 运行协调', () => {
  test('运行预检期已有真实身份，精确停止不会写入半轮历史或在迟到预检后启动模型', async () => {
    const validate = deferred<void>()
    const { backend, coordinator, adapter, owner, other, session } = await open(() => validate.promise)
    let queries = 0
    adapter.handler = async function* () { queries += 1; yield* success('不应执行') }
    const send = coordinator.send(owner, { sessionId: session.id, text: '等待预检' }, () => {})
    const run = coordinator.getOwnedRun(owner, session.id)!
    expect(run.runId).toBeString()
    expect(backend.agent.getActiveRun(session.id)).toEqual(run)
    expect(backend.sessions.getMessages(session.id)).toEqual([])
    // 控制 DTO 不接受事件时间戳，也不允许省略轮次。
    expect(coordinator.stopRun(owner, { sessionId: session.id })).toBe(false)
    const target = { sessionId: run.sessionId, runId: run.runId }
    expect(coordinator.stopRun(other, target)).toBe(false)
    expect(coordinator.stopRun(owner, target)).toBe(true)
    expect(await send).toMatchObject({ success: false })
    expect(coordinator.getOwnedRun(owner, session.id)).toBeUndefined()
    validate.resolve()
    await Promise.resolve()
    expect(queries).toBe(0)
    expect(backend.sessions.getMessages(session.id)).toEqual([])
    expect(coordinator.stopRun(owner, target)).toBe(false)
  })

  test('旧轮次不能停止或答复下一轮；事件始末使用执行层的同一个 ID', async () => {
    const { backend, coordinator, adapter, owner, other, session } = await open()
    const events: BackendAgentRunEvent[] = []
    const foreignEvents: BackendAgentRunEvent[] = []
    const permissionReady = deferred<BackendAgentRunEvent>()
    const questionReady = deferred<BackendAgentRunEvent>()
    expect(() => coordinator.subscribeRunEvents('未登记', () => {})).toThrow()
    const release = coordinator.subscribeRunEvents(owner, (event) => {
      events.push(event)
      if (event.event.type === 'permission_request') permissionReady.resolve(event)
      if (event.event.type === 'ask_user_request') questionReady.resolve(event)
    })
    coordinator.subscribeRunEvents(other, (event) => { foreignEvents.push(event) })
    adapter.handler = async function* (input) {
      if (input.prompt === '下一轮') {
        await input.canUseTool?.('Write', {}, { toolUseId: 'write', executionPolicy: input.executionPolicy!,
          toolExecution: { kind: 'runtime' } })
        await input.customTools?.find((tool) => tool.name === 'AskUserQuestion')?.execute({
          questions: [{ question: '选什么?', options: [{ label: 'A' }] }],
        }, { toolUseId: 'question' })
      }
      yield* success('完成')
    }
    await coordinator.send(owner, { sessionId: session.id, text: '第一轮' }, () => {})
    const old = events[0]!.run
    const send = coordinator.send(owner, { sessionId: session.id, text: '下一轮' }, () => {})
    const permission = await permissionReady.promise
    if (permission.event.type !== 'permission_request') throw new Error('预期审批')
    const current = permission.run
    expect(current.runId).not.toBe(old.runId)
    expect(current).toEqual(backend.agent.getActiveRun(session.id)!)
    const response = { requestId: permission.event.request.requestId, behavior: 'deny' }
    const target = { sessionId: session.id, runId: current.runId }
    expect(coordinator.stopRun(owner, { ...target, runId: old.runId })).toBe(false)
    expect(coordinator.respondRunPermission(owner, { ...target, runId: old.runId, response })).toBe(false)
    expect(coordinator.respondRunPermission(other, { ...target, response })).toBe(false)
    expect(coordinator.respondRunPermission(owner, { ...target, response, owner })).toBe(false)
    expect(coordinator.respondRunPermission(owner, { ...target, sessionId: '其他会话', response })).toBe(false)
    const before = events.length
    backend.events.emit({ type: 'run_started', sessionId: session.id, runStartedAt: current.runStartedAt, source: 'renderer' })
    expect(events).toHaveLength(before)
    expect(coordinator.respondRunPermission(owner, { ...target, response })).toBe(true)
    expect(coordinator.respondRunPermission(owner, { ...target, response })).toBe(false)
    const question = await questionReady.promise
    if (question.event.type !== 'ask_user_request') throw new Error('预期追问')
    const answer = { requestId: question.event.request.requestId, behavior: 'answer', answers: { '选什么?': 'A' } }
    expect(coordinator.respondRunAskUser(owner, { ...target, runId: old.runId, response: answer })).toBe(false)
    expect(coordinator.respondRunAskUser(owner, { ...target, response: { ...answer, requestId: response.requestId } })).toBe(false)
    expect(coordinator.respondRunAskUser(other, { ...target, response: answer })).toBe(false)
    expect(coordinator.respondRunAskUser(owner, { ...target, response: answer })).toBe(true)
    await send
    expect(coordinator.respondRunAskUser(owner, { ...target, response: answer })).toBe(false)
    expect(foreignEvents).toEqual([])
    for (const run of [old, current]) {
      const round = events.filter((event) => event.run.runId === run.runId)
      expect(round[0]?.event.type).toBe('run_started')
      expect(round.at(-1)?.event.type).toBe('run_finished')
      expect(round.every((event) => event.run.sessionId === session.id && event.run.runStartedAt === run.runStartedAt)).toBe(true)
    }
    release()
  })

  test('用户消息落盘失败仍投递带真实身份的完成包，不伪造成功或当前运行', async () => {
    const { backend, coordinator, owner, session } = await open()
    const events: BackendAgentRunEvent[] = []
    coordinator.subscribeRunEvents(owner, (event) => { events.push(event) })
    const append = spyOn(backend.sessions, 'appendMessage').mockImplementation(() => { throw new Error('写入失败') })
    const result = await coordinator.send(owner, { sessionId: session.id, text: '不能落盘' }, () => {})
    append.mockRestore()
    expect(result.success).toBe(false)
    expect(events).toHaveLength(1)
    expect(events[0]).toMatchObject({ run: { sessionId: session.id }, visibleSessionId: session.id,
      event: { type: 'run_finished', completion: { persisted: false } } })
    expect(events[0]!.run.runId).toBeString()
    expect(coordinator.getOwnedRun(owner, session.id)).toBeUndefined()
    expect(backend.sessions.getMessages(session.id)).toEqual([])
  })

  test('精确停止一个真实子轮不误停父轮或同级任务，取消后仍投递该子轮终态', async () => {
    const { backend, coordinator, adapter, clients, owner, other, session } = await open()
    const pendingReady = deferred<void>()
    const parentFinish = deferred<void>()
    const envelopes: BackendAgentRunEvent[] = []
    const permissions: BackendAgentRunEvent[] = []
    coordinator.subscribeRunEvents(owner, (event) => {
      envelopes.push(event)
      if (event.event.type === 'permission_request') {
        permissions.push(event)
        if (permissions.length === 2) pendingReady.resolve()
      }
    })
    let queries = 0
    adapter.handler = async function* (input) {
      queries += 1
      if (input.sessionId !== session.id) {
        await input.canUseTool?.('Write', {}, { toolUseId: 'write', executionPolicy: input.executionPolicy!,
          toolExecution: { kind: 'runtime' } })
        yield* success('子任务结果')
        return
      }
      const delegate = input.customTools?.find((tool) => tool.name === 'Agent')!
      for (const index of [1, 2]) {
        await delegate.execute({ description: `子任务 ${index}`, prompt: `检查 ${index}`,
          subagent_type: 'coder', run_in_background: true }, { toolUseId: `child-${index}`, signal: input.abortSignal })
      }
      await parentFinish.promise
      yield* success('父任务结果')
    }
    const send = coordinator.send(owner, { sessionId: session.id, text: '派生两个任务' }, () => {})
    await pendingReady.promise
    const first = permissions[0]!.run
    const second = permissions[1]!.run
    const parent = coordinator.getOwnedRun(owner, session.id)!
    const firstTarget = { sessionId: first.sessionId, runId: first.runId }
    expect(coordinator.stopRun(other, firstTarget)).toBe(false)
    expect(coordinator.stopRun(owner, { ...firstTarget, runId: parent.runId })).toBe(false)
    expect(coordinator.stopRun(owner, firstTarget)).toBe(true)
    await backend.agent.waitUntilIdle(first.sessionId)
    expect(coordinator.stopRun(owner, firstTarget)).toBe(false)
    expect(backend.agent.isActive(session.id)).toBe(true)
    expect(coordinator.getOwnedRun(owner, second.sessionId)).toEqual(second)
    expect(envelopes.filter((event) => event.run.runId === first.runId).at(-1)).toMatchObject({
      visibleSessionId: session.id, event: { type: 'run_finished', completion: { stoppedByUser: true } },
    })
    const pending = permissions[1]!.event
    if (pending.type !== 'permission_request') throw new Error('预期审批')
    expect(coordinator.respondRunPermission(owner, { sessionId: second.sessionId, runId: second.runId,
      response: { requestId: pending.request.requestId, behavior: 'allow' } })).toBe(true)
    const secondTask = backend.tasks.list(session.id).find((task) => task.childSessionId === second.sessionId)!
    expect((await backend.collaboration.wait(session.id, secondTask.id)).status).toBe('completed')
    expect(backend.tasks.list(session.id).find((task) => task.childSessionId === first.sessionId)?.status).toBe('canceled')
    // 结束入口后放行夹具父轮；已完成子任务的等待通知不能增加一次模型请求。
    clients.detach(owner)
    parentFinish.resolve()
    await send
    expect(queries).toBe(3)
  })

  test.each(['deliver', 'disconnect'] as const)('真实后台子任务固定发起入口；其他入口接管期间 %s', async (mode) => {
    const { backend, coordinator, adapter, clients, owner, other, session } = await open()
    const childGate = deferred<void>()
    const permissionReady = deferred<AgentGenerationEvent>()
    const otherReady = deferred<void>()
    const otherFinish = deferred<void>()
    const notificationFinished = deferred<void>()
    const originEvents: AgentGenerationEvent[] = []
    const otherEvents: AgentGenerationEvent[] = []
    const envelopes: BackendAgentRunEvent[] = []
    coordinator.subscribeRunEvents(owner, (event) => { envelopes.push(event) })
    let notificationQueries = 0
    let childDecision: string | undefined
    let statusAtPermission: string | undefined
    adapter.handler = async function* (input) {
      if (input.sessionId !== session.id) {
        await childGate.promise
        childDecision = (await input.canUseTool?.('Write', { file_path: 'child.txt' }, {
          toolUseId: 'child-write', executionPolicy: input.executionPolicy!, toolExecution: { kind: 'runtime' },
        }))?.behavior
        yield* success('后台结果')
        return
      }
      if (input.prompt === '派生后台任务') {
        const delegate = input.customTools?.find((tool) => tool.name === 'Agent')
        if (!delegate) throw new Error('缺少 Agent 工具')
        const result = await delegate.execute({ description: '后台检查', prompt: '检查文件',
          subagent_type: 'coder', run_in_background: true }, { toolUseId: 'background', signal: input.abortSignal })
        if (result.isError) throw new Error('后台派生失败')
      } else if (input.prompt === '另一个入口的输入') {
        otherReady.resolve()
        await otherFinish.promise
      } else if (input.prompt.includes('<system-reminder>')) {
        notificationQueries += 1
      }
      yield* success('主会话回复')
    }
    await coordinator.send(owner, { sessionId: session.id, text: '派生后台任务' }, (event) => {
      originEvents.push(event)
      if (event.type === 'permission_request') {
        statusAtPermission = backend.tasks.list(session.id).find((task) => task.childSessionId === event.request.sessionId)?.status
        permissionReady.resolve(event)
      }
      if (event.type === 'run_finished' && event.source === 'background_notification') notificationFinished.resolve()
    })
    const task = backend.tasks.list(session.id)[0]!
    expect(task.runInBackground).toBe(true)
    const next = coordinator.send(other, { sessionId: session.id, text: '另一个入口的输入' }, (event) => { otherEvents.push(event) })
    await otherReady.promise
    childGate.resolve()
    const permission = await permissionReady.promise
    if (permission.type !== 'permission_request') throw new Error('预期子任务审批')
    expect(permission.sessionId).toBe(session.id)
    expect(permission.request.sessionId).toBe(task.childSessionId)
    expect(statusAtPermission).toBe('blocked')
    expect(otherEvents.filter((event) => event.type === 'permission_request')).toEqual([])
    const childRun = coordinator.getOwnedRun(owner, task.childSessionId)!
    const rootRun = coordinator.getOwnedRun(other, session.id)!
    expect(childRun.sessionId).toBe(task.childSessionId)
    expect(childRun.runId).not.toBe(rootRun.runId)
    const response = { requestId: permission.request.requestId, behavior: 'allow' }
    const reply = { sessionId: childRun.sessionId, runId: childRun.runId, response }
    expect(coordinator.respondRunPermission(other, reply)).toBe(false)
    expect(coordinator.respondRunPermission(owner, { ...reply, sessionId: session.id })).toBe(false)
    expect(coordinator.respondRunPermission(owner, reply)).toBe(true)
    expect((await backend.collaboration.wait(session.id, task.id)).status).toBe('completed')
    expect(childDecision).toBe('allow')
    expect(notificationQueries).toBe(0)
    if (mode === 'disconnect') clients.detach(owner)
    otherFinish.resolve()
    await next
    if (mode === 'deliver') await notificationFinished.promise
    await backend.agent.waitUntilIdle(session.id)
    expect(notificationQueries).toBe(mode === 'deliver' ? 1 : 0)
    expect(otherEvents.filter((event) => 'source' in event && event.source === 'background_notification')).toEqual([])
    expect(backend.tasks.get(task.id)?.status).toBe('completed')
    expect(backend.permissions.getOwner(task.childSessionId)).toBeUndefined()
    const childEvents = envelopes.filter((event) => event.run.sessionId === task.childSessionId)
    expect(childEvents[0]?.event.type).toBe('run_started')
    expect(childEvents.at(-1)?.event.type).toBe('run_finished')
    expect(childEvents.every((event) => event.run.runId === childRun.runId && event.visibleSessionId === session.id)).toBe(true)
    expect(childEvents.find((event) => event.event.type === 'permission_request')?.event.sessionId).toBe(task.childSessionId)
  })

  test('父轮结束后入口断开仍取消真实活动子任务，拒绝 pending 且不启动后台续跑', async () => {
    const { backend, coordinator, adapter, clients, owner, session } = await open()
    const pendingReady = deferred<AgentGenerationEvent>()
    let queries = 0
    let decision: string | undefined
    adapter.handler = async function* (input) {
      queries += 1
      if (input.sessionId !== session.id) {
        decision = (await input.canUseTool?.('Write', {}, { toolUseId: 'child-write',
          executionPolicy: input.executionPolicy!, toolExecution: { kind: 'runtime' } }))?.behavior
        yield* success('断开后的迟到结果')
        return
      }
      const delegate = input.customTools?.find((tool) => tool.name === 'Agent')!
      await delegate.execute({ description: '检查', prompt: '检查文件', subagent_type: 'coder', run_in_background: true },
        { toolUseId: 'background', signal: input.abortSignal })
      yield* success('父轮完成')
    }
    await coordinator.send(owner, { sessionId: session.id, text: '后台检查' }, (event) => {
      if (event.type === 'permission_request') pendingReady.resolve(event)
    })
    await pendingReady.promise
    const task = backend.tasks.list(session.id)[0]!
    expect(backend.tasks.get(task.id)?.status).toBe('blocked')
    expect(backend.agent.isActive(session.id)).toBe(false)
    clients.detach(owner)
    await backend.agent.waitUntilIdle(task.childSessionId)
    expect(decision).toBe('deny')
    expect(backend.tasks.get(task.id)?.status).toBe('canceled')
    expect(backend.sessions.getMessages(task.childSessionId).at(-1)).toMatchObject({ terminal_reason: 'stopped' })
    expect(queries).toBe(2)
    expect(backend.permissions.getOwner(task.childSessionId)).toBeUndefined()
  })

  test('拒绝未登记身份和自报 owner；按队列顺序执行，每轮产生独立 runId', async () => {
    const { backend, coordinator, adapter, clients, owner, other, session } = await open()
    expect(process.versions.electron).toBeUndefined()
    expect(await coordinator.send('伪造客户端', { sessionId: session.id, text: '不能落盘' }, () => {}))
      .toMatchObject({ success: false, code: 'invalid_input' })
    expect(await coordinator.send(owner, { sessionId: session.id, text: '不能指定 owner', owner: other }, () => {}))
      .toMatchObject({ success: false, code: 'invalid_input' })
    expect(backend.sessions.getMessages(session.id)).toEqual([])
    const ready = deferred<void>()
    const finish = deferred<void>()
    const prompts: string[] = []
    const runs: BackendOwnedRun[] = []
    adapter.handler = async function* (input) {
      prompts.push(input.prompt)
      if (input.prompt === '第一条') { ready.resolve(); await finish.promise }
      yield* success(input.prompt)
    }
    const send = coordinator.send(owner, { sessionId: session.id, text: '第一条' }, (event) => {
      if (event.type === 'run_started') {
        const run = coordinator.getOwnedRun(owner, session.id)
        if (run) runs.push(run)
      }
    })
    await ready.promise
    const queued = await coordinator.send(owner, { sessionId: session.id, text: '第二条' }, () => {})
    expect(queued).toMatchObject({ success: true, disposition: 'queued' })
    expect(coordinator.listQueuedMessages(other, session.id)).toEqual([])
    expect(coordinator.stop(other, session.id)).toBe(false)
    expect(coordinator.getOwnedRun(other, session.id)).toBeUndefined()
    finish.resolve()
    expect(await send).toMatchObject({ success: true, disposition: 'started' })
    expect(prompts).toEqual(['第一条', '第二条'])
    expect(runs).toHaveLength(2)
    expect(runs[0]?.runId).not.toBe(runs[1]?.runId)
    expect(runs[0]?.runStartedAt).toBeLessThan(runs[1]!.runStartedAt)
    expect(coordinator.getOwnedRun(owner, session.id)).toBeUndefined()
    expect(backend.sessions.getMessages(session.id)).toHaveLength(6)
    clients.detach(owner)
    expect(await coordinator.send(owner, { sessionId: session.id, text: '旧身份' }, () => {})).toMatchObject({ success: false })
  })

  test('审批与追问只接受真实 owner，答复进入工具结果，重复答复被拒绝', async () => {
    const { backend, coordinator, adapter, owner, other, session } = await open()
    const permissionReady = deferred<AgentGenerationEvent>()
    const questionReady = deferred<AgentGenerationEvent>()
    let permissionBehavior: string | undefined
    let answerContent: unknown
    adapter.handler = async function* (input) {
      const decision = await input.canUseTool?.('Write', { file_path: 'a.txt' }, {
        toolUseId: 'write', executionPolicy: input.executionPolicy!, toolExecution: { kind: 'runtime' },
      })
      permissionBehavior = decision?.behavior
      const ask = input.customTools?.find((tool) => tool.name === 'AskUserQuestion')
      const result = await ask?.execute({ questions: [{ question: '选什么?', options: [{ label: 'A' }, { label: 'B' }] }] },
        { toolUseId: 'question', signal: input.abortSignal })
      answerContent = result?.content
      yield* success('交互结束')
    }
    const send = coordinator.send(owner, { sessionId: session.id, text: '需要交互' }, (event) => {
      if (event.type === 'permission_request') permissionReady.resolve(event)
      if (event.type === 'ask_user_request') questionReady.resolve(event)
    })
    const permission = await permissionReady.promise
    if (permission.type !== 'permission_request') throw new Error('预期审批事件')
    expect(coordinator.respondPermission(other, { requestId: permission.request.requestId, behavior: 'allow' })).toBe(false)
    expect(coordinator.respondPermission(owner, { requestId: permission.request.requestId, behavior: 'deny' })).toBe(true)
    expect(coordinator.respondPermission(owner, { requestId: permission.request.requestId, behavior: 'allow' })).toBe(false)
    const question = await questionReady.promise
    if (question.type !== 'ask_user_request') throw new Error('预期追问事件')
    const reply = { requestId: question.request.requestId, behavior: 'answer', answers: { '选什么?': 'A' } }
    expect(coordinator.respondAskUser(other, reply)).toBe(false)
    expect(coordinator.respondAskUser(owner, reply)).toBe(true)
    expect(coordinator.respondAskUser(owner, reply)).toBe(false)
    await send
    expect(permissionBehavior).toBe('deny')
    expect(answerContent).toEqual({ answers: { '选什么?': 'A' } })
    expect(backend.sessions.getMessages(session.id).at(-1)).toMatchObject({ type: 'result', subtype: 'success' })
  })

  test('客户端断开拒绝 pending、清空队列；等待空闲的后台通知不能迟到启动', async () => {
    const { backend, coordinator, adapter, clients, owner, session } = await open()
    const ready = deferred<AgentGenerationEvent>()
    let decision: string | undefined
    let queries = 0
    adapter.handler = async function* (input) {
      queries += 1
      decision = (await input.canUseTool?.('Write', {}, {
        toolUseId: 'write', executionPolicy: input.executionPolicy!, toolExecution: { kind: 'runtime' },
      }))?.behavior
      yield* success('断开后迟到输出')
    }
    const send = coordinator.send(owner, { sessionId: session.id, text: '主请求' }, (event) => {
      if (event.type === 'permission_request') ready.resolve(event)
    })
    const event = await ready.promise
    if (event.type !== 'permission_request') throw new Error('预期审批')
    await coordinator.send(owner, { sessionId: session.id, text: '等待输入' }, () => {})
    const background = coordinator.sendBackgroundNotification(owner, { sessionId: session.id, text: '后台完成提醒' }, () => {})
    clients.detach(owner)
    expect(await background).toMatchObject({ success: false, code: 'invalid_input' })
    await send
    expect(decision).toBe('deny')
    expect(queries).toBe(1)
    expect(coordinator.listQueuedMessages(owner, session.id)).toEqual([])
    expect(coordinator.respondPermission(owner, { requestId: event.request.requestId, behavior: 'allow' })).toBe(false)
    const history = backend.sessions.getMessages(session.id)
    expect(JSON.stringify(history)).not.toContain('后台完成提醒')
    expect(JSON.stringify(history)).not.toContain('等待输入')
    expect(history.at(-1)).toMatchObject({ type: 'result', terminal_reason: 'stopped', stopped_by_user: true })
  })

  test('后台通知等待用户轮结束；其间追加的用户输入不继承通知的合成标记或来源', async () => {
    const { backend, coordinator, adapter, owner, session } = await open()
    const userReady = deferred<void>()
    const userFinish = deferred<void>()
    const notificationReady = deferred<void>()
    const notificationFinish = deferred<void>()
    const prompts: string[] = []
    const sources: string[] = []
    const unsubscribe = backend.events.subscribe((event) => {
      if (event.type === 'run_started') sources.push(event.source)
    })
    adapter.handler = async function* (input) {
      prompts.push(input.prompt)
      if (input.prompt === '首轮输入') { userReady.resolve(); await userFinish.promise }
      if (input.prompt === '任务完成提醒') { notificationReady.resolve(); await notificationFinish.promise }
      yield* success('已处理')
    }
    const first = coordinator.send(owner, { sessionId: session.id, text: '首轮输入' }, () => {})
    await userReady.promise
    const notification = coordinator.sendBackgroundNotification(owner, { sessionId: session.id, text: '任务完成提醒' }, () => {})
    expect(prompts).toEqual(['首轮输入'])
    userFinish.resolve()
    await first
    await notificationReady.promise
    expect(await coordinator.send(owner, { sessionId: session.id, text: '追加输入' }, () => {}, { inputOrigin: 'quick' }))
      .toMatchObject({ disposition: 'queued' })
    notificationFinish.resolve()
    await notification
    unsubscribe()
    expect(prompts).toEqual(['首轮输入', '任务完成提醒', '追加输入'])
    expect(sources).toEqual(['renderer', 'background_notification', 'renderer'])
    const users = backend.sessions.getMessages(session.id).filter((message) => message.type === 'user')
    expect(users[1]).toMatchObject({ isSynthetic: true })
    expect(users[2]).toMatchObject({ inputOrigin: 'quick' })
    expect(users[2]).not.toHaveProperty('isSynthetic')
  })

  test('父轮已空闲的子会话交互仍由客户端注销收束；没有客户端时副作用拒绝', async () => {
    const { coordinator, clients, owner, permissions, askUsers } = await open()
    permissions.bindOwner('child', owner)
    askUsers.bindOwner('child', owner)
    const run = new AbortController()
    const approve = permissions.createCanUseTool('child', 1, run.signal)
    const pending = approve('Write', {}, { toolUseId: 'child-write', toolExecution: { kind: 'runtime' },
      executionPolicy: { sandboxMode: 'workspaceWrite', approvalPolicy: 'onRequest', approvalReviewer: 'user' } })
    const question = askUsers.createTool('child', 1, run.signal).execute({ questions: [{ question: '继续吗?', options: [] }] },
      { toolUseId: 'child-question' })
    clients.detach(owner)
    expect(await pending).toMatchObject({ behavior: 'deny' })
    expect(await question).toMatchObject({ isError: true })
    expect(permissions.getOwner('child')).toBeUndefined()
    expect(await approve('Write', {}, { toolUseId: 'later', toolExecution: { kind: 'runtime' },
      executionPolicy: { sandboxMode: 'workspaceWrite', approvalPolicy: 'onRequest', approvalReviewer: 'user' } }))
      .toMatchObject({ behavior: 'deny' })
    expect(coordinator.getOwnedRun(owner, 'child')).toBeUndefined()
  })
})
