import * as React from 'react'
import { ChevronRight, File, Folder, FolderTree, Link, Loader2, RefreshCw, X } from 'lucide-react'
import type { AgentWorkspaceFilePreview, AgentWorkspaceTreeEntry } from '@axon/shared'
import { useAgentController } from './AgentStateProvider'

/** 文件工具窗口展示受限目录和只读预览；工作区切换或卸载时丢弃全部迟到响应。 */
export function WorkspaceFileTree({ projectId, workspaceUpdatedAt }: {
  projectId: string
  workspaceUpdatedAt: number
}): React.ReactElement {
  const controller = useAgentController()
  const [entries, setEntries] = React.useState<AgentWorkspaceTreeEntry[]>([])
  const [loading, setLoading] = React.useState(true)
  const [error, setError] = React.useState(false)
  const [truncated, setTruncated] = React.useState(false)
  const [watchFailed, setWatchFailed] = React.useState(false)
  const [preview, setPreview] = React.useState<AgentWorkspaceFilePreview | null>(null)
  const [previewLoading, setPreviewLoading] = React.useState(false)
  const [previewError, setPreviewError] = React.useState(false)
  const selectedPath = React.useRef<string | null>(null)
  const requestVersion = React.useRef(0)
  const previewVersion = React.useRef(0)

  const load = React.useCallback(async (): Promise<void> => {
    const version = ++requestVersion.current
    setLoading(true)
    setError(false)
    try {
      const listing = await controller.listProjectDirectory(projectId)
      if (requestVersion.current !== version) return
      setEntries(listing.entries)
      setTruncated(listing.truncated)
    } catch {
      if (requestVersion.current === version) setError(true)
    } finally {
      if (requestVersion.current === version) setLoading(false)
    }
  }, [controller, projectId])

  /** 预览请求独立防乱序，快速切换文件时旧内容不会覆盖新选择。 */
  const loadPreview = React.useCallback(async (relativePath: string): Promise<void> => {
    const version = ++previewVersion.current
    selectedPath.current = relativePath
    setPreviewLoading(true)
    setPreviewError(false)
    try {
      const next = await controller.readProjectFile(projectId, relativePath)
      if (previewVersion.current === version) setPreview(next)
    } catch {
      if (previewVersion.current === version) {
        setPreview(null)
        setPreviewError(true)
      }
    } finally {
      if (previewVersion.current === version) setPreviewLoading(false)
    }
  }, [controller, projectId])

  const closePreview = React.useCallback((): void => {
    previewVersion.current += 1
    selectedPath.current = null
    setPreview(null)
    setPreviewError(false)
    setPreviewLoading(false)
  }, [])

  React.useEffect(() => {
    closePreview()
    void load()
    setWatchFailed(false)
    const unsubscribe = controller.onProjectDirectoryChanged((event) => {
      if (event.projectId !== projectId) return
      void load()
      if (selectedPath.current) void loadPreview(selectedPath.current)
    })
    void controller.watchProjectDirectory(projectId).catch(() => setWatchFailed(true))
    return () => {
      requestVersion.current += 1
      previewVersion.current += 1
      unsubscribe()
      void controller.unwatchProjectDirectory(projectId).catch(() => {})
    }
  }, [closePreview, controller, load, loadPreview, projectId, workspaceUpdatedAt])

  return <section aria-label="工作区文件面板" className="flex h-full min-h-0 flex-col">
    <div className="titlebar-drag-region flex h-12 shrink-0 items-center gap-2 border-b px-3">
      <FolderTree size={14} />
      <span className="flex-1 text-xs font-medium">工作区文件</span>
      <button type="button" aria-label="刷新工作区文件" disabled={loading} onClick={() => void load()} className="titlebar-no-drag rounded p-1 text-muted-foreground hover:bg-muted hover:text-foreground disabled:opacity-40">
        {loading ? <Loader2 size={13} className="animate-spin" /> : <RefreshCw size={13} />}
      </button>
    </div>
    <div className={`min-h-0 overflow-auto p-2 text-xs ${preview || previewLoading || previewError ? 'h-1/2 shrink-0 border-b' : 'flex-1'}`}>
      {error
        ? <p className="px-1 py-2 text-destructive">读取工作区文件失败</p>
        : !loading && entries.length === 0
          ? <p className="px-1 py-2 text-muted-foreground">工作区暂无文件</p>
          : <TreeEntries entries={entries} selectedPath={selectedPath.current} onSelect={(path) => void loadPreview(path)} />}
      {truncated && <p className="mt-2 border-t px-1 pt-2 text-[11px] text-muted-foreground">文件较多，仅显示部分内容</p>}
      {watchFailed && <p className="mt-2 border-t px-1 pt-2 text-[11px] text-muted-foreground">自动刷新不可用，可手动刷新</p>}
    </div>
    {(preview || previewLoading || previewError) && <FilePreview preview={preview} loading={previewLoading} error={previewError} onClose={closePreview} />}
  </section>
}

function TreeEntries({ entries, selectedPath, onSelect }: {
  entries: AgentWorkspaceTreeEntry[]
  selectedPath: string | null
  onSelect(relativePath: string): void
}): React.ReactElement {
  return <div className="space-y-0.5">{entries.map((entry) => (
    entry.kind === 'directory'
      ? <details key={entry.relativePath}>
          <summary className="group flex cursor-pointer list-none items-center gap-1 rounded px-1 py-1 hover:bg-muted [&::-webkit-details-marker]:hidden">
            <ChevronRight size={11} className="shrink-0 transition-transform group-open:rotate-90" />
            <Folder size={13} className="shrink-0 text-muted-foreground" />
            <span className="truncate" title={entry.relativePath}>{entry.name}</span>
          </summary>
          {entry.children && entry.children.length > 0 && <div className="ml-3 border-l pl-1">
            <TreeEntries entries={entry.children} selectedPath={selectedPath} onSelect={onSelect} />
          </div>}
        </details>
      : entry.kind === 'symlink'
        ? <div key={entry.relativePath} className="flex items-center gap-1 rounded px-1 py-1 pl-[18px] text-muted-foreground">
            <Link size={12} className="shrink-0" /><span className="truncate" title={entry.relativePath}>{entry.name}</span>
          </div>
        : <button type="button" key={entry.relativePath} aria-label={`预览 ${entry.relativePath}`} onClick={() => onSelect(entry.relativePath)} className={`flex w-full items-center gap-1 rounded px-1 py-1 pl-[18px] text-left hover:bg-muted ${selectedPath === entry.relativePath ? 'bg-muted' : ''}`}>
            <File size={12} className="shrink-0 text-muted-foreground" />
            <span className="truncate" title={entry.relativePath}>{entry.name}</span>
          </button>
  ))}</div>
}

function FilePreview({ preview, loading, error, onClose }: {
  preview: AgentWorkspaceFilePreview | null
  loading: boolean
  error: boolean
  onClose(): void
}): React.ReactElement {
  return <section aria-label="文件预览" className="flex min-h-0 flex-1 flex-col bg-background">
    <div className="flex h-9 shrink-0 items-center gap-2 border-b px-3">
      <span className="min-w-0 flex-1 truncate text-[11px] font-medium">{preview?.relativePath ?? '文件预览'}</span>
      <button type="button" aria-label="关闭文件预览" onClick={onClose} className="rounded p-1 text-muted-foreground hover:bg-muted"><X size={12} /></button>
    </div>
    <div className="min-h-0 flex-1 overflow-auto p-3 text-xs">
      {loading
        ? <p className="flex items-center gap-1.5 text-muted-foreground"><Loader2 size={12} className="animate-spin" />正在读取…</p>
        : error
          ? <p className="text-destructive">文件不存在或无法安全读取</p>
          : preview?.kind === 'too_large'
            ? <p className="text-muted-foreground">文件超过 512 KB，暂不预览</p>
            : preview?.kind === 'binary'
              ? <p className="text-muted-foreground">二进制文件暂不预览</p>
              : preview?.kind === 'text'
                ? <pre className="whitespace-pre-wrap break-words font-mono text-[11px] leading-5">{preview.content}</pre>
                : null}
    </div>
  </section>
}
