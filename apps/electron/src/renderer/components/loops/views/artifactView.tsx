/** 产物只从已登记历史快照读取；HTML 在无同源权限、无联网权限的独立 frame 内预览。 */
import { useEffect, useState } from 'react'
import type { ReactNode } from 'react'
import type { LoopArtifactContent } from '@axon/shared'
import type { ArtifactSummary } from '../types'
import { artifactKind } from '../lib/artifactKind'
import { TaskFileView } from './TaskFileView'
import { btnSm } from './ui'

export const isMarkdown = (path: string): boolean => artifactKind(path) === 'markdown'
export function ViewerHead({ path, meta, action }: { path: string; meta?: string; action?: ReactNode }) {
  return <div className="sticky top-0 z-10 flex flex-wrap items-center gap-2 border-b border-hairline bg-surface px-5 py-2.5">
    <span className="break-all font-mono text-label text-primary">{path}</span>
    {meta && <span className="text-caption text-disabled">· {meta}</span>}{action && <span className="ml-auto">{action}</span>}
  </div>
}

/** 懒读取采用代次清理，避免切文件后旧响应覆盖新选中内容。 */
export function ArtifactBody({ loopId, file }: { loopId: string; file: ArtifactSummary }) {
  const [content, setContent] = useState<LoopArtifactContent | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [source, setSource] = useState(false)
  useEffect(() => {
    let active = true; setContent(null); setError(null); setSource(false)
    void window.axon.loops.readArtifact(loopId, file.path, file.runId).then((value) => { if (active) setContent(value) },
      (cause: unknown) => { if (active) setError(cause instanceof Error ? cause.message : String(cause)) })
    return () => { active = false }
  }, [loopId, file.path, file.runId, file.updatedAt])
  if (error) return <div className="p-5 text-sm text-destructive">{error}</div>
  if (!content) return <div className="p-5 text-sm text-muted-foreground">正在读取产物…</div>
  const kind = artifactKind(file.path)
  const download = (): void => {
    const bytes = content.encoding === 'base64' ? Uint8Array.from(atob(content.content), (char) => char.charCodeAt(0)) : content.content
    const url = URL.createObjectURL(new Blob([bytes], { type: content.mediaType }))
    const link = document.createElement('a'); link.href = url; link.download = file.path.split('/').at(-1) ?? 'artifact'; link.click()
    setTimeout(() => URL.revokeObjectURL(url), 1000)
  }
  return <div className="min-w-0">
    <div className="flex items-center justify-end gap-2 border-b border-hairline px-4 py-2">
      {content.encoding === 'utf8' && <button type="button" className={btnSm} onClick={() => setSource(!source)}>{source ? '预览' : '源码'}</button>}
      <button type="button" className={btnSm} onClick={download}>下载</button>
    </div>
    {content.encoding === 'base64' ? content.mediaType.startsWith('image/')
      ? <img className="mx-auto max-h-[480px] max-w-full object-contain p-3" alt={file.path} src={`data:${content.mediaType};base64,${content.content}`} />
      : <p className="p-5 text-sm text-secondary">二进制产物不提供内联预览，可以下载此历史版本。</p>
      : source || kind === 'text' ? <pre className="max-h-[600px] overflow-auto whitespace-pre-wrap break-words p-5 font-mono text-xs">{content.content}</pre>
        : kind === 'markdown' ? <TaskFileView content={content.content} />
          : <iframe title={file.path} sandbox="allow-scripts" className="h-[420px] w-full border-0 bg-white"
            srcDoc={`<meta http-equiv="Content-Security-Policy" content="default-src 'none'; script-src 'unsafe-inline'; style-src 'unsafe-inline'; img-src data: blob:; connect-src 'none'; form-action 'none'; base-uri 'none'">${content.content}`} />}
  </div>
}
