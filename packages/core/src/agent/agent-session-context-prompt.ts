import type { SDKMessage } from '@axon/shared'

const MAX_RECOVERY_CONTEXT_CHARS = 60_000
const MAX_RECOVERY_MESSAGE_CHARS = 8_000

function stringifyContent(value: unknown): string {
  if (typeof value === 'string') return value
  if (value === undefined || value === null) return ''
  try { return JSON.stringify(value) ?? '' } catch { return '[内容无法序列化]' }
}

/** 将一条中立消息压缩成恢复文本；运行状态、result 和思考内容不重复注入模型。 */
function recoveryLine(message: SDKMessage): string | undefined {
  if (message.type === 'user') {
    const content = (message as { message?: { content?: unknown[] } }).message?.content ?? []
    const text = content.map((block) => {
      if (!block || typeof block !== 'object') return ''
      const item = block as { type?: unknown; text?: unknown; content?: unknown; tool_use_id?: unknown }
      if (item.type === 'text') return typeof item.text === 'string' ? item.text : ''
      if (item.type === 'tool_result') return `[工具结果 ${String(item.tool_use_id ?? '')}] ${stringifyContent(item.content)}`
      return ''
    }).filter(Boolean).join('\n')
    return text ? `用户：${text.slice(0, MAX_RECOVERY_MESSAGE_CHARS)}` : undefined
  }
  if (message.type === 'assistant') {
    const content = (message as { message?: { content?: unknown[] } }).message?.content ?? []
    const text = content.map((block) => {
      if (!block || typeof block !== 'object') return ''
      const item = block as { type?: unknown; text?: unknown; name?: unknown; input?: unknown }
      if (item.type === 'text') return typeof item.text === 'string' ? item.text : ''
      if (item.type === 'tool_use') return `[调用工具 ${String(item.name ?? '')}] ${stringifyContent(item.input)}`
      return ''
    }).filter(Boolean).join('\n')
    return text ? `助手：${text.slice(0, MAX_RECOVERY_MESSAGE_CHARS)}` : undefined
  }
  return undefined
}

/**
 * 从 Axon JSONL 的最近可见消息构造有界恢复上下文；输入是稳定中立历史，
 * 输出作为新 runtime session 的首轮前缀，无法还原的内部状态不会伪装成无损 resume。
 */
export function buildRecoveryPrompt(messages: SDKMessage[]): string {
  const selected: string[] = []
  let length = 0
  for (let index = messages.length - 1; index >= 0; index -= 1) {
    const line = recoveryLine(messages[index]!)
    if (!line) continue
    if (length + line.length > MAX_RECOVERY_CONTEXT_CHARS) break
    selected.unshift(line)
    length += line.length
  }
  if (selected.length === 0) return ''
  return [
    '[会话恢复上下文]',
    '原运行会话记录不可用。以下内容来自应用已持久化的可见历史，只作为此前对话背景。',
    ...selected,
    '[恢复说明]',
    '请结合以上背景继续处理下一条用户消息，不要复述恢复说明。',
  ].join('\n\n')
}
