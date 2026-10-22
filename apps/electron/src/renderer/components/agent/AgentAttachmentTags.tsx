import * as React from 'react'
import { FileText, Folder, Image, Sparkles, X } from 'lucide-react'
import type { AgentInputAttachment, AgentImageSource } from '@axon/shared'
import { formatAttachmentSize } from '@/lib/chat-attachment'
import { AgentImagePreview } from './AgentImagePreview'

/** 草稿与历史共用轻量标签；完整正文和 Skill 展开内容不混入用户气泡。 */
export function AgentAttachmentTags({ attachments, onRemove, disabled = false, imageSource, onRestoreText, canRestoreText, onPreviewOpen }: {
  attachments: readonly AgentInputAttachment[]
  onRemove?: (id: string) => void
  disabled?: boolean
  imageSource?: AgentImageSource
  onRestoreText?: (id: string) => void
  canRestoreText?: (id: string) => boolean
  onPreviewOpen?: () => void
}): React.ReactElement | null {
  if (!attachments.length) return null
  return <div className="flex min-w-0 flex-wrap gap-1.5" aria-label="消息附件">
    {attachments.map((attachment) => {
      const Icon = attachment.kind === 'directory' ? Folder : attachment.kind === 'image' ? Image
        : attachment.kind === 'skill' ? Sparkles : FileText
      const details = attachment.kind === 'pastedText' && attachment.pastedText
        ? `${attachment.pastedText.characterCount.toLocaleString()} 字符：${attachment.pastedText.preview}`
        : attachment.kind === 'selection' ? `${attachment.source ?? '选中片段'}${attachment.startLine ? `:${attachment.startLine}${attachment.endLine ? `–${attachment.endLine}` : ''}` : ''}\n${attachment.text.slice(0, 120)}`
          : 'path' in attachment ? attachment.path : 'size' in attachment ? formatAttachmentSize(attachment.size) : attachment.name
      return <span key={attachment.id} title={details} className="inline-flex min-w-0 max-w-64 items-center gap-1.5 rounded-lg border border-border bg-background px-2 py-1 text-xs text-muted-foreground">
        {attachment.kind === 'image' && attachment.storage === 'managed' && imageSource
          ? <AgentImagePreview attachment={attachment} source={imageSource} disabled={disabled} onOpen={onPreviewOpen} />
          : <><Icon size={13} aria-hidden="true" className="shrink-0" /><span className="min-w-0 truncate">{attachment.name}</span></>}
        {attachment.kind === 'pastedText' && attachment.pastedText && <span className="shrink-0 text-[10px]">{attachment.pastedText.characterCount.toLocaleString()} 字</span>}
        {attachment.kind === 'pastedText' && onRestoreText && <button type="button" disabled={disabled || !canRestoreText?.(attachment.id)}
          onClick={() => onRestoreText(attachment.id)} title={canRestoreText?.(attachment.id) ? '改回输入框内联文字' : '超过输入框长度，保留为文本附件'} className="shrink-0 rounded px-1 text-[10px] hover:bg-muted disabled:opacity-40">内联</button>}
        {onRemove && <button type="button" disabled={disabled} aria-label={`移除附件 ${attachment.name}`}
          onClick={() => onRemove(attachment.id)} className="rounded p-0.5 hover:bg-muted hover:text-foreground disabled:opacity-40"><X size={12} /></button>}
      </span>
    })}
  </div>
}
