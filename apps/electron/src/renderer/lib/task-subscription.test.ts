import { describe, expect, test } from 'bun:test'
import type { AgentTaskEvent, AgentTaskSubscriptionEvent } from '@axon/shared'
import { observeTasks } from './task-subscription'

function fixture() {
  const gate = Promise.withResolvers<{ subscriptionId: string }>()
  let listener!: (event: AgentTaskSubscriptionEvent) => void
  const order: string[] = [], canceled: string[] = [], seen: AgentTaskEvent[] = []
  const observation = observeTasks({
    subscribe: () => { order.push('subscribe'); return gate.promise },
    unsubscribe: async (id) => { canceled.push(id); return true },
    onEvent: (callback) => { order.push('listen'); listener = callback; return () => { order.push('unlink') } },
  }, (event) => seen.push(event))
  const event: AgentTaskEvent = { type: 'agent_event', rootSessionId: 'root', taskId: 'task', agentId: 'child', event: { type: 'run_started', sessionId: 'child', runStartedAt: 1, source: 'delegation' } }
  return { gate, order, canceled, seen, observation, emit: (id: string, value = event) => listener({ subscriptionId: id, event: value }), event }
}
describe('Task 精确观察生命周期', () => {
  test('先监听再登记，早到事件按响应代次重放，旧代次事件丢弃', async () => {
    const f = fixture()
    f.emit('old'); f.emit('current')
    expect(f.order).toEqual(['listen', 'subscribe']); expect(f.seen).toEqual([])
    f.gate.resolve({ subscriptionId: 'current' }); await f.observation.ready
    f.emit('old'); f.emit('current')
    expect(f.seen).toEqual([f.event, f.event])
    f.observation.dispose(); f.observation.dispose(); f.emit('current')
    expect(f.canceled).toEqual(['current']); expect(f.seen).toHaveLength(2)
  })
  test('卸载后迟到登记只取消原 ID，不作用于下一观察者', async () => {
    const f = fixture(); f.observation.dispose()
    f.gate.resolve({ subscriptionId: 'late' }); await f.observation.ready
    expect(f.canceled).toEqual(['late']); expect(f.order).toEqual(['listen', 'subscribe', 'unlink'])
    expect(f.seen).toEqual([])
  })
  test('响应丢失不重投、不猜 ID，释放事件并向读取者报告失败', async () => {
    const f = fixture(); f.emit('unknown')
    f.gate.reject(new Error('交付未知'))
    await expect(f.observation.ready).rejects.toThrow('交付未知')
    f.emit('unknown'); f.observation.dispose()
    expect(f.order).toEqual(['listen', 'subscribe', 'unlink']); expect(f.canceled).toEqual([]); expect(f.seen).toEqual([])
  })
  test('早到流有界积压，超限明确失败并释放已知代次，不静默跳过 delta', async () => {
    const f = fixture()
    for (let i = 0; i < 129; i++) f.emit('current')
    f.gate.resolve({ subscriptionId: 'current' })
    await expect(f.observation.ready).rejects.toThrow('积压过多')
    expect(f.canceled).toEqual(['current']); expect(f.seen).toEqual([])
    expect(f.order).toEqual(['listen', 'subscribe', 'unlink'])
  })
  test('单个早到大正文同样受预算限制，不仅限制事件数量', async () => {
    const f = fixture()
    f.emit('current', { ...f.event, event: { type: 'stream', sessionId: 'child', runStartedAt: 1, source: 'delegation', payload: { kind: 'sdk_message', message: { type: 'assistant', message: { content: [{ type: 'text', text: 'x'.repeat(600_000) }] } } } } })
    f.gate.resolve({ subscriptionId: 'current' })
    await expect(f.observation.ready).rejects.toThrow('积压过多')
    expect(f.canceled).toEqual(['current']); expect(f.seen).toEqual([])
  })
})
