import { expect, test } from 'bun:test'
import type { AgentAssistantDelta, AgentStreamPayload } from '@axon/shared'
import { AgentInterruptedHistory } from './agent-interrupted-history'

function delta(uuid: string, ...deltas: AgentAssistantDelta[]): AgentStreamPayload {
  return { kind: 'sdk_delta', delta: { uuid, session_id: 'runtime-1', deltas } }
}

test('保留块真实顺序和空白，end 覆盖累积值；半截工具参数不进入中断历史', () => {
  const history = new AgentInterruptedHistory()
  history.observe(delta('draft',
    { type: 'start' }, { type: 'thinking_start', contentIndex: 0 },
    { type: 'thinking_delta', contentIndex: 0, delta: '想' },
    { type: 'thinking_end', contentIndex: 0, content: '思考' },
    { type: 'text_start', contentIndex: 1 }, { type: 'text_delta', contentIndex: 1, delta: '正文' },
    { type: 'text_end', contentIndex: 1, content: ' 正文\n' },
    { type: 'toolcall_start', contentIndex: 2, toolCall: { id: 'half', name: 'Bash' } },
    { type: 'toolcall_delta', contentIndex: 2, delta: '{"command":"rm ', toolCall: { id: 'half', name: 'Bash' } },
    { type: 'thinking_delta', contentIndex: 3, delta: '后续思考' },
  ))
  expect(history.takeInterrupted(() => 'new')).toEqual([{
    kind: 'sdk_message', message: {
      type: 'assistant', uuid: 'draft', session_id: 'runtime-1', parent_tool_use_id: null, isPartial: true,
      message: { stop_reason: 'interrupted', content: [
        { type: 'thinking', thinking: '思考' }, { type: 'text', text: ' 正文\n' },
        { type: 'thinking', thinking: '后续思考' },
      ] },
    },
  }])
  expect(history.takeInterrupted(() => 'new')).toEqual([])
})

test('完整消息覆盖草稿，普通重试和 overflow 撤销的草稿不复活，空工具草稿只清除 UI', () => {
  const history = new AgentInterruptedHistory()
  for (const uuid of ['complete', 'retry', 'overflow']) {
    history.observe(delta(uuid, { type: 'text_delta', contentIndex: 0, delta: '废弃草稿' }))
  }
  history.observe({ kind: 'sdk_message', message: {
    type: 'assistant', uuid: 'complete', parent_tool_use_id: null, message: { content: [{ type: 'text', text: '完整' }] },
  } })
  history.observe({ kind: 'retry_status', status: { phase: 'scheduled', attempt: 1, maxAttempts: 3, delayMs: 1, discardedAssistantUuid: 'retry' } })
  history.observe({ kind: 'discard_assistant', uuid: 'overflow' })
  history.observe(delta('half', { type: 'toolcall_end', contentIndex: 0, toolCall: { id: 'not-submitted', name: 'Bash', arguments: { command: 'pwd' } } }))
  expect(history.takeInterrupted(() => 'new')).toEqual([{ kind: 'discard_assistant', uuid: 'half' }])
})

test('已收到工具结果保持事实；停止后仅一次接纳本轮调用回传，未知/混入文本不放行', () => {
  const history = new AgentInterruptedHistory()
  history.observe({ kind: 'sdk_message', message: {
    type: 'assistant', parent_tool_use_id: null, message: { content: ['done', 'late', 'unknown'].map((id) => ({
      type: 'tool_use', id, name: 'Bash', input: { command: 'pwd' },
    })) },
  } })
  history.observe({ kind: 'sdk_message', message: {
    type: 'user', parent_tool_use_id: null, message: { content: [{ type: 'tool_result', tool_use_id: 'done', content: 'ok' }] },
  } })
  const late: AgentStreamPayload = { kind: 'sdk_message', message: {
    type: 'user', uuid: 'late-result', parent_tool_use_id: null, message: { content: [
      { type: 'text', text: '迟到输入' }, { type: 'tool_result', tool_use_id: 'old-run', content: '旧轮结果' },
      { type: 'tool_result', tool_use_id: 'late', content: '真实结果', is_error: false },
      { type: 'tool_result', tool_use_id: 'late', content: '重复结果' },
    ] },
  } }
  expect(history.acceptStoppedToolResult(late)).toMatchObject({ kind: 'sdk_message', message: {
    message: { content: [{ type: 'tool_result', tool_use_id: 'late', content: '真实结果', is_error: false }] },
  } })
  expect(history.acceptStoppedToolResult(late)).toBeNull()
  expect(history.acceptStoppedToolResult(delta('late-draft', { type: 'text_delta', contentIndex: 0, delta: '不能放行' }))).toBeNull()
  const checkpoint = history.takeInterrupted(() => 'unknown-record')
  expect(checkpoint).toHaveLength(1)
  expect(checkpoint[0]).toMatchObject({ kind: 'sdk_message', message: {
    type: 'user', uuid: 'unknown-record', isSynthetic: true, message: { content: [{
      type: 'tool_result', tool_use_id: 'unknown', is_error: true, execution_status: 'unknown',
      content: expect.stringContaining('副作用未知'),
    }] },
  } })
})
