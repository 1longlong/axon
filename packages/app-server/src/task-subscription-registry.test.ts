import { describe, expect, test } from 'bun:test'
import type { AgentTaskEvent, AgentTaskSubscriptionEvent } from '@axon/shared'
import { TaskSubscriptionRegistry } from './task-subscription-registry'

const event: AgentTaskEvent = { type: 'agent_event', rootSessionId: 'root', taskId: 'task', agentId: 'child', event: { type: 'run_started', sessionId: 'child', runStartedAt: 1, source: 'delegation' } }
describe('Task 共用订阅代次', () => {
  test('替换、旧取消与跨入口取消不影响新订阅，迟到旧回调不能投递', () => {
    const registry = new TaskSubscriptionRegistry(), callbacks: Array<(event: AgentTaskEvent) => void> = [], seen: AgentTaskSubscriptionEvent[] = []
    let released = 0
    const connect = (callback: (event: AgentTaskEvent) => void) => { callbacks.push(callback); return () => { released++ } }
    const a = registry.subscribe('a', connect, () => true, (packet) => seen.push(packet))
    const b = registry.subscribe('b', connect, () => true, (packet) => seen.push(packet))
    const next = registry.subscribe('a', connect, () => true, (packet) => seen.push(packet))
    expect(released).toBe(1); expect(registry.unsubscribe('a', a.subscriptionId)).toBe(false)
    expect(registry.unsubscribe('b', next.subscriptionId)).toBe(false)
    callbacks[0]!(event); callbacks[1]!(event); callbacks[2]!(event)
    expect(seen.map((packet) => packet.subscriptionId)).toEqual([b.subscriptionId, next.subscriptionId])
    registry.close(); registry.close(); expect(released).toBe(3)
  })
  test('装配时入口失效且未显式 detach 时也只释放一次；失败不遗留路由', () => {
    const registry = new TaskSubscriptionRegistry()
    let active = true, released = 0
    expect(() => registry.subscribe('a', () => { active = false; return () => { released++ } }, () => active, () => {})).toThrow('已断开')
    expect(released).toBe(1)
    expect(() => registry.subscribe('a', () => { throw new Error('装配失败') }, () => true, () => {})).toThrow('装配失败')
    expect(registry.unsubscribe('a', 'unknown')).toBe(false)
    registry.close(); expect(released).toBe(1)
    expect(() => registry.subscribe('a', () => () => {}, () => true, () => {})).toThrow('已断开')
  })
})
