import { afterEach, beforeEach, describe, expect, test } from 'bun:test'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type { AgentRunOutcome } from '../agent/agent-service'
import { AgentCollaborationService, AgentCollaborationServiceError } from './agent-collaboration-service'
import { AgentDelegationManager } from './agent-delegation-manager'
import { AgentSessionManager } from '../agent/agent-session-manager'

let directory: string
let sessions: AgentSessionManager
let tasks: AgentDelegationManager
let rootSessionId: string

beforeEach(() => {
  directory = mkdtempSync(join(tmpdir(), 'axon-agent-collaboration-'))
  let nextSessionId = 1
  sessions = new AgentSessionManager({
    indexPath: join(directory, 'index.json'), sessionsDir: join(directory, 'sessions'),
    createId: () => `session-${nextSessionId++}`, now: () => 1_000,
  })
  tasks = new AgentDelegationManager({
    sessionsDir: join(directory, 'sessions'), createId: () => `task-${tasks.list().length + 1}`, now: () => 1_000,
  })
  rootSessionId = sessions.create({
    channelId: 'channel-1', modelId: 'model-1', projectId: 'project-1', permissionMode: 'acceptEdits',
    thinkingLevel: 'high',
  }).id
})

afterEach(() => rmSync(directory, { recursive: true, force: true }))

function successOutcome(text: string): AgentRunOutcome {
  return {
    result: { type: 'result', subtype: 'success', usage: { input_tokens: 1, output_tokens: 1 } },
    finalText: text,
  }
}

describe('AgentCollaborationService', () => {
  test('前台委派直接等待运行结果，同一工具调用重放不重复创建', async () => {
    const calls: Array<{ sessionId: string; text: string }> = []
    const service = new AgentCollaborationService({
      sessions,
      delegations: tasks,
      agent: {
        sendMessage: async (input) => { calls.push(input); return successOutcome('子 Agent 结论') },
        isActive: (sessionId) => sessionId === rootSessionId,
        stop: () => false,
      },
      resolveProjectCwd: () => directory,
    })
    const input = {
      parentSessionId: rootSessionId, parentToolUseId: 'tool-1', title: '检查项目',
      objective: '执行检查', subagentType: 'coder' as const, runInBackground: false,
    }
    const created = service.delegate(input)
    const replayed = service.delegate(input)
    const terminal = await service.wait(rootSessionId, created.id)

    expect(replayed.id).toBe(created.id)
    expect(calls).toHaveLength(1)
    expect(calls[0]).toMatchObject({ text: '执行检查' })
    expect(terminal).toMatchObject({ status: 'completed', resultSummary: '子 Agent 结论' })
    expect(sessions.get(terminal.childSessionId)).toMatchObject({
      rootSessionId, parentSessionId: rootSessionId, parentToolUseId: 'tool-1',
      channelId: 'channel-1', modelId: 'model-1', projectId: 'project-1', permissionMode: 'acceptEdits',
      thinkingLevel: 'high',
    })
  })

  test('后台终态先持久化，再交给宿主完成通知', async () => {
    let notifiedStatus: string | undefined
    let resolveNotification: (() => void) | undefined
    const notification = new Promise<void>((resolve) => { resolveNotification = resolve })
    const service = new AgentCollaborationService({
      sessions,
      delegations: tasks,
      agent: {
        sendMessage: async () => successOutcome('后台完成'),
        isActive: (sessionId) => sessionId === rootSessionId,
        stop: () => false,
      },
      resolveProjectCwd: () => directory,
    })
    service.setBackgroundCompletionHandler(async (task) => {
      notifiedStatus = tasks.get(task.id)?.status
      resolveNotification?.()
    })
    const created = service.delegate({
      parentSessionId: rootSessionId, parentToolUseId: 'tool-bg', title: '后台检查',
      objective: '后台执行', subagentType: 'explore', runInBackground: true,
    })
    await service.wait(rootSessionId, created.id)
    await notification
    expect(notifiedStatus).toBe('completed')
  })

  test('拒绝非运行中父会话和子 Agent 再委派', async () => {
    const service = new AgentCollaborationService({
      sessions,
      delegations: tasks,
      agent: {
        sendMessage: async () => successOutcome('完成'),
        isActive: () => false,
        stop: () => false,
      },
      resolveProjectCwd: () => directory,
    })
    expect(() => service.delegate({
      parentSessionId: rootSessionId, parentToolUseId: 'tool-1', title: '任务',
      objective: '目标', subagentType: 'coder', runInBackground: false,
    })).toThrow(expect.objectContaining({ code: 'parent_inactive' }))

    const child = sessions.create({
      parentSessionId: rootSessionId, rootSessionId, parentToolUseId: 'tool-existing', subagentType: 'coder',
    })
    const childService = new AgentCollaborationService({
      sessions,
      delegations: tasks,
      agent: { sendMessage: async () => successOutcome('完成'), isActive: () => true, stop: () => false },
      resolveProjectCwd: () => directory,
    })
    try {
      childService.delegate({
        parentSessionId: child.id, parentToolUseId: 'nested-tool', title: '嵌套',
        objective: '不允许', subagentType: 'coder', runInBackground: false,
      })
      throw new Error('应当拒绝嵌套委派')
    } catch (error) {
      expect(error).toBeInstanceOf(AgentCollaborationServiceError)
      expect((error as AgentCollaborationServiceError).code).toBe('limit_reached')
    }
  })
})
