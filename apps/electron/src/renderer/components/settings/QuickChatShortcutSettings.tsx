import * as React from 'react'
import { Keyboard, Pencil, Plus, Trash2 } from 'lucide-react'
import type { AgentSessionMeta, ConversationMeta } from '@axon/shared'
import type { QuickChatShortcutBinding } from '@/types/settings'

function targetKey(binding: Pick<QuickChatShortcutBinding, 'sessionType' | 'sessionId'>): string {
  return `${binding.sessionType}:${binding.sessionId}`
}

/** 只录制常见且可跨 Electron 平台解析的组合键；系统占用由主进程注册结果判定。 */
function acceleratorFromKey(event: React.KeyboardEvent<HTMLInputElement>): string | null {
  const key = /^Key[A-Z]$/.test(event.code)
    ? event.code.slice(3)
    : /^Digit[0-9]$/.test(event.code)
      ? event.code.slice(5)
      : /^F(?:[1-9]|1[0-9]|2[0-4])$/.test(event.key)
        ? event.key
        : event.key === ' ' ? 'Space' : null
  if (!key || !(event.metaKey || event.ctrlKey || event.altKey)) return null
  return [
    event.metaKey ? 'Command' : null,
    event.ctrlKey ? 'Control' : null,
    event.altKey ? 'Alt' : null,
    event.shiftKey ? 'Shift' : null,
    key,
  ].filter(Boolean).join('+')
}

export function QuickChatShortcutSettings(): React.ReactElement {
  const [bindings, setBindings] = React.useState<QuickChatShortcutBinding[]>([])
  const [chats, setChats] = React.useState<ConversationMeta[]>([])
  const [agents, setAgents] = React.useState<AgentSessionMeta[]>([])
  const [loading, setLoading] = React.useState(true)
  const [saving, setSaving] = React.useState(false)
  const [editingId, setEditingId] = React.useState<string | null>(null)
  const [target, setTarget] = React.useState('')
  const [accelerator, setAccelerator] = React.useState('')
  const [recording, setRecording] = React.useState(false)
  const [message, setMessage] = React.useState('')
  const [error, setError] = React.useState('')

  React.useEffect(() => {
    let canceled = false
    void Promise.all([
      window.axon.settings.get(),
      window.axon.chat.listConversations(),
      window.axon.agent.listSessions(),
    ]).then(([settings, conversations, sessions]) => {
      if (canceled) return
      setBindings(settings.quickChatShortcuts)
      setChats(conversations)
      setAgents(sessions.filter((session) => !session.parentSessionId))
    }).catch(() => { if (!canceled) setError('加载快捷键和会话失败') })
      .finally(() => { if (!canceled) setLoading(false) })
    return () => { canceled = true }
  }, [])

  const targets = React.useMemo(() => [
    ...chats.map((chat) => ({ key: `chat:${chat.id}`, label: `Chat · ${chat.title}` })),
    ...agents.map((agent) => ({ key: `agent:${agent.id}`, label: `Agent · ${agent.title}` })),
  ], [agents, chats])
  const targetLabels = React.useMemo(() => new Map(targets.map((item) => [item.key, item.label])), [targets])
  const staleCount = bindings.filter((binding) => !targetLabels.has(targetKey(binding))).length

  /** 只有主进程完成组合键注册和原子写盘后才更新界面列表。 */
  const persist = async (next: QuickChatShortcutBinding[], success: string): Promise<boolean> => {
    setSaving(true)
    setError('')
    setMessage('')
    try {
      const saved = await window.axon.settings.update({ quickChatShortcuts: next })
      setBindings(saved.quickChatShortcuts)
      setMessage(success)
      return true
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : '保存快捷键失败')
      return false
    } finally {
      setSaving(false)
    }
  }

  const saveBinding = (): void => {
    const selected = targets.find((item) => item.key === target)
    if (!selected || !accelerator) {
      setError('请选择会话并录制组合键')
      return
    }
    const sessionType = target.startsWith('chat:') ? 'chat' : 'agent'
    const nextBinding: QuickChatShortcutBinding = {
      id: editingId ?? window.crypto.randomUUID(),
      accelerator,
      sessionType,
      sessionId: target.slice(sessionType.length + 1),
    }
    const next = editingId
      ? bindings.map((binding) => binding.id === editingId ? nextBinding : binding)
      : [...bindings, nextBinding]
    void persist(next, editingId ? '快捷键已更新' : '快捷键已添加').then((saved) => {
      // 保存失败时保留表单，方便用户换一个未被占用的组合键。
      if (saved) {
        setEditingId(null)
        setTarget('')
        setAccelerator('')
      }
    })
  }

  const editBinding = (binding: QuickChatShortcutBinding): void => {
    setEditingId(binding.id)
    setTarget(targetKey(binding))
    setAccelerator(binding.accelerator)
    setError('')
    setMessage('')
  }

  const recordKey = (event: React.KeyboardEvent<HTMLInputElement>): void => {
    event.preventDefault()
    event.stopPropagation()
    if (event.key === 'Escape') {
      event.currentTarget.blur()
      return
    }
    const recorded = acceleratorFromKey(event)
    if (!recorded) return
    setAccelerator(recorded)
    event.currentTarget.blur()
  }

  return <section>
    <h1 className="text-xl font-semibold">快捷键</h1>
    <p className="mt-1 text-sm text-muted-foreground">为现有会话绑定多个全局组合键；按键会打开该会话的快捷输入与回复窗口。</p>

    <div className="mt-6 rounded-xl border bg-card p-4 shadow-sm">
      <div className="flex items-center gap-2 text-sm font-medium"><Keyboard size={16} />快捷唤起对话</div>
      {loading ? <p className="mt-4 text-xs text-muted-foreground">正在加载…</p> : <>
        <div className="mt-4 space-y-2">
          {bindings.length === 0 && <p className="text-xs text-muted-foreground">尚未绑定快捷键。</p>}
          {bindings.map((binding) => {
            const label = targetLabels.get(targetKey(binding))
            return <div key={binding.id} className="flex items-center gap-3 rounded-lg border px-3 py-2 text-xs">
              <kbd className="shrink-0 rounded bg-muted px-2 py-1 font-mono">{binding.accelerator}</kbd>
              <span className={`min-w-0 flex-1 truncate ${label ? '' : 'text-destructive'}`}>{label ?? '会话已删除 · 绑定失效'}</span>
              <button type="button" aria-label={`编辑 ${binding.accelerator}`} disabled={saving || !label} onClick={() => editBinding(binding)} className="text-muted-foreground hover:text-foreground disabled:opacity-40"><Pencil size={14} /></button>
              <button type="button" aria-label={`移除 ${binding.accelerator}`} disabled={saving} onClick={() => void persist(bindings.filter((item) => item.id !== binding.id), '快捷键已移除')} className="text-muted-foreground hover:text-destructive disabled:opacity-40"><Trash2 size={14} /></button>
            </div>
          })}
        </div>
        {staleCount > 0 && <button type="button" disabled={saving} onClick={() => void persist(bindings.filter((binding) => targetLabels.has(targetKey(binding))), '失效绑定已清理')} className="mt-3 text-xs text-destructive underline disabled:opacity-40">清理 {staleCount} 条失效绑定</button>}

        <div className="mt-5 grid gap-3 border-t pt-4 sm:grid-cols-[minmax(0,1fr)_180px_auto] sm:items-end">
          <label className="min-w-0 text-xs text-muted-foreground">目标会话
            <select value={target} onChange={(event) => setTarget(event.target.value)} disabled={saving} className="mt-1 h-9 w-full rounded-md border bg-background px-2 text-sm text-foreground">
              <option value="">选择会话</option>
              {targets.map((item) => <option key={item.key} value={item.key}>{item.label}</option>)}
            </select>
          </label>
          <label className="text-xs text-muted-foreground">组合键
            <input aria-label="录制全局快捷键" readOnly value={recording ? '请按组合键…' : accelerator} onKeyDown={recordKey} onFocus={() => setRecording(true)} onBlur={() => setRecording(false)} placeholder="点击后按组合键" disabled={saving} className="mt-1 h-9 w-full rounded-md border bg-background px-2 text-sm text-foreground" />
          </label>
          <button type="button" disabled={saving || !target || !accelerator} onClick={saveBinding} className="flex h-9 items-center justify-center gap-1 rounded-md bg-primary px-3 text-xs text-primary-foreground disabled:opacity-40"><Plus size={14} />{editingId ? '保存' : '添加'}</button>
        </div>
        {editingId && <button type="button" onClick={() => { setEditingId(null); setTarget(''); setAccelerator('') }} className="mt-2 text-xs text-muted-foreground hover:text-foreground">取消编辑</button>}
        <p className="mt-3 text-xs text-muted-foreground">使用 Command、Control 或 Alt 加字母、数字、功能键；系统占用时不会替换原绑定。</p>
      </>}
    </div>
    {error && <p role="alert" className="mt-3 text-xs text-destructive">{error}</p>}
    {message && <p role="status" className="mt-3 text-xs text-muted-foreground">{message}</p>}
  </section>
}
