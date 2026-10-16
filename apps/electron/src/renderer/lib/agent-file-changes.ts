import type { SDKMessage } from '@axon/shared'
import { groupAgentTurns } from './agent-turn-groups'

export type AgentFileChangeOperation = 'write' | 'edit'

export interface AgentFileChange {
  path: string
  operations: AgentFileChangeOperation[]
}

export interface AgentTurnFileChanges {
  resultIndex: number
  files: AgentFileChange[]
}

interface PendingFileCall {
  id: string
  path: string
  operation: AgentFileChangeOperation
  succeeded: boolean
}

function asRecord(value: unknown): Record<string, unknown> | null {
  return value && typeof value === 'object' && !Array.isArray(value) ? value as Record<string, unknown> : null
}

function readFileCall(block: unknown): PendingFileCall | null {
  const value = asRecord(block)
  if (!value || value.type !== 'tool_use' || typeof value.id !== 'string') return null
  const operation = typeof value.name === 'string' ? value.name.toLocaleLowerCase() : ''
  if (operation !== 'write' && operation !== 'edit') return null
  const input = asRecord(value.input)
  const rawPath = input?.file_path ?? input?.path
  if (typeof rawPath !== 'string' || !rawPath.trim()) return null
  return { id: value.id, path: rawPath.trim().replace(/^\.\//, ''), operation, succeeded: false }
}

function markSuccessfulResults(message: Record<string, unknown>, calls: PendingFileCall[]): void {
  if (message.type !== 'user') return
  const payload = asRecord(message.message)
  const content = Array.isArray(payload?.content) ? payload.content : []
  for (const block of content) {
    const result = asRecord(block)
    if (!result || result.type !== 'tool_result' || typeof result.tool_use_id !== 'string' || result.is_error === true) continue
    const call = calls.find((item) => item.id === result.tool_use_id)
    if (call) call.succeeded = true
  }
}

function aggregateSuccessfulCalls(calls: readonly PendingFileCall[]): AgentFileChange[] {
  const files = new Map<string, Set<AgentFileChangeOperation>>()
  for (const call of calls) {
    if (!call.succeeded) continue
    const operations = files.get(call.path) ?? new Set<AgentFileChangeOperation>()
    operations.add(call.operation)
    files.set(call.path, operations)
  }
  return [...files].map(([path, operations]) => ({ path, operations: [...operations] }))
}

/**
 * 沿显示轮次汇总中断前后已有成功 tool_result 的写入操作；
 * 失败、权限拒绝和未完成调用不冒充文件变更。
 */
export function collectAgentTurnFileChanges(messages: readonly SDKMessage[]): AgentTurnFileChanges[] {
  const summaries: AgentTurnFileChanges[] = []
  for (const group of groupAgentTurns(messages)) {
    if (group.kind !== 'reply' || group.resultIndex === undefined) continue
    const calls: PendingFileCall[] = []
    for (const raw of group.messages) {
      const message = raw as Record<string, unknown>
      if (message.type === 'assistant') {
        const payload = asRecord(message.message)
        const content = Array.isArray(payload?.content) ? payload.content : []
        for (const block of content) {
          const call = readFileCall(block)
          if (call) calls.push(call)
        }
      }
      markSuccessfulResults(message, calls)
    }
    const files = aggregateSuccessfulCalls(calls)
    if (files.length > 0) summaries.push({ resultIndex: group.resultIndex, files })
  }
  return summaries
}
