import { describe, expect, test } from 'bun:test'
import type { SDKMessage } from '@axon/shared'
import { collectAgentTurnFileChanges } from './agent-file-changes'

function assistantCalls(...content: Array<Record<string, unknown>>): SDKMessage {
  return { type: 'assistant', message: { content }, parent_tool_use_id: null }
}

function toolResults(...content: Array<Record<string, unknown>>): SDKMessage {
  return { type: 'user', message: { content }, parent_tool_use_id: null }
}

function result(extra: Record<string, unknown> = {}): SDKMessage {
  return { type: 'result', subtype: 'success', usage: { input_tokens: 1 }, ...extra }
}

describe('Agent 每轮文件变更汇总', () => {
  test('只收集有成功结果的 write/edit，并按路径合并操作', () => {
    const messages: SDKMessage[] = [
      assistantCalls(
        { type: 'tool_use', id: 'write-1', name: 'Write', input: { file_path: './src/app.ts' } },
        { type: 'tool_use', id: 'edit-1', name: 'edit', input: { path: 'src/app.ts' } },
        { type: 'tool_use', id: 'read-1', name: 'read', input: { file_path: 'README.md' } },
      ),
      toolResults(
        { type: 'tool_result', tool_use_id: 'write-1', content: 'ok' },
        { type: 'tool_result', tool_use_id: 'edit-1', content: 'ok' },
        { type: 'tool_result', tool_use_id: 'read-1', content: 'ok' },
      ),
      result(),
    ]

    expect(collectAgentTurnFileChanges(messages)).toEqual([{
      resultIndex: 2,
      files: [{ path: 'src/app.ts', operations: ['write', 'edit'] }],
    }])
  })

  test('忽略失败、权限拒绝、未完成调用和合成压缩终态', () => {
    const messages: SDKMessage[] = [
      assistantCalls(
        { type: 'tool_use', id: 'failed', name: 'write', input: { path: 'failed.ts' } },
        { type: 'tool_use', id: 'pending', name: 'edit', input: { path: 'pending.ts' } },
      ),
      toolResults({ type: 'tool_result', tool_use_id: 'failed', is_error: true }),
      result({ isSyntheticCompactionResult: true }),
      assistantCalls({ type: 'tool_use', id: 'success', name: 'write', input: { path: 'success.ts' } }),
      toolResults({ type: 'tool_result', tool_use_id: 'success' }),
      result(),
    ]

    expect(collectAgentTurnFileChanges(messages)).toEqual([{
      resultIndex: 5,
      files: [{ path: 'success.ts', operations: ['write'] }],
    }])
  })

  test('正常终态隔离相邻轮次，不让迟到结果串入下一轮', () => {
    const messages: SDKMessage[] = [
      assistantCalls({ type: 'tool_use', id: 'old', name: 'write', input: { path: 'old.ts' } }),
      result(),
      toolResults({ type: 'tool_result', tool_use_id: 'old' }),
      result(),
    ]

    expect(collectAgentTurnFileChanges(messages)).toEqual([])
  })
})
