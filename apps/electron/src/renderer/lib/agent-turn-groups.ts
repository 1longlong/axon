import type { SDKAssistantMessage, SDKMessage, SDKUserMessage } from '@axon/shared'
import { isAgentUserStoppedResult } from './agent-message'

export type AgentDisplayGroup =
  | { kind: 'user'; message: SDKMessage; index: number }
  | { kind: 'reply'; messages: readonly SDKMessage[]; resultIndex?: number; turnId?: string }

function isUserInput(message: SDKMessage): boolean {
  if (message.type !== 'user' || (message as SDKUserMessage).isSynthetic) return false
  return ((message as SDKUserMessage).message?.content ?? []).some((block) => block.type === 'text')
}

/** 只聚合 UI：工具回传与多次 assistant 调用仍保留原 JSONL 顺序和轮次终态。 */
export function groupAgentTurns(messages: readonly SDKMessage[]): AgentDisplayGroup[] {
  const groups: AgentDisplayGroup[] = []
  let reply: SDKMessage[] = []
  let turnId: string | undefined
  const flush = (resultIndex?: number): void => {
    const visible = reply.some((message) => message.type === 'assistant'
      || (message.type === 'result' && message.subtype !== 'success' && !isAgentUserStoppedResult(message))
      || (message.type === 'system' && ['permission_denied', 'axon_attachment_warning'].includes(String(message.subtype)))
      || (message.type === 'user' && ((message as SDKUserMessage).message?.content ?? []).some((block) => block.type === 'tool_result')))
    if (visible) groups.push({ kind: 'reply', messages: reply, ...(resultIndex === undefined ? {} : { resultIndex }),
      ...(turnId ? { turnId } : {}) })
    reply = []
  }

  for (let index = 0; index < messages.length; index += 1) {
    const message = messages[index]!
    if (isUserInput(message)) {
      flush()
      turnId = (message as SDKUserMessage).uuid
      groups.push({ kind: 'user', message, index })
      continue
    }
    // 后台续跑也有真实输入 UUID，只是不显示气泡；其暂停仍须接回自身回复。
    if (message.type === 'user' && (message as SDKUserMessage).isSynthetic
      && (message as SDKUserMessage).message?.content?.some((block) => block.type === 'text')) {
      turnId = (message as SDKUserMessage).uuid
    }
    if (message.type === 'system' && message.subtype === 'axon_continued') {
      const previous = groups.at(-1)
      const stopped = previous?.kind === 'reply' ? previous.messages.at(-1) : undefined
      // 只有明确关联原轮和停止结果的继续标记可重新打开旧回复，不按文本猜测。
      if (reply.length === 0 && previous?.kind === 'reply' && previous.turnId === message.turn_id
        && turnId === message.turn_id && typeof message.turn_id === 'string'
        && stopped && isAgentUserStoppedResult(stopped)
        && (stopped as { uuid?: string }).uuid === message.stopped_result_uuid) {
        groups.pop()
        reply = [...previous.messages, message]
      } else reply.push(message)
      continue
    }
    if (
      message.type !== 'assistant'
      && message.type !== 'result'
      && message.type !== 'user'
      && !(message.type === 'system' && ['permission_denied', 'axon_attachment_warning'].includes(String(message.subtype)))
    ) continue
    if (message.type === 'result' && message.isSyntheticCompactionResult === true) continue
    reply.push(message)
    if (message.type === 'result') flush(index)
  }
  flush()
  return groups
}

/** 只检查尚未收束的当前回复；历史输出与空 delta 不应隐藏新一轮的等待提示。 */
export function hasActiveAgentTurnOutput(groups: readonly AgentDisplayGroup[]): boolean {
  const current = groups.at(-1)
  if (current?.kind !== 'reply' || current.resultIndex !== undefined) return false
  const continuedAt = current.messages.findLastIndex((message) => message.type === 'system' && message.subtype === 'axon_continued')
  return current.messages.slice(continuedAt + 1).some((message) => {
    if (message.type === 'assistant') return (message as SDKAssistantMessage).message.content.some((block) => {
      if (block.type === 'text') return String(block.text ?? '').trim().length > 0
      if (block.type === 'thinking') return String(block.thinking ?? '').trim().length > 0
      return block.type !== 'unknown'
    })
    if (message.type === 'user') return ((message as SDKUserMessage).message?.content ?? []).some((block) => block.type === 'tool_result')
    return message.type === 'system' && ['permission_denied', 'axon_attachment_warning'].includes(String(message.subtype))
  })
}
