import { afterEach, describe, expect, test } from 'bun:test'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { PassThrough } from 'node:stream'
import { createBackend, createBackendPaths, createCredentialCodec } from '@axon/core'
import type { AxonBackend } from '@axon/core'
import { APP_SERVER_METHODS as methods, APP_SERVER_NOTIFICATIONS as notices } from '@axon/shared'
import type { AgentProviderAdapter, AgentQueryInput, AgentStreamPayload, AgentWorkflowResult, AppServerClient,
  AppServerAgentRunEvent, AppServerAgentWorkflowEvent, BackendAgentWorkflow, AgentSessionMeta, RpcJsonValue } from '@axon/shared'
import { AppServerConnection, JsonRpcPeer } from './index'

const cleanups: Array<() => Promise<void>> = []
afterEach(async () => { for (const cleanup of cleanups.splice(0).reverse()) await cleanup() })
async function* success(text = '完成'): AsyncIterable<AgentStreamPayload> {
  yield { kind: 'sdk_message', message: { type: 'assistant', parent_tool_use_id: null, message: { content: [{ type: 'text', text }] } } }
  yield { kind: 'sdk_message', message: { type: 'result', subtype: 'success', usage: { input_tokens: 1 } } }
}
function untilAbort(signal: AbortSignal): Promise<void> {
  if (signal.aborted) return Promise.resolve()
  return new Promise<void>((resolve) => signal.addEventListener('abort', () => resolve(), { once: true }))
}
/** 真实协议/业务/历史；模型用中立 adapter，握手/窗口与 OS 沙箱并不在此夹具中伪装。 */
async function open() {
  const directory = mkdtempSync(join(tmpdir(), 'axon-workflow-rpc-'))
  const up = new PassThrough(), down = new PassThrough(), parent = new JsonRpcPeer(down, up), child = new JsonRpcPeer(up, down)
  let handler: (input: AgentQueryInput) => AsyncIterable<AgentStreamPayload> = async function* () { yield* success() }
  const adapter: AgentProviderAdapter = { query: (input) => handler(input), abort() {}, dispose() {}, async drain() {} }
  const events: AppServerAgentRunEvent[] = [], workflows: AppServerAgentWorkflowEvent[] = []
  const initialFinished = Promise.withResolvers<void>()
  parent.handleNotification(notices.AGENT_RUN, (params) => {
    const packet = params as unknown as AppServerAgentRunEvent; events.push(packet)
    if (packet.event.event.type === 'run_finished' && packet.event.event.source === 'external') initialFinished.resolve()
  })
  parent.handleNotification(notices.AGENT_WORKFLOW, (params) => { workflows.push(params as unknown as AppServerAgentWorkflowEvent) })
  let backend!: AxonBackend
  const connection = new AppServerConnection({ peer: child, bootstrap() {
    backend = createBackend({ paths: createBackendPaths({ dataDir: join(directory, 'data'), homeDir: directory }),
      applicationVersion: '0.1.4', credentialCodec: createCredentialCodec(), resolveAdapter: () => adapter,
      agentConfiguration: { systemPrompt: '', generateTitle: false, features: { skills: false, mcp: false, memory: false, tasks: true } } })
    return { backend, applicationVersion: '0.1.4', capabilities: { runtimes: [], credentialStorage: 'unavailable', channelTargetConfirmation: false } }
  } })
  cleanups.push(async () => { connection.close(); parent.close(); await connection.drain(); up.destroy(); down.destroy(); rmSync(directory, { recursive: true, force: true }) })
  await parent.request(methods.INITIALIZE, { protocolVersion: 1, client: { name: 'axon-workflow-fixture', version: '0.1.4' },
    hostCapabilities: { credentialStorage: 'unavailable', channelTargetConfirmation: false } })
  const external = await parent.request(methods.REGISTER_CLIENT, { kind: 'external' }) as unknown as AppServerClient
  const foreign = await parent.request(methods.REGISTER_CLIENT, { kind: 'external' }) as unknown as AppServerClient
  const main = await parent.request(methods.REGISTER_CLIENT, { kind: 'main' }) as unknown as AppServerClient
  const channel = await backend.channels.create({ name: '隔离渠道', provider: 'openai', baseUrl: 'https://example.test/v1', apiKey: '',
    models: [{ id: 'fixture', name: '夹具模型', enabled: true }] })
  const project = backend.projects.create({ name: '隔离项目' })
  const request = (method: string, input?: RpcJsonValue, client = external, signal?: AbortSignal) => parent.request(method,
    { clientId: client.clientId, ...(input === undefined ? {} : { input }) }, { timeoutMs: 0, signal })
  const create = async () => await request(methods.AGENT_CREATE_SESSION, { title: '工作流会话', channelId: channel.id, modelId: 'fixture', projectId: project.id,
    approvalPolicy: 'never', userInputPolicy: 'reject' }) as unknown as AgentSessionMeta
  const session = await create()
  return { backend, parent, external, foreign, main, session, request, create, events, workflows, initialFinished,
    setHandler: (value: typeof handler) => { handler = value } }
}

describe('非交互工作流固定 RPC 与真实根协作', () => {
  test('初始主轮后保留 owner，禁止追加/接管/改配置；子结果续跑落盘后才唯一完成', async () => {
    const f = await open(), childGate = Promise.withResolvers<void>(), resumed = Promise.withResolvers<void>(), resumeGate = Promise.withResolvers<void>()
    let rootCalls = 0
    f.setHandler(async function* (input) {
      if (input.sessionId !== f.session.id) { await childGate.promise; yield* success('后台子结果'); return }
      rootCalls++
      if (rootCalls === 1) {
        expect(input.prompt).toBe('  原始任务\n')
        await input.customTools!.find((tool) => tool.name === 'Agent')!.execute({ description: '后台任务', prompt: '检查', subagent_type: 'explore', run_in_background: true },
          { toolUseId: 'background', signal: input.abortSignal })
        yield* success('初步回复')
      } else { expect(input.prompt).toContain('后台子结果'); resumed.resolve(); await resumeGate.promise; yield* success('最终回复') }
    })
    let completed = false
    const pending = f.request(methods.AGENT_EXECUTE_WORKFLOW, { sessionId: f.session.id, text: '  原始任务\n' })
      .then((value) => { completed = true; return value as unknown as AgentWorkflowResult })
    try {
      await f.initialFinished.promise
      expect(f.backend.agentRuns.isActive(f.session.id)).toBe(false)
      expect(completed).toBe(false)
      const active = await f.request(methods.AGENT_GET_WORKFLOW, f.session.id) as unknown as BackendAgentWorkflow
      expect(active).toMatchObject({ sessionId: f.session.id, workflowId: expect.any(String) })
      expect(await f.request(methods.AGENT_GET_WORKFLOW, f.session.id, f.foreign)).toBeNull()
      for (const client of [f.external, f.foreign]) {
        expect(await f.request(methods.AGENT_SEND, { sessionId: f.session.id, text: '不能追加' }, client)).toMatchObject({ success: false, code: 'already_active' })
        await expect(f.request(methods.AGENT_UPDATE_SESSION, { sessionId: f.session.id, update: { approvalPolicy: 'onRequest' } }, client))
          .rejects.toMatchObject({ code: -32020, data: { code: 'already_active' } })
        await expect(f.request(methods.AGENT_DELETE_SESSION, f.session.id, client)).rejects.toMatchObject({ data: { code: 'already_active' } })
      }
      childGate.resolve(); await resumed.promise
      expect(completed).toBe(false)
      resumeGate.resolve()
      const result = await pending
      expect(result).toMatchObject({ status: 'completed', completion: { persisted: true, resultSubtype: 'success' } })
      const roots = f.events.filter((packet) => packet.event.run.sessionId === f.session.id && packet.event.event.type === 'run_started')
      expect(roots).toHaveLength(2)
      expect(result.lastRun).toEqual(roots[1]!.event.run)
      expect(active).toEqual(result.workflow)
      expect(f.workflows.map((packet) => packet.event.type)).toEqual(['workflow_started', 'workflow_finished'])
      expect(f.workflows.every((packet) => packet.clientId === f.external.clientId)).toBe(true)
      expect(await f.request(methods.AGENT_GET_WORKFLOW, f.session.id)).toBeNull()
      expect(f.backend.sessions.getMessages(f.session.id).filter((message) => message.type === 'result')).toHaveLength(2)
    } finally { childGate.resolve(); resumeGate.resolve(); await pending }
  })

  test('主轮空隙精确取消整个工作流；等待真实子 finally，旧令牌不能停止后续工作流', async () => {
    const f = await open(), childExited = Promise.withResolvers<void>(), cleanupGate = Promise.withResolvers<void>(), secondEntered = Promise.withResolvers<void>(), secondGate = Promise.withResolvers<void>()
    let roots = 0
    f.setHandler(async function* (input) {
      if (input.sessionId !== f.session.id) { await untilAbort(input.abortSignal!); childExited.resolve(); await cleanupGate.promise; yield* success('迟到结果'); return }
      roots++
      if (roots === 1) {
        await input.customTools!.find((tool) => tool.name === 'Agent')!.execute({ description: '后台任务', prompt: '检查', subagent_type: 'explore', run_in_background: true },
          { toolUseId: 'cancel-background', signal: input.abortSignal })
        yield* success('初步回复')
      } else { secondEntered.resolve(); await secondGate.promise; yield* success() }
    })
    const first = f.request(methods.AGENT_EXECUTE_WORKFLOW, { sessionId: f.session.id, text: '开始' })
    try {
      await f.initialFinished.promise
      const metadata = await f.request(methods.AGENT_GET_WORKFLOW, f.session.id) as unknown as { sessionId: string; workflowId: string }
      const active = { sessionId: metadata.sessionId, workflowId: metadata.workflowId }
      expect(await f.request(methods.AGENT_CANCEL_WORKFLOW, active, f.foreign)).toBe(false)
      expect(await f.request(methods.AGENT_CANCEL_WORKFLOW, { ...active, workflowId: 'old' })).toBe(false)
      expect(await f.request(methods.AGENT_CANCEL_WORKFLOW, active)).toBe(true)
      await childExited.promise
      expect(f.backend.tasks.list(f.session.id)[0]?.status).toBe('canceled')
      expect(await f.request(methods.AGENT_GET_WORKFLOW, f.session.id)).toMatchObject(active)
      expect(f.workflows.filter((packet) => packet.event.type === 'workflow_finished')).toHaveLength(0)
      cleanupGate.resolve()
      expect(await first).toMatchObject({ status: 'canceled' })
      expect(roots).toBe(1)
      const second = f.request(methods.AGENT_EXECUTE_WORKFLOW, { sessionId: f.session.id, text: '新任务' })
      try {
        await secondEntered.promise
        expect(await f.request(methods.AGENT_CANCEL_WORKFLOW, active)).toBe(false)
        expect(await f.request(methods.AGENT_GET_WORKFLOW, f.session.id)).not.toMatchObject(active)
        secondGate.resolve(); expect(await second).toMatchObject({ status: 'completed' })
      } finally { secondGate.resolve(); await second }
    } finally { f.backend.clients.detach(f.external.clientId); cleanupGate.resolve(); secondGate.resolve(); await first }
  })

  test('取消 RPC 等待会停止工作流，但其真实业务仍占有身份直到执行 finally 完成', async () => {
    const f = await open(), entered = Promise.withResolvers<void>(), aborted = Promise.withResolvers<void>(), cleanupGate = Promise.withResolvers<void>()
    f.setHandler(async function* (input) {
      entered.resolve(); await untilAbort(input.abortSignal!); aborted.resolve(); await cleanupGate.promise; yield* success('迟到回复')
    })
    const cancel = new AbortController()
    const pending = f.request(methods.AGENT_EXECUTE_WORKFLOW, { sessionId: f.session.id, text: '任务' }, f.external, cancel.signal).catch((error: unknown) => error)
    try {
      await entered.promise; cancel.abort()
      expect(await pending).toMatchObject({ code: 'canceled' })
      await aborted.promise
      expect(await f.request(methods.AGENT_GET_WORKFLOW, f.session.id)).not.toBeNull()
      expect(await f.request(methods.AGENT_SEND, { sessionId: f.session.id, text: '不能抢占' })).toMatchObject({ success: false, code: 'already_active' })
      cleanupGate.resolve(); await f.backend.agentRuns.drain()
      expect(await f.request(methods.AGENT_GET_WORKFLOW, f.session.id)).toBeNull()
      expect(f.workflows.filter((packet) => packet.event.type === 'workflow_finished')).toHaveLength(1)
    } finally { cleanupGate.resolve(); await pending }
  })

  test('客户端注销只取消自己的工作流；其他根继续，断开后的后台结果不再续跑', async () => {
    const f = await open(), other = await f.create(), childAborted = Promise.withResolvers<void>(), childCleanup = Promise.withResolvers<void>(),
      otherEntered = Promise.withResolvers<void>(), otherGate = Promise.withResolvers<void>()
    let otherSignal: AbortSignal | undefined, roots = 0
    f.setHandler(async function* (input) {
      if (input.sessionId === other.id) { otherSignal = input.abortSignal; otherEntered.resolve(); await otherGate.promise; yield* success('另一根完成'); return }
      if (input.sessionId !== f.session.id) { await untilAbort(input.abortSignal!); childAborted.resolve(); await childCleanup.promise; yield* success('迟到子结果'); return }
      roots++
      await input.customTools!.find((tool) => tool.name === 'Agent')!.execute({ description: '后台任务', prompt: '检查', subagent_type: 'explore', run_in_background: true },
        { toolUseId: 'detached-child', signal: input.abortSignal })
      yield* success('初步回复')
    })
    const ours = f.request(methods.AGENT_EXECUTE_WORKFLOW, { sessionId: f.session.id, text: '工作流' })
    const theirs = f.request(methods.AGENT_SEND, { sessionId: other.id, text: '独立任务' }, f.foreign)
    try {
      await otherEntered.promise; await f.initialFinished.promise
      expect(await f.parent.request(methods.DETACH_CLIENT, { clientId: f.external.clientId })).toBe(true)
      await childAborted.promise
      expect(otherSignal?.aborted).toBe(false)
      expect(f.backend.agentRuns.isActive(other.id)).toBe(true)
      childCleanup.resolve(); expect(await ours).toMatchObject({ status: 'canceled' })
      expect(roots).toBe(1)
      expect(f.workflows.filter((packet) => packet.event.type === 'workflow_finished')).toHaveLength(0)
      otherGate.resolve(); expect(await theirs).toMatchObject({ success: true })
    } finally { childCleanup.resolve(); otherGate.resolve(); f.backend.clients.detach(f.external.clientId); await Promise.all([ours, theirs]) }
  })

  test('主轮空闲但旧普通会话的后台执行未完时，不能开始新工作流接管', async () => {
    const f = await open(), childGate = Promise.withResolvers<void>()
    let roots = 0
    f.setHandler(async function* (input) {
      if (input.sessionId !== f.session.id) { await childGate.promise; yield* success('后台完成'); return }
      roots++
      if (roots === 1) await input.customTools!.find((tool) => tool.name === 'Agent')!.execute({ description: '原入口后台任务', prompt: '检查', subagent_type: 'explore', run_in_background: true },
        { toolUseId: 'legacy-background', signal: input.abortSignal })
      yield* success()
    })
    try {
      expect(await f.request(methods.AGENT_SEND, { sessionId: f.session.id, text: '普通发送' }, f.foreign)).toMatchObject({ success: true })
      expect(f.backend.agentRuns.isActive(f.session.id)).toBe(false)
      await expect(f.request(methods.AGENT_EXECUTE_WORKFLOW, { sessionId: f.session.id, text: '不能接管' })).rejects.toMatchObject({ data: { code: 'already_active' } })
      expect(f.workflows).toEqual([])
      childGate.resolve(); await f.backend.collaboration.waitForRootIdle(f.session.id)
      expect(roots).toBe(2)
      expect(await f.request(methods.AGENT_EXECUTE_WORKFLOW, { sessionId: f.session.id, text: '原入口已结束' })).toMatchObject({ status: 'completed' })
    } finally { childGate.resolve() }
  })

  test('模型错误是 failed 而非 RPC 接管成功；普通交互会话/桌面/伪造字段在运行前拒绝', async () => {
    const f = await open()
    let calls = 0
    f.setHandler(async function* () { calls++; yield { kind: 'sdk_message', message: { type: 'result', subtype: 'error', usage: { input_tokens: 1 },
      error: { code: 'provider_error', category: 'provider', message: '模型请求失败', retryable: false } } } })
    const payload = { sessionId: f.session.id, text: '任务' }
    await expect(f.request(methods.AGENT_EXECUTE_WORKFLOW, payload, f.main)).rejects.toMatchObject({ code: -32602 })
    await expect(f.request(methods.AGENT_EXECUTE_WORKFLOW, { ...payload, workflowId: 'forged' })).rejects.toMatchObject({ data: { code: 'invalid_input' } })
    await expect(f.request(methods.AGENT_CANCEL_WORKFLOW, { sessionId: f.session.id, workflowId: 'id', owner: f.external.clientId })).rejects.toMatchObject({ data: { code: 'invalid_input' } })
    await f.request(methods.AGENT_UPDATE_SESSION, { sessionId: f.session.id, update: { userInputPolicy: 'ask' } })
    await expect(f.request(methods.AGENT_EXECUTE_WORKFLOW, payload)).rejects.toMatchObject({ data: { code: 'invalid_input' } })
    expect(calls).toBe(0); expect(f.workflows).toEqual([])
    await f.request(methods.AGENT_UPDATE_SESSION, { sessionId: f.session.id, update: { userInputPolicy: 'reject' } })
    expect(await f.request(methods.AGENT_EXECUTE_WORKFLOW, payload)).toMatchObject({ status: 'failed', error: { category: 'provider', code: 'provider_error' }, completion: { persisted: true } })
    expect(calls).toBe(1)
    expect(await f.request(methods.AGENT_GET_WORKFLOW, f.session.id)).toBeNull()
  })
})
