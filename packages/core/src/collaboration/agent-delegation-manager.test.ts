import { afterEach, beforeEach, describe, expect, test } from 'bun:test'
import { mkdtempSync, readFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type { AgentDelegationCreateInput } from '@axon/shared'
import { AgentDelegationManager } from './agent-delegation-manager'
import { AgentSessionManager } from '../agent/agent-session-manager'

let directory: string
let sessionsDir: string
let nowValue: number
let nextSessionId: number

beforeEach(() => {
  directory = mkdtempSync(join(tmpdir(), 'axon-agent-delegations-'))
  sessionsDir = join(directory, 'sessions')
  nowValue = 1_000
  nextSessionId = 1
})

afterEach(() => rmSync(directory, { recursive: true, force: true }))

function createManagers(): { sessions: AgentSessionManager; tasks: AgentDelegationManager } {
  return {
    sessions: new AgentSessionManager({
      indexPath: join(directory, 'agent-sessions.json'),
      sessionsDir,
      createId: () => `session-${nextSessionId++}`,
      now: () => nowValue,
    }),
    tasks: new AgentDelegationManager({
      sessionsDir,
      createId: () => 'task-1',
      now: () => nowValue,
    }),
  }
}

function taskInput(rootSessionId: string, childSessionId: string): AgentDelegationCreateInput {
  return {
    rootSessionId,
    parentSessionId: rootSessionId,
    childSessionId,
    parentToolUseId: 'tool-1',
    title: '检查构建',
    objective: '运行构建并返回结果',
    subagentType: 'coder',
    runInBackground: true,
    depth: 1,
  }
}

describe('AgentDelegationManager 根会话聚合存储', () => {
  test('任务和子 Agent 共享 state.json，磁盘不重复存可推导外键', () => {
    const { sessions, tasks } = createManagers()
    const root = sessions.create({ channelId: 'channel-1', modelId: 'model-1', projectId: 'project-1' })
    const child = sessions.create({
      title: '检查构建', channelId: 'channel-1', modelId: 'model-1', projectId: 'project-1',
      parentSessionId: root.id, rootSessionId: root.id, parentToolUseId: 'tool-1', subagentType: 'coder',
    })
    const created = tasks.create(taskInput(root.id, child.id))

    expect(tasks.get(created.id)).toMatchObject({
      rootSessionId: root.id, parentSessionId: root.id, childSessionId: child.id, depth: 1,
    })
    const state = JSON.parse(readFileSync(join(sessionsDir, root.id, 'state.json'), 'utf-8')) as {
      agents: Record<string, Record<string, unknown>>
      tasks: Array<Record<string, unknown>>
    }
    expect(state.agents.main!.channelId).toBe('channel-1')
    expect(state.agents[child.id]).not.toHaveProperty('parentToolUseId')
    expect(state.tasks[0]).toMatchObject({ id: created.id, agentId: child.id, parentToolUseId: 'tool-1' })
    expect(state.tasks[0]).not.toHaveProperty('rootSessionId')
    expect(state.tasks[0]).not.toHaveProperty('childSessionId')

    const reloaded = createManagers()
    expect(reloaded.sessions.get(child.id)).toMatchObject({
      parentSessionId: root.id, rootSessionId: root.id, parentToolUseId: 'tool-1',
    })
    expect(reloaded.tasks.get(created.id)?.childSessionId).toBe(child.id)
  })

  test('状态机写入完整终态并推送快照，终态不可复活', () => {
    const { sessions, tasks } = createManagers()
    const root = sessions.create()
    const child = sessions.create({
      parentSessionId: root.id, rootSessionId: root.id, parentToolUseId: 'tool-1', subagentType: 'coder',
    })
    const events: string[] = []
    tasks.subscribe((event) => events.push(`${event.task.status}:${event.task.updatedAt}`))
    const created = tasks.create(taskInput(root.id, child.id))
    nowValue = 2_000
    tasks.transition(created.id, { status: 'running' })
    nowValue = 3_000
    tasks.updateProgress(created.id, '已完成检查')
    nowValue = 4_000
    const completed = tasks.transition(created.id, { status: 'completed', resultSummary: '构建通过' })

    expect(completed).toMatchObject({
      status: 'completed', resultSummary: '构建通过', latestProgress: '已完成检查',
      startedAt: 2_000, finishedAt: 4_000,
    })
    expect(events).toEqual(['queued:1000', 'running:2000', 'running:3000', 'completed:4000'])
    expect(() => tasks.transition(created.id, { status: 'running' })).toThrow(
      expect.objectContaining({ code: 'invalid_transition' }),
    )
  })

  test('启动时将遗留的 queued/running 任务收敛为 interrupted', () => {
    const { sessions, tasks } = createManagers()
    const root = sessions.create()
    const child = sessions.create({
      parentSessionId: root.id, rootSessionId: root.id, parentToolUseId: 'tool-1', subagentType: 'coder',
    })
    const created = tasks.create(taskInput(root.id, child.id))
    nowValue = 9_000
    const interrupted = tasks.markRunningDelegationsAsInterrupted()
    expect(interrupted).toHaveLength(1)
    expect(tasks.get(created.id)).toMatchObject({ status: 'interrupted', finishedAt: 9_000 })
  })
})
