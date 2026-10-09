import { describe, expect, test } from 'bun:test'
import type { SDKMessage } from '@axon/shared'
import { mergeAgentHistory, recordAgentHistoryChange } from './agent-history-merge'
import type { AgentHistoryChanges } from './agent-history-merge'

function message(uuid: string, text: string): SDKMessage {
  return { type: 'assistant', uuid, parent_tool_use_id: null, message: { content: [{ type: 'text', text }] } }
}
function changes(): AgentHistoryChanges { return { byUuid: new Map(), unkeyed: [] } }

describe('Agent 完整历史与实时覆盖层', () => {
  test('只覆盖读取期间触及的完整消息，新 ID 原位去重；基线摘要/未知字段完整保留', () => {
    const overlay = changes()
    overlay.byUuid.set('new', 'complete')
    const summary: SDKMessage = { type: 'system', uuid: 'summary', subtype: 'compact_boundary', summary: '摘要', extension: { keep: true } }
    const result = mergeAgentHistory([message('old', '磁盘'), summary, message('new', '先前值')],
      [message('old', '读取前旧缓存'), message('new', '当前完整值')], overlay)
    expect(result).toEqual([message('old', '磁盘'), summary, message('new', '当前完整值')])
    expect(result[1]).toBe(summary)
  })

  test('新草稿追加；同 ID 草稿不覆盖磁盘完整值，也不在下次读取永久残留', () => {
    const overlay = changes()
    overlay.byUuid.set('same', 'draft'); overlay.byUuid.set('draft', 'draft')
    expect(mergeAgentHistory([message('same', '完整')], [message('same', '片段'), message('draft', '新片段')], overlay))
      .toEqual([message('same', '完整'), message('draft', '新片段')])
    expect(mergeAgentHistory([message('same', '完整')], [message('draft', '旧草稿')], changes()))
      .toEqual([message('same', '完整')])
  })

  test('撤回/重试删除不被快照复活；同一 UUID 后续完整消息可正常重建', () => {
    const overlay = changes()
    recordAgentHistoryChange(overlay, { type: 'stream', sessionId: 'session', runStartedAt: 1, source: 'renderer',
      payload: { kind: 'discard_assistant', uuid: 'discarded' } })
    expect(mergeAgentHistory([message('discarded', '过期')], [], overlay)).toEqual([])
    recordAgentHistoryChange(overlay, { type: 'stream', sessionId: 'session', runStartedAt: 1, source: 'renderer',
      payload: { kind: 'sdk_message', message: message('discarded', '重建完整值') } })
    expect(mergeAgentHistory([message('discarded', '过期')], [message('discarded', '重建完整值')], overlay))
      .toEqual([message('discarded', '重建完整值')])
  })

  test('不丢弃无 UUID 的新增未知消息；同一 assistant 的连续 delta 只记录一个键', () => {
    const overlay = changes(), unknown: SDKMessage = { type: 'future_event', extra: { keep: true } }
    recordAgentHistoryChange(overlay, { type: 'stream', sessionId: 'session', runStartedAt: 1, source: 'renderer', payload: { kind: 'sdk_message', message: unknown } })
    for (let i = 0; i < 100; i += 1) recordAgentHistoryChange(overlay, { type: 'stream', sessionId: 'session', runStartedAt: 1, source: 'renderer',
      payload: { kind: 'sdk_delta', delta: { uuid: 'draft', deltas: [{ type: 'text_delta', contentIndex: 0, delta: 'a' }] } } })
    expect(overlay.byUuid.size).toBe(1)
    expect(mergeAgentHistory([], [unknown, message('draft', 'a'.repeat(100))], overlay)).toEqual([unknown, message('draft', 'a'.repeat(100))])
  })
})
