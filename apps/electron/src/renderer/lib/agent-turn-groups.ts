import type { SDKMessage, SDKUserMessage } from '@axon/shared'

export type AgentDisplayGroup =
  | { kind: 'user'; message: SDKMessage; index: number }
  | { kind: 'reply'; messages: readonly SDKMessage[]; resultIndex?: number }

function isUserInput(message: SDKMessage): boolean {
  if (message.type !== 'user' || (message as SDKUserMessage).isSynthetic) return false
  return ((message as SDKUserMessage).message?.content ?? []).some((block) => block.type === 'text')
}

/** 只聚合 UI：工具回传与多次 assistant 调用仍保留原 JSONL 顺序和轮次终态。 */
export function groupAgentTurns(messages: readonly SDKMessage[]): AgentDisplayGroup[] {
  const groups: AgentDisplayGroup[] = []
  let reply: SDKMessage[] = []
  const flush = (resultIndex?: number): void => {
    const visible = reply.some((message) => message.type === 'assistant'
      || (message.type === 'result' && message.subtype !== 'success')
      || (message.type === 'system' && message.subtype === 'permission_denied')
      || (message.type === 'user' && ((message as SDKUserMessage).message?.content ?? []).some((block) => block.type === 'tool_result')))
    if (visible) groups.push({ kind: 'reply', messages: reply, ...(resultIndex === undefined ? {} : { resultIndex }) })
    reply = []
  }

  for (let index = 0; index < messages.length; index += 1) {
    const message = messages[index]!
    if (isUserInput(message)) {
      flush()
      groups.push({ kind: 'user', message, index })
      continue
    }
    if (
      message.type !== 'assistant'
      && message.type !== 'result'
      && message.type !== 'user'
      && !(message.type === 'system' && message.subtype === 'permission_denied')
    ) continue
    if (message.type === 'result' && message.isSyntheticCompactionResult === true) continue
    reply.push(message)
    if (message.type === 'result') flush(index)
  }
  flush()
  return groups
}
