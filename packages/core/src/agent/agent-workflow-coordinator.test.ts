import { describe, expect, test } from 'bun:test'
import type { AgentCompletionPayload, AgentSessionMeta, BackendAgentWorkflowEvent, BackendOwnedRun } from '@axon/shared'
import { BackendClientRegistry } from '../backend-client-registry'
import { AgentWorkflowCoordinator } from './agent-workflow-coordinator'
import type { AgentWorkflowCoordinatorOptions } from './agent-workflow-coordinator'

const session: AgentSessionMeta = { id: 'root', title: '工作流', runtimeId: 'pi', createdAt: 1, updatedAt: 1,
  approvalPolicy: 'never', userInputPolicy: 'reject' }
const run: BackendOwnedRun = { sessionId: session.id, runId: 'run', runStartedAt: 1 }
const completed: AgentCompletionPayload = { terminalReason: 'success', resultSubtype: 'success', stoppedByUser: false,
  persisted: true, usage: { input_tokens: 0 }, completedAt: 2, durationMs: 1 }

/** 此夹具只验证工作流控制/失败边界；真实协议、协作和历史由 app-server 集成测试覆盖。 */
function fixture(overrides: Partial<AgentWorkflowCoordinatorOptions> = {}) {
  const clients = new BackendClientRegistry(), owner = clients.register(), events: BackendAgentWorkflowEvent[] = []
  let workflow!: AgentWorkflowCoordinator
  const options: AgentWorkflowCoordinatorOptions = { clients, getSession: () => session, busy: () => false,
    send: async () => {
      workflow.observe(owner, { run, visibleSessionId: session.id,
        event: { type: 'run_started', sessionId: session.id, runStartedAt: 1, source: 'external' } })
      workflow.observe(owner, { run, visibleSessionId: session.id,
        event: { type: 'run_finished', sessionId: session.id, runStartedAt: 1, source: 'external', completion: completed } })
      return { success: true, disposition: 'started' }
    }, stop() {}, cancelDescendants() {}, async waitForDescendants() {}, ...overrides }
  workflow = new AgentWorkflowCoordinator(options)
  workflow.subscribe(owner, (event) => events.push(event))
  return { workflow, clients, owner, options, events }
}

describe('工作流失败与实际收束边界', () => {
  test('单轮 success 但终态未落盘时，整个工作流必须失败', async () => {
    const f = fixture()
    f.options.send = async () => {
      f.workflow.observe(f.owner, { run, visibleSessionId: session.id, event: { type: 'run_finished', sessionId: session.id,
        runStartedAt: 1, source: 'external', completion: { ...completed, persisted: false } } })
      return { success: true, disposition: 'started' }
    }
    expect(await f.workflow.execute(f.owner, { sessionId: session.id, text: '任务' }))
      .toMatchObject({ status: 'failed', error: { category: 'persistence', code: 'persistence_error' } })
    expect(f.events.map((event) => event.type)).toEqual(['workflow_started', 'workflow_finished'])
  })

  test('发送成功不替代真实主轮完成事件；发送失败仍等待实际子收束', async () => {
    const f = fixture({ send: async () => ({ success: true, disposition: 'started' }) })
    expect(await f.workflow.execute(f.owner, { sessionId: session.id, text: '任务' })).toMatchObject({ status: 'failed' })
    const gate = Promise.withResolvers<void>(), entered = Promise.withResolvers<void>()
    f.options.send = async () => ({ success: false, code: 'persistence_error', message: '不能保存' })
    f.options.waitForDescendants = async () => { entered.resolve(); await gate.promise }
    const pending = f.workflow.execute(f.owner, { sessionId: session.id, text: '任务' })
    try {
      await entered.promise
      expect(f.workflow.active(session.id)).toBe(true)
      expect(f.workflow.permitsSend(f.owner, session.id)).toBe(false)
      gate.resolve()
      expect(await pending).toMatchObject({ status: 'failed', error: { code: 'persistence_error' } })
    } finally { gate.resolve(); await pending }
  })

  test('取消期间实际存储失败仍报告 failed；普通迟到交付拒绝则保持 canceled', async () => {
    for (const code of ['persistence_error', 'runtime_error']) {
      const gate = Promise.withResolvers<void>(), entered = Promise.withResolvers<void>()
      const f = fixture({ waitForDescendants: async () => { entered.resolve(); await gate.promise; throw { code, message: '私有故障内容' } } })
      const pending = f.workflow.execute(f.owner, { sessionId: session.id, text: '任务' })
      try {
        await entered.promise
        expect(f.workflow.cancel(f.owner, f.workflow.getOwned(f.owner, session.id)!)).toBe(true)
        gate.resolve()
        const result = await pending
        expect(result.status).toBe(code === 'persistence_error' ? 'failed' : 'canceled')
        expect(JSON.stringify(result)).not.toContain('私有故障内容')
      } finally { gate.resolve(); await pending }
    }
  })

  test('一个停止动作失败不能跳过另一个，dispose/drain 仍等待真实 finally', async () => {
    const gate = Promise.withResolvers<void>(), entered = Promise.withResolvers<void>()
    let stopped = 0, drained = false
    const f = fixture({ cancelDescendants() { throw new Error('私有清理故障') }, stop() { stopped++ },
      waitForDescendants: async () => { entered.resolve(); await gate.promise } })
    const pending = f.workflow.execute(f.owner, { sessionId: session.id, text: '任务' })
    try {
      await entered.promise; f.workflow.dispose()
      const draining = f.workflow.drain().then(() => { drained = true })
      await Promise.resolve()
      expect(stopped).toBe(1); expect(drained).toBe(false)
      expect(f.workflow.permitsSend(f.owner, session.id)).toBe(false)
      gate.resolve(); await draining
      const result = await pending
      expect(result.status).toBe('failed')
      expect(JSON.stringify(result)).not.toContain('私有清理故障')
      expect(f.workflow.active(session.id)).toBe(false)
      expect(() => f.workflow.execute(f.owner, { sessionId: session.id, text: '不能重开' })).toThrow()
    } finally { gate.resolve(); await pending }
  })
})
