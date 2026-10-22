import * as React from 'react'
import { Dialog } from '@base-ui/react/dialog'
import { Image as ImageIcon, Loader2, X } from 'lucide-react'
import type { AgentImageSource, AgentManagedAttachment } from '@axon/shared'
import { readAgentImageBlob } from '@/lib/agent-image-preview'

/** 组件只持有短期 Blob URL；切换来源、关闭或卸载时撤销，不缓存完整历史图片。 */
function useImageUrl(source: AgentImageSource, attachmentId: string, variant: 'image' | 'thumbnail', enabled: boolean) {
  const key = `${JSON.stringify(source)}\0${attachmentId}\0${variant}`
  const [state, setState] = React.useState<{ key: string; url?: string; failed?: boolean }>()
  React.useEffect(() => {
    if (!enabled) return
    const controller = new AbortController()
    let url: string | undefined
    setState(undefined)
    void readAgentImageBlob(source, attachmentId, variant, controller.signal).then((blob) => {
      if (controller.signal.aborted) return
      url = URL.createObjectURL(blob)
      setState({ key, url })
    }).catch(() => { if (!controller.signal.aborted) setState({ key, failed: true }) })
    return () => { controller.abort(); if (url) URL.revokeObjectURL(url) }
  }, [key, enabled])
  return enabled && state?.key === key ? state : undefined
}

/** 草稿/历史共用缩略图和 Dialog；完整处理版本只在用户展开时读取。 */
export function AgentImagePreview({ attachment, source, disabled, onOpen }: {
  attachment: AgentManagedAttachment
  source: AgentImageSource
  disabled: boolean
  onOpen?: () => void
}): React.ReactElement {
  const [open, setOpen] = React.useState(false)
  const thumbnail = useImageUrl(source, attachment.id, 'thumbnail', true)
  const full = useImageUrl(source, attachment.id, 'image', open)
  const [failedUrl, setFailedUrl] = React.useState<string>()
  const fail = Boolean(thumbnail?.failed || thumbnail?.url && thumbnail.url === failedUrl)
  return <Dialog.Root open={open} onOpenChange={(value) => { if (value) onOpen?.(); setOpen(value) }}>
    <Dialog.Trigger disabled={disabled || fail} aria-label={`预览图片 ${attachment.name}`} title={fail ? '图片缺失或损坏' : attachment.name}
      className="flex min-w-0 items-center gap-1.5 rounded p-0.5 text-left hover:bg-muted disabled:opacity-60">
      {thumbnail?.url && !fail ? <img src={thumbnail.url} alt="" onError={() => setFailedUrl(thumbnail.url)} className="h-8 w-8 shrink-0 rounded object-cover" />
        : !thumbnail ? <Loader2 size={14} className="shrink-0 animate-spin" /> : <ImageIcon size={14} className="shrink-0" />}
      <span className="min-w-0 truncate">{attachment.name}{fail ? '（图片不可用）' : ''}</span>
    </Dialog.Trigger>
    <Dialog.Portal>
      <Dialog.Backdrop className="fixed inset-0 z-[120] bg-black/35" />
      <Dialog.Popup className="fixed left-1/2 top-1/2 z-[121] flex max-h-[85vh] w-[min(90vw,64rem)] -translate-x-1/2 -translate-y-1/2 flex-col rounded-xl border border-border bg-background p-4 shadow-lg outline-none">
        <div className="mb-3 flex items-center justify-between gap-3">
          <Dialog.Title className="truncate text-sm font-medium">{attachment.name}</Dialog.Title>
          <Dialog.Close aria-label="关闭图片预览" className="rounded p-1 hover:bg-muted"><X size={16} /></Dialog.Close>
        </div>
        <div className="min-h-24 min-w-0 overflow-auto">
          {full?.failed || full?.url && full.url === failedUrl ? <p role="alert" className="p-3 text-sm text-muted-foreground">图片已缺失或损坏，无法预览。</p>
            : full?.url ? <img src={full.url} alt={attachment.name} onError={() => setFailedUrl(full.url)} className="mx-auto max-h-[65vh] max-w-full object-contain" />
              : <div className="flex items-center justify-center p-6"><Loader2 size={20} className="animate-spin" /></div>}
        </div>
        <Dialog.Description className="mt-3 text-xs text-muted-foreground">{attachment.image?.width} × {attachment.image?.height}{attachment.image?.note ? ` · ${attachment.image.note}` : ''} · 预览为发送给模型的处理版本，原件保留。</Dialog.Description>
      </Dialog.Popup>
    </Dialog.Portal>
  </Dialog.Root>
}
