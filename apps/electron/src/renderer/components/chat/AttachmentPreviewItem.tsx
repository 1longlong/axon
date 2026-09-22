import * as React from 'react'
import { FileText, X } from 'lucide-react'
import type { PendingAttachment } from '@/lib/chat-attachment'
import { pendingAttachmentPreview } from '@/lib/chat-attachment'

/**
 * 待发送附件的预览项：图片用内存 data URL 缩略图，其他文件显示图标。
 * 删除只影响 renderer 内存草稿，此时文件尚未落盘。
 */
export function AttachmentPreviewItem({
  attachment,
  onRemove,
}: {
  attachment: PendingAttachment
  onRemove: (id: string) => void
}): React.ReactElement {
  const preview = pendingAttachmentPreview(attachment)
  return (
    <span className="group relative flex items-center gap-2 rounded-lg border bg-background px-2 py-1.5">
      {preview ? (
        <img src={preview} alt={attachment.filename} className="h-8 w-8 rounded object-cover" />
      ) : (
        <span className="flex h-8 w-8 items-center justify-center rounded bg-muted text-muted-foreground">
          <FileText size={15} />
        </span>
      )}
      <span className="max-w-40 truncate text-xs text-foreground" title={attachment.filename}>{attachment.filename}</span>
      <button
        type="button"
        aria-label={`移除附件 ${attachment.filename}`}
        onClick={() => onRemove(attachment.id)}
        className="rounded p-0.5 text-muted-foreground hover:bg-muted hover:text-foreground"
      >
        <X size={13} />
      </button>
    </span>
  )
}
