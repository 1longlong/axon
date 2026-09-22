import * as React from 'react'
import { Brain, FolderOpen, MoreHorizontal, Pencil, Plug, Plus, RotateCcw, Trash2 } from 'lucide-react'
import type { AgentProject, AgentProjectWorkspaceInput } from '@axon/shared'
import { useAgentController } from './AgentStateProvider'
import { McpProjectDialog } from './McpProjectDialog'

interface CommonProps {
  disabled?: boolean
  onError(message: string | null): void
}

/** 点击详情菜单外部或按 Escape 时关闭，避免原生 details 弹层滞留。 */
function useDismissibleDetails(ref: React.RefObject<HTMLDetailsElement>): void {
  React.useEffect(() => {
    const closeOutside = (event: PointerEvent): void => {
      if (ref.current?.open && !ref.current.contains(event.target as Node)) ref.current.open = false
    }
    const closeOnEscape = (event: KeyboardEvent): void => {
      if (event.key === 'Escape' && ref.current?.open) ref.current.open = false
    }
    document.addEventListener('pointerdown', closeOutside)
    document.addEventListener('keydown', closeOnEscape)
    return () => {
      document.removeEventListener('pointerdown', closeOutside)
      document.removeEventListener('keydown', closeOnEscape)
    }
  }, [ref])
}

/** 左侧栏的新建入口；名称和可选工作区在同一对话框内一次确认。 */
export function ProjectCreateActions({ disabled = false, onError }: CommonProps): React.ReactElement {
  const controller = useAgentController()
  const [open, setOpen] = React.useState(false)
  const [busy, setBusy] = React.useState(false)

  const chooseLocal = async (): Promise<{ path: string; suggestedName: string } | null> => {
    if (busy) return null
    setBusy(true)
    onError(null)
    try {
      const selection = await controller.pickLocalWorkspace()
      return !selection || selection.canceled ? null : selection
    } catch {
      onError('选择本地工作区失败')
      return null
    } finally {
      setBusy(false)
    }
  }

  const submit = async (name: string, workspace: AgentProjectWorkspaceInput): Promise<void> => {
    if (busy) return
    setBusy(true)
    onError(null)
    try {
      await controller.createProject({ name, workspace })
      setOpen(false)
    } catch {
      onError('创建项目失败，请检查名称是否重复或目录是否可用')
    } finally {
      setBusy(false)
    }
  }

  return <>
    <button type="button" aria-label="新建 Agent 项目" disabled={disabled || busy} onClick={() => {
      onError(null)
      setOpen(true)
    }} className="mt-3 flex h-9 w-full items-center justify-center gap-2 rounded-lg border border-dashed text-sm text-muted-foreground transition-colors hover:bg-muted hover:text-foreground disabled:opacity-40">
      <Plus size={15} />{busy ? '正在处理…' : '新建项目'}
    </button>
    {open && <ProjectCreateDialog busy={busy} onCancel={() => setOpen(false)} onChooseLocal={chooseLocal} onSubmit={submit} />}
  </>
}

/** 项目节点菜单集中承载名称、唯一工作区、MCP 与记忆开关，不修改会话级字段。 */
export function ProjectActions({ project, sessionCount, disabled = false, onError }: CommonProps & {
  project: AgentProject
  sessionCount: number
}): React.ReactElement {
  const controller = useAgentController()
  const menuRef = React.useRef<HTMLDetailsElement>(null)
  const [busy, setBusy] = React.useState(false)
  const [renaming, setRenaming] = React.useState(false)
  const [editingMcp, setEditingMcp] = React.useState(false)
  useDismissibleDetails(menuRef)

  /** 项目更新统一控制忙碌态，并返回成功与否供对话框决定是否关闭。 */
  const perform = React.useCallback(async (action: () => Promise<void>): Promise<boolean> => {
    if (busy) return false
    setBusy(true)
    onError(null)
    try {
      await action()
      return true
    } catch {
      onError('项目操作失败，请检查目录是否可用')
      return false
    } finally {
      setBusy(false)
      menuRef.current?.removeAttribute('open')
    }
  }, [busy, onError])

  const chooseLocal = (): void => {
    void perform(async () => {
      const selection = await controller.pickLocalWorkspace()
      if (!selection || selection.canceled) return
      await controller.updateProject(project.id, { workspace: { kind: 'local', path: selection.path } })
    })
  }

  const submitRename = async (name: string): Promise<void> => {
    const saved = await perform(async () => { await controller.updateProject(project.id, { name }) })
    if (saved) setRenaming(false)
  }

  const deleteProject = (): void => {
    if (sessionCount > 0 || !window.confirm(`删除项目“${project.name}”？应用管理的默认目录也会被删除。`)) return
    void perform(async () => { await controller.deleteProject(project.id) })
  }

  return <>
    <details ref={menuRef} className="relative shrink-0">
      <summary aria-label={`管理项目 ${project.name}`} title="管理项目"
        className="flex size-7 cursor-pointer list-none items-center justify-center rounded text-muted-foreground hover:bg-background hover:text-foreground [&::-webkit-details-marker]:hidden">
        <MoreHorizontal size={14} />
      </summary>
      <div className="absolute right-0 top-7 z-30 w-48 rounded-md border bg-popover p-1 text-popover-foreground shadow-md">
        <MenuAction disabled={disabled || busy} onClick={() => {
          menuRef.current?.removeAttribute('open')
          setRenaming(true)
        }}><Pencil size={13} />重命名项目</MenuAction>
        <MenuAction disabled={disabled || busy} onClick={chooseLocal}>
          <FolderOpen size={13} />选择本地工作区
        </MenuAction>
        <MenuAction disabled={disabled || busy} onClick={() => {
          menuRef.current?.removeAttribute('open')
          setEditingMcp(true)
        }}><Plug size={13} />MCP 服务</MenuAction>
        <MenuAction disabled={disabled || busy} onClick={() => {
          void perform(async () => {
            await controller.updateProject(project.id, { memoryEnabled: !project.memoryEnabled })
          })
        }}><Brain size={13} />{project.memoryEnabled ? '关闭项目记忆' : '启用项目记忆'}</MenuAction>
        <MenuAction disabled={disabled || busy || project.workspace.kind === 'managed'} onClick={() => {
          void perform(async () => { await controller.updateProject(project.id, { workspace: { kind: 'managed' } }) })
        }}><RotateCcw size={13} />恢复默认目录</MenuAction>
        <div className="my-1 border-t" />
        <MenuAction disabled={disabled || busy || sessionCount > 0} danger onClick={deleteProject}>
          <Trash2 size={13} />{sessionCount > 0 ? '有会话，无法删除' : '删除项目'}
        </MenuAction>
      </div>
    </details>
    {renaming && <ProjectNameDialog initialName={project.name} busy={busy} onCancel={() => setRenaming(false)} onSubmit={(name) => void submitRename(name)} />}
    {editingMcp && <McpProjectDialog projectId={project.id} projectName={project.name}
      onClose={() => setEditingMcp(false)} />}
  </>
}

function ProjectCreateDialog({ busy, onCancel, onChooseLocal, onSubmit }: {
  busy: boolean
  onCancel(): void
  onChooseLocal(): Promise<{ path: string; suggestedName: string } | null>
  onSubmit(name: string, workspace: AgentProjectWorkspaceInput): void
}): React.ReactElement {
  const [name, setName] = React.useState('')
  const [workspace, setWorkspace] = React.useState<AgentProjectWorkspaceInput>({ kind: 'managed' })

  /** 本地目录选中后回填工作区；名称为空时才采用目录名，保留用户已输入内容。 */
  const chooseLocal = async (): Promise<void> => {
    const selection = await onChooseLocal()
    if (!selection) return
    setWorkspace({ kind: 'local', path: selection.path })
    setName((current) => current.trim() ? current : selection.suggestedName)
  }

  const workspaceDescription = workspace.kind === 'local'
    ? workspace.path
    : '未选择本地文件夹，将使用默认目录'

  return <div role="dialog" aria-modal="true" aria-label="创建项目" className="fixed inset-0 z-50 flex items-center justify-center bg-black/35 p-4">
    <form className="w-full max-w-sm rounded-lg border bg-background p-4 shadow-xl" onSubmit={(event) => {
      event.preventDefault()
      const normalized = name.trim()
      if (normalized && !busy) onSubmit(normalized, workspace)
    }}>
      <h2 className="text-sm font-medium">创建项目</h2>
      <p className="mt-1 text-xs text-muted-foreground">项目下的所有会话共享同一个工作区。</p>
      <label className="mt-4 block text-xs text-muted-foreground">项目名称</label>
      <input autoFocus aria-label="项目名称" value={name} disabled={busy} maxLength={100}
        onChange={(event) => setName(event.target.value)}
        className="mt-1 h-9 w-full rounded-md border bg-background px-3 text-sm outline-none focus:ring-1 focus:ring-ring" />
      <span className="mt-4 block text-xs text-muted-foreground">本地工作区（可选）</span>
      <div className="mt-1 flex gap-2">
        <button type="button" disabled={busy} onClick={() => void chooseLocal()}
          className={`h-8 flex-1 rounded-md border px-3 text-xs hover:bg-muted disabled:opacity-40 ${workspace.kind === 'local' ? 'border-primary bg-muted text-foreground' : ''}`}>
          选择本地文件夹
        </button>
        {workspace.kind === 'local' && <button type="button" disabled={busy} onClick={() => setWorkspace({ kind: 'managed' })}
          className="h-8 rounded-md border px-3 text-xs hover:bg-muted disabled:opacity-40">取消选择</button>}
      </div>
      <p className="mt-2 truncate text-[11px] text-muted-foreground" title={workspaceDescription}>{workspaceDescription}</p>
      <div className="mt-4 flex justify-end gap-2">
        <button type="button" disabled={busy} onClick={onCancel} className="h-8 rounded-md border px-3 text-xs hover:bg-muted disabled:opacity-40">取消</button>
        <button type="submit" disabled={busy || !name.trim()} className="h-8 rounded-md bg-primary px-3 text-xs text-primary-foreground disabled:opacity-40">创建</button>
      </div>
    </form>
  </div>
}

function ProjectNameDialog({ initialName, busy, onCancel, onSubmit }: {
  initialName: string
  busy: boolean
  onCancel(): void
  onSubmit(name: string): void
}): React.ReactElement {
  const [name, setName] = React.useState(initialName)
  return <div role="dialog" aria-modal="true" aria-label="重命名项目" className="fixed inset-0 z-50 flex items-center justify-center bg-black/35 p-4">
    <form className="w-full max-w-sm rounded-lg border bg-background p-4 shadow-xl" onSubmit={(event) => {
      event.preventDefault()
      const normalized = name.trim()
      if (normalized && !busy) onSubmit(normalized)
    }}>
      <h2 className="text-sm font-medium">重命名项目</h2>
      <input autoFocus aria-label="项目名称" value={name} disabled={busy} maxLength={100}
        onChange={(event) => setName(event.target.value)}
        className="mt-4 h-9 w-full rounded-md border bg-background px-3 text-sm outline-none focus:ring-1 focus:ring-ring" />
      <div className="mt-4 flex justify-end gap-2">
        <button type="button" disabled={busy} onClick={onCancel} className="h-8 rounded-md border px-3 text-xs hover:bg-muted disabled:opacity-40">取消</button>
        <button type="submit" disabled={busy || !name.trim()} className="h-8 rounded-md bg-primary px-3 text-xs text-primary-foreground disabled:opacity-40">保存</button>
      </div>
    </form>
  </div>
}

function MenuAction({ children, disabled, danger = false, onClick }: {
  children: React.ReactNode
  disabled: boolean
  danger?: boolean
  onClick(): void
}): React.ReactElement {
  return <button type="button" disabled={disabled} onClick={onClick}
    className={`flex w-full items-center gap-2 rounded-sm px-2 py-1.5 text-left text-xs hover:bg-muted disabled:opacity-40 ${danger ? 'text-destructive' : ''}`}>
    {children}
  </button>
}
