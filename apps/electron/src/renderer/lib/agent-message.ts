import type { SDKMessage, SDKResultMessage } from '@axon/shared'

/** 用户主动停止属于执行状态；真正的清理/持久化等失败仍需展示错误。 */
export function isAgentUserStoppedResult(message: SDKMessage): boolean {
  if (message.type !== 'result') return false
  const result = message as SDKResultMessage
  return result.terminal_reason === 'stopped' && result.stopped_by_user === true
    && (!result.error || result.error.category === 'canceled')
}

/** 将未知工具结果安全转换为可复制文本，避免把对象直接交给 JSX。 */
export function stringifyAgentContent(content: unknown): string {
  if (typeof content === 'string') return content
  if (content === undefined || content === null) return ''
  try { return JSON.stringify(content, null, 2) ?? '' } catch { return '[无法显示工具结果]' }
}

/** 提取面向用户的可见文本；思考签名和工具参数不进入复制内容。 */
export function agentMessageText(message: SDKMessage): string {
  if (message.type === 'user') {
    if ((message as { isSynthetic?: unknown }).isSynthetic === true) return ''
    const user = message as { message?: { content?: unknown[] } }
    return (user.message?.content ?? []).map((block) => {
      if (!block || typeof block !== 'object') return ''
      const item = block as { type?: unknown; text?: unknown; content?: unknown }
      if (item.type === 'text') return typeof item.text === 'string' ? item.text : ''
      if (item.type === 'tool_result') return stringifyAgentContent(item.content)
      return ''
    }).filter(Boolean).join('\n')
  }
  if (message.type === 'assistant') {
    const assistant = message as { message: { content: unknown[] } }
    return assistant.message.content.map((block) => {
      if (!block || typeof block !== 'object') return ''
      const item = block as { type?: unknown; text?: unknown; thinking?: unknown }
      return item.type === 'text' && typeof item.text === 'string' ? item.text : ''
    }).filter(Boolean).join('')
  }
  if (message.type === 'result') {
    const result = message as { error?: { message?: unknown }; errors?: unknown; terminal_reason?: unknown }
    return typeof result.error?.message === 'string'
      ? result.error.message
      : Array.isArray(result.errors)
      ? result.errors.filter((item): item is string => typeof item === 'string').join('\n')
      : typeof result.terminal_reason === 'string' ? result.terminal_reason : ''
  }
  return ''
}
