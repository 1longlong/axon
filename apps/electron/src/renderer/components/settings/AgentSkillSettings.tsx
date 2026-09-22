import * as React from 'react'
import { Loader2 } from 'lucide-react'
import type { AgentSkillSettingsSnapshot } from '@axon/shared'

const SOURCE_LABELS: Record<AgentSkillSettingsSnapshot['discovered'][number]['directoryKind'], string> = {
  axon: '项目 .axon',
  agents: '项目 .agents',
  builtin: 'Axon 管理',
  user: '用户全局',
}

/** Skills 设置只操作 catalog 选择；renderer 不读取目录或处理安装包。 */
export function AgentSkillSettings(): React.ReactElement {
  const [snapshot, setSnapshot] = React.useState<AgentSkillSettingsSnapshot | null>(null)
  const [selected, setSelected] = React.useState<string[]>([])
  const [loading, setLoading] = React.useState(true)
  const [saving, setSaving] = React.useState(false)
  const [message, setMessage] = React.useState<string | null>(null)

  React.useEffect(() => {
    let cancelled = false
    void window.axon.agentSkills.getSettings()
      .then((value) => {
        if (cancelled) return
        setSnapshot(value)
        setSelected(value.desiredCatalogIds)
      })
      .catch(() => { if (!cancelled) setMessage('读取 Skills 设置失败') })
      .finally(() => { if (!cancelled) setLoading(false) })
    return () => { cancelled = true }
  }, [])

  const applied = snapshot?.desiredCatalogIds ?? []
  const dirty = [...selected].sort().join('\0') !== [...applied].sort().join('\0')
  const unavailableIds = [...new Set([
    ...(snapshot?.installed.map((item) => item.catalogId) ?? []),
    ...applied,
  ])].filter((id) => !snapshot?.available.some((item) => item.catalogId === id))

  const apply = async (): Promise<void> => {
    setSaving(true)
    setMessage(null)
    try {
      const next = await window.axon.agentSkills.applySettings(selected)
      setSnapshot(next)
      setSelected(next.desiredCatalogIds)
      setMessage(next.failures.length > 0
        ? `Skills 设置已保存，${next.failures.length} 项处理失败`
        : 'Skills 设置已应用')
    } catch {
      setMessage('应用 Skills 设置失败')
    } finally {
      setSaving(false)
    }
  }

  return <div className="mt-6 rounded-xl border bg-card p-4 shadow-sm">
    <div>
      <h2 className="text-sm font-medium">Skills</h2>
      <p className="mt-1 text-xs leading-5 text-muted-foreground">
        Axon 管理项安装到 ~/.axon/skills；项目和用户全局 Skills 仍由文件目录提供。
      </p>
    </div>

    {loading ? <div className="mt-4 flex items-center gap-2 text-xs text-muted-foreground">
      <Loader2 size={14} className="animate-spin" />正在读取 Skills…
    </div> : <>
      <div className="mt-4">
        <h3 className="text-xs font-medium">可安装</h3>
        {(snapshot?.available.length || unavailableIds.length) ? <div className="mt-2 divide-y rounded-lg border">
          {snapshot?.available.map((skill) => {
            const checked = selected.includes(skill.catalogId)
            const installed = snapshot.installed.some((item) => (
              item.catalogId === skill.catalogId && item.contentHash === skill.contentHash
            ))
            return <label key={skill.catalogId} className="flex cursor-pointer items-start gap-3 p-3 hover:bg-muted/40">
              <input
                type="checkbox"
                checked={checked}
                disabled={saving}
                onChange={(event) => setSelected((current) => event.target.checked
                  ? [...current, skill.catalogId]
                  : current.filter((id) => id !== skill.catalogId))}
                className="mt-0.5"
              />
              <span className="min-w-0 flex-1">
                <span className="flex items-center gap-2 text-sm">
                  {skill.name}
                  <span className="text-xs text-muted-foreground">v{skill.version}</span>
                  {installed && <span className="rounded-full bg-muted px-2 py-0.5 text-[11px] text-muted-foreground">已安装</span>}
                </span>
                <span className="mt-1 block text-xs leading-5 text-muted-foreground">{skill.description}</span>
              </span>
            </label>
          })}
          {unavailableIds.map((catalogId) => {
            const installed = snapshot?.installed.find((item) => item.catalogId === catalogId)
            return <label key={catalogId} className="flex cursor-pointer items-start gap-3 p-3 hover:bg-muted/40">
              <input
                type="checkbox"
                checked={selected.includes(catalogId)}
                disabled={saving}
                onChange={(event) => setSelected((current) => event.target.checked
                  ? [...current, catalogId]
                  : current.filter((id) => id !== catalogId))}
                className="mt-0.5"
              />
              <span className="min-w-0 flex-1">
                <span className="text-sm">{installed?.name ?? catalogId}</span>
                <span className="mt-1 block text-xs text-muted-foreground">
                  当前安装来源不可用；取消选择后仍可卸载 Axon 已登记的副本。
                </span>
              </span>
            </label>
          })}
        </div> : <p className="mt-2 rounded-lg border border-dashed px-3 py-4 text-xs text-muted-foreground">
          暂无可安装 Skills。安装来源将在后续接入。
        </p>}
      </div>

      <div className="mt-4">
        <h3 className="text-xs font-medium">已发现的全局 Skills</h3>
        {snapshot?.discovered.length ? <div className="mt-2 divide-y rounded-lg border">
          {snapshot.discovered.map((skill) => <div
            key={`${skill.directoryKind}:${skill.relativeInstructionPath}`}
            className="flex items-start justify-between gap-3 p-3"
          >
            <div className="min-w-0">
              <p className="truncate text-sm">{skill.name}</p>
              <p className="mt-1 text-xs text-muted-foreground">{skill.description}</p>
            </div>
            <div className="flex shrink-0 items-center gap-2 text-[11px] text-muted-foreground">
              <span>{SOURCE_LABELS[skill.directoryKind]}</span>
              <span className="rounded-full bg-muted px-2 py-0.5">{skill.effective ? '有效' : '已覆盖'}</span>
            </div>
          </div>)}
        </div> : <p className="mt-2 rounded-lg border border-dashed px-3 py-4 text-xs text-muted-foreground">
          尚未在 ~/.axon/skills 或 ~/.agents/skills 中发现 Skill。
        </p>}
      </div>

      {snapshot?.failures.length ? <div className="mt-3 rounded-md border border-destructive/30 bg-destructive/5 p-3 text-xs text-destructive">
        {snapshot.failures.map((failure) => <p key={failure.catalogId}>{failure.catalogId}：{failure.message}</p>)}
      </div> : null}

      <div className="mt-4 flex items-center gap-3">
        <button
          type="button"
          disabled={!dirty || saving}
          onClick={() => void apply()}
          className="rounded-md bg-primary px-3 py-1.5 text-xs text-primary-foreground disabled:opacity-50"
        >
          {saving ? '正在应用…' : '应用 Skills 设置'}
        </button>
        <p className="text-xs text-muted-foreground" role="status">{message}</p>
      </div>
    </>}
  </div>
}
