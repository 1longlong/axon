import { describe, expect, test } from 'bun:test'
import { APP_SERVER_CLIENT_METHODS, APP_SERVER_NOTIFICATIONS } from '@axon/shared'
import type { BackendAgentRunEvent, ExecEvent, RpcJsonObject } from '@axon/shared'
import { JsonRpcPeer, toWireValue } from '@axon/app-server'
import { PassThrough } from 'node:stream'
import { ExecRunStream, ExecStreamError } from './run-stream'

const start = (runId = 'root-1', sessionId = 'root', source: 'external' | 'delegation' | 'background_notification' = 'external'): BackendAgentRunEvent => ({
  run: { runId, sessionId, runStartedAt: 1 }, visibleSessionId: 'root',
  event: { type: 'run_started', sessionId, runStartedAt: 1, source },
})
function stream(base: BackendAgentRunEvent, payload: RpcJsonObject): RpcJsonObject {
  return toWireValue({ ...base, event: { type: 'stream', sessionId: base.run.sessionId, runStartedAt: 1,
    source: base.event.type === 'run_started' ? base.event.source : 'external', payload } }) as RpcJsonObject
}
function end(base: BackendAgentRunEvent, patch: RpcJsonObject = {}): RpcJsonObject {
  return toWireValue({ ...base, event: { type: 'run_finished', sessionId: base.run.sessionId, runStartedAt: 1,
    source: base.event.type === 'run_started' ? base.event.source : 'external',
    completion: { terminalReason: 'completed', resultSubtype: 'success', persisted: true, stoppedByUser: false,
      usage: { input_tokens: 5 }, completedAt: 2, durationMs: 1, ...patch } } }) as RpcJsonObject
}
function assistant(uuid: string, text: string, extras: RpcJsonObject[] = []): RpcJsonObject {
  return { kind: 'sdk_message', message: { type: 'assistant', uuid, parent_tool_use_id: null,
    message: { content: [{ type: 'thinking', thinking: '隐藏思考' }, ...extras, { type: 'text', text }] } } }
}
const result = (subtype = 'success', patch: RpcJsonObject = {}): RpcJsonObject => ({ kind: 'sdk_message',
  message: { type: 'result', subtype, usage: { input_tokens: 5 }, ...patch } })
const workflow = { workflowId: 'workflow', sessionId: 'root', startedAt: 0 }
function workflowResult(base = start(), patch: RpcJsonObject = {}): RpcJsonObject {
  const packet = end(base)
  return { workflow, status: 'completed', lastRun: toWireValue(base.run), completion: (packet.event as RpcJsonObject).completion!, ...patch }
}
function fixture(ready = true) {
  const events: ExecEvent[] = [], collector = new ExecRunStream({ executionId: 'execution', now: () => 7, emit: (event) => { events.push(event) } })
  collector.bind('external', 'root')
  const receive = (value: BackendAgentRunEvent | RpcJsonObject, clientId = 'external') => collector.receive({ clientId, event: toWireValue(value) })
  const receiveWorkflow = (event: RpcJsonObject, clientId = 'external') => collector.receiveWorkflow({ clientId, event })
  if (ready) receiveWorkflow({ type: 'workflow_started', workflow })
  return { collector, events, receive, receiveWorkflow }
}

describe('exec 中立事件与本轮完成快照', () => {
  test('CLI 执行终态必须晚于确认/清理且唯一；不能用后端成功掩盖输出或清理失败', () => {
    const events: ExecEvent[] = [], collector = new ExecRunStream({ executionId: 'cli', emit: (event) => events.push(event) })
    expect(() => collector.finishExecution({ exitCode: 1, cleanup: 'not_started' })).toThrow(ExecStreamError)
    collector.beginExecution()
    expect(() => collector.beginExecution()).toThrow(ExecStreamError)
    expect(() => collector.finishExecution({ exitCode: 0, cleanup: 'completed' })).toThrow(ExecStreamError)
    collector.finishExecution({ exitCode: 2, cleanup: 'not_started' })
    expect(() => collector.finishExecution({ exitCode: 2, cleanup: 'not_started' })).toThrow(ExecStreamError)
    expect(events.map((event) => event.type)).toEqual(['exec_started', 'exec_finished'])
    expect(events.map((event) => event.sequence)).toEqual([1, 2])

    const f = fixture(false), base = start()
    f.collector.beginExecution(); f.receiveWorkflow({ type: 'workflow_started', workflow })
    f.receive(base); f.receive(stream(base, result())); f.receive(end(base))
    const done = workflowResult(base)
    f.receiveWorkflow({ type: 'workflow_finished', result: done })
    f.collector.confirm(done)
    expect(() => f.collector.finishExecution({ exitCode: 0, cleanup: 'failed' })).toThrow(ExecStreamError)
    f.collector.finishExecution({ exitCode: 0, cleanup: 'completed' })
    expect(f.events.at(-1)?.type).toBe('exec_finished')
    expect(f.events.map((event) => event.sequence)).toEqual(f.events.map((_, index) => index + 1))

    const broken = fixture(false)
    broken.collector.beginExecution(); broken.receive(start())
    expect(broken.collector.signal.aborted).toBe(true)
    broken.collector.finishExecution({ exitCode: 1, cleanup: 'completed', error: {
      code: 'exec_protocol_error', category: 'protocol', message: '协议故障', retryable: false,
    } })
    expect(broken.events.at(-1)).toMatchObject({ type: 'exec_finished', completion: { exitCode: 1 } })
  })

  test('result 不代表收尾完成；只取主轮完整正文，思考/工具/子轮/流式草稿不混入', () => {
    const f = fixture(), root = start(), child = start('child-1', 'child', 'delegation')
    f.receive(root); f.receive(child)
    f.receive(stream(root, { kind: 'sdk_delta', delta: { uuid: 'draft', deltas: [{ type: 'text_delta', contentIndex: 0, delta: '未完成草稿' }] } }))
    f.receive(stream(root, assistant('before', '正在分析')))
    f.receive(stream(child, assistant('child-answer', '子代理正文')))
    f.receive(stream(child, result())); f.receive(end(child))
    f.receive(stream(root, assistant('final', '  最终回答\n\n', [{ type: 'tool_use', id: 'tool', name: 'Read', input: {} }])))
    f.receive(stream(root, result()))
    expect(f.collector.latest()).toBeUndefined()
    f.receive(end(root))
    expect(f.collector.latest()).toMatchObject({ runId: 'root-1', sessionId: 'root', success: true, finalText: '  最终回答\n\n' })
    expect(f.events.map((event) => event.sequence)).toEqual(f.events.map((_, index) => index + 1))
    expect(f.events.every((event) => event.version === 1 && event.timestamp === 7 && event.executionId === 'execution')).toBe(true)
    expect(f.events.some((event) => event.type === 'agent_event' && event.run.sessionId === 'child')).toBe(true)
    expect(JSON.stringify(f.events)).not.toContain('clientId')
  })
  test('重试/压缩丢弃候选、相同 uuid 更新，不重复正文；新主轮未结束时不返回旧回复', () => {
    const f = fixture(), first = start()
    f.receive(first)
    f.receive(stream(first, assistant('kept', '保留正文')))
    f.receive(stream(first, assistant('draft', '失败草稿')))
    f.receive(stream(first, { kind: 'retry_status', status: { phase: 'scheduled', attempt: 1, maxAttempts: 3, delayMs: 1, discardedAssistantUuid: 'draft' } }))
    f.receive(stream(first, assistant('retry', '重试正文')))
    f.receive(stream(first, { kind: 'discard_assistant', uuid: 'retry' }))
    f.receive(stream(first, assistant('kept', '更新后的正文')))
    f.receive(stream(first, result())); f.receive(end(first))
    expect(f.collector.latest()?.finalText).toBe('更新后的正文')
    const second = start('root-2', 'root', 'background_notification')
    f.receive(second)
    expect(f.collector.latest()).toBeUndefined()
    f.receive(stream(second, assistant('second', '子任务交付后最终回复')))
    f.receive(stream(second, result())); f.receive(end(second))
    expect(f.collector.latest()?.finalText).toBe('子任务交付后最终回复')
  })
  test('失败/停止/终态未落盘不能变成功；无文本成功也不编造模型回复', () => {
    for (const mode of ['failure', 'stopped', 'unpersisted', 'empty']) {
      const f = fixture(), base = start(); f.receive(base)
      if (mode !== 'unpersisted') f.receive(stream(base, result(mode === 'failure' ? 'error' : 'success', mode === 'stopped' ? { stopped_by_user: true } : {})))
      f.receive(end(base, mode === 'failure' ? { resultSubtype: 'error' } : mode === 'stopped' ? { stoppedByUser: true } : mode === 'unpersisted' ? { persisted: false } : {}))
      expect(f.collector.latest()?.success).toBe(mode === 'empty')
      expect(f.collector.latest()?.finalText).toBe('')
    }
  })
  test('忽略其他入口/可见根，匹配入口的无效身份或乱序封口，不泄漏底层异常', () => {
    const foreign = fixture()
    foreign.receive(start(), 'other'); foreign.receive({ ...toWireValue(start()) as RpcJsonObject, visibleSessionId: 'other' })
    expect(foreign.events.map((event) => event.type)).toEqual(['workflow_started']); expect(foreign.collector.signal.aborted).toBe(false)
    const cases: Array<(f: ReturnType<typeof fixture>, base: BackendAgentRunEvent) => void> = [
      (f, base) => f.receive(base),
      (f, base) => f.receive({ ...toWireValue(base) as RpcJsonObject, event: { type: 'stream', sessionId: 'wrong', runStartedAt: 1 } }),
      (f, base) => f.receive(stream(base, { kind: 'sdk_message', message: { type: 'assistant', uuid: 'bad', message: { content: [{ type: 'text', text: 1 }] } } })),
      (f, base) => f.receive(end(base)),
      (f, base) => { f.receive(stream(base, result())); f.receive(end(base, { resultSubtype: 'error' })) },
      (f, base) => { f.receive(stream(base, result())); f.receive(stream(base, assistant('late', '迟到正文'))) },
      (f, base) => f.receive({ ...stream(base, assistant('wrong-source', '错误')), event: { type: 'stream', sessionId: 'root', runStartedAt: 1, source: 'delegation', payload: result() } }),
      (f) => f.receive(start('overlap')),
    ]
    for (const action of cases) {
      const f = fixture(), base = start(); f.receive(base); action(f, base)
      expect(f.collector.signal.aborted).toBe(true)
      const length = f.events.length; f.receive(stream(base, result())); expect(f.events).toHaveLength(length)
      expect(() => f.collector.latest()).toThrow(ExecStreamError)
    }
    const missing = fixture(); missing.receive(stream(start(), result()))
    expect(missing.collector.signal.aborted).toBe(true)
  })
  test('真实 peer 安装先于发送，意外反向审批拒绝/追问取消，不自动授权', async () => {
    for (const [method, behavior] of [[APP_SERVER_CLIENT_METHODS.AGENT_PERMISSION, 'deny'], [APP_SERVER_CLIENT_METHODS.AGENT_ASK_USER, 'cancel']] as const) {
      const up = new PassThrough(), down = new PassThrough(), parent = new JsonRpcPeer(down, up), child = new JsonRpcPeer(up, down)
      const f = fixture(); f.collector.attach(parent)
      child.notify(APP_SERVER_NOTIFICATIONS.AGENT_RUN, { clientId: 'external', event: toWireValue(start()) })
      const reply = await child.request(method, { clientId: 'external', event: { event: { request: { requestId: 'request' } } } })
      expect(reply).toEqual({ requestId: 'request', behavior })
      expect(f.events.map((event) => event.type)).toEqual(['workflow_started', 'agent_event'])
      expect(f.collector.signal.aborted).toBe(true)
      f.collector.dispose(); parent.close(); child.close(); up.destroy(); down.destroy()
    }
  })
  test('有界文本保留/输出回调故障封口；dispose 后迟到通知不再输出', () => {
    const f = fixture(), base = start(); f.receive(base)
    f.receive(stream(base, assistant('huge', 'x'.repeat(16 * 1024 * 1024 + 1))))
    expect(f.collector.signal.aborted).toBe(true)
    const failed = new ExecRunStream({ executionId: 'execution', emit() { throw new Error('fixture-secret') } })
    failed.bind('external', 'root'); failed.receiveWorkflow({ clientId: 'external', event: { type: 'workflow_started', workflow } })
    expect(failed.signal.reason).toBeInstanceOf(ExecStreamError)
    expect((failed.signal.reason as Error).message).not.toContain('fixture-secret')
    const disposed = fixture(false); disposed.collector.dispose(); disposed.receive(base)
    expect(disposed.events).toEqual([])
    expect(() => disposed.collector.bind('external', 'root')).toThrow(ExecStreamError)
  })

  test('首次主轮完成不提供工作流最终结果，通知和 RPC 都核对最后后台续跑', () => {
    const f = fixture(), first = start(), child = start('child-1', 'child', 'delegation')
    f.receive(first); f.receive(child)
    f.receive(stream(first, assistant('first', '初步回复'))); f.receive(stream(first, result())); f.receive(end(first))
    expect(f.collector.activeWorkflow()).toEqual(workflow)
    f.receive(stream(child, assistant('child', '子结果'))); f.receive(stream(child, result())); f.receive(end(child))
    const last = start('root-2', 'root', 'background_notification')
    f.receive(last); f.receive(stream(last, assistant('last', '  最后回复\n'))); f.receive(stream(last, result())); f.receive(end(last))
    const finished = workflowResult(last)
    f.receiveWorkflow({ type: 'workflow_finished', result: finished })
    expect(f.collector.signal.aborted).toBe(false)
    expect(f.collector.activeWorkflow()).toBeUndefined()
    expect(f.collector.confirm(finished)).toMatchObject({ success: true, finalText: '  最后回复\n', result: { status: 'completed', lastRun: { runId: 'root-2' } } })
    expect(f.events[0]?.type).toBe('workflow_started'); expect(f.events.at(-1)?.type).toBe('workflow_finished')
    expect(f.events.map((event) => event.sequence)).toEqual(f.events.map((_, index) => index + 1))
    expect(() => f.collector.confirm(finished)).toThrow(ExecStreamError)
  })

  test('失败/取消可以结束但不输出局部正文；发送前失败及首次落盘失败也有明确终态', () => {
    for (const status of ['failed', 'canceled']) {
      const f = fixture(), base = start()
      f.receive(base); f.receive(stream(base, assistant('partial', '局部回复'))); f.receive(stream(base, result())); f.receive(end(base))
      const finished = workflowResult(base, { status, ...(status === 'failed' ? { error: { code: 'runtime_error', category: 'runtime', message: '交付失败', retryable: false } } : {}) })
      f.receiveWorkflow({ type: 'workflow_finished', result: finished })
      expect(f.collector.confirm(finished)).toMatchObject({ success: false, finalText: '', result: { status } })
    }
    const before = fixture(), preflight = { workflow, status: 'failed', error: { code: 'runtime_error', category: 'runtime', message: '未发送', retryable: false } }
    before.receiveWorkflow({ type: 'workflow_finished', result: preflight })
    expect(before.collector.confirm(preflight).success).toBe(false)
    const lost = fixture(), base = start(), finish = end(base, { persisted: false, resultSubtype: 'error' })
    lost.receive(finish)
    const failed = workflowResult(base, { status: 'failed', completion: (finish.event as RpcJsonObject).completion!,
      error: { code: 'persistence_error', category: 'persistence', message: '不能保存', retryable: false } })
    lost.receiveWorkflow({ type: 'workflow_finished', result: failed })
    expect(lost.collector.confirm(failed)).toMatchObject({ success: false, result: { completion: { persisted: false } } })
  })

  test('提前/重复/错身份完成、遗失通知、RPC 不一致和完成后的迟到事件均封口', () => {
    const actions: Array<(f: ReturnType<typeof fixture>, finished: RpcJsonObject) => void> = [
      (f) => f.receiveWorkflow({ type: 'workflow_started', workflow }),
      (f, done) => f.receiveWorkflow({ type: 'workflow_finished', result: { ...done, workflow: { ...workflow, workflowId: 'old' } } }),
      (f, done) => f.receiveWorkflow({ type: 'workflow_finished', result: { ...done, lastRun: { runId: 'old', sessionId: 'root', runStartedAt: 1 } } }),
      (f, done) => f.receiveWorkflow({ type: 'workflow_finished', result: { ...done, completion: { ...(done.completion as RpcJsonObject), persisted: false } } }),
      (f, done) => { f.receiveWorkflow({ type: 'workflow_finished', result: done }); f.receiveWorkflow({ type: 'workflow_finished', result: done }) },
      (f, done) => { f.receiveWorkflow({ type: 'workflow_finished', result: done }); f.receive(start('late', 'root', 'background_notification')) },
      (f, done) => { expect(() => f.collector.confirm(done)).toThrow(ExecStreamError) },
      (f, done) => { f.receiveWorkflow({ type: 'workflow_finished', result: done }); expect(() => f.collector.confirm({ ...done, status: 'canceled' })).toThrow(ExecStreamError) },
    ]
    for (const action of actions) {
      const f = fixture(), base = start(); f.receive(base); f.receive(stream(base, result())); f.receive(end(base))
      action(f, workflowResult(base)); expect(f.collector.signal.aborted).toBe(true)
    }
    const child = fixture(), base = start()
    child.receive(base); child.receive(start('child', 'child', 'delegation')); child.receive(stream(base, result())); child.receive(end(base))
    child.receiveWorkflow({ type: 'workflow_finished', result: workflowResult(base) })
    expect(child.collector.signal.aborted).toBe(true)
    const missingStart = fixture(false); missingStart.receive(start()); expect(missingStart.collector.signal.aborted).toBe(true)
    const unfinished = fixture(); unfinished.receive(start()); unfinished.receiveWorkflow({ type: 'workflow_finished', result: workflowResult() })
    expect(unfinished.collector.signal.aborted).toBe(true)
  })

  test('忽略其他工作流范围，公开终态剔除额外字段；没有开始通知不能确认成功', () => {
    const f = fixture(), base = start()
    f.receiveWorkflow({ type: 'workflow_started', workflow: { ...workflow, sessionId: 'other' } })
    f.receiveWorkflow({ type: 'workflow_finished', result: { ...workflowResult(), workflow: { ...workflow, sessionId: 'other' }, lastRun: { ...base.run, sessionId: 'other' } } }, 'foreign')
    expect(f.events).toHaveLength(1)
    f.receive(base); f.receive(stream(base, result())); f.receive(end(base))
    const done = workflowResult()
    f.receiveWorkflow({ type: 'workflow_finished', result: { ...done, secret: 'private-wrapper', workflow: { ...workflow, privateToken: 'private-token' } } })
    expect(f.collector.confirm(done).success).toBe(true)
    expect(JSON.stringify(f.events)).not.toContain('private-')
    const missing = fixture(false)
    expect(() => missing.collector.confirm(done)).toThrow(ExecStreamError)
  })
})
