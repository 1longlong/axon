import { afterEach, beforeEach, describe, expect, test } from 'bun:test'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type { AgentTaskEvent } from '@axon/shared'
import { AgentDelegationManager } from './agent-delegation-manager'
import { AgentEventBus } from '../agent/agent-event-bus'
import { AgentSessionManager } from '../agent/agent-session-manager'
import { AgentTaskIpcController } from './agent-task-ipc-handlers'

let directory: string

beforeEach(() => { directory = mkdtempSync(join(tmpdir(), 'axon-agent-task-ipc-')) })
afterEach(() => rmSync(directory, { recursive: true, force: true }))

describe('AgentTaskIpcController', () => {
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
    const controller = new AgentTaskIpcController({ sessions, tasks, events })

    expect(controller.list(root.id)).toHaveLength(1)
    expect(controller.get(root.id, task.id)?.childSessionId).toBe(child.id)
    expect(controller.get(otherRoot.id, task.id)).toBeNull()
    expect(controller.getMessages(root.id, task.id)[0]).toMatchObject({ uuid: 'child-message-1' })
    expect(() => controller.list(child.id)).toThrow('根会话不存在')
    expect(() => controller.getMessages(otherRoot.id, task.id)).toThrow('子任务不存在')
  })

  test('把状态快照和子 Agent 实时事件投影到同一 taskId', () => {
    let changedListener: ((event: AgentTaskEvent & { type: 'changed' }) => void) | undefined
    let runListener: ((event: Parameters<AgentEventBus['emit']>[0]) => void) | undefined
    const task = {
      id: 'task-1', rootSessionId: 'root-1', parentSessionId: 'root-1', childSessionId: 'child-1',
      parentToolUseId: 'tool-1', title: '任务', objective: '目标', subagentType: 'coder' as const,
      runInBackground: true, depth: 1, status: 'running' as const, createdAt: 1, updatedAt: 2, startedAt: 2,
    }
    const controller = new AgentTaskIpcController({
      sessions: { get: () => ({ id: 'root-1', runtimeId: 'pi', title: '根', createdAt: 1, updatedAt: 1 }), getMessages: () => [] },
      tasks: {
        list: () => [task], get: () => task,
        subscribe: (listener) => { changedListener = listener; return () => {} },
      },
      events: { subscribe: (listener) => { runListener = listener; return () => {} } },
    })
    const received: AgentTaskEvent[] = []
    const release = controller.subscribe((event) => received.push(event))
    changedListener?.({ type: 'changed', rootSessionId: 'root-1', task: { ...task, latestProgress: '进行中' } })
    runListener?.({ type: 'run_started', sessionId: 'child-1', runStartedAt: 10, source: 'delegation' })
    runListener?.({ type: 'run_started', sessionId: 'unrelated', runStartedAt: 11, source: 'delegation' })
    release()

    expect(received.map((event) => event.type)).toEqual(['changed', 'agent_event'])
    expect(received[1]).toMatchObject({ rootSessionId: 'root-1', taskId: 'task-1', agentId: 'child-1' })
  })
})
