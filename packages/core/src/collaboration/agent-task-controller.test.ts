import { afterEach, beforeEach, describe, expect, spyOn, test } from 'bun:test'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type { AgentDelegation, AgentGenerationEvent, AgentTaskChangedEvent, AgentTaskEvent, BackendOwnedRun } from '@axon/shared'
import { AgentDelegationManager } from './agent-delegation-manager'
import { AgentEventBus } from '../agent/agent-event-bus'
import { AgentSessionManager } from '../agent/agent-session-manager'
import { AgentTaskController, AgentTaskControllerError } from './agent-task-controller'

import { BackendClientRegistry } from '../backend-client-registry'

let directory: string
let clients: BackendClientRegistry
let owner: string

beforeEach(() => {
  directory = mkdtempSync(join(tmpdir(), 'axon-agent-task-'))
  clients = new BackendClientRegistry()
  owner = clients.register()
})
afterEach(() => {
  clients.dispose()
  rmSync(directory, { recursive: true, force: true })
})

/** 可保留迟到回调的上游夹具，用于验证释放不是仅从监听集合删除。 */
function subscriptionsFixture() {
  const task: AgentDelegation = {
    id: 'task-1', rootSessionId: 'root-1', parentSessionId: 'root-1', childSessionId: 'child-1',
    parentToolUseId: 'tool-1', title: '任务', objective: '目标', subagentType: 'coder',
    runInBackground: true, depth: 1, status: 'running', createdAt: 1, updatedAt: 2, startedAt: 2,
  }
  const changed = new Set<(event: AgentTaskChangedEvent) => void>()
  const runs = new Set<(event: AgentGenerationEvent) => void>()
  const savedChanged: Array<(event: AgentTaskChangedEvent) => void> = []
  const savedRuns: Array<(event: AgentGenerationEvent) => void> = []
  let snapshots = 0
  let failSetup = false
  let failRelease = false
  const controller = new AgentTaskController({ clients,
    sessions: { get: () => undefined, getMessages: () => [] },
    tasks: {
      list: () => { snapshots += 1; return [task] }, get: () => task,
      subscribe: (listener) => {
        changed.add(listener)
        savedChanged.push(listener)
        return () => { changed.delete(listener) }
      },
    },
    events: { subscribe: (listener) => {
      if (failSetup) throw new Error('运行订阅失败')
      runs.add(listener)
      savedRuns.push(listener)
      return () => { runs.delete(listener); if (failRelease) throw new Error('运行清理失败') }
    } },
  })
  const emitRun = (): void => {
    for (const listener of runs) listener({ type: 'run_started', sessionId: task.childSessionId, runStartedAt: 10, source: 'delegation' })
  }
  return { controller, task, changed, runs, savedChanged, savedRuns, emitRun,
    snapshots: () => snapshots,
    failSetup: () => { failSetup = true }, failRelease: () => { failRelease = true },
  }
}

describe('AgentTaskController', () => {
  test('只允许根会话读取所属 task 与子会话 JSONL', () => {
    let nextSessionId = 1
    const sessionsDir = join(directory, 'sessions')
    const sessions = new AgentSessionManager({
      indexPath: join(directory, 'index.json'), sessionsDir,
      createId: () => `session-${nextSessionId++}`, now: () => 1_000,
    })
    const tasks = new AgentDelegationManager({ sessionsDir, createId: () => 'task-1', now: () => 1_000 })
    const events = new AgentEventBus()
    const root = sessions.create()
    const otherRoot = sessions.create()
    const child = sessions.create({
      parentSessionId: root.id, rootSessionId: root.id, parentToolUseId: 'tool-1', subagentType: 'explore',
    })
    const task = tasks.create({
      rootSessionId: root.id, parentSessionId: root.id, childSessionId: child.id,
      parentToolUseId: 'tool-1', title: '搜索入口', objective: '定位入口',
      subagentType: 'explore', runInBackground: false, depth: 1,
    })
    sessions.appendMessage(child.id, {
      type: 'assistant', message: { content: [{ type: 'text', text: '找到了' }] },
      parent_tool_use_id: null, uuid: 'child-message-1',
    })
    const controller = new AgentTaskController({ clients, sessions, tasks, events })

    expect(controller.list(root.id)).toHaveLength(1)
    expect(controller.get(root.id, task.id)?.childSessionId).toBe(child.id)
    expect(controller.get(otherRoot.id, task.id)).toBeNull()
    expect(controller.getMessages(root.id, task.id)[0]).toMatchObject({ uuid: 'child-message-1' })
    expect(() => controller.list(child.id)).toThrow('根会话不存在')
    expect(() => controller.getMessages(otherRoot.id, task.id)).toThrow('子任务不存在')
    for (const value of [undefined, {}, 1, '', '../escape', 'a'.repeat(129)]) {
      expect(() => controller.list(value)).toThrow(AgentTaskControllerError)
    }
    expect(() => controller.get(root.id, '../escape')).toThrow(AgentTaskControllerError)
  })

  test('把状态快照和子 Agent 实时事件投影到同一 taskId', () => {
    let changedListener: ((event: AgentTaskEvent & { type: 'changed' }) => void) | undefined
    let runListener: ((event: Parameters<AgentEventBus['emit']>[0], run?: BackendOwnedRun) => void) | undefined
    const task = {
      id: 'task-1', rootSessionId: 'root-1', parentSessionId: 'root-1', childSessionId: 'child-1',
      parentToolUseId: 'tool-1', title: '任务', objective: '目标', subagentType: 'coder' as const,
      runInBackground: true, depth: 1, status: 'running' as const, createdAt: 1, updatedAt: 2, startedAt: 2,
    }
    const controller = new AgentTaskController({ clients,
      sessions: { get: () => ({ id: 'root-1', runtimeId: 'pi', title: '根', createdAt: 1, updatedAt: 1 }), getMessages: () => [] },
      tasks: {
        list: () => [task], get: () => task,
        subscribe: (listener) => { changedListener = listener; return () => {} },
      },
      events: { subscribe: (listener) => { runListener = listener; return () => {} } },
    })
    const received: AgentTaskEvent[] = []
    const release = controller.subscribe(owner, (event) => received.push(event))
    changedListener?.({ type: 'changed', rootSessionId: 'root-1', task: { ...task, latestProgress: '进行中' } })
    const run = { sessionId: 'child-1', runId: 'real-child-run', runStartedAt: 10 }
    runListener?.({ type: 'run_started', sessionId: 'child-1', runStartedAt: 10, source: 'delegation' }, run)
    runListener?.({ type: 'run_started', sessionId: 'unrelated', runStartedAt: 11, source: 'delegation' })
    release()

    expect(received.map((event) => event.type)).toEqual(['changed', 'agent_event'])
    expect(received[1]).toMatchObject({ rootSessionId: 'root-1', taskId: 'task-1', agentId: 'child-1', run })
    expect(received[1]?.type === 'agent_event' && received[1].run).not.toBe(run)
  })

  test('每个订阅独立缓存；同入口释放一个或另入口断开都不影响剩余投影', () => {
    const fixture = subscriptionsFixture()
    const other = clients.register()
    const received: AgentTaskEvent[][] = [[], [], []]
    const first = fixture.controller.subscribe(owner, (event) => received[0]!.push(event))
    fixture.controller.subscribe(owner, (event) => received[1]!.push(event))
    fixture.controller.subscribe(other, (event) => received[2]!.push(event))
    fixture.emitRun()
    first()
    first()
    fixture.emitRun()
    expect(received.map((events) => events.length)).toEqual([1, 2, 2])
    clients.detach(owner)
    fixture.emitRun()
    fixture.savedRuns[0]!({ type: 'run_started', sessionId: 'child-1', runStartedAt: 11, source: 'delegation' })
    fixture.savedChanged[1]!({ type: 'changed', rootSessionId: 'root-1', task: fixture.task })
    expect(received.map((events) => events.length)).toEqual([1, 2, 3])
    expect(fixture.snapshots()).toBe(3)
    expect(fixture.runs.size).toBe(1)
    expect(fixture.changed.size).toBe(1)
    expect(() => fixture.controller.subscribe(owner, () => {})).toThrow('未登记或已断开')
    expect(() => fixture.controller.subscribe('自报身份', () => {})).toThrow('未登记或已断开')
    fixture.controller.dispose()
    fixture.controller.dispose()
    expect(fixture.runs.size).toBe(0)
    expect(fixture.changed.size).toBe(0)
    expect(() => fixture.controller.subscribe(other, () => {})).toThrow('未登记或已断开')
  })

  test('新任务状态补充缓存，后续 delta 不重新读取任务快照', () => {
    const fixture = subscriptionsFixture()
    const received: AgentTaskEvent[] = []
    const release = fixture.controller.subscribe(owner, (event) => received.push(event))
    const task = { ...fixture.task, id: 'task-2', childSessionId: 'child-2' }
    fixture.savedRuns[0]!({ type: 'run_started', sessionId: 'child-2', runStartedAt: 10, source: 'delegation' })
    fixture.savedChanged[0]!({ type: 'changed', rootSessionId: 'root-1', task })
    fixture.savedRuns[0]!({ type: 'run_started', sessionId: 'child-2', runStartedAt: 10, source: 'delegation' })
    expect(received.map((event) => event.type)).toEqual(['changed', 'agent_event'])
    expect(received[1]).toMatchObject({ taskId: 'task-2', agentId: 'child-2' })
    expect(fixture.snapshots()).toBe(1)
    release()
  })

  test('消费者异常不阻断其他入口；某个上游清理失败仍释放全部资源', () => {
    const fixture = subscriptionsFixture()
    const warn = spyOn(console, 'warn').mockImplementation(() => {})
    try {
      fixture.controller.subscribe(owner, () => { throw new Error('页面异常') })
      const received: AgentTaskEvent[] = []
      fixture.controller.subscribe(owner, (event) => received.push(event))
      fixture.emitRun()
      expect(received).toHaveLength(1)
      expect(warn).toHaveBeenCalledTimes(1)
      fixture.failRelease()
      expect(() => fixture.controller.dispose()).toThrow('子任务投影清理失败')
      expect(fixture.runs.size).toBe(0)
      expect(fixture.changed.size).toBe(0)
      fixture.controller.dispose()
      fixture.savedRuns[1]!({ type: 'run_started', sessionId: 'child-1', runStartedAt: 11, source: 'delegation' })
      expect(received).toHaveLength(1)
    } finally { warn.mockRestore() }
  })

  test('第二个上游订阅失败时撤销已建立的任务监听，迟到状态不投递', () => {
    const fixture = subscriptionsFixture()
    fixture.failSetup()
    const received: AgentTaskEvent[] = []
    expect(() => fixture.controller.subscribe(owner, (event) => received.push(event))).toThrow('运行订阅失败')
    fixture.savedChanged[0]!({ type: 'changed', rootSessionId: 'root-1', task: fixture.task })
    expect(fixture.changed.size).toBe(0)
    expect(fixture.runs.size).toBe(0)
    expect(received).toEqual([])
    fixture.controller.dispose()
  })
})
