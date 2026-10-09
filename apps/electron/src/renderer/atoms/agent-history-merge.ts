/** Agent 历史读取期间的实时覆盖层；只保留当前读请求的最终变更，不缓存所有 delta。 */
import type { AgentGenerationEvent, SDKMessage } from '@axon/shared'

export interface AgentHistoryChanges {
  byUuid: Map<string, 'complete' | 'draft' | 'removed'>
  unkeyed: SDKMessage[]
}
function uuid(message: SDKMessage): string | undefined {
  const value = (message as { uuid?: unknown }).uuid
  return typeof value === 'string' && value ? value : undefined
}

/** 上游 reducer 确认事件改变了消息后才记录；瞬时状态和迟到旧流不进入覆盖层。 */
export function recordAgentHistoryChange(changes: AgentHistoryChanges, event: AgentGenerationEvent): void {
  if (event.type !== 'stream') return
  const payload = event.payload
  if (payload.kind === 'sdk_message') {
    const key = uuid(payload.message)
    if (key) changes.byUuid.set(key, 'complete')
    else changes.unkeyed.push(payload.message)
  } else if (payload.kind === 'sdk_delta') changes.byUuid.set(payload.delta.uuid, 'draft')
  else if (payload.kind === 'discard_assistant') changes.byUuid.set(payload.uuid, 'removed')
  else if (payload.kind === 'retry_status' && payload.status.phase === 'scheduled' && payload.status.discardedAssistantUuid) {
    changes.byUuid.set(payload.status.discardedAssistantUuid, 'removed')
  }
}

/** 完整快照是基线：合并读取期间的新完整消息/新草稿，草稿不能覆盖磁盘已有完整同 ID 消息。 */
export function mergeAgentHistory(snapshot: readonly SDKMessage[], live: readonly SDKMessage[], changes: AgentHistoryChanges): SDKMessage[] {
  const current = new Map(live.flatMap((message) => { const key = uuid(message); return key ? [[key, message] as const] : [] }))
  const seen = new Set<string>()
  const result: SDKMessage[] = []
  for (const message of snapshot) {
    const key = uuid(message)
    if (key && changes.byUuid.get(key) === 'removed') continue
    if (key) seen.add(key)
    // 完整消息在后端先保存再通知，优先实时完整值；delta 则可能早于快照内的完整终态。
    result.push(key && changes.byUuid.get(key) === 'complete' ? current.get(key) ?? message : message)
  }
  const unkeyed = new Set(changes.unkeyed)
  for (const message of live) {
    const key = uuid(message)
    if (!key) { if (unkeyed.has(message)) result.push(message); continue }
    const mode = changes.byUuid.get(key)
    if (mode && mode !== 'removed' && !seen.has(key)) { result.push(message); seen.add(key) }
  }
  return result
}
