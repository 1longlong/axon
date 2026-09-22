import * as React from 'react'
import { Bot, Check, Pencil, X } from 'lucide-react'
import { MAX_AGENT_SESSION_TITLE_LENGTH } from '@axon/shared'
import type { AgentProject, AgentSessionMeta } from '@axon/shared'
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

  return <header className="titlebar-drag-region flex shrink-0 items-center gap-2 border-b px-4 py-2">
    <Bot size={17} className="shrink-0" />
    <div className="titlebar-no-drag min-w-0 flex-1">
      {editing ? <div className="flex items-center gap-1">
        <input
          autoFocus
          value={title}
          maxLength={MAX_AGENT_SESSION_TITLE_LENGTH}
          disabled={busy}
          onChange={(event) => setTitle(event.target.value)}
          onKeyDown={(event) => {
            if (event.key === 'Enter') void save()
            if (event.key === 'Escape') { setTitle(session.title); setEditing(false) }
          }}
          className="h-7 min-w-0 max-w-sm flex-1 rounded-md border bg-background px-2 text-sm outline-none focus:ring-1 focus:ring-ring"
        />
        <button type="button" aria-label="保存标题" disabled={busy} onClick={() => void save()} className="rounded p-1 text-muted-foreground hover:bg-muted hover:text-foreground">
          <Check size={14} />
        </button>
        <button type="button" aria-label="取消编辑" disabled={busy} onClick={() => { setTitle(session.title); setEditing(false) }} className="rounded p-1 text-muted-foreground hover:bg-muted hover:text-foreground">
          <X size={14} />
        </button>
      </div> : <div className="flex min-w-0 items-center gap-1">
        <p className="truncate text-sm font-medium">{session.title}</p>
        <button type="button" aria-label="编辑 Agent 会话标题" onClick={() => setEditing(true)} className="rounded p-1 text-muted-foreground hover:bg-muted hover:text-foreground">
          <Pencil size={13} />
        </button>
      </div>}
      <p className="truncate text-[11px] text-muted-foreground">
        {project?.name ?? '项目不可用'} · {session.modelId ?? '未选择模型'}
      </p>
      {error && <p className="text-[11px] text-destructive">{error}</p>}
    </div>
  </header>
}
