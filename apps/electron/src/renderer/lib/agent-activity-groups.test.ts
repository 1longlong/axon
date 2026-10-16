import { describe, expect, test } from 'bun:test'
import type { SDKAssistantMessage, SDKContentBlock, SDKMessage } from '@axon/shared'
import { groupAgentActivities, summarizeAgentActivity } from './agent-activity-groups'

const assistant = (uuid: string, ...content: SDKContentBlock[]): SDKAssistantMessage => ({
  type: 'assistant', uuid, message: { content }, parent_tool_use_id: null,
})
const read: SDKContentBlock = { type: 'tool_use', id: 'read-1', name: 'Read', input: { path: 'a.ts' } }
const thought: SDKContentBlock = { type: 'thinking', thinking: '检查代码' }
const result: SDKMessage = { type: 'result', subtype: 'success', usage: {} }

describe('Agent 连续活动投影', () => {
  test('用户停止只收束动画，尾活动保留展开语义且不产生停止 notice；真正失败仍显示', () => {
    const stop: SDKMessage = { type: 'result', subtype: 'error', terminal_reason: 'stopped', stopped_by_user: true }
    const parts = groupAgentActivities([assistant('before', thought, { type: 'text', text: '说明' }, read), stop], { running: false })
    expect(parts.map((part) => part.kind)).toEqual(['activity', 'block', 'activity'])
    expect(parts[0]).toMatchObject({ closed: true })
    expect(parts[0]).not.toHaveProperty('interrupted')
    expect(parts[2]).toMatchObject({ closed: true, interrupted: true })
    const failed = groupAgentActivities([assistant('before', read), { ...stop, terminal_reason: 'failed',
      error: { code: 'runtime_cleanup_failed', category: 'runtime', message: '清理失败', retryable: false } }], { running: false })
    expect(failed.at(-1)?.kind).toBe('notice')
  })
  test('跨模型消息和已关联工具回传累积；正文出现后关闭旧组，后续活动建立新组', () => {
    const messages: SDKMessage[] = [
      assistant('first', thought, read),
      { type: 'user', parent_tool_use_id: null, message: { content: [{ type: 'tool_result', tool_use_id: 'read-1', content: '文件内容' }] } },
      assistant('second', { type: 'tool_use', id: 'grep-1', name: 'Grep', input: { pattern: 'function' } }),
      assistant('third', { type: 'text', text: '找到了入口' }, thought),
    ]
    const parts = groupAgentActivities(messages, { running: true, hideToolResult: () => true, streamingAssistantUuid: 'third' })
    expect(parts.map((part) => part.kind)).toEqual(['activity', 'block', 'activity'])
    expect(parts[0]).toMatchObject({ key: 'first-0', closed: true, items: [{ block: thought }, { block: read }, { block: { name: 'Grep' } }] })
    expect(parts[2]).toMatchObject({ key: 'third-1', closed: false, items: [{ isStreaming: true }] })
    expect(messages[0]).toEqual(assistant('first', thought, read))
  })

  test('空正文、空思考、占位和内部压缩终态不结束活动', () => {
    const parts = groupAgentActivities([
      assistant('first', read),
      { ...result, isSyntheticCompactionResult: true },
      assistant('draft', { type: 'text', text: ' ' }, { type: 'thinking', thinking: '' }, { type: 'unknown' }),
    ], { running: true })
    expect(parts).toHaveLength(1)
    expect(parts[0]).toMatchObject({ closed: false, items: [{ block: read }] })
  })

  test('普通终态和缺少终态的非活跃历史尾组默认收起，不误标历史思考为流式', () => {
    expect(groupAgentActivities([assistant('a', thought), result], { running: true })[0]).toMatchObject({ closed: true })
    expect(groupAgentActivities([assistant('a', thought)], { running: false })[0]).toMatchObject({ closed: true, items: [{ isStreaming: false }] })
  })

  test('失败终态、权限拒绝和未关联结果仍作为独立可见记录保持顺序', () => {
    const messages: SDKMessage[] = [
      assistant('a', read),
      { type: 'system', subtype: 'permission_denied', message: '用户拒绝' },
      { type: 'user', parent_tool_use_id: null, message: { content: [{ type: 'tool_result', tool_use_id: 'orphan', content: '失败', is_error: true }] } },
      { ...result, subtype: 'error', errors: ['连接失败'] },
    ]
    expect(groupAgentActivities(messages, { running: false }).map((part) => part.kind)).toEqual(['activity', 'notice', 'notice', 'notice'])
  })

  test('摘要按真实类型计数，重复路径和调用 ID 不制造额外计数', () => {
    const parts = groupAgentActivities([assistant('a', thought, read,
      { ...read, id: 'read-2' },
      { ...read, id: 'read-3', input: { path: 'b.ts' } },
      { type: 'tool_use', id: 'bash-1', name: 'Bash', input: { command: 'pwd' } },
      { type: 'tool_use', id: 'bash-1', name: 'Bash', input: { command: 'pwd' } },
      { type: 'tool_use', id: 'glob-1', name: 'Glob', input: { pattern: '*.ts' } },
      { type: 'tool_use', id: 'mcp-1', name: 'mcp_demo', input: {} },
    )], { running: false })
    const group = parts[0]
    if (group?.kind !== 'activity') throw new Error('缺少活动组')
    expect(summarizeAgentActivity(group)).toBe('思考 1 段，读取 2 个文件，搜索 1 次，执行 1 条命令，其他工具 1 次')
  })

  test('新增片段与后续正文不会改变原活动组的稳定 key', () => {
    const first = groupAgentActivities([assistant('a', thought)], { running: true })
    const updated = groupAgentActivities([assistant('a', thought, read, { type: 'text', text: '结果' })], { running: true })
    expect(updated[0]?.key).toBe(first[0]?.key)
    expect(updated[0]).toMatchObject({ closed: true })
  })
})
