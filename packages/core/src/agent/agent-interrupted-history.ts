import type {
  AgentStreamPayload, SDKAssistantMessage, SDKTextBlock, SDKThinkingBlock, SDKToolResultBlock, SDKToolUseBlock, SDKUserMessage,
} from '@axon/shared'

interface AssistantDraft {
  sessionId?: string
  blocks: Map<number, SDKTextBlock | SDKThinkingBlock>
}

/**
 * 每轮只暂存尚未完成的中立输出和未回传调用。停止时形成一次历史检查点，
 * 不解析工具参数字符串、不驱动执行，也不读取 Runtime artifact。
 */
export class AgentInterruptedHistory {
  private readonly drafts = new Map<string, AssistantDraft>()
  private readonly pendingTools = new Map<string, { sessionId?: string }>()

  /** 消费停止前已被 core 接纳的事件；完整消息和 Runtime 撤销会移除对应草稿。 */
  observe(payload: AgentStreamPayload): void {
    if (payload.kind === 'discard_assistant') this.drafts.delete(payload.uuid)
    if (payload.kind === 'retry_status' && payload.status.phase === 'scheduled' && payload.status.discardedAssistantUuid) {
      this.drafts.delete(payload.status.discardedAssistantUuid)
    }
    if (payload.kind === 'sdk_delta') {
      let draft = this.drafts.get(payload.delta.uuid)
      if (!draft) {
        draft = { sessionId: payload.delta.session_id, blocks: new Map() }
        this.drafts.set(payload.delta.uuid, draft)
      }
      for (const delta of payload.delta.deltas) {
        if (delta.type === 'start') continue
        // 参数流即使有 toolcall_end 也不能证明 Runtime 已接纳调用，不存为 tool_use。
        if (delta.type.startsWith('toolcall_')) continue
        const index = delta.contentIndex
        const previous = draft.blocks.get(index)
        if (delta.type === 'text_start') draft.blocks.set(index, { type: 'text', text: '' })
        if (delta.type === 'thinking_start') draft.blocks.set(index, { type: 'thinking', thinking: '' })
        if (delta.type === 'text_delta') draft.blocks.set(index, {
          type: 'text', text: `${previous?.type === 'text' ? String(previous.text ?? '') : ''}${delta.delta}`,
        })
        if (delta.type === 'thinking_delta') draft.blocks.set(index, {
          type: 'thinking', thinking: `${previous?.type === 'thinking' ? String(previous.thinking ?? '') : ''}${delta.delta}`,
        })
        if (delta.type === 'text_end') draft.blocks.set(index, { type: 'text', text: delta.content })
        if (delta.type === 'thinking_end') draft.blocks.set(index, { type: 'thinking', thinking: delta.content })
      }
    }
    if (payload.kind !== 'sdk_message') return
    if (payload.message.type === 'assistant') {
      const message = payload.message as SDKAssistantMessage
      if (message.uuid) this.drafts.delete(message.uuid)
      for (const block of message.message.content) {
        if (block.type !== 'tool_use') continue
        const tool = block as SDKToolUseBlock
        this.pendingTools.set(tool.id, { sessionId: message.session_id })
      }
    }
    if (payload.message.type === 'user') {
      for (const block of (payload.message as SDKUserMessage).message?.content ?? []) {
        if (block.type === 'tool_result') this.pendingTools.delete(String(block.tool_use_id))
      }
    }
  }

  /** 停止后只接纳本轮已登记、尚无结果的调用回传；混入的新文本/未知调用一律去除。 */
  acceptStoppedToolResult(payload: AgentStreamPayload): AgentStreamPayload | null {
    if (payload.kind !== 'sdk_message' || payload.message.type !== 'user') return null
    const message = payload.message as SDKUserMessage
    const content = (message.message?.content ?? []).filter((block) => {
      if (block.type !== 'tool_result' || typeof block.tool_use_id !== 'string') return false
      if (!this.pendingTools.has(block.tool_use_id)) return false
      this.pendingTools.delete(block.tool_use_id)
      return true
    })
    return content.length ? { kind: 'sdk_message', message: { ...message, message: { content } } } : null
  }

  /** 真实 query 收束后调用一次；只保存停止前的正文/思考，未知状态不是伪造的执行结果。 */
  takeInterrupted(createId: () => string): AgentStreamPayload[] {
    const payloads: AgentStreamPayload[] = []
    for (const [uuid, draft] of this.drafts) {
      const content = [...draft.blocks].sort(([left], [right]) => left - right).map(([, block]) => block)
        .filter((block) => block.type === 'text' ? String(block.text).length > 0 : String(block.thinking).length > 0)
      // 只有未完整参数时移除 UI 草稿；没有可恢复正文就不制造空白 assistant。
      if (!content.length) payloads.push({ kind: 'discard_assistant', uuid })
      else payloads.push({
        kind: 'sdk_message', message: {
          type: 'assistant', uuid, session_id: draft.sessionId, parent_tool_use_id: null,
          isPartial: true, message: { content, stop_reason: 'interrupted' },
        },
      })
    }
    for (const [id, { sessionId }] of this.pendingTools) {
      const block: SDKToolResultBlock = {
        type: 'tool_result', tool_use_id: id, is_error: true, execution_status: 'unknown',
        content: '执行被中断，未收到完整工具结果。是否执行完成及是否产生副作用未知，续做前需要核实实际状态。',
      }
      payloads.push({
        kind: 'sdk_message', message: {
          type: 'user', uuid: createId(), session_id: sessionId, parent_tool_use_id: null,
          isSynthetic: true, message: { content: [block] },
        },
      })
    }
    this.drafts.clear()
    this.pendingTools.clear()
    return payloads
  }
}
