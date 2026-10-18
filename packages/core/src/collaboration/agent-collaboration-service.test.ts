import { afterEach, beforeEach, describe, expect, test } from 'bun:test'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type { AgentRunOutcome } from '../agent/agent-service'
import { AgentServiceError } from '../agent/agent-service'
import { MAX_AGENT_DELEGATION_CONCURRENCY } from '@axon/shared'
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
    channelId: 'channel-1', modelId: 'model-1', projectId: 'project-1',
    sandboxMode: 'workspaceWrite',
    approvalPolicy: 'onRequest', approvalReviewer: 'user',
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
  test('根收束等待实际子执行和终态后的后台交付；并发等待共用同一 Promise', async () => {
    const child = Promise.withResolvers<AgentRunOutcome>(), delivery = Promise.withResolvers<void>(), entered = Promise.withResolvers<void>()
    const service = new AgentCollaborationService({ sessions, delegations: tasks,
      agent: { sendMessage: () => child.promise, isActive: () => true, stop: () => false }, resolveExecutionContext: () => ({ workspacePath: directory }) })
    service.setBackgroundCompletionHandler(async () => { entered.resolve(); await delivery.promise })
    const task = service.delegate({ parentSessionId: rootSessionId, parentToolUseId: 'root-drain', title: '后台任务',
      objective: '检查', subagentType: 'explore', runInBackground: true })
    const waiting = service.waitForRootIdle(rootSessionId)
    expect(service.waitForRootIdle(rootSessionId)).toBe(waiting)
    let finished = false
    void waiting.then(() => { finished = true })
    await Promise.resolve(); expect(finished).toBe(false)
    child.resolve(successOutcome('子任务结束'))
    await entered.promise
    expect(tasks.get(task.id)?.status).toBe('completed')
    expect(finished).toBe(false)
    delivery.resolve(); await waiting
    expect(finished).toBe(true)
  })

  test('排队任务在执行 finally 中启动；交付再次派生任务时根等待继续跟随', async () => {
    const gates = new Map<string, ReturnType<typeof Promise.withResolvers<AgentRunOutcome>>>()
    const started: string[] = []
    const lastStarted = Promise.withResolvers<void>()
    const count = MAX_AGENT_DELEGATION_CONCURRENCY + 2
    const service = new AgentCollaborationService({ sessions, delegations: tasks,
      agent: { async sendMessage(input) {
        started.push(input.text)
        const gate = Promise.withResolvers<AgentRunOutcome>(); gates.set(input.text, gate)
        if (input.text === '交付后继') lastStarted.resolve()
        return await gate.promise
      }, isActive: () => true, stop: () => false }, resolveExecutionContext: () => ({ workspacePath: directory }) })
    service.setBackgroundCompletionHandler(async (task) => {
      if (task.objective === '任务0') service.delegate({ parentSessionId: rootSessionId, parentToolUseId: 'followup', title: '后继',
        objective: '交付后继', subagentType: 'explore', runInBackground: false })
    })
    for (let index = 0; index < count; index++) service.delegate({ parentSessionId: rootSessionId, parentToolUseId: `queue-${index}`,
      title: '排队检查', objective: `任务${index}`, subagentType: 'explore', runInBackground: true })
    expect(started).toHaveLength(MAX_AGENT_DELEGATION_CONCURRENCY)
    let finished = false
    const waiting = service.waitForRootIdle(rootSessionId).then(() => { finished = true })
    // 每个槽释放后才继续解析排队任务；不靠定时 sleep 猜它是否已启动。
    for (let index = 0; index < count; index++) {
      while (!gates.has(`任务${index}`)) await new Promise<void>((resolve) => setImmediate(resolve))
      gates.get(`任务${index}`)!.resolve(successOutcome('完成'))
    }
    await lastStarted.promise
    expect(finished).toBe(false)
    gates.get('交付后继')!.resolve(successOutcome('后继完成'))
    await waiting
    expect(started).toHaveLength(count + 1)
    expect(tasks.list(rootSessionId).every((task) => task.status === 'completed')).toBe(true)
  })

  test('根等待不受其他根的长任务影响；取消状态先落盘也必须等待执行 finally', async () => {
    const other = sessions.create({ channelId: 'channel-1', modelId: 'model-1', projectId: 'project-1' })
    const gates = new Map<string, ReturnType<typeof Promise.withResolvers<AgentRunOutcome>>>()
    const stops: string[] = []
    const service = new AgentCollaborationService({ sessions, delegations: tasks,
      agent: { sendMessage(input) { const gate = Promise.withResolvers<AgentRunOutcome>(); gates.set(input.sessionId, gate); return gate.promise },
        isActive: () => true, stop(id) { stops.push(id); return true } }, resolveExecutionContext: () => ({ workspacePath: directory }) })
    const ours = service.delegate({ parentSessionId: rootSessionId, parentToolUseId: 'ours', title: '当前根', objective: '检查', subagentType: 'explore', runInBackground: false })
    const theirs = service.delegate({ parentSessionId: other.id, parentToolUseId: 'theirs', title: '另一个根', objective: '检查', subagentType: 'explore', runInBackground: false })
    service.cancelDescendants(rootSessionId)
    expect(tasks.get(ours.id)?.status).toBe('canceled')
    expect(stops).toEqual([ours.childSessionId])
    let finished = false
    const waiting = service.waitForRootIdle(rootSessionId).then(() => { finished = true })
    await Promise.resolve(); expect(finished).toBe(false)
    gates.get(ours.childSessionId)!.resolve(successOutcome('迟到结果'))
    await waiting
    expect(tasks.get(theirs.id)?.status).toBe('running')
    expect(tasks.get(ours.id)?.status).toBe('canceled')
    gates.get(theirs.childSessionId)!.resolve(successOutcome('另一个根完成'))
    await service.waitForRootIdle(other.id)
  })

  test('交付失败即使已被日志捕获、发生于等待之前，也不能报告根成功', async () => {
    const delivered = Promise.withResolvers<void>()
    const service = new AgentCollaborationService({ sessions, delegations: tasks,
      agent: { async sendMessage() { return successOutcome('完成') }, isActive: () => true, stop: () => false }, resolveExecutionContext: () => ({ workspacePath: directory }) })
    service.setBackgroundCompletionHandler(async () => { delivered.resolve(); throw new Error('fixture-secret') })
    const task = service.delegate({ parentSessionId: rootSessionId, parentToolUseId: 'bad-delivery', title: '交付失败', objective: '检查', subagentType: 'explore', runInBackground: true })
    await delivered.promise
    await new Promise<void>((resolve) => setImmediate(resolve))
    expect(tasks.get(task.id)?.status).toBe('completed')
    await expect(service.waitForRootIdle(rootSessionId)).rejects.toMatchObject({ code: 'runtime_error', message: '子任务执行或后台结果交付未完整完成' })
    // 根等待消费本批失败；后续正常工作不被永久粘住。
    await service.waitForRootIdle(rootSessionId)
  })

  test('终态存储失败不会被当作 idle；无实际执行器的活动记录明确报错', async () => {
    const service = new AgentCollaborationService({ sessions, delegations: {
      list: (...args) => tasks.list(...args), get: (...args) => tasks.get(...args), create: (...args) => tasks.create(...args),
      transition(id, update) { if (update.status === 'completed') throw new Error('fixture-secret'); return tasks.transition(id, update) },
    }, agent: { async sendMessage() { return successOutcome('完成') }, isActive: () => true, stop: () => false }, resolveExecutionContext: () => ({ workspacePath: directory }) })
    service.delegate({ parentSessionId: rootSessionId, parentToolUseId: 'failed-storage', title: '存储失败', objective: '检查', subagentType: 'explore', runInBackground: false })
    await expect(service.waitForRootIdle(rootSessionId)).rejects.toMatchObject({ code: 'persistence_error' })
    await expect(service.waitForRootIdle(rootSessionId)).rejects.toMatchObject({ code: 'runtime_error', message: '存在没有实际执行器的未完成子任务' })
    expect(() => service.waitForRootIdle('missing')).toThrow(AgentCollaborationServiceError)
  })

  test('缺少后台交付处理器明确失败；续跑持久化错误保留错误类别', async () => {
    for (const mode of ['missing-handler', 'persistence']) {
      const service = new AgentCollaborationService({ sessions, delegations: tasks,
        agent: { async sendMessage() { return successOutcome('完成') }, isActive: () => true, stop: () => false }, resolveExecutionContext: () => ({ workspacePath: directory }) })
      if (mode === 'persistence') service.setBackgroundCompletionHandler(async () => { throw new AgentServiceError('persistence_error', '保存续跑失败') })
      service.delegate({ parentSessionId: rootSessionId, parentToolUseId: mode, title: '后台结果', objective: '检查', subagentType: 'explore', runInBackground: true })
      await expect(service.waitForRootIdle(rootSessionId)).rejects.toMatchObject({ code: mode === 'persistence' ? 'persistence_error' : 'runtime_error' })
    }
  })

  test('取消终态不能掩盖迟到的子原文存储故障；根故障优先保留持久化错误', async () => {
    for (const canceled of [true, false]) {
      const child = Promise.withResolvers<AgentRunOutcome>(), delivered = Promise.withResolvers<void>()
      const service = new AgentCollaborationService({ sessions, delegations: tasks,
        agent: { sendMessage: (input) => input.text === '先完成' ? Promise.resolve(successOutcome('完成')) : child.promise,
          isActive: () => true, stop: () => true }, resolveExecutionContext: () => ({ workspacePath: directory }) })
      service.setBackgroundCompletionHandler(async () => { delivered.resolve(); throw new Error('私有交付错误') })
      if (!canceled) {
        service.delegate({ parentSessionId: rootSessionId, parentToolUseId: 'runtime-before-storage', title: '先完成', objective: '先完成', subagentType: 'explore', runInBackground: true })
        await delivered.promise
        await new Promise<void>((resolve) => setImmediate(resolve))
      }
      const task = service.delegate({ parentSessionId: rootSessionId, parentToolUseId: `late-storage-${canceled}`, title: '存储故障', objective: '等待', subagentType: 'explore', runInBackground: false })
      if (canceled) service.cancelDescendants(rootSessionId)
      const waiting = service.waitForRootIdle(rootSessionId)
      child.reject(new AgentServiceError('persistence_error', '私有存储错误'))
      await expect(waiting).rejects.toMatchObject({ code: 'persistence_error', message: '子任务执行或后台结果交付未完整完成' })
      expect(tasks.get(task.id)?.status).toBe(canceled ? 'canceled' : 'failed')
      await service.waitForRootIdle(rootSessionId)
    }
  })

  test('explore/plan 创建为只读，不继承父会话的项目写权限', async () => {
    const service = new AgentCollaborationService({
      sessions, delegations: tasks,
      agent: { sendMessage: async () => successOutcome('完成'), isActive: () => true, stop: () => false },
      resolveExecutionContext: () => ({ workspacePath: directory }),
      prepareChildSession: (parent) => ({ projectId: parent.projectId, sandboxMode: 'workspaceWrite', approvalPolicy: 'onRequest', userInputPolicy: 'ask' }),
    })
    for (const role of ['explore', 'plan'] as const) {
      const task = service.delegate({ parentSessionId: rootSessionId, parentToolUseId: `tool-${role}`,
        title: '检查', objective: '分析', subagentType: role, runInBackground: false })
      await service.wait(rootSessionId, task.id)
      expect(sessions.get(task.childSessionId)).toMatchObject({ sandboxMode: 'readOnly', approvalPolicy: 'onRequest' })
    }
  })

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
      resolveExecutionContext: () => ({ workspacePath: directory }),
      prepareChildSession: (parent) => ({ projectId: parent.projectId }),
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
      channelId: 'channel-1', modelId: 'model-1', projectId: 'project-1',
      sandboxMode: 'workspaceWrite',
      approvalPolicy: 'onRequest', approvalReviewer: 'user',
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
      resolveExecutionContext: () => ({ workspacePath: directory }),
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
      resolveExecutionContext: () => ({ workspacePath: directory }),
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
      resolveExecutionContext: () => ({ workspacePath: directory }),
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
