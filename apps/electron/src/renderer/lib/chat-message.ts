import type { ChatContentBlock, FileAttachment } from '@axon/shared'
import { formatAttachmentSize } from '@/lib/chat-attachment'

/** 把结构化消息转换为剪贴板文本，不复制不透明推理签名；附件以名称与大小列出。 */
export function contentBlocksToPlainText(
  blocks: readonly ChatContentBlock[],
  attachments?: readonly FileAttachment[],
): string {
  const text = blocks.map((block) => {
    if (block.type === 'text' || block.type === 'reasoning') return block.text
    if (block.type === 'tool_call') return `${block.name}\n${block.arguments}`
    return `${block.name}\n${block.output}`
  }).filter(Boolean).join('\n\n')
  if (!attachments?.length) return text
  const list = attachments.map((item) => `附件：${item.filename}（${formatAttachmentSize(item.size)}）`).join('\n')
  return text ? `${text}\n\n${list}` : list
}
