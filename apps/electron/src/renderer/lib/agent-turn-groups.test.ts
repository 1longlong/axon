import { describe, expect, test } from 'bun:test'
import type { SDKAssistantMessage, SDKContentBlock, SDKMessage } from '@axon/shared'
import { groupAgentTurns, hasActiveAgentTurnOutput } from './agent-turn-groups'

const input: SDKMessage = { type: 'user', message: { content: [{ type: 'text', text: '开始任务' }] }, parent_tool_use_id: null }
const result: SDKMessage = { type: 'result', subtype: 'success', usage: { input_tokens: 1 } }
const assistant = (...content: SDKContentBlock[]): SDKAssistantMessage => ({ type: 'assistant', message: { content }, parent_tool_use_id: null })
const hasOutput = (...messages: SDKMessage[]): boolean => hasActiveAgentTurnOutput(groupAgentTurns(messages))

describe('当前 Agent 回复的等待提示边界', () => {
  test('新任务不能因历史思考或历史正文而隐藏等待提示', () => {
    expect(hasOutput()).toBe(false)
    expect(hasOutput(input)).toBe(false)
    expect(hasOutput(input, assistant({ type: 'thinking', thinking: '旧思考' }, { type: 'text', text: '旧答案' }), result, input)).toBe(false)
    expect(hasOutput(input, assistant({ type: 'text', text: '上一轮答案' }), result)).toBe(false)
  })

  test('空草稿与内部占位不算输出，首个实际思考或正文才隐藏等待提示', () => {
    expect(hasOutput(input, assistant({ type: 'thinking', thinking: '  ' }, { type: 'text', text: '' }, { type: 'unknown' }))).toBe(false)
    expect(hasOutput(input, assistant({ type: 'thinking', thinking: '分析任务' }))).toBe(true)
    expect(hasOutput(input, assistant({ type: 'text', text: '开始检查' }))).toBe(true)
  })

  test('工具调用、回传和权限拒绝已有可见反馈，不再重复等待动效', () => {
    expect(hasOutput(input, assistant({ type: 'tool_use', id: 'tool-1', name: 'Read', input: {} }))).toBe(true)
    expect(hasOutput(input, { type: 'user', message: { content: [{ type: 'tool_result', tool_use_id: 'tool-1', content: '' }] }, parent_tool_use_id: null })).toBe(true)
    expect(hasOutput(input, { type: 'system', subtype: 'permission_denied', message: '权限已拒绝' })).toBe(true)
  })

  test('多次模型调用之间及内部压缩收束后，保留当前回复已有输出的判断', () => {
    expect(hasOutput(input, assistant({ type: 'thinking', thinking: '已输出' }), assistant({ type: 'thinking', thinking: '' }))).toBe(true)
    expect(hasOutput(input, assistant({ type: 'text', text: '已有输出' }), { ...result, isSyntheticCompactionResult: true })).toBe(true)
  })
})
