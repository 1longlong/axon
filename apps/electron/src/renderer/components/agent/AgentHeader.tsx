import * as React from 'react'
import { Check, Pencil, X } from 'lucide-react'
import { MAX_AGENT_SESSION_TITLE_LENGTH } from '@axon/shared'
import type { AgentProject, AgentSessionMeta } from '@axon/shared'
import { AgentSessionIcon } from '@/components/icons/WorkbenchIcons'
import { useAgentController } from './AgentStateProvider'

/** Agent 顶栏编辑会话元数据；保存后 controller 会同步左侧项目树的会话快照。 */
export function AgentHeader({
  session,
  project,
}: {
  session: AgentSessionMeta
  project?: AgentProject
}): React.ReactElement {
  const controller = useAgentController()
  const [editing, setEditing] = React.useState(false)
  const [title, setTitle] = React.useState(session.title)
  const [busy, setBusy] = React.useState(false)
  const [error, setError] = React.useState<string | null>(null)

  React.useEffect(() => {
    if (!editing) setTitle(session.title)
  }, [editing, session.title])

  const save = React.useCallback(async () => {
    const normalized = title.trim()
    if (!normalized || normalized === session.title) {
      setTitle(session.title)
      setEditing(false)
      return
    }
    setBusy(true)
    setError(null)
    try {
      await controller.updateSession(session.id, { title: normalized })
      setEditing(false)
    } catch {
      setError('更新标题失败')
    } finally {
      setBusy(false)
    }
  }, [controller, session.id, session.title, title])

  return <header className="titlebar-drag-region flex min-h-11 shrink-0 items-center gap-2 border-b border-border-subtle bg-[hsl(var(--content-area))] px-5 py-2">
    <AgentSessionIcon size={14} className="shrink-0 text-muted-foreground" />
    <div className="titlebar-no-drag min-w-0 flex-1">
      <div className="flex min-w-0 items-center gap-2">
        {editing ? <div className="flex min-w-0 flex-1 items-center gap-1">
          <input
            autoFocus
            aria-label="Agent 会话标题"
            value={title}
            maxLength={MAX_AGENT_SESSION_TITLE_LENGTH}
            disabled={busy}
            onChange={(event) => setTitle(event.target.value)}
            onKeyDown={(event) => {
              if (event.key === 'Enter') void save()
              if (event.key === 'Escape') { setTitle(session.title); setEditing(false) }
            }}
            className="h-7 min-w-0 flex-1 rounded border bg-background px-2 text-xs outline-none focus:ring-1 focus:ring-ring"
          />
          <button type="button" aria-label="保存标题" disabled={busy} onClick={() => void save()} className="flex size-6 shrink-0 items-center justify-center rounded text-muted-foreground hover:bg-muted hover:text-foreground focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-ring disabled:opacity-40">
            <Check size={12} />
          </button>
          <button type="button" aria-label="取消编辑" disabled={busy} onClick={() => { setTitle(session.title); setEditing(false) }} className="flex size-6 shrink-0 items-center justify-center rounded text-muted-foreground hover:bg-muted hover:text-foreground focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-ring disabled:opacity-40">
            <X size={12} />
          </button>
        </div> : <div className="group/title flex min-w-0 max-w-[50%] items-center gap-1">
          <p className="truncate text-xs font-semibold" title={session.title}>{session.title}</p>
          <button type="button" aria-label="编辑 Agent 会话标题" onClick={() => setEditing(true)} className="flex size-6 shrink-0 items-center justify-center rounded text-muted-foreground opacity-0 hover:bg-muted hover:text-foreground group-hover/title:opacity-100 group-focus-within/title:opacity-100 focus-visible:opacity-100 focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-ring">
            <Pencil size={12} />
          </button>
        </div>}
        <span aria-hidden="true" className="shrink-0 text-xs text-muted-foreground/50">/</span>
        <span className="min-w-0 flex-1 truncate font-mono text-[11px] text-muted-foreground" title={session.modelId ?? '未选择模型'}>{session.modelId ?? '未选择模型'}</span>
        <span className="min-w-0 max-w-[25%] truncate text-[11px] text-muted-foreground" title={project?.name ?? '项目不可用'}>{project?.name ?? '项目不可用'}</span>
      </div>
      {error && <p role="alert" className="mt-1 break-words text-[11px] text-destructive">{error}</p>}
    </div>
  </header>
}
