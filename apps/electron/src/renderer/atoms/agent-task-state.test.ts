import { describe, expect, test } from 'bun:test'
import { createStore } from 'jotai/vanilla'
import type { AgentDelegation, AgentTaskEvent, SDKMessage } from '@axon/shared'
import { AgentTaskRendererController, agentTaskStateAtom } from './agent-task-state'

function task(updatedAt: number, status: AgentDelegation['status'] = 'running'): AgentDelegation {
  return {
    id: 'task-1', rootSessionId: 'root-1', parentSessionId: 'root-1', childSessionId: 'child-1',
    parentToolUseId: 'tool-1', title: '检查', objective: '检查项目', subagentType: 'coder',
    runInBackground: true, depth: 1, status, createdAt: 1, updatedAt,
    ...(status === 'running' ? { startedAt: 2 } : {}),
  }
}

function createApi() {
  let listener: ((event: AgentTaskEvent) => void) | undefined
  let resolveList: ((tasks: AgentDelegation[]) => void) | undefined
  const messages: SDKMessage[] = [{
    type: 'assistant', message: { content: [{ type: 'text', text: '子 Agent 结果' }] },
    parent_tool_use_id: null, uuid: 'message-1',
  }]
  return {
    api: {
      list: () => new Promise<AgentDelegation[]>((resolve) => { resolveList = resolve }),
      get: async () => task(5),
      getMessages: async () => messages,
      onEvent: (callback: (event: AgentTaskEvent) => void) => { listener = callback; return () => { listener = undefined } },
    },
    emit: (event: AgentTaskEvent) => listener?.(event),
    resolveList: (tasks: AgentDelegation[]) => resolveList?.(tasks),
  }
}

describe('AgentTaskRendererController', () => {
  test('实时 task 事件不会被较慢的旧快照覆盖', async () => {
    const harness = createApi()
    const store = createStore()
    const controller = new AgentTaskRendererController(harness.api, store)
    controller.start()
    const loading = controller.loadTasks('root-1')
    harness.emit({ type: 'changed', rootSessionId: 'root-1', task: task(8, 'completed') })
    harness.resolveList([task(3, 'running')])
    await loading
    expect(store.get(agentTaskStateAtom).tasksByRootSession['root-1']?.[0]).toMatchObject({
      status: 'completed', updatedAt: 8,
    })
  })

  test('子 Agent 运行事件复用主消息 reducer，完整历史按需加载', async () => {
    const harness = createApi()
    const store = createStore()
    const controller = new AgentTaskRendererController(harness.api, store)
    controller.start()
    harness.emit({
      type: 'agent_event', rootSessionId: 'root-1', taskId: 'task-1', agentId: 'child-1',
      event: { type: 'run_started', sessionId: 'child-1', runStartedAt: 10, source: 'delegation' },
    })
    harness.emit({
      type: 'agent_event', rootSessionId: 'root-1', taskId: 'task-1', agentId: 'child-1',
      event: {
        type: 'stream', sessionId: 'child-1', runStartedAt: 10, source: 'delegation',
        payload: {
          kind: 'sdk_message',
          message: {
            type: 'assistant', message: { content: [{ type: 'text', text: '正在检查' }] },
            parent_tool_use_id: null, uuid: 'live-1',
          },
        },
      },
    })
    expect(store.get(agentTaskStateAtom).runningByTask['task-1']).toBe(true)
    expect(store.get(agentTaskStateAtom).liveMessagesByTask['task-1']?.[0]).toMatchObject({ uuid: 'live-1' })

    await controller.loadMessages('root-1', 'task-1')
    expect(store.get(agentTaskStateAtom).messagesByTask['task-1']?.[0]).toMatchObject({ uuid: 'message-1' })
    expect(store.get(agentTaskStateAtom).messageStatusByTask['task-1']).toBe('ready')
  })
})
