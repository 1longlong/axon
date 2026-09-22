import type { SDKAssistantMessage, SDKMessage, SDKToolResultBlock, SDKToolUseBlock, SDKUserMessage } from '@axon/shared'

export interface AgentToolMessageIndex {
  resultsByToolUseId: ReadonlyMap<string, SDKToolResultBlock>
  toolUsesById: ReadonlyMap<string, SDKToolUseBlock>
}

/** 按 tool use id 连接 assistant 调用与随后 user 回传的结果，供消息 UI 合并展示。 */
export function indexAgentToolMessages(messages: readonly SDKMessage[]): AgentToolMessageIndex {
  const resultsByToolUseId = new Map<string, SDKToolResultBlock>()
  const toolUsesById = new Map<string, SDKToolUseBlock>()

  for (const message of messages) {
    if (message.type === 'assistant') {
      for (const block of (message as SDKAssistantMessage).message.content) {
        if (block.type === 'tool_use' && typeof block.id === 'string') {
          toolUsesById.set(block.id, block as SDKToolUseBlock)
        }
      }
      continue
    }
    if (message.type !== 'user') continue
    for (const block of (message as SDKUserMessage).message?.content ?? []) {
      if (block.type === 'tool_result' && typeof block.tool_use_id === 'string') {
        resultsByToolUseId.set(block.tool_use_id, block as SDKToolResultBlock)
      }
    }
  }

  return { resultsByToolUseId, toolUsesById }
}
