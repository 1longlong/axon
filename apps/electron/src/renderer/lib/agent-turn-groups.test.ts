import { describe, expect, test } from 'bun:test'
import type { SDKAssistantMessage, SDKContentBlock, SDKMessage } from '@axon/shared'
import { groupAgentTurns, hasActiveAgentTurnOutput } from './agent-turn-groups'

const input: SDKMessage = { type: 'user', message: { content: [{ type: 'text', text: '开始任务' }] }, parent_tool_use_id: null }
const result: SDKMessage = { type: 'result', subtype: 'success', usage: { input_tokens: 1 } }
const assistant = (...content: SDKContentBlock[]): SDKAssistantMessage => ({ type: 'assistant', message: { content }, parent_tool_use_id: null })
const hasOutput = (...messages: SDKMessage[]): boolean => hasActiveAgentTurnOutput(groupAgentTurns(messages))

describe('当前 Agent 回复的等待提示边界', () => {
  test('后台结果续跑的输入不显示用户气泡，但暂停后继续仍按其真实 UUID 合并', () => {
    const groups = groupAgentTurns([
      { ...input, uuid: 'human-turn' }, assistant({ type: 'text', text: '原轮结束' }), result,
      { ...input, uuid: 'background-turn', isSynthetic: true }, assistant({ type: 'text', text: '后台处理到一半' }),
      { ...result, uuid: 'background-stop', subtype: 'error', terminal_reason: 'stopped', stopped_by_user: true },
      { type: 'system', subtype: 'axon_continued', turn_id: 'background-turn', stopped_result_uuid: 'background-stop' },
      assistant({ type: 'text', text: '后台原任务继续完成' }), result,
    ])
    expect(groups.map((group) => group.kind)).toEqual(['user', 'reply', 'reply'])
    expect(groups.at(-1)).toMatchObject({ kind: 'reply', turnId: 'background-turn' })
    const last = groups.at(-1)
    expect(last?.kind === 'reply' && last.messages.filter((message) => message.type === 'assistant')).toHaveLength(2)
  })

  test('明确继续重开原回复，重复中断仍沿原轮；刷新后投影一致且真实新输入另起一轮', () => {
    const user = { ...input, uuid: 'turn-1' }
    const stop = { ...result, uuid: 'stop-1', subtype: 'error', terminal_reason: 'stopped', stopped_by_user: true }
    const marker: SDKMessage = { type: 'system', subtype: 'axon_continued', turn_id: 'turn-1', stopped_result_uuid: 'stop-1' }
    const history: SDKMessage[] = [user, assistant({ type: 'text', text: '中断前' }), stop, marker]
    let groups = groupAgentTurns(history)
    expect(groups.map((group) => group.kind)).toEqual(['user', 'reply'])
    expect(groups[1]).toMatchObject({ turnId: 'turn-1' })
    expect(groups[1]).not.toHaveProperty('resultIndex')
    expect(hasActiveAgentTurnOutput(groups)).toBe(false)
    history.push(assistant({ type: 'text', text: '继续一' }), { ...stop, uuid: 'stop-2' },
      { ...marker, stopped_result_uuid: 'stop-2' }, assistant({ type: 'text', text: '继续二' }), result)
    groups = groupAgentTurns(history)
    expect(groups.map((group) => group.kind)).toEqual(['user', 'reply'])
    expect(groups[1]).toMatchObject({ turnId: 'turn-1', resultIndex: history.length - 1 })
    expect(groupAgentTurns(JSON.parse(JSON.stringify(history)) as SDKMessage[])).toEqual(groups)
    history.push({ ...user, uuid: 'turn-2' }, assistant({ type: 'text', text: '新任务回复' }), result)
    expect(groupAgentTurns(history).map((group) => group.kind)).toEqual(['user', 'reply', 'user', 'reply'])
  })

  test('轮次或停止结果不匹配，或先前并非用户停止，不能合并旧回复', () => {
    const user = { ...input, uuid: 'turn-1' }
    const stop = { ...result, uuid: 'stop-1', subtype: 'error', terminal_reason: 'stopped', stopped_by_user: true }
    const marker: SDKMessage = { type: 'system', subtype: 'axon_continued', turn_id: 'turn-1', stopped_result_uuid: 'stop-1' }
    for (const [terminal, next] of [[stop, { ...marker, turn_id: 'other' }], [stop, { ...marker, stopped_result_uuid: 'other' }],
      [{ ...stop, terminal_reason: 'failed' }, marker]] as Array<[SDKMessage, SDKMessage]>) {
      expect(groupAgentTurns([user, assistant({ type: 'text', text: '旧输出' }), terminal, next,
        assistant({ type: 'text', text: '另一执行' }), result]).map((group) => group.kind)).toEqual(['user', 'reply', 'reply'])
    }
  })

  test('继续后只有旧内容不算新执行已输出，首个新 delta 才结束等待', () => {
    const history: SDKMessage[] = [{ ...input, uuid: 'turn-1' }, assistant({ type: 'text', text: '旧回复' }),
      { ...result, uuid: 'stop-1', subtype: 'error', terminal_reason: 'stopped', stopped_by_user: true },
      { type: 'system', subtype: 'axon_continued', turn_id: 'turn-1', stopped_result_uuid: 'stop-1' }]
    expect(hasOutput(...history)).toBe(false)
    expect(hasOutput(...history, assistant({ type: 'text', text: '新输出' }))).toBe(true)
  })

  test('停止只有状态时不造空回复；内部继续输入不产生用户气泡，真实后续输入仍显示', () => {
    const stop: SDKMessage = { type: 'result', subtype: 'error', terminal_reason: 'stopped', stopped_by_user: true }
    expect(groupAgentTurns([input, stop])).toEqual([{ kind: 'user', message: input, index: 0 }])
    const internal: SDKMessage = { ...input, isSynthetic: true, message: { content: [{ type: 'text', text: '内部继续' }] } }
    const groups = groupAgentTurns([input, assistant({ type: 'text', text: '中断前正文' }), stop,
      internal, assistant({ type: 'text', text: '继续后的正文' }), result, input])
    expect(groups.map((group) => group.kind)).toEqual(['user', 'reply', 'reply', 'user'])
    expect(groups.filter((group) => group.kind === 'user')).toHaveLength(2)
  })
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
