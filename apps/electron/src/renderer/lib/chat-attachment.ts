/**
 * Chat 附件的 renderer 助手：待发送附件的构造、校验与展示格式化。
 *
 * 两阶段草稿策略：选择/粘贴的文件先以 base64 留在 renderer 内存（data 字段），
 * 预览直接用 data URL；直到用户真正发送时才经 attachments.save 落盘——
 * "加了附件又取消"不会在磁盘留下孤儿文件。
 */

import { isImageAttachment, MAX_ATTACHMENTS_PER_MESSAGE, MAX_ATTACHMENT_SIZE } from '@axon/shared'

/** 待发送附件：尚未落盘，data 为 base64 内容（不含 data: 前缀）。 */
export interface PendingAttachment {
  id: string
  filename: string
  mediaType: string
  size: number
  data: string
}

/** 结构化文件输入，避免纯函数直接依赖 DOM File，便于测试。 */
export interface PendingAttachmentSource {
  name: string
  mediaType: string
  size: number
  bytes: ArrayBuffer
}

export interface PendingAttachmentBatch {
  attachments: PendingAttachment[]
  /** 第一个导致无法添加的错误；附件保留已通过校验的部分。 */
  error?: string
}

/** ArrayBuffer → base64。分块转换避免大文件时超出 btoa 的单字符串处理限制。 */
export function arrayBufferToBase64(buffer: ArrayBuffer): string {
  const bytes = new Uint8Array(buffer)
  const chunkSize = 0x8000
  const chunks: string[] = []
  for (let offset = 0; offset < bytes.length; offset += chunkSize) {
    chunks.push(String.fromCharCode(...bytes.subarray(offset, offset + chunkSize)))
  }
  return btoa(chunks.join(''))
}

/** 附件大小的用户可读格式（B/KB/MB，进位 1024）。 */
export function formatAttachmentSize(size: number): string {
  if (size < 1024) return `${size} B`
  if (size < 1024 * 1024) return `${Math.max(1, Math.round(size / 1024))} KB`
  return `${(size / (1024 * 1024)).toFixed(1)} MB`
}

/** 待发送附件的预览地址：仅图片生成 data URL，其他类型由调用方显示文件图标。 */
export function pendingAttachmentPreview(attachment: PendingAttachment): string | undefined {
  if (!isImageAttachment(attachment.mediaType)) return undefined
  return `data:${attachment.mediaType};base64,${attachment.data}`
}

/**
 * 把新选择的文件追加为待发送附件。
 * 单文件超限或超出数量上限时整体不添加并给出稳定错误；空文件跳过。
 */
export function appendPendingAttachments(
  sources: readonly PendingAttachmentSource[],
  existing: readonly PendingAttachment[],
): PendingAttachmentBatch {
  const usable = sources.filter((source) => source.size > 0)
  if (usable.length === 0) return { attachments: [] }

  for (const source of usable) {
    if (source.size > MAX_ATTACHMENT_SIZE) {
      return { attachments: [], error: `「${source.name}」超过 ${formatAttachmentSize(MAX_ATTACHMENT_SIZE)} 上限` }
    }
  }
  if (existing.length + usable.length > MAX_ATTACHMENTS_PER_MESSAGE) {
    return { attachments: [], error: `一条消息最多携带 ${MAX_ATTACHMENTS_PER_MESSAGE} 个附件` }
  }

  const startId = Date.now()
  return {
    attachments: usable.map((source, index) => ({
      id: `pending-${startId}-${index}`,
      filename: source.name || 'attachment',
      mediaType: source.mediaType || 'application/octet-stream',
      size: source.size,
      data: arrayBufferToBase64(source.bytes),
    })),
  }
}
