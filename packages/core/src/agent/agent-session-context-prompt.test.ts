import { expect, test } from 'bun:test'
import type { SDKMessage } from '@axon/shared'
import { buildAgentContinuationPrompt, buildAgentInterruptionPrompt, buildRecoveryPrompt } from './agent-session-context-prompt'

const stopped: SDKMessage = {
  type: 'result', subtype: 'error', terminal_reason: 'stopped', stopped_by_user: true,
  usage: { input_tokens: 0 },
}

test('同轮继续的宿主背景明确授权续做、核实副作用和重新申请权限，不要求新的用户消息', () => {
  const prompt = buildAgentContinuationPrompt()
  expect(prompt).toStartWith('<system-reminder>')
  expect(prompt).toEndWith('</system-reminder>')
  expect(prompt).toContain('明确允许继续原任务')
  expect(prompt).toContain('不是新的用户发言')
  expect(prompt).toContain('先核实')
  expect(prompt).toContain('旧审批和追问已撤销')
  const recovery = buildRecoveryPrompt([{ type: 'user', message: { content: [{ type: 'text', text: '原任务' }] } }, stopped])
  expect(recovery).toContain('宿主明确授权的续做')
  expect(recovery).not.toContain('下一条用户消息')
})

test('内部继续输入的语义恢复不冒充用户发言，停止背景仍可识别', () => {
  const internal: SDKMessage = { type: 'user', isSynthetic: true, message: { content: [{ type: 'text', text: '内部续做' }] } }
  const prompt = buildRecoveryPrompt([stopped, internal])
  expect(prompt).toContain('宿主内部输入：内部续做')
  expect(prompt).not.toContain('用户：内部续做')
  expect(buildAgentInterruptionPrompt([stopped, internal])).toContain('上一轮执行被用户停止')
})

test('最近真实停止轮生成固定中断提醒，不重放历史正文、工具参数和思考', () => {
  const prompt = buildAgentInterruptionPrompt([
    { type: 'user', message: { content: [{ type: 'text', text: '不可重新投递的原任务' }] } },
    { type: 'assistant', message: { content: [{ type: 'thinking', thinking: '私有思考' },
      { type: 'tool_use', id: 'write-1', name: 'Write', input: { content: '私有工具参数' } }] } },
    stopped,
    { type: 'system', subtype: 'compact_boundary', compact_result: 'success', summary: '摘要' },
    { type: 'result', subtype: 'success', isSyntheticCompactionResult: true },
  ])
  expect(prompt).toStartWith('<system-reminder>')
  expect(prompt).toContain('部分副作用')
  expect(prompt).toContain('以当前用户消息为准')
  expect(prompt).toContain('当前轮的权限流程')
  expect(prompt).not.toContain('不可重新投递')
  expect(prompt).not.toContain('私有')
})

test('仅最近真实轮的明确用户停止产生提醒；成功、失败和未收束新输入不沿用旧停止', () => {
  const histories: SDKMessage[][] = [
    [],
    [stopped, { type: 'result', subtype: 'success' }],
    [stopped, { type: 'result', subtype: 'error', terminal_reason: 'failed' }],
    [{ type: 'result', subtype: 'error', terminal_reason: 'stopped' }],
    [{ type: 'result', subtype: 'error', stopped_by_user: true, terminal_reason: 'failed' }],
    [stopped, { type: 'user', message: { content: [{ type: 'text', text: '新输入尚未收束' }] } }],
  ]
  for (const history of histories) expect(buildAgentInterruptionPrompt(history)).toBe('')
  expect(buildAgentInterruptionPrompt([
    stopped, { type: 'user', message: { content: [{ type: 'tool_result', tool_use_id: 'write-1', content: '返回值' }] } },
  ])).toContain('上一轮执行被用户停止')
})

test('语义恢复保留最新成功摘要和有界可见历史；失败/noop 摘要、思考、result 不作为背景', () => {
  const messages: SDKMessage[] = [
    { type: 'user', message: { content: [{ type: 'text', text: '历史任务' }] } },
    { type: 'system', subtype: 'compact_boundary', compact_result: 'success', summary: '旧摘要' },
    { type: 'assistant', message: { content: [{ type: 'thinking', thinking: '不可注入思考' }, { type: 'text', text: '可见回复' }] } },
    { type: 'system', subtype: 'compact_boundary', compact_result: 'success', summary: '最新成功摘要' },
    { type: 'system', subtype: 'compact_boundary', compact_result: 'failed', summary: '不可注入失败摘要' },
    { type: 'result', subtype: 'success', result: '不可注入终态' },
  ]
  const prompt = buildRecoveryPrompt(messages)
  expect(prompt).toContain('历史任务'); expect(prompt).toContain('可见回复'); expect(prompt).toContain('最新成功摘要')
  expect(prompt).not.toContain('旧摘要'); expect(prompt).not.toContain('不可注入')
  expect(prompt).toContain('语义恢复'); expect(buildRecoveryPrompt([])).toBe('')
  expect(buildRecoveryPrompt([{ type: 'system', subtype: 'compact_boundary', compact_result: 'success', summary: '仅摘要' }])).toContain('仅摘要')
  const bounded = buildRecoveryPrompt([{ type: 'system', subtype: 'compact_boundary', compact_result: 'success', summary: 's'.repeat(100000) },
    ...Array.from({ length: 100 }, (): SDKMessage => ({ type: 'user', message: { content: [{ type: 'text', text: 'u'.repeat(10000) }] } }))])
  expect(bounded.length).toBeLessThan(61000)
})

test('中断历史语义恢复明确部分输出和工具未知，思考不作为模型背景', () => {
  const prompt = buildRecoveryPrompt([
    { type: 'assistant', isPartial: true, parent_tool_use_id: null, message: { content: [
      { type: 'text', text: '尚未说完' }, { type: 'thinking', thinking: '不恢复的思考' },
    ] } },
    { type: 'user', isSynthetic: true, parent_tool_use_id: null, message: { content: [{
      type: 'tool_result', tool_use_id: 'write-1', execution_status: 'unknown', is_error: true,
      content: '是否执行完成未知',
    }] } },
  ])
  expect(prompt).toContain('助手（已中断的部分输出）：尚未说完')
  expect(prompt).toContain('工具状态未知（应用中断记录） write-1')
  expect(prompt).not.toContain('不恢复的思考')
})
