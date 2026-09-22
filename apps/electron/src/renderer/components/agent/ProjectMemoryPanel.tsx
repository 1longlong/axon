import * as React from 'react'
import { Brain, FilePlus2, FileText, Loader2, RefreshCw, Save } from 'lucide-react'
import { AGENT_MEMORY_INDEX_FILE } from '@axon/shared'
import type { AgentMemorySummary } from '@axon/shared'
import { useAgentController } from './AgentStateProvider'

/** 项目记忆编辑器：只消费 Agent 专用 IPC，文件选择和刷新都防止迟到响应覆盖当前草稿。 */
export function ProjectMemoryPanel({ projectId, workspaceUpdatedAt }: {
  projectId: string
  workspaceUpdatedAt: number
}): React.ReactElement {
  const controller = useAgentController()
  const [summary, setSummary] = React.useState<AgentMemorySummary | null>(null)
  const [selectedPath, setSelectedPath] = React.useState<string | null>(null)
  const [content, setContent] = React.useState('')
  const [savedContent, setSavedContent] = React.useState('')
  const [loading, setLoading] = React.useState(true)
  const [fileLoading, setFileLoading] = React.useState(false)
  const [saving, setSaving] = React.useState(false)
  const [error, setError] = React.useState<string | null>(null)
  const [changeNotice, setChangeNotice] = React.useState<'refreshed' | 'conflict' | null>(null)
  const [watchFailed, setWatchFailed] = React.useState(false)
  const [fileReloadVersion, setFileReloadVersion] = React.useState(0)
  const listVersion = React.useRef(0)
  const fileVersion = React.useRef(0)
  const dirtyRef = React.useRef(false)
  const savingRef = React.useRef(false)
  const ownWriteRef = React.useRef<{ relativePath: string; until: number } | null>(null)
  const dirty = content !== savedContent
  dirtyRef.current = dirty
  savingRef.current = saving

  /** 重读权威文件列表；需要时同步触发当前文件重读，外部事件不直接修改编辑内容。 */
  const loadSummary = React.useCallback(async (options: {
    confirmDiscard?: boolean
    reloadSelected?: boolean
  } = {}): Promise<boolean> => {
    if (options.confirmDiscard !== false && dirtyRef.current && !window.confirm('放弃尚未保存的记忆修改？')) {
      return false
    }
    const version = ++listVersion.current
    setLoading(true)
    setError(null)
    try {
      const next = await controller.listProjectMemory(projectId)
      if (listVersion.current !== version) return false
      setSummary(next)
      setSelectedPath((current) => (
        current && next.files.some((file) => file.relativePath === current)
          ? current
          : next.files.find((file) => file.relativePath === AGENT_MEMORY_INDEX_FILE)?.relativePath
            ?? next.files[0]?.relativePath
            ?? null
      ))
      if (next.files.length === 0) {
        setContent('')
        setSavedContent('')
      }
      if (options.reloadSelected) setFileReloadVersion((current) => current + 1)
      return true
    } catch {
      if (listVersion.current === version) setError('读取项目记忆失败')
      return false
    } finally {
      if (listVersion.current === version) setLoading(false)
    }
  }, [controller, projectId])

  React.useEffect(() => {
    setSelectedPath(null)
    setContent('')
    setSavedContent('')
    setChangeNotice(null)
    setWatchFailed(false)
    void loadSummary({ confirmDiscard: false })
    return () => {
      listVersion.current += 1
      fileVersion.current += 1
    }
  }, [loadSummary, projectId, workspaceUpdatedAt])

  /** 监听只驱动 UI 刷新；未保存草稿存在时改为提示，由用户决定何时丢弃。 */
  React.useEffect(() => {
    let disposed = false
    const unsubscribe = controller.onProjectMemoryChanged((event) => {
      if (event.projectId !== projectId) return
      const ownWrite = ownWriteRef.current
      if (savingRef.current) return
      const recentOwnWrite = ownWrite && Date.now() <= ownWrite.until
      if (dirtyRef.current) {
        setChangeNotice('conflict')
        return
      }
      if (recentOwnWrite && (!event.relativePath || event.relativePath === ownWrite.relativePath)) {
        // 自身原子写与外部变化可能同名或合批：省略提示但仍重读，不能漏掉后到内容。
        ownWriteRef.current = null
        void loadSummary({ confirmDiscard: false, reloadSelected: true })
        return
      }
      setChangeNotice('refreshed')
      void loadSummary({ confirmDiscard: false, reloadSelected: true })
    })
    void controller.watchProjectMemory(projectId).then(() => {
      if (!disposed) setWatchFailed(false)
    }).catch(() => {
      if (!disposed) setWatchFailed(true)
    })
    return () => {
      disposed = true
      unsubscribe()
      void controller.unwatchProjectMemory(projectId)
    }
  }, [controller, loadSummary, projectId, workspaceUpdatedAt])

  React.useEffect(() => {
    if (!selectedPath) return
    const version = ++fileVersion.current
    setFileLoading(true)
    setError(null)
    void controller.readProjectMemory(projectId, selectedPath).then((file) => {
      if (fileVersion.current !== version) return
      setContent(file.content)
      setSavedContent(file.content)
    }).catch(() => {
      if (fileVersion.current === version) setError('读取记忆文件失败')
    }).finally(() => {
      if (fileVersion.current === version) setFileLoading(false)
    })
  }, [controller, fileReloadVersion, projectId, selectedPath])

  const selectFile = (relativePath: string): void => {
    if (relativePath === selectedPath) return
    if (dirty && !window.confirm('放弃尚未保存的记忆修改？')) return
    setSelectedPath(relativePath)
  }

  const save = async (): Promise<void> => {
    if (!selectedPath || saving || !dirty) return
    setSaving(true)
    setError(null)
    try {
      const file = await controller.writeProjectMemory(projectId, selectedPath, content)
      ownWriteRef.current = { relativePath: file.relativePath, until: Date.now() + 1_000 }
      setContent(file.content)
      setSavedContent(file.content)
      setSummary((current) => current ? {
        ...current,
        totalBytes: current.totalBytes
          - (current.files.find((item) => item.relativePath === file.relativePath)?.size ?? 0)
          + file.size,
        files: current.files.map((item) => item.relativePath === file.relativePath
          ? { relativePath: file.relativePath, size: file.size, updatedAt: file.updatedAt }
          : item),
      } : current)
    } catch {
      setError('保存记忆文件失败')
    } finally {
      setSaving(false)
    }
  }

  const createIndex = async (): Promise<void> => {
    if (saving) return
    setSaving(true)
    setError(null)
    try {
      await controller.writeProjectMemory(projectId, AGENT_MEMORY_INDEX_FILE, '# MEMORY\n\n项目长期记忆索引。\n')
      ownWriteRef.current = { relativePath: AGENT_MEMORY_INDEX_FILE, until: Date.now() + 1_000 }
      setSelectedPath(AGENT_MEMORY_INDEX_FILE)
      setSummary(await controller.listProjectMemory(projectId))
    } catch {
      setError('创建 MEMORY.md 失败')
    } finally {
      setSaving(false)
    }
  }

  return <section aria-label="项目记忆面板" className="flex h-full min-h-0 flex-col">
    <div className="titlebar-drag-region flex h-12 shrink-0 items-center gap-2 border-b px-3">
      <Brain size={14} />
      <span className="min-w-0 flex-1 truncate text-xs font-medium">项目记忆</span>
      <button type="button" title="刷新" aria-label="刷新项目记忆" disabled={loading || saving}
        onClick={() => void loadSummary({ reloadSelected: true }).then((loaded) => {
          if (loaded) setChangeNotice(null)
        })} className="titlebar-no-drag rounded p-1 text-muted-foreground hover:bg-muted hover:text-foreground disabled:opacity-40">
        {loading ? <Loader2 size={13} className="animate-spin" /> : <RefreshCw size={13} />}
      </button>
    </div>
    {error && <p className="border-b px-3 py-2 text-[11px] text-destructive">{error}</p>}
    {watchFailed && <p className="border-b px-3 py-2 text-[11px] text-amber-600">自动刷新不可用，可手动刷新记忆。</p>}
    {changeNotice === 'refreshed' && <p className="border-b px-3 py-2 text-[11px] text-muted-foreground">检测到记忆变化，已自动刷新。</p>}
    {changeNotice === 'conflict' && <div className="flex items-center gap-2 border-b px-3 py-2 text-[11px] text-amber-600">
      <span className="min-w-0 flex-1">磁盘上的记忆已变化，当前草稿尚未覆盖。</span>
      <button type="button" className="shrink-0 underline" onClick={() => void loadSummary({ reloadSelected: true }).then((loaded) => {
        if (loaded) setChangeNotice(null)
      })}>重新加载</button>
    </div>}
    <div className="max-h-40 shrink-0 overflow-auto border-b p-2 text-xs">
      {!loading && summary?.files.length === 0
        ? <div className="space-y-2 px-1 py-2 text-muted-foreground">
            <p>尚未建立项目记忆。</p>
            <button type="button" disabled={saving} onClick={() => void createIndex()}
              className="flex h-8 items-center gap-1.5 rounded-md border px-2 text-xs hover:bg-muted disabled:opacity-40">
              <FilePlus2 size={13} />新建 MEMORY.md
            </button>
          </div>
        : summary?.files.map((file) => <button type="button" key={file.relativePath}
            aria-label={`打开记忆 ${file.relativePath}`} onClick={() => selectFile(file.relativePath)}
            className={`flex w-full items-center gap-1.5 rounded px-2 py-1.5 text-left hover:bg-muted ${selectedPath === file.relativePath ? 'bg-muted' : ''}`}>
            <FileText size={12} className="shrink-0 text-muted-foreground" />
            <span className="truncate" title={file.relativePath}>{file.relativePath}</span>
          </button>)}
    </div>
    <div className="flex min-h-0 flex-1 flex-col bg-background">
      <div className="flex h-9 shrink-0 items-center gap-2 border-b px-3">
        <span className="min-w-0 flex-1 truncate text-[11px] font-medium">{selectedPath ?? '选择记忆文件'}</span>
        {dirty && <span className="text-[10px] text-amber-600">未保存</span>}
        <button type="button" title="保存" aria-label="保存记忆文件" disabled={!selectedPath || !dirty || saving || fileLoading}
          onClick={() => void save()} className="rounded p-1 text-muted-foreground hover:bg-muted hover:text-foreground disabled:opacity-30">
          {saving ? <Loader2 size={13} className="animate-spin" /> : <Save size={13} />}
        </button>
      </div>
      {fileLoading
        ? <div className="flex flex-1 items-center justify-center text-xs text-muted-foreground"><Loader2 size={14} className="animate-spin" /></div>
        : selectedPath
          ? <textarea aria-label="编辑项目记忆" value={content} onChange={(event) => setContent(event.target.value)}
              spellCheck={false} className="min-h-0 flex-1 resize-none bg-transparent p-3 font-mono text-xs leading-5 outline-none" />
          : <div className="flex flex-1 items-center justify-center px-4 text-center text-xs text-muted-foreground">从上方选择记忆文件</div>}
    </div>
  </section>
}
