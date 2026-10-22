/** 图片预览只使用固定附件协议；校验完整字节和哈希后才交给浏览器解码。 */
import { MAX_AGENT_ATTACHMENT_CHUNK_BYTES, MAX_AGENT_IMAGE_PREPARED_BYTES, MAX_AGENT_IMAGE_THUMBNAIL_BYTES } from '@axon/shared'
import type { AgentAttachmentCommand, AgentAttachmentCommandResult, AgentImageChunk, AgentImageSource } from '@axon/shared'

/** 一次只拉一个有界块；取消不继续请求，迟到块不会创建新预览 URL。 */
export async function readAgentImageBlob(source: AgentImageSource, attachmentId: string, variant: 'image' | 'thumbnail', signal: AbortSignal,
  readChunk: (input: Extract<AgentAttachmentCommand, { action: 'readImage' }>) => Promise<AgentAttachmentCommandResult> = window.axon.agent.attachmentCommand): Promise<Blob> {
  const limit = variant === 'thumbnail' ? MAX_AGENT_IMAGE_THUMBNAIL_BYTES : MAX_AGENT_IMAGE_PREPARED_BYTES
  let bytes: Uint8Array<ArrayBuffer> | undefined, expected: Pick<AgentImageChunk, 'sha256' | 'mediaType' | 'totalBytes'> | undefined
  let offset = 0
  while (!bytes || offset < bytes.length) {
    signal.throwIfAborted()
    const value = await readChunk({ action: 'readImage', source, attachmentId, variant, offset })
    signal.throwIfAborted()
    if (!value || typeof value !== 'object' || !('data' in value)) throw new Error('图片预览响应无效')
    const chunk = value as AgentImageChunk
    if (chunk.attachmentId !== attachmentId || chunk.variant !== variant || chunk.offset !== offset || !Number.isSafeInteger(chunk.totalBytes)
      || chunk.totalBytes < 1 || chunk.totalBytes > limit || !['image/png', 'image/jpeg'].includes(chunk.mediaType)
      || !/^[a-f0-9]{64}$/.test(chunk.sha256) || typeof chunk.data !== 'string'
      || chunk.data.length > Math.ceil(MAX_AGENT_ATTACHMENT_CHUNK_BYTES / 3) * 4) throw new Error('图片预览内容超过限制')
    if (expected && (expected.sha256 !== chunk.sha256 || expected.mediaType !== chunk.mediaType || expected.totalBytes !== chunk.totalBytes)) throw new Error('图片预览在读取时发生变化')
    if (!expected) { expected = chunk; bytes = new Uint8Array(chunk.totalBytes) }
    const decoded = atob(chunk.data)
    if (decoded.length !== Math.min(MAX_AGENT_ATTACHMENT_CHUNK_BYTES, bytes!.length - offset)) throw new Error('图片预览块大小无效')
    for (let index = 0; index < decoded.length; index += 1) bytes![offset + index] = decoded.charCodeAt(index)
    offset += decoded.length
  }
  const hash = new Uint8Array(await crypto.subtle.digest('SHA-256', bytes))
  signal.throwIfAborted()
  if ([...hash].map((value) => value.toString(16).padStart(2, '0')).join('') !== expected?.sha256) throw new Error('图片预览已损坏')
  return new Blob([bytes], { type: expected.mediaType })
}
