import * as React from 'react'
import { useAtom } from 'jotai'
import { Trash2 } from 'lucide-react'
import type { SystemPromptTemplate } from '@/types/settings'
import {
  agentSystemPromptAtom,
  agentSystemPromptTemplatesAtom,
  updateAgentSystemPrompt,
  updateAgentSystemPromptTemplates,
} from '@/atoms/system-prompt'
import { BUILTIN_SYSTEM_PROMPT_TEMPLATES } from '@/lib/system-prompt-templates'
import { AgentSkillSettings } from './AgentSkillSettings'

const DEFAULT_ENABLED = true

/** Agent 全局设置页；归因开关直接持久化，后续运行会从主进程读取最新值。 */
export function AgentSettings(): React.ReactElement {
  const [enabled, setEnabled] = React.useState(DEFAULT_ENABLED)
  const [loading, setLoading] = React.useState(true)
  const [saving, setSaving] = React.useState(false)
  const [message, setMessage] = React.useState<string | null>(null)
  const [appliedPrompt, setAppliedPrompt] = useAtom(agentSystemPromptAtom)
  const [customTemplates, setCustomTemplates] = useAtom(agentSystemPromptTemplatesAtom)
  const [promptDraft, setPromptDraft] = React.useState(appliedPrompt)
  const [promptTouched, setPromptTouched] = React.useState(false)
  const [promptSaving, setPromptSaving] = React.useState(false)
  const [newTemplateName, setNewTemplateName] = React.useState('')
  const templates = React.useMemo(
    () => [...BUILTIN_SYSTEM_PROMPT_TEMPLATES, ...customTemplates],
    [customTemplates],
  )
  const appliedTemplate = templates.find((template) => template.content === appliedPrompt)
  const selectedTemplateId = templates.find((template) => template.content === promptDraft)?.id
    ?? (promptDraft ? '__draft__' : '')

  React.useEffect(() => {
    if (!promptTouched) setPromptDraft(appliedPrompt)
  }, [appliedPrompt, promptTouched])

  React.useEffect(() => {
    let cancelled = false
    void window.axon.settings.get()
      .then((settings) => {
        if (!cancelled) setEnabled(settings.gitAttributionEnabled)
      })
      .catch(() => { if (!cancelled) setMessage('读取 Agent 设置失败') })
      .finally(() => { if (!cancelled) setLoading(false) })
    return () => { cancelled = true }
  }, [])

  /** 乐观更新开关；写盘失败时回滚，避免界面状态与实际 system prompt 不一致。 */
  const changeAttribution = async (next: boolean): Promise<void> => {
    const previous = enabled
    setEnabled(next)
    setSaving(true)
    setMessage(null)
    try {
      await window.axon.settings.update({ gitAttributionEnabled: next })
      setMessage('Agent 设置已保存')
    } catch {
      setEnabled(previous)
      setMessage('保存 Agent 设置失败')
    } finally {
      setSaving(false)
    }
  }

  /** 只有显式“应用”才替换 Agent 当前提示词；预设选择只更新本页草稿。 */
  const applyPrompt = async (): Promise<void> => {
    const normalized = promptDraft.trim()
    setPromptSaving(true)
    setMessage(null)
    try {
      await updateAgentSystemPrompt(normalized)
      setAppliedPrompt(normalized)
      setPromptDraft(normalized)
      setPromptTouched(false)
      setMessage(normalized ? 'Agent 系统提示词已应用' : 'Agent 系统提示词已清空')
    } catch {
      setMessage('应用 Agent 系统提示词失败')
    } finally {
      setPromptSaving(false)
    }
  }

  const saveCustomTemplate = async (): Promise<void> => {
    const name = newTemplateName.trim()
    const content = promptDraft.trim()
    if (!name || !content) {
      setMessage('请输入预设名称，并填写提示词内容')
      return
    }
    const next: SystemPromptTemplate[] = [
      ...customTemplates,
      { id: `custom-${crypto.randomUUID()}`, name, content },
    ]
    try {
      await updateAgentSystemPromptTemplates(next)
      setCustomTemplates(next)
      setPromptDraft(content)
      setNewTemplateName('')
      setMessage('新预设已保存；点击应用后才会用于 Agent')
    } catch {
      setMessage('预设保存失败')
    }
  }

  const deleteCustomTemplate = async (id: string): Promise<void> => {
    const next = customTemplates.filter((template) => template.id !== id)
    try {
      await updateAgentSystemPromptTemplates(next)
      setCustomTemplates(next)
      setMessage('预设已删除；当前生效提示词未变')
    } catch {
      setMessage('预设删除失败')
    }
  }

  return <section>
    <h1 className="text-xl font-semibold">Agent 设置</h1>
    <p className="mt-1 text-sm text-muted-foreground">配置所有项目共享的 Agent 行为。</p>
    <div className="mt-6 rounded-xl border bg-card p-4 shadow-sm">
      <div className="flex items-center justify-between gap-6">
        <div>
          <p className="text-sm font-medium">Git / PR 标识</p>
          <p className="mt-1 text-xs leading-5 text-muted-foreground">
            Agent 创建 commit 或 PR/MR 时附加 Axon 标识；不会修改 Git 作者，也不会添加共同作者。
          </p>
        </div>
        <button
          type="button"
          role="switch"
          aria-checked={enabled}
          aria-label="Git / PR 标识"
          disabled={loading || saving}
          onClick={() => void changeAttribution(!enabled)}
          className={`relative h-6 w-11 shrink-0 rounded-full transition-colors disabled:opacity-50 ${enabled ? 'bg-primary' : 'bg-muted'}`}
        >
          <span className={`absolute left-1 top-1 size-4 rounded-full bg-background shadow transition-transform ${enabled ? 'translate-x-5' : 'translate-x-0'}`} />
        </button>
      </div>
    </div>
    <div className="mt-6 rounded-xl border bg-card p-4 shadow-sm">
      <div className="flex items-start justify-between gap-4">
        <div>
          <h2 className="text-sm font-medium">Agent 系统提示词</h2>
          <p className="mt-1 text-xs text-muted-foreground">只影响之后的 Agent 请求，Chat 不使用。</p>
        </div>
        <span className="shrink-0 rounded-full bg-muted px-3 py-1 text-xs text-muted-foreground">
          当前：{appliedPrompt ? appliedTemplate?.name ?? '自定义内容' : '空白'}
        </span>
      </div>
      <div className="mt-3 flex items-center gap-2">
        <select
          value={selectedTemplateId}
          onChange={(event) => {
            const id = event.target.value
            if (!id) setPromptDraft('')
            else {
              const template = templates.find((item) => item.id === id)
              if (template) setPromptDraft(template.content)
            }
            setPromptTouched(true)
            setMessage(null)
          }}
          className="h-9 min-w-0 flex-1 rounded-md border bg-background px-2 text-sm outline-none focus:ring-1 focus:ring-ring"
          aria-label="Agent 系统提示词预设"
        >
          <option value="">空白</option>
          {selectedTemplateId === '__draft__' && <option value="__draft__">当前编辑内容</option>}
          <optgroup label="内置预设">
            {BUILTIN_SYSTEM_PROMPT_TEMPLATES.map((template) => (
              <option key={template.id} value={template.id}>{template.name}</option>
            ))}
          </optgroup>
          {customTemplates.length > 0 && (
            <optgroup label="我的预设">
              {customTemplates.map((template) => (
                <option key={template.id} value={template.id}>{template.name}</option>
              ))}
            </optgroup>
          )}
        </select>
        {customTemplates.some((template) => template.id === selectedTemplateId) && (
          <button
            type="button"
            onClick={() => void deleteCustomTemplate(selectedTemplateId)}
            className="flex h-9 w-9 shrink-0 items-center justify-center rounded-md border text-muted-foreground hover:bg-muted hover:text-foreground"
            title="删除当前预设"
            aria-label="删除当前预设"
          >
            <Trash2 size={15} />
          </button>
        )}
      </div>
      <textarea
        value={promptDraft}
        onChange={(event) => {
          setPromptDraft(event.target.value)
          setPromptTouched(true)
        }}
        className="mt-3 h-72 w-full resize-y rounded-md border bg-background p-3 font-mono text-xs leading-5 outline-none focus:ring-1 focus:ring-ring"
        placeholder="当前为空白，不向 Agent 添加用户系统提示词。"
        aria-label="Agent 系统提示词内容"
      />
      <div className="mt-2 flex flex-wrap items-center gap-2">
        <button
          type="button"
          disabled={promptSaving}
          onClick={() => void applyPrompt()}
          className="rounded-md bg-primary px-3 py-1.5 text-xs text-primary-foreground disabled:opacity-50"
        >
          {promptSaving ? '正在应用…' : '应用到 Agent'}
        </button>
        <input
          value={newTemplateName}
          onChange={(event) => setNewTemplateName(event.target.value)}
          className="h-8 min-w-44 rounded-md border bg-background px-2 text-xs outline-none focus:ring-1 focus:ring-ring"
          placeholder="新预设名称"
          maxLength={100}
        />
        <button
          type="button"
          onClick={() => void saveCustomTemplate()}
          className="rounded-md border px-3 py-1.5 text-xs hover:bg-muted"
        >
          新增预设
        </button>
      </div>
    </div>
    <AgentSkillSettings />
    <p className="mt-3 text-xs text-muted-foreground" role="status">{message}</p>
  </section>
}
