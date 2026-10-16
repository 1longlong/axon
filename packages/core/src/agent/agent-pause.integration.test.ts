import { afterEach, expect, test } from 'bun:test'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type { AgentContinueQueryInput, AgentProviderAdapter, AgentQueryInput, AgentStreamPayload, SDKUserMessage } from '@axon/shared'
import { AgentRuntimeCleanupError } from '@axon/shared'
import { BackendClientRegistry } from '../backend-client-registry'
import { AgentEventBus } from './agent-event-bus'
import { AgentRunCoordinator } from './agent-run-coordinator'
import { AgentService } from './agent-service'
import { AgentSessionManager } from './agent-session-manager'

const cleanups: Array<() => Promise<void>> = []
afterEach(async () => { for (const cleanup of cleanups.splice(0).reverse()) await cleanup() })

class Adapter implements AgentProviderAdapter {
  readonly started = Promise.withResolvers<void>()
  readonly tail = Promise.withResolvers<void>()
  readonly inputs: AgentQueryInput[] = []
  readonly continuations: AgentContinueQueryInput[] = []
  slow = true
  cleaned = false
  cleanupFailure = false
  onContinuation?: () => void
  async *query(input: AgentQueryInput): AsyncIterable<AgentStreamPayload> {
    this.inputs.push(input)
    yield* this.execute(input)
  }
  async *continueQuery(input: AgentContinueQueryInput): AsyncIterable<AgentStreamPayload> {
    this.continuations.push(input)
    this.onContinuation?.()
    yield* this.execute(input)
  }
  private async *execute(input: Pick<AgentQueryInput, 'abortSignal'>): AsyncIterable<AgentStreamPayload> {
    try {
      yield { kind: 'sdk_message', message: { type: 'assistant', parent_tool_use_id: null,
        message: { content: [{ type: 'text', text: '已完成部分工作' }] } } }
      this.started.resolve()
      if (this.slow) {
        if (!input.abortSignal?.aborted) await new Promise<void>((resolve) => input.abortSignal?.addEventListener('abort', () => resolve(), { once: true }))
        await this.tail.promise
      }
      // 即便取消后 Runtime 迟到报告 success，core 也必须按停止规范化。
      yield { kind: 'sdk_message', message: { type: 'result', subtype: 'success', usage: { input_tokens: 1 } } }
    } finally {
      this.cleaned = true
      if (this.cleanupFailure) throw new AgentRuntimeCleanupError()
    }
  }
  abort(): void {}
  dispose(): void {}
  async drain(): Promise<void> {}
}

function fixture(options: { childFailure?: boolean; persistenceFailure?: boolean; cleanupFailure?: boolean } = {}) {
  const directory = mkdtempSync(join(tmpdir(), 'axon-pause-'))
  const paths = { indexPath: join(directory, 'sessions.json'), sessionsDir: join(directory, 'sessions') }
  const sessions = new AgentSessionManager(paths)
  const session = sessions.create({ projectId: 'project', channelId: 'channel', modelId: 'model' })
  const clients = new BackendClientRegistry()
  const owner = clients.register(), other = clients.register()
  const events = new AgentEventBus(), adapter = new Adapter()
  adapter.cleanupFailure = options.cleanupFailure === true
  const agent = new AgentService({ sessionManager: sessions, adapter, eventBus: events,
    channelManager: { resolve: async () => ({ id: 'channel', name: '渠道', provider: 'openai',
      baseUrl: 'https://example.test/v1', apiKey: '', models: [{ id: 'model', name: '模型', enabled: true }],
      enabled: true, createdAt: 1, updatedAt: 1 }) }, resolveProjectCwd: () => directory,
    runtimeConfigDir: join(directory, 'runtime'), runtimeSessionDir: join(directory, 'runtime', 'sessions'),
  })
  const children = Promise.withResolvers<void>()
  let childBusy = true, canceledChildren = 0, workspace = directory, workspaceUnavailable = false
  const coordinatorOptions = { clients, sessions, agent, events,
    resolveCreationWorkspace: () => { if (workspaceUnavailable) throw new Error('工作区已不存在'); return workspace },
    cancelWorkflowDescendants: () => { canceledChildren++ },
    waitForWorkflowDescendants: async () => { await children.promise; if (options.childFailure) throw new Error('私有交付错误') },
    isWorkflowRootBusy: () => childBusy,
  }
  const coordinator = new AgentRunCoordinator(coordinatorOptions)
  if (options.persistenceFailure) {
    const append = sessions.appendMessage.bind(sessions)
    sessions.appendMessage = (id, message) => {
      if (message.type === 'system' && message.subtype === 'axon_paused') throw new Error('私有磁盘错误')
      return append(id, message)
    }
  }
  const releaseChildren = (): void => { childBusy = false; children.resolve() }
  cleanups.push(async () => {
    adapter.tail.resolve(); releaseChildren(); coordinator.dispose(); agent.dispose(); clients.dispose()
    await Promise.all([coordinator.drain(), agent.drain()])
    rmSync(directory, { recursive: true, force: true })
  })
  return { directory, paths, sessions, session, clients, owner, other, adapter, agent, events, coordinator,
    coordinatorOptions, releaseChildren, get canceledChildren() { return canceledChildren },
    changeWorkspace: () => { workspace = join(directory, 'changed') },
    removeWorkspace: () => { workspaceUnavailable = true } }
}

test('暂停等待 query finally 和本根子交付；暂停身份持久化、重建可读，同轮继续且拒绝重复', async () => {
  const f = fixture()
  const changes: Array<string | null> = []
  const release = f.coordinator.subscribePauseChanges(({ sessionId }) => {
    expect(sessionId).toBe(f.session.id)
    changes.push(f.coordinator.getPause(f.other, sessionId)?.state ?? null)
  })
  const sending = f.coordinator.send(f.owner, { sessionId: f.session.id, text: '原始任务' }, () => {})
  await f.adapter.started.promise
  const run = f.coordinator.getOwnedRun(f.owner, f.session.id)!
  const background = f.coordinator.sendBackgroundNotification(f.owner,
    { sessionId: f.session.id, text: '迟到子结果不得自动续跑' }, () => {})
  await expect(f.coordinator.pauseRun(f.other, { sessionId: run.sessionId, runId: run.runId })).rejects.toMatchObject({ code: 'invalid_input' })
  await expect(f.coordinator.pauseRun(f.owner, { sessionId: run.sessionId, runId: '旧轮次' })).rejects.toMatchObject({ code: 'invalid_input' })
  const pausing = f.coordinator.pauseRun(f.owner, { sessionId: run.sessionId, runId: run.runId })
  const snapshot = f.coordinator.getPause(f.owner, f.session.id)!
  expect(snapshot.state).toBe('pausing')
  expect(f.canceledChildren).toBe(1)
  expect(f.adapter.cleaned).toBe(false)
  expect(await f.coordinator.continueRun(f.owner, { sessionId: f.session.id, pauseId: snapshot.pauseId })).toMatchObject({ success: false })
  expect(await f.coordinator.send(f.other, { sessionId: f.session.id, text: '暂停期间插入' }, () => {})).toMatchObject({ success: false })
  expect(() => f.coordinator.deleteSession(f.session.id)).toThrow()
  expect(() => f.coordinator.updateSession(f.session.id, { projectId: 'changed' })).toThrow()
  await expect(f.coordinator.pauseRun(f.owner, { sessionId: run.sessionId, runId: run.runId })).rejects.toThrow()
  expect(f.sessions.getMessages(f.session.id).some((message) => message.type === 'system' && message.subtype === 'axon_paused')).toBe(false)

  f.adapter.tail.resolve()
  await sending
  expect(await background).toMatchObject({ success: false, code: 'already_active' })
  expect(f.adapter.inputs).toHaveLength(1)
  expect(f.adapter.cleaned).toBe(true)
  expect(f.coordinator.getPause(f.owner, f.session.id)?.state).toBe('pausing')
  f.releaseChildren()
  const paused = await pausing
  expect(paused).toMatchObject({ pauseId: snapshot.pauseId, state: 'paused' })
  expect(changes).toContain('pausing')
  expect(changes.at(-1)).toBe('paused')
  release()
  const restored = new AgentSessionManager(f.paths)
  const second = new AgentRunCoordinator({ ...f.coordinatorOptions, sessions: restored })
  expect(second.getPause(f.other, f.session.id)).toEqual(paused)
  // 内部输入标识本身不是继续授权，后台输入不能越过持久暂停凭据。
  expect(await second.send(f.other, { sessionId: f.session.id, text: '未经继续核验的内部输入' }, () => {}, { synthetic: true }))
    .toMatchObject({ success: false, code: 'already_active' })
  expect(f.adapter.inputs).toHaveLength(1)
  expect(await second.continueRun(f.other, { sessionId: f.session.id, pauseId: '旧身份' })).toMatchObject({ success: false })
  f.adapter.slow = false
  const continuing = second.continueRun(f.other, { sessionId: f.session.id, pauseId: paused.pauseId })
  expect(await second.continueRun(f.other, { sessionId: f.session.id, pauseId: paused.pauseId })).toMatchObject({ success: false })
  expect(await continuing).toMatchObject({ success: true })
  expect(f.adapter.inputs).toHaveLength(1)
  expect(f.adapter.continuations).toHaveLength(1)
  expect(f.adapter.continuations[0]).not.toHaveProperty('prompt')
  expect(f.adapter.continuations[0]?.interruptionContext).toContain('明确允许继续原任务')
  const continuedHistory = restored.getMessages(f.session.id)
  const internal = continuedHistory.filter((message) => message.type === 'user' && message.isSynthetic === true)
  expect(internal).toHaveLength(0)
  expect(continuedHistory.filter((message) => message.type === 'user' && message.isSynthetic !== true)).toHaveLength(1)
  expect(continuedHistory.find((message) => message.type === 'system' && message.subtype === 'axon_continued'))
    .toMatchObject({ turn_id: paused.turnId, resumed_pause_id: paused.pauseId })
  const originalUser = continuedHistory.find((message) => message.type === 'user') as SDKUserMessage | undefined
  if (!originalUser?.uuid) throw new Error('原用户消息缺失')
  expect(paused.turnId).toBe(originalUser.uuid)
  expect(new AgentSessionManager(f.paths).getMessages(f.session.id)).toEqual(continuedHistory)
  expect(second.getPause(f.other, f.session.id)).toBeNull()
  second.dispose(); await second.drain()
})

test('同一原轮反复暂停和继续：turnId 不变，runId/暂停凭据更新，旧控制不能影响新执行', async () => {
  const f = fixture()
  const sending = f.coordinator.send(f.owner, { sessionId: f.session.id, text: '原任务' }, () => {})
  await f.adapter.started.promise
  let run = f.coordinator.getOwnedRun(f.owner, f.session.id)!
  const pausing = f.coordinator.pauseRun(f.owner, { sessionId: run.sessionId, runId: run.runId })
  f.adapter.tail.resolve(); f.releaseChildren()
  let paused = await pausing
  await sending
  const turnId = paused.turnId
  for (let index = 0; index < 2; index++) {
    const started = Promise.withResolvers<void>()
    f.adapter.onContinuation = () => { started.resolve() }
    const continuing = f.coordinator.continueRun(f.owner, { sessionId: f.session.id, pauseId: paused.pauseId })
    await started.promise
    const nextRun = f.coordinator.getOwnedRun(f.owner, f.session.id)!
    expect(nextRun.runId).not.toBe(run.runId)
    await expect(f.coordinator.pauseRun(f.owner, { sessionId: run.sessionId, runId: run.runId })).rejects.toMatchObject({ code: 'invalid_input' })
    const nextPause = await f.coordinator.pauseRun(f.owner, { sessionId: nextRun.sessionId, runId: nextRun.runId })
    await continuing
    expect(nextPause.turnId).toBe(turnId)
    expect(nextPause.pauseId).not.toBe(paused.pauseId)
    expect(await f.coordinator.continueRun(f.owner, { sessionId: f.session.id, pauseId: paused.pauseId })).toMatchObject({ success: false })
    run = nextRun; paused = nextPause
  }
  const restored = new AgentSessionManager(f.paths)
  const afterRestart = new AgentRunCoordinator({ ...f.coordinatorOptions, sessions: restored })
  try { expect(afterRestart.getPause(f.other, f.session.id)).toEqual(paused) }
  finally { afterRestart.dispose(); await afterRestart.drain() }
  expect(restored.getMessages(f.session.id).filter((message) => message.type === 'user')).toHaveLength(1)
  f.adapter.slow = false
  expect(await f.coordinator.continueRun(f.owner, { sessionId: f.session.id, pauseId: paused.pauseId })).toMatchObject({ success: true })
  expect(f.coordinator.getPause(f.owner, f.session.id)).toBeNull()
})

test('Runtime 未实现继续时明确拒绝，原暂停与历史保持可恢复，不退回隐藏用户输入', async () => {
  const f = fixture()
  const sending = f.coordinator.send(f.owner, { sessionId: f.session.id, text: '原任务' }, () => {})
  await f.adapter.started.promise
  const run = f.coordinator.getOwnedRun(f.owner, f.session.id)!
  const pausing = f.coordinator.pauseRun(f.owner, { sessionId: run.sessionId, runId: run.runId })
  f.adapter.tail.resolve(); f.releaseChildren()
  const paused = await pausing
  await sending
  Object.defineProperty(f.adapter, 'continueQuery', { value: undefined })
  const before = f.sessions.getMessages(f.session.id)
  expect(await f.coordinator.continueRun(f.owner, { sessionId: f.session.id, pauseId: paused.pauseId }))
    .toMatchObject({ success: false, message: '当前 Runtime 尚未接入无用户消息继续' })
  expect(f.sessions.getMessages(f.session.id)).toEqual(before)
  expect(f.coordinator.getPause(f.other, f.session.id)).toEqual(paused)
  expect(f.adapter.inputs).toHaveLength(1)
})

test('重启只认匹配原输入/停止结果/工作区的暂停 marker，损坏关联不能复活旧暂停', async () => {
  for (const broken of [{ turn_id: 'other-turn' }, { stopped_result_uuid: 'other-result' }, { workspace_path: '/other-workspace' }]) {
    const f = fixture()
    const sending = f.coordinator.send(f.owner, { sessionId: f.session.id, text: '原任务' }, () => {})
    await f.adapter.started.promise
    const run = f.coordinator.getOwnedRun(f.owner, f.session.id)!
    const pausing = f.coordinator.pauseRun(f.owner, { sessionId: run.sessionId, runId: run.runId })
    f.adapter.tail.resolve(); f.releaseChildren()
    await pausing; await sending
    const marker = f.sessions.getMessages(f.session.id).at(-1)!
    f.sessions.appendMessage(f.session.id, { ...marker, uuid: 'broken-pause', pause_id: 'broken-pause', ...broken })
    const restored = new AgentRunCoordinator({ ...f.coordinatorOptions, sessions: new AgentSessionManager(f.paths) })
    try { expect(restored.getPause(f.other, f.session.id)).toBeNull() }
    finally { restored.dispose(); await restored.drain() }
  }
})

test('继续标记已落盘而后续结果未保存时，重启也不能再次消费旧暂停', async () => {
  const f = fixture()
  const sending = f.coordinator.send(f.owner, { sessionId: f.session.id, text: '原任务' }, () => {})
  await f.adapter.started.promise
  const run = f.coordinator.getOwnedRun(f.owner, f.session.id)!
  const pausing = f.coordinator.pauseRun(f.owner, { sessionId: run.sessionId, runId: run.runId })
  f.adapter.tail.resolve(); f.releaseChildren()
  const paused = await pausing
  await sending
  const marker = f.sessions.getMessages(f.session.id).at(-1)!
  if (marker.type !== 'system') throw new Error('暂停 marker 缺失')
  // 模拟接纳继续后进程异常退出：没有下一条 assistant/result，旧凭据仍已被消费。
  f.sessions.appendMessage(f.session.id, {
    type: 'system', subtype: 'axon_continued', turn_id: paused.turnId,
    resumed_pause_id: paused.pauseId, stopped_result_uuid: marker.stopped_result_uuid,
    run_id: 'accepted-new-run', run_started_at: run.runStartedAt + 1,
  })
  const restored = new AgentRunCoordinator({ ...f.coordinatorOptions, sessions: new AgentSessionManager(f.paths) })
  try {
    expect(restored.getPause(f.other, f.session.id)).toBeNull()
    expect(await restored.continueRun(f.other, { sessionId: f.session.id, pauseId: paused.pauseId }))
      .toMatchObject({ success: false, code: 'invalid_input' })
    expect(f.adapter.continuations).toHaveLength(0)
  } finally { restored.dispose(); await restored.drain() }
})

test('查询清理、子交付或暂停状态保存失败不产生可继续凭据', async () => {
  for (const options of [{ childFailure: true }, { persistenceFailure: true }, { cleanupFailure: true }]) {
    const f = fixture(options)
    const sending = f.coordinator.send(f.owner, { sessionId: f.session.id, text: '原任务' }, () => {})
    await f.adapter.started.promise
    const run = f.coordinator.getOwnedRun(f.owner, f.session.id)!
    const pausing = f.coordinator.pauseRun(f.owner, { sessionId: run.sessionId, runId: run.runId })
    f.adapter.tail.resolve(); f.releaseChildren()
    await expect(pausing).rejects.toMatchObject({ code: options.persistenceFailure ? 'persistence_error' : 'runtime_error' })
    await sending
    expect(f.coordinator.getPause(f.owner, f.session.id)).toBeNull()
    expect(f.sessions.getMessages(f.session.id).some((message) => message.type === 'system' && message.subtype === 'axon_paused')).toBe(false)
  }
})

test('普通停止不产生暂停凭据；暂停中入口失效也不生成可继续状态', async () => {
  for (const pause of [false, true]) {
    const f = fixture()
    const sending = f.coordinator.send(f.owner, { sessionId: f.session.id, text: '任务' }, () => {})
    await f.adapter.started.promise
    const run = f.coordinator.getOwnedRun(f.owner, f.session.id)!
    const pausing = pause ? f.coordinator.pauseRun(f.owner, { sessionId: run.sessionId, runId: run.runId }) : undefined
    if (pause) f.clients.detach(f.owner)
    else expect(f.coordinator.stopRun(f.owner, { sessionId: run.sessionId, runId: run.runId })).toBe(true)
    f.adapter.tail.resolve(); f.releaseChildren()
    if (pausing) await expect(pausing).rejects.toMatchObject({ code: 'invalid_input' })
    await sending
    expect(f.coordinator.getPause(f.other, f.session.id)).toBeNull()
  }
})

test('暂停后普通新输入消费凭据，项目工作区改绑使原凭据失效', async () => {
  for (const changeWorkspace of [false, true]) {
    const f = fixture()
    const sending = f.coordinator.send(f.owner, { sessionId: f.session.id, text: '任务' }, () => {})
    await f.adapter.started.promise
    const run = f.coordinator.getOwnedRun(f.owner, f.session.id)!
    const pausing = f.coordinator.pauseRun(f.owner, { sessionId: run.sessionId, runId: run.runId })
    f.adapter.tail.resolve(); f.releaseChildren()
    const paused = await pausing; await sending
    if (changeWorkspace) {
      f.changeWorkspace()
      expect(f.coordinator.getPause(f.other, f.session.id)).toBeNull()
      expect(await f.coordinator.continueRun(f.owner, { sessionId: f.session.id, pauseId: paused.pauseId })).toMatchObject({ success: false })
    } else {
      f.adapter.slow = false
      expect(await f.coordinator.send(f.other, { sessionId: f.session.id, text: '新任务' }, () => {})).toMatchObject({ success: true })
      expect(f.coordinator.getPause(f.other, f.session.id)).toBeNull()
    }
  }
})

test('工作区已失效仍取消旧轮并等待清理，但不生成继续凭据', async () => {
  const f = fixture()
  const sending = f.coordinator.send(f.owner, { sessionId: f.session.id, text: '任务' }, () => {})
  await f.adapter.started.promise
  const run = f.coordinator.getOwnedRun(f.owner, f.session.id)!
  f.removeWorkspace()
  const pausing = f.coordinator.pauseRun(f.owner, { sessionId: run.sessionId, runId: run.runId })
  expect(f.adapter.inputs[0]?.abortSignal?.aborted).toBe(true)
  f.adapter.tail.resolve(); f.releaseChildren()
  await expect(pausing).rejects.toMatchObject({ code: 'workspace_unavailable' })
  await sending
  expect(f.adapter.cleaned).toBe(true)
  expect(f.coordinator.getPause(f.other, f.session.id)).toBeNull()
})
