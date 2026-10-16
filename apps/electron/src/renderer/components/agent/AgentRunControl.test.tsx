import { expect, test } from 'bun:test'
import * as React from 'react'
import { Provider } from 'jotai'
import { createStore } from 'jotai/vanilla'
import { renderToStaticMarkup } from 'react-dom/server'
import { agentStateAtom, createInitialAgentRendererState } from '@/atoms/agent-state'
import type { AgentRendererState } from '@/atoms/agent-state-model'
import { AgentStateProvider } from './AgentStateProvider'
import { AgentRunControl } from './AgentRunControl'
import { AgentInput } from './AgentInput'

/** 静态渲染只验证现有组件投影，不运行 provider effect 或伪称真实 IPC/GUI。 */
function render(patch: Partial<AgentRendererState>, compact = false,
  content: React.ReactElement = <AgentRunControl sessionId="session" compact={compact} />): string {
  const descriptor = Object.getOwnPropertyDescriptor(globalThis, 'window')
  Object.defineProperty(globalThis, 'window', { configurable: true, value: {
    axon: { agent: {}, agentProjects: {}, agentMemory: {}, agentTasks: {} },
  } })
  try {
    const store = createStore()
    store.set(agentStateAtom, { ...createInitialAgentRendererState(), ...patch })
    return renderToStaticMarkup(<Provider store={store}><AgentStateProvider>{content}</AgentStateProvider></Provider>)
  } finally {
    if (descriptor) Object.defineProperty(globalThis, 'window', descriptor)
    else Reflect.deleteProperty(globalThis, 'window')
  }
}

test('两个输入入口共用暂停按钮；只有观察状态时不提供控制按钮', () => {
  const state = { activeRunsBySession: { session: 10 }, ownedRunsBySession: { session: { sessionId: 'session', runId: 'run', runStartedAt: 10 } } }
  for (const compact of [false, true]) expect(render(state, compact)).toContain('aria-label="暂停 Agent"')
  const observer = render({ activeRunsBySession: { session: 10 } })
  expect(observer).toContain('其他入口运行中')
  expect(observer).not.toContain('暂停 Agent')
})

test('正在收束保持禁用；只有 ready 的 paused 凭据才开放继续', () => {
  const pause = { sessionId: 'session', turnId: 'turn', runId: 'run', runStartedAt: 10, pauseId: 'pause', state: 'paused' as const }
  const closing = render({ pauseOperationsBySession: { session: 'pausing' } })
  expect(closing).toContain('正在暂停')
  expect(closing).toContain('disabled=""')
  expect(closing).not.toContain('继续 Agent')
  const stale = render({ pausesBySession: { session: pause }, pauseStatusBySession: { session: 'loading' } })
  expect(stale).toContain('继续 Agent'); expect(stale).toContain('disabled=""')
  const ready = render({ pausesBySession: { session: pause }, pauseStatusBySession: { session: 'ready' } })
  expect(ready).toContain('继续 Agent'); expect(ready).not.toContain('disabled=""')
  const failed = render({ pausesBySession: { session: { ...pause, state: 'pausing' } }, pauseStatusBySession: { session: 'error' } })
  expect(failed).toContain('重读 Agent 暂停状态')
  expect(failed).not.toContain('继续 Agent')
  expect(failed).not.toContain('正在暂停')
})

test('发送/暂停/继续只切换同一圆形图标；暂停后的新草稿仍能发送新任务', () => {
  const control = (hasDraft = false, sendDisabled = false): React.ReactElement =>
    <AgentRunControl sessionId="session" onSend={() => {}} hasDraft={hasDraft} sendDisabled={sendDisabled} />
  const pause = { sessionId: 'session', turnId: 'turn', runId: 'run', runStartedAt: 10, pauseId: 'pause', state: 'paused' as const }
  const idle = render({}, false, control(false, true))
  expect(idle).toContain('aria-label="发送消息"')
  expect(idle).toContain('lucide-arrow-up')
  expect(idle).toContain('disabled=""')
  const paused = { pausesBySession: { session: pause }, pauseStatusBySession: { session: 'ready' as const } }
  const continuing = render(paused, false, control())
  expect(continuing).toContain('lucide-play')
  expect(continuing).not.toContain('发送消息')
  const newTask = render(paused, false, control(true))
  expect(newTask).toContain('发送消息')
  expect(newTask).not.toContain('继续 Agent')
  const running = render({ activeRunsBySession: { session: 10 },
    ownedRunsBySession: { session: { sessionId: 'session', runId: 'run', runStartedAt: 10 } } }, false, control(true))
  expect(running).toContain('lucide-pause')
  expect(running).not.toContain('发送消息')
  for (const html of [idle, continuing, newTask, running]) {
    expect(html.match(/<button\b/g)).toHaveLength(1)
    expect(html).toContain('size-8')
    expect(html).toContain('rounded-full')
    expect(html).toContain('</svg></button>')
  }
})

test('主输入区只渲染一个发送/运行控制位置，不并排添加发送或排队按钮', () => {
  const pause = { sessionId: 'session', turnId: 'turn', runId: 'run', runStartedAt: 10, pauseId: 'pause', state: 'paused' as const }
  const cases: Array<Partial<AgentRendererState>> = [
    {},
    { activeRunsBySession: { session: 10 }, ownedRunsBySession: { session: { sessionId: 'session', runId: 'run', runStartedAt: 10 } } },
    { pausesBySession: { session: pause }, pauseStatusBySession: { session: 'ready' } },
    { pauseOperationsBySession: { session: 'pausing' } },
  ]
  for (const state of cases) {
    const html = render(state, false, <AgentInput sessionId="session" />)
    expect(html.match(/aria-label="(?:发送消息|暂停 Agent|继续 Agent|正在暂停…)"/g)).toHaveLength(1)
    expect(html).not.toContain('>排队</button>')
  }
})
