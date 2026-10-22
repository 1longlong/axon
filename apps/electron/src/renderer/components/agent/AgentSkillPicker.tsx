import * as React from 'react'
import { Dialog } from '@base-ui/react/dialog'
import { Loader2, Sparkles, X } from 'lucide-react'
import type { AgentSkillChoice } from '@axon/shared'

const SOURCE_LABELS: Record<AgentSkillChoice['directoryKind'], string> = { axon: '项目 .axon', agents: '项目 .agents', builtin: 'Axon 管理', user: '用户全局' }

/** 仅选择后端发现的 Skill；文本直接粘贴到输入框，不要求手工填写来源。 */
export function AgentSkillPicker({ sessionId, disabled, open, onOpenChange, onSkill, onOpen, onClose }: {
  sessionId: string
  disabled: boolean
  open: boolean
  onOpenChange(open: boolean): void
  onSkill(skill: AgentSkillChoice): Promise<void>
  onOpen?: () => void
  onClose?: () => void
}): React.ReactElement {
  const searchRef = React.useRef<HTMLInputElement>(null)
  const listId = React.useId()
  const [skills, setSkills] = React.useState<AgentSkillChoice[]>([])
  const [loading, setLoading] = React.useState(false)
  const [error, setError] = React.useState<string>()
  const [saving, setSaving] = React.useState(false)
  const [query, setQuery] = React.useState('')
  const [activeSource, setActiveSource] = React.useState<string>()
  const [revision, refresh] = React.useReducer((value: number) => value + 1, 0)
  React.useEffect(() => {
    if (!open) return
    let active = true
    setLoading(true); setError(undefined); setSkills([])
    void window.axon.agent.attachmentCommand({ action: 'listSkills', sessionId }).then((result) => {
      if (!result || typeof result !== 'object' || !('skills' in result) || !Array.isArray(result.skills)) throw new Error('Skills 响应无效')
      if (active) setSkills(result.skills)
    }).catch(() => { if (active) setError('读取 Skills 失败，请刷新后重试') }).finally(() => { if (active) setLoading(false) })
    return () => { active = false }
  }, [sessionId, open, revision])
  React.useEffect(() => { if (disabled && !saving) onOpenChange(false) }, [disabled, saving, onOpenChange])

  /** 选择只插入本地胶囊；实际来源复核和正文加载仍在发送链路的后端进行。 */
  const add = async (skill: AgentSkillChoice): Promise<void> => {
    setSaving(true); setError(undefined)
    try { await onSkill(skill); onOpenChange(false) }
    catch { setError('添加 Skill 失败，请刷新后重新选择') }
    finally { setSaving(false) }
  }
  const filtered = skills.filter((skill) => `${skill.name} ${skill.description}`.toLowerCase().includes(query.toLowerCase()))
  const activeIndex = Math.max(0, filtered.findIndex((skill) => skill.sourceId === activeSource))
  React.useEffect(() => {
    if (open) document.getElementById(`${listId}-${activeIndex}`)?.scrollIntoView({ block: 'nearest' })
  }, [open, activeIndex, listId, query])
  return <Dialog.Root open={open} onOpenChangeComplete={(value) => { if (!value) onClose?.() }} onOpenChange={(value) => { if (!saving) { if (value) onOpen?.(); onOpenChange(value) } }}>
    <Dialog.Trigger disabled={disabled} aria-label="添加 Skill" title="添加 Skill"
      className="rounded p-1 text-muted-foreground hover:bg-muted/60 hover:text-foreground disabled:opacity-40"><Sparkles size={14} /></Dialog.Trigger>
    <Dialog.Portal>
      <Dialog.Backdrop className="fixed inset-0 z-[120] bg-black/35" />
      <Dialog.Popup initialFocus={searchRef} data-agent-context-dialog className="fixed left-1/2 top-1/2 z-[121] flex max-h-[80vh] w-[min(90vw,36rem)] -translate-x-1/2 -translate-y-1/2 flex-col rounded-xl border bg-background p-4 shadow-lg outline-none">
        <div className="flex items-center justify-between gap-3"><Dialog.Title className="text-sm font-medium">选择 Skill</Dialog.Title><Dialog.Close disabled={saving} aria-label="关闭 Skill 选择" className="rounded p-1 hover:bg-muted"><X size={16} /></Dialog.Close></div>
        <Dialog.Description className="mt-1 text-xs text-muted-foreground">仅添加到当前草稿，不会发送消息或授予工具权限。</Dialog.Description>
        <div className="my-3 flex gap-2"><input ref={searchRef} value={query} disabled={saving}
          onChange={(event) => { setQuery(event.target.value); setActiveSource(undefined) }}
          role="combobox" aria-expanded aria-controls={listId} aria-activedescendant={filtered.length ? `${listId}-${activeIndex}` : undefined}
          onKeyDown={(event) => {
            if (event.nativeEvent.isComposing || event.keyCode === 229 || saving || !filtered.length) return
            if (event.key === 'ArrowDown' || event.key === 'ArrowUp') {
              event.preventDefault()
              const index = (activeIndex + (event.key === 'ArrowDown' ? 1 : -1) + filtered.length) % filtered.length
              setActiveSource(filtered[index]!.sourceId)
            } else if (event.key === 'Enter') { event.preventDefault(); void add(filtered[activeIndex]!) }
          }} aria-label="搜索 Skills" placeholder="搜索名称或描述" className="min-w-0 flex-1 rounded-md border bg-background px-2 py-1.5 text-xs" /><button type="button" disabled={saving || loading} onClick={refresh} className="rounded-md border px-2 text-xs hover:bg-muted disabled:opacity-40">刷新</button></div>
        <div id={listId} role="listbox" aria-label="可用 Skills" className="min-h-24 overflow-y-auto">{loading ? <div className="flex items-center gap-2 py-4 text-xs text-muted-foreground"><Loader2 size={14} className="animate-spin" />正在读取 Skills…</div>
          : filtered.length ? filtered.map((skill, index) => <button key={skill.sourceId} id={`${listId}-${index}`} role="option" aria-selected={index === activeIndex} type="button" disabled={saving}
            onMouseEnter={() => setActiveSource(skill.sourceId)} onClick={() => void add(skill)} className={`mb-1 block w-full rounded-md border p-3 text-left hover:bg-muted/40 disabled:opacity-40 ${index === activeIndex ? 'bg-muted/40' : ''}`}><span className="flex items-center justify-between gap-3 text-xs"><span className="font-mono font-medium">{skill.name}</span><span className="text-muted-foreground">{SOURCE_LABELS[skill.directoryKind]}</span></span><span className="mt-1 block text-xs text-muted-foreground">{skill.description}</span><span className="mt-1 block truncate font-mono text-[10px] text-muted-foreground">{skill.relativeInstructionPath}</span></button>)
            : <p className="py-4 text-xs text-muted-foreground">没有可供选择的 Skill。可将其放入项目或用户 Skills 目录。</p>}</div>
        {error && <p role="alert" className="mt-2 text-xs text-destructive">{error}</p>}
      </Dialog.Popup>
    </Dialog.Portal>
  </Dialog.Root>
}
