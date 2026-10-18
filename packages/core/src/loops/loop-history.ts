/** Loop 仅暴露当前任务登记会话的有界应用历史，不读取 Runtime 私有日志。 */
import type { SDKAssistantMessage, SDKMessage, SDKResultMessage, SDKUserMessage } from '@axon/shared'
import type { JsonlHistoryReader } from '../storage/jsonl-history-reader'

export interface LoopTracePage {
  entries: Array<{ offset: number; type: string; text: string; truncated: boolean }>
  nextOffset: number | null
}

/** 复用只读快照逐页定位；每次最多返回 20 条/每条 1600 字，不泄露 thinking 或宿主 system。 */
export function readLoopTrace(reader: JsonlHistoryReader<SDKMessage>, offset: number): LoopTracePage {
  const entries: LoopTracePage['entries'] = []
  let index = 0
  try {
    while (true) {
      const page = reader.readPage()
      for (const message of page.messages) {
        const position = index++
        if (position < offset) continue
        if (entries.length === 20) return { entries, nextOffset: position }
        const text = describeMessage(message)
        entries.push({ offset: position, type: message.type, text: text.slice(0, 1600), truncated: text.length > 1600 })
      }
      if (page.done) return { entries, nextOffset: null }
    }
  } finally { reader.close() }
}

function describeMessage(message: SDKMessage): string {
  if (message.type === 'assistant') return (message as SDKAssistantMessage).message.content.flatMap((block) => {
    if (block.type === 'text' && typeof block.text === 'string') return [block.text]
    if (block.type === 'tool_use') return [`调用 ${block.name} (${block.id})：${JSON.stringify(block.input)}`]
    return []
  }).join('\n')
  if (message.type === 'user') {
    const content = (message as SDKUserMessage).message?.content ?? []
    if (typeof content === 'string') return content
    return content.flatMap((block) => block.type === 'text' && typeof block.text === 'string' ? [block.text]
      : block.type === 'tool_result' ? [`工具结果 ${block.tool_use_id}${block.is_error ? '（错误）' : ''}：${JSON.stringify(block.content)}`] : []).join('\n')
  }
  if (message.type === 'result') {
    const result = message as SDKResultMessage
    return `状态：${result.subtype}；费用：${result.total_cost_usd ?? '未知'}；${result.error?.message ?? result.errors?.join('；') ?? ''}`
  }
  return '非正文系统事件；请以执行记录的状态和错误摘要为准。'
}
