import * as React from 'react'
import { FileIcon } from '@react-symbols/icons/utils'
import { ChevronRight, Link, Loader2, RefreshCw, X } from 'lucide-react'
import type { AgentWorkspaceTreeEntry } from '@axon/shared'
import { ProjectFolderIcon } from '@/components/icons/WorkbenchIcons'
import { cn } from '@/lib/utils'
import { EMPTY_WORKSPACE_FILE_TABS, workspaceFileTabsReducer } from '@/lib/workspace-file-tabs'
import { observeProjectWatch } from '@/lib/project-watch'
import { useAgentController } from './AgentStateProvider'
import { WorkspaceFileTabs } from './WorkspaceFileTabs'

interface WorkspaceFileTreeProps {
  projectId: string
  workspaceUpdatedAt: number
  treeOpen: boolean
  treeId: string
  treeAnchorRef: React.RefObject<HTMLButtonElement>
  previewVisible: boolean
  onPreviewOpenChange(open: boolean): void
  onCloseTree(restoreFocus?: boolean): void
}

/** 文件工具窗口展示受限目录和只读预览；工作区切换或卸载时丢弃全部迟到响应。 */
export function WorkspaceFileTree({ projectId, workspaceUpdatedAt, treeOpen, treeId, treeAnchorRef, previewVisible, onPreviewOpenChange, onCloseTree }: WorkspaceFileTreeProps): React.ReactElement {
  const controller = useAgentController()
  const [entries, setEntries] = React.useState<AgentWorkspaceTreeEntry[]>([])
  const [loading, setLoading] = React.useState(true)
  const [error, setError] = React.useState(false)
  const [truncated, setTruncated] = React.useState(false)
  const [watchFailed, setWatchFailed] = React.useState(false)
  const [files, dispatchFiles] = React.useReducer(workspaceFileTabsReducer, EMPTY_WORKSPACE_FILE_TABS)
  const filesRef = React.useRef(files)
  filesRef.current = files
  const requestVersion = React.useRef(0)
  const previewVersion = React.useRef(0)
  const workspaceVersion = React.useRef(0)
  const treeRef = React.useRef<HTMLElement>(null)
  const hasPreview = files.tabs.length > 0

  // 只在打开/关闭预览时通知布局；目录监听重读同一文件不会强行展开手动收起的预览。
  React.useEffect(() => {
    onPreviewOpenChange(hasPreview)
  }, [hasPreview, onPreviewOpenChange])

  /** 浮层非模态：Escape 归还图标焦点，点击外部仅收树，不抢走目标控件的焦点。 */
  React.useEffect(() => {
    if (!treeOpen) return
    treeRef.current?.focus()
    const onKeyDown = (event: KeyboardEvent): void => {
      if (event.key !== 'Escape') return
      event.preventDefault()
      onCloseTree()
    }
    const onPointerDown = (event: PointerEvent): void => {
      if (!(event.target instanceof Node)) return
      if (treeRef.current?.contains(event.target) || treeAnchorRef.current?.contains(event.target)) return
      onCloseTree(false)
    }
    document.addEventListener('keydown', onKeyDown)
    document.addEventListener('pointerdown', onPointerDown)
    return () => {
      document.removeEventListener('keydown', onKeyDown)
      document.removeEventListener('pointerdown', onPointerDown)
    }
  }, [onCloseTree, treeAnchorRef, treeOpen])

  /** 目录读取经 controller 获取受限树；只接收最新请求，避免监听刷新乱序覆盖。 */
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

  /** 每个文件独立接收读取结果；目录刷新不切换激活项，重置后的迟到响应直接丢弃。 */
  const loadPreview = React.useCallback(async (relativePath: string, activate = true): Promise<void> => {
    const requestId = ++previewVersion.current
    const version = workspaceVersion.current
    dispatchFiles({ type: 'load', relativePath, requestId, activate })
    try {
      const next = await controller.readProjectFile(projectId, relativePath)
      if (workspaceVersion.current === version) dispatchFiles({ type: 'loaded', relativePath, requestId, preview: next })
    } catch {
      if (workspaceVersion.current === version) dispatchFiles({ type: 'failed', relativePath, requestId })
    }
  }, [controller, projectId])

  // 工作区重置先隔离旧响应，再订阅刷新；卸载同时释放监听和读取结果的归属。
  React.useEffect(() => {
    workspaceVersion.current += 1
    dispatchFiles({ type: 'clear' })
    setWatchFailed(false)
    const stopWatch = observeProjectWatch({
      projectId, kind: 'workspace',
      watch: (id) => controller.watchProjectDirectory(id),
      unwatch: (target) => controller.unwatchProjectDirectory(target),
      onChanged: (callback) => controller.onProjectDirectoryChanged(callback),
      onClosed: (callback) => controller.onProjectWatchClosed(callback),
      ready: () => { setWatchFailed(false); void load() },
      changed: () => {
        void load()
        for (const tab of filesRef.current.tabs) void loadPreview(tab.relativePath, false)
      },
      closed: (event) => {
        // 目录已经失效，先拒绝旧树/预览结果；重新订阅后才读取新的工作区。
        requestVersion.current++; workspaceVersion.current++
        dispatchFiles({ type: 'clear' }); setEntries([])
        setWatchFailed(event.reason !== 'project_changed')
        setError(event.reason === 'project_deleted')
        setLoading(event.reason === 'project_changed')
      },
      failed: () => { setWatchFailed(true); void load() },
    })
    return () => {
      requestVersion.current += 1
      workspaceVersion.current += 1
      stopWatch()
    }
  }, [controller, load, loadPreview, projectId, workspaceUpdatedAt])

  return <section aria-label="工作区文件面板" className="relative flex h-full min-h-0 flex-col">
    {/* 保持各 Tab 内容挂载，切换或手动收栏时保留阅读位置。 */}
    {hasPreview && <div hidden={!previewVisible} className={cn('flex min-h-0 flex-1 flex-col', !previewVisible && 'hidden')}>
      <WorkspaceFileTabs tabs={files.tabs} activePath={files.activePath}
        onSelect={(relativePath) => dispatchFiles({ type: 'activate', relativePath })}
        onClose={(relativePath) => {
          dispatchFiles({ type: 'close', relativePath })
          if (files.tabs.length === 1) treeAnchorRef.current?.focus()
        }} />
    </div>}
    {/* 仅隐藏浮层而不卸载：目录展开态、文件预览和工作区监听都继续有效。 */}
    <section ref={treeRef} id={treeId} role="dialog" aria-modal="false" tabIndex={-1} aria-label="工作区文件树" hidden={!treeOpen} className={cn('workspace-file-tree-popover absolute right-3 top-2 z-30 w-72 max-w-[calc(100vw_-_4rem)] max-h-[min(28rem,calc(100%_-_1rem))] min-h-0 flex-col rounded-[8px] border border-border text-popover-foreground shadow-sm outline-none', treeOpen ? 'flex' : 'hidden')}>
      <span aria-hidden="true" className="workspace-file-tree-pointer pointer-events-none absolute" />
      <div className="flex h-8 shrink-0 items-center gap-1.5 border-b border-border-subtle px-2.5">
        <ProjectFolderIcon size={14} className="shrink-0 text-amber-500 dark:text-amber-400" />
        <span className="min-w-0 flex-1 truncate text-xs font-semibold">工作区文件</span>
        <button type="button" aria-label="刷新工作区文件" title="刷新工作区文件" disabled={loading} onClick={() => void load()} className="flex size-6 shrink-0 items-center justify-center rounded text-muted-foreground hover:bg-muted/60 hover:text-foreground focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-ring disabled:opacity-40">
          {loading ? <Loader2 size={12} className="animate-spin" /> : <RefreshCw size={12} />}
        </button>
        <button type="button" aria-label="收起工作区文件树" title="收起文件树，保留预览" onClick={() => onCloseTree()} className="flex size-6 shrink-0 items-center justify-center rounded text-muted-foreground hover:bg-muted/60 hover:text-foreground focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-ring"><X size={12} /></button>
      </div>
      <div className="min-h-0 overflow-auto px-1.5 py-1.5 font-mono text-[11px]">
        {error
          ? <p className="px-1 py-2 text-destructive">读取工作区文件失败</p>
          : loading && entries.length === 0
            ? <p className="px-1 py-2 text-muted-foreground">正在读取工作区…</p>
            : !loading && entries.length === 0
              ? <p className="px-1 py-2 text-muted-foreground">工作区暂无文件</p>
              : <WorkspaceTreeEntries entries={entries} selectedPath={files.activePath} onSelect={(path) => {
                if (files.tabs.some((tab) => tab.relativePath === path)) dispatchFiles({ type: 'activate', relativePath: path })
                else void loadPreview(path)
              }} />}
        {truncated && <p className="mt-2 border-t border-border-subtle px-1 pt-2 text-[11px] text-muted-foreground">文件较多，仅显示部分内容</p>}
        {watchFailed && <p className="mt-2 border-t border-border-subtle px-1 pt-2 text-[11px] text-muted-foreground">自动刷新不可用，可手动刷新</p>}
      </div>
      {!loading && !error && <div className="shrink-0 border-t border-border-subtle px-3 py-1 font-mono text-[10px] text-muted-foreground">顶层 {entries.length} 项{truncated ? '（部分）' : ''}</div>}
    </section>
  </section>
}

interface WorkspaceTreeEntriesProps {
  entries: AgentWorkspaceTreeEntry[]
  selectedPath: string | null
  onSelect(relativePath: string): void
}

export function WorkspaceTreeEntries({ entries, selectedPath, onSelect }: WorkspaceTreeEntriesProps): React.ReactElement {
  return <div className="space-y-0.5">{entries.map((entry) => (
    entry.kind === 'directory'
      ? <details key={entry.relativePath} className="[&[open]>summary>svg:first-child]:rotate-90">
          <summary className="flex min-w-0 cursor-pointer list-none items-center gap-1.5 rounded px-1.5 py-1 hover:bg-muted/60 focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-ring [&::-webkit-details-marker]:hidden">
            <ChevronRight size={11} className="shrink-0 text-muted-foreground transition-transform motion-reduce:transition-none" />
            <ProjectFolderIcon size={13} className="shrink-0 text-amber-500 dark:text-amber-400" />
            <span className="truncate" title={entry.relativePath}>{entry.name}</span>
          </summary>
          {entry.children && entry.children.length > 0 && <div className="ml-3 pl-1">
            <WorkspaceTreeEntries entries={entry.children} selectedPath={selectedPath} onSelect={onSelect} />
          </div>}
        </details>
      : entry.kind === 'symlink'
        ? <div key={entry.relativePath} className="flex min-w-0 items-center gap-1.5 rounded px-1.5 py-1 pl-[23px] text-muted-foreground">
            <Link size={12} className="shrink-0" /><span className="truncate" title={entry.relativePath}>{entry.name}</span>
          </div>
        : <button type="button" key={entry.relativePath} aria-label={`预览 ${entry.relativePath}`} aria-pressed={selectedPath === entry.relativePath} onClick={() => onSelect(entry.relativePath)} className={cn('flex w-full min-w-0 items-center gap-1.5 rounded border border-transparent px-1.5 py-1 pl-[23px] text-left hover:bg-muted/60 focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-ring', selectedPath === entry.relativePath && 'border-border bg-background font-medium text-foreground')}>
            <WorkspaceFileIcon name={entry.name} size={14} />
            <span className="truncate" title={entry.relativePath}>{entry.name}</span>
          </button>
  ))}</div>
}

interface WorkspaceFileIconProps {
  name: string
  size: number
}

function WorkspaceFileIcon({ name, size }: WorkspaceFileIconProps): React.ReactElement {
  return <FileIcon fileName={name} autoAssign width={size} height={size} aria-hidden="true" focusable="false" className="shrink-0 text-muted-foreground" />
}
