import { describe, expect, test } from 'bun:test'
import type { SDKMessage } from '@axon/shared'
import { indexAgentToolMessages } from './agent-tool-messages'

describe('Agent 工具消息关联', () => {
  test('使用 tool use id 连接调用和后续结果', () => {
    const messages: SDKMessage[] = [
      {
        type: 'assistant', parent_tool_use_id: null,
        message: { content: [{ type: 'tool_use', id: 'read-1', name: 'Read', input: { path: 'README.md' } }] },
      },
      {
        type: 'user', parent_tool_use_id: null,
        message: { content: [{ type: 'tool_result', tool_use_id: 'read-1', content: '文件内容' }] },
      },
    ]

    const index = indexAgentToolMessages(messages)
    expect(index.toolUsesById.get('read-1')?.name).toBe('Read')
    expect(index.resultsByToolUseId.get('read-1')?.content).toBe('文件内容')
  })

  test('保留尚未返回结果的调用', () => {
    const index = indexAgentToolMessages([{
      type: 'assistant', parent_tool_use_id: null,
      message: { content: [{ type: 'tool_use', id: 'write-1', name: 'Write', input: {} }] },
    }])

    expect(index.toolUsesById.has('write-1')).toBe(true)
    expect(index.resultsByToolUseId.has('write-1')).toBe(false)
  })
})
