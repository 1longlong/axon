import { describe, expect, test } from 'bun:test'
import { AgentEventBus } from './agent-event-bus'

describe('AgentEventBus', () => {
  test('监听器异常不会阻断其他消费者，取消订阅后不再接收', () => {
    const bus = new AgentEventBus()
    const received: string[] = []
    bus.subscribe(() => { throw new Error('renderer gone') })
    const unsubscribe = bus.subscribe((event) => received.push(event.type))

    bus.emit({ type: 'run_started', sessionId: 'session-1', runStartedAt: 1, source: 'renderer' })
    unsubscribe()
    bus.emit({
      type: 'run_finished', sessionId: 'session-1', runStartedAt: 1, source: 'renderer',
      completion: {
        terminalReason: 'completed', resultSubtype: 'success', stoppedByUser: false,
        usage: { input_tokens: 0, output_tokens: 0 }, completedAt: 2, durationMs: 1, persisted: true,
      },
    })

    expect(received).toEqual(['run_started'])
  })
})
