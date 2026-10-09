import { describe, expect, test } from 'bun:test'
import { createStore } from 'jotai/vanilla'
import type { AgentDelegation, AgentTaskEvent, AgentTaskSubscriptionEvent, SDKMessage } from '@axon/shared'
import { AgentTaskRendererController, agentTaskStateAtom } from './agent-task-state'
import type { AgentTaskRendererApi } from './agent-task-state'

function task(updatedAt: number, status: AgentDelegation['status'] = 'running'): AgentDelegation {
  return {
    id: 'task-1', rootSessionId: 'root-1', parentSessionId: 'root-1', childSessionId: 'child-1',
    parentToolUseId: 'tool-1', title: '检查', objective: '检查项目', subagentType: 'coder',
    runInBackground: true, depth: 1, status, createdAt: 1, updatedAt,
    ...(status === 'running' ? { startedAt: 2 } : {}),
  }
}

function createApi() {
  let listener: ((event: AgentTaskSubscriptionEvent) => void) | undefined
  let resolveList: ((tasks: AgentDelegation[]) => void) | undefined
  const listed = Promise.withResolvers<void>()
  const messages: SDKMessage[] = [{
    type: 'assistant', message: { content: [{ type: 'text', text: '子 Agent 结果' }] },
    parent_tool_use_id: null, uuid: 'message-1',
  }]
  const api: AgentTaskRendererApi = {
      subscribe: async () => ({ subscriptionId: 'current' }),
      unsubscribe: async () => true,
      list: () => new Promise<AgentDelegation[]>((resolve) => { resolveList = resolve; listed.resolve() }),
      get: async () => task(5),
      getMessages: async () => messages,
      onEvent: (callback) => { listener = callback; return () => { listener = undefined } },
  }
  return {
    api,
    emit: (event: AgentTaskEvent, subscriptionId = 'current') => listener?.({ subscriptionId, event }),
    resolveList: async (tasks: AgentDelegation[]) => { await listed.promise; resolveList?.(tasks) },
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
    await harness.resolveList([task(3, 'running')])
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
    await Promise.resolve()
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
    expect(store.get(agentTaskStateAtom).messagesByTask['task-1']?.[0]).toMatchObject({ uuid: 'live-1' })

    await controller.loadMessages('root-1', 'task-1')
    expect(store.get(agentTaskStateAtom).messagesByTask['task-1']?.[0]).toMatchObject({ uuid: 'message-1' })
    expect(store.get(agentTaskStateAtom).messageStatusByTask['task-1']).toBe('ready')
  })

  test('相同 updatedAt 的读取期间事件优先，下一份完整快照可移除旧缓存', async () => {
    const f = createApi(), store = createStore(), controller = new AgentTaskRendererController(f.api, store)
    controller.start()
    const read = controller.loadTasks('root-1')
    f.emit({ type: 'changed', rootSessionId: 'root-1', task: task(8, 'completed') })
    await f.resolveList([task(8, 'running')]); await read
    expect(store.get(agentTaskStateAtom).tasksByRootSession['root-1']?.[0]?.status).toBe('completed')
    f.api.list = async () => []
    await controller.loadTasks('root-1')
    expect(store.get(agentTaskStateAtom).tasksByRootSession['root-1']).toEqual([])
  })

  test('历史以完整快照为基线；新完整消息保留、旧草稿不降级、撤销不复活，后续轮次不清空历史', async () => {
    const f = createApi(), store = createStore(), controller = new AgentTaskRendererController(f.api, store)
    controller.start(); await Promise.resolve()
    f.emit({ type: 'changed', rootSessionId: 'root-1', task: task(8) })
    const run = { sessionId: 'child-1', runId: 'real-run', runStartedAt: 10 }
    const emit = (event: Extract<AgentTaskEvent, { type: 'agent_event' }>['event']): void => f.emit({ type: 'agent_event', rootSessionId: 'root-1', taskId: 'task-1', agentId: 'child-1', run, event })
    emit({ type: 'run_started', sessionId: 'child-1', runStartedAt: 10, source: 'delegation' })
    const gate = Promise.withResolvers<SDKMessage[]>(), entered = Promise.withResolvers<void>()
    f.api.getMessages = () => { entered.resolve(); return gate.promise }
    const read = controller.loadMessages('root-1', 'task-1'); await entered.promise
    emit({ type: 'stream', sessionId: 'child-1', runStartedAt: 10, source: 'delegation', payload: { kind: 'sdk_delta', delta: { uuid: 'same', deltas: [{ type: 'text_delta', contentIndex: 0, delta: '草稿' }] } } })
    const complete: SDKMessage = { type: 'assistant', uuid: 'new', parent_tool_use_id: null, message: { content: [{ type: 'text', text: '新正文' }] } }
    emit({ type: 'stream', sessionId: 'child-1', runStartedAt: 10, source: 'delegation', payload: { kind: 'sdk_message', message: complete } })
    emit({ type: 'stream', sessionId: 'child-1', runStartedAt: 10, source: 'delegation', payload: { kind: 'discard_assistant', uuid: 'removed' } })
    const stored: SDKMessage = { type: 'assistant', uuid: 'same', parent_tool_use_id: null, message: { content: [{ type: 'text', text: '完整正文' }] } }
    gate.resolve([stored, { ...complete, uuid: 'removed' }]); await read
    expect(store.get(agentTaskStateAtom).messagesByTask['task-1']).toEqual([stored, complete])
    f.emit({ type: 'agent_event', rootSessionId: 'root-1', taskId: 'task-1', agentId: 'child-1', run: { ...run, runId: 'next-run', runStartedAt: 20 }, event: { type: 'run_started', sessionId: 'child-1', runStartedAt: 20, source: 'delegation' } })
    emit({ type: 'stream', sessionId: 'child-1', runStartedAt: 10, source: 'delegation', payload: { kind: 'sdk_message', message: { ...complete, uuid: 'late-old' } } })
    expect(store.get(agentTaskStateAtom).messagesByTask['task-1']).toEqual([stored, complete])
  })

  test('重载后首个可信子 stream 可以恢复只读流；错误身份/旧代次/审批不进入消息状态', async () => {
    const f = createApi(), store = createStore(), controller = new AgentTaskRendererController(f.api, store)
    controller.start(); await Promise.resolve()
    const message: SDKMessage = { type: 'result', uuid: 'result', subtype: 'success' }
    const event: AgentTaskEvent = { type: 'agent_event', rootSessionId: 'root-1', taskId: 'task-1', agentId: 'child-1', run: { sessionId: 'child-1', runId: 'actual-run', runStartedAt: 10 }, event: { type: 'stream', sessionId: 'child-1', runStartedAt: 10, source: 'delegation', payload: { kind: 'sdk_message', message } } }
    f.emit(event, 'old'); expect(store.get(agentTaskStateAtom).messagesByTask['task-1']).toBeUndefined()
    f.emit({ ...event, agentId: 'wrong-child' }); expect(store.get(agentTaskStateAtom).messagesByTask['task-1']).toBeUndefined()
    f.emit(event)
    expect(store.get(agentTaskStateAtom).messagesByTask['task-1']).toEqual([message])
    expect(store.get(agentTaskStateAtom).runningByTask['task-1']).toBe(true)
    f.emit({ ...event, event: { type: 'ask_user_resolved', sessionId: 'child-1', runStartedAt: 10, requestId: 'request', reason: 'answered' } })
    expect(store.get(agentTaskStateAtom).messagesByTask['task-1']).toEqual([message])
  })

  test('历史失败保留实时内容且不是完整成功；卸载隔离迟到 list/get/历史', async () => {
    const f = createApi(), store = createStore(), controller = new AgentTaskRendererController(f.api, store)
    const stop = controller.start(); await Promise.resolve()
    const message: SDKMessage = { type: 'result', uuid: 'live', subtype: 'success' }
    f.emit({ type: 'agent_event', rootSessionId: 'root-1', taskId: 'task-1', agentId: 'child-1', run: { sessionId: 'child-1', runId: 'actual-run', runStartedAt: 10 }, event: { type: 'stream', sessionId: 'child-1', runStartedAt: 10, source: 'delegation', payload: { kind: 'sdk_message', message } } })
    f.api.getMessages = async () => { throw new Error('sk-private') }
    await controller.loadMessages('root-1', 'task-1')
    expect(store.get(agentTaskStateAtom).messageStatusByTask['task-1']).toBe('error')
    expect(store.get(agentTaskStateAtom).messagesByTask['task-1']).toEqual([message])
    expect(store.get(agentTaskStateAtom).lastError?.message).not.toContain('sk-private')
    const list = controller.loadTasks('root-1'), gate = Promise.withResolvers<AgentDelegation | null>(), entered = Promise.withResolvers<void>()
    f.api.get = () => { entered.resolve(); return gate.promise }
    const get = controller.loadTask('root-1', 'task-1')
    await entered.promise
    stop(); gate.resolve(task(100)); await f.resolveList([task(100)])
    await list; expect(await get).toBeNull()
    expect(store.get(agentTaskStateAtom).tasksByRootSession['root-1']).toBeUndefined()
  })
})
