import { describe, expect, test } from 'bun:test'
import type { AgentGenerationEvent } from '@axon/shared'
import { DockAgentFeedbackController } from './dock-agent-feedback'

function runStarted(sessionId: string, runStartedAt: number): AgentGenerationEvent {
  return { type: 'run_started', sessionId, runStartedAt, source: 'renderer' }
}

function runFinished(
  sessionId: string,
  runStartedAt: number,
  stoppedByUser = false,
): AgentGenerationEvent {
  return {
    type: 'run_finished',
    sessionId,
    runStartedAt,
    source: 'renderer',
    completion: {
      terminalReason: stoppedByUser ? 'stopped' : 'completed',
      resultSubtype: 'success',
      stoppedByUser,
      usage: { input_tokens: 1, output_tokens: 1 },
      completedAt: runStartedAt + 1,
      durationMs: 1,
      persisted: true,
    },
  }
}

function permissionRequest(requestId: string): AgentGenerationEvent {
  return {
    type: 'permission_request',
    sessionId: 'session-1',
    runStartedAt: 1,
    request: {
      requestId,
      sessionId: 'session-1',
      runStartedAt: 1,
      toolUseId: 'tool-1',
      toolName: 'Write',
      toolInput: {},
      description: '写入文件',
      dangerLevel: 'normal',
      allowAlways: true,
      createdAt: 1,
      expiresAt: 2,
    },
  }
}

describe('DockAgentFeedbackController', () => {
  test('运行数量显示数字，待交互优先显示感叹号', () => {
    const badges: string[] = []
    const controller = new DockAgentFeedbackController({
      dock: { setBadge: (value) => badges.push(value), requestAttention: () => 1, cancelAttention: () => {} },
      isForeground: () => true,
    })

    controller.initialize([{ sessionId: 'existing', runStartedAt: 1, source: 'external' }])
    controller.handleEvent(runStarted('session-2', 2))
    controller.handleEvent(permissionRequest('request-1'))
    controller.handleEvent({
      type: 'permission_resolved', sessionId: 'session-1', runStartedAt: 1,
      requestId: 'request-1', behavior: 'allow', reason: 'response',
    })
    controller.handleEvent(runFinished('session-2', 2))

    expect(badges).toEqual(['1', '2', '!', '2', '1'])
  })

  test('后台交互和完成只维持一个注意力请求，聚焦后可再次请求', () => {
    const requested: number[] = []
    const canceled: number[] = []
    let nextId = 10
    const controller = new DockAgentFeedbackController({
      dock: {
        setBadge: () => {},
        requestAttention: () => { requested.push(nextId); return nextId++ },
        cancelAttention: (id) => canceled.push(id),
      },
      isForeground: () => false,
    })

    controller.handleEvent(permissionRequest('request-1'))
    controller.handleEvent(runFinished('session-1', 1))
    expect(requested).toEqual([10])

    controller.acknowledgeAttention()
    controller.handleEvent(runFinished('session-2', 2))
    expect(canceled).toEqual([10])
    expect(requested).toEqual([10, 11])
  })

  test('前台完成和用户停止不请求注意力，无 Dock 时安全降级', () => {
    let requests = 0
    const foreground = new DockAgentFeedbackController({
      dock: { setBadge: () => {}, requestAttention: () => ++requests, cancelAttention: () => {} },
      isForeground: () => true,
    })
    foreground.handleEvent(runFinished('session-1', 1))

    const background = new DockAgentFeedbackController({
      dock: { setBadge: () => {}, requestAttention: () => ++requests, cancelAttention: () => {} },
      isForeground: () => false,
    })
    background.handleEvent(runFinished('session-2', 2, true))
    const unavailable = new DockAgentFeedbackController({ dock: null, isForeground: () => false })
    unavailable.initialize([])
    unavailable.handleEvent(permissionRequest('request-2'))
    unavailable.dispose()

    expect(requests).toBe(0)
  })
})
