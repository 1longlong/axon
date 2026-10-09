import * as React from 'react'
import { Loader2 } from 'lucide-react'
import type { AgentSkillSettingsSnapshot } from '@axon/shared'
import { RendererSkillSettings, skillSettingsCanApply } from '../../lib/agent-skill-settings'
import type { RendererSkillSettingsState } from '../../lib/agent-skill-settings'

const SOURCE_LABELS: Record<AgentSkillSettingsSnapshot['discovered'][number]['directoryKind'], string> = {
  axon: '项目 .axon',
  agents: '项目 .agents',
  builtin: 'Axon 管理',
  user: '用户全局',
}

/** Skills 设置只操作 catalog 选择；renderer 不读取目录或处理安装包。 */
export function AgentSkillSettings(): React.ReactElement {
  const [state, setState] = React.useState<RendererSkillSettingsState>({ snapshot: null, selected: [], loading: true, refreshing: false, readFailed: false, saving: false, message: null, failures: [] })
  const controller = React.useRef<RendererSkillSettings | null>(null)
  const { snapshot, selected, loading, saving, refreshing, message, failures } = state

  React.useEffect(() => {
    const current = new RendererSkillSettings(window.axon, setState)
    controller.current = current
    current.start()
    return () => { current.dispose(); if (controller.current === current) controller.current = null }
  }, [])

  const applied = snapshot?.desiredCatalogIds ?? []
  const unavailableIds = [...new Set([
    ...(snapshot?.installed.map((item) => item.catalogId) ?? []),
    ...applied,
    ...selected,
  ])].filter((id) => !snapshot?.available.some((item) => item.catalogId === id))

  return <div className="mt-4 rounded-md border border-border-subtle bg-[hsl(var(--input-surface))] p-4">
    <div>
      <h2 className="text-xs font-medium">Skills{refreshing && !loading && <span className="ml-2 text-muted-foreground">正在刷新…</span>}</h2>
      <p className="mt-1 text-xs leading-5 text-muted-foreground">
        Axon 管理项安装到 ~/.axon/skills；项目和用户全局 Skills 仍由文件目录提供。
      </p>
    </div>

    {loading ? <div className="mt-4 flex items-center gap-2 text-xs text-muted-foreground">
      <Loader2 size={14} className="animate-spin" />正在读取 Skills…
    </div> : <>
      <div className="mt-4">
        <h3 className="text-xs font-medium">可安装</h3>
        {(snapshot?.available.length || unavailableIds.length) ? <div className="mt-2 divide-y divide-border-subtle overflow-hidden rounded-md border">
          {snapshot?.available.map((skill) => {
            const checked = selected.includes(skill.catalogId)
            const installed = snapshot.installed.some((item) => (
              item.catalogId === skill.catalogId && item.contentHash === skill.contentHash && item.version === skill.version
            ))
            return <label key={skill.catalogId} className="flex cursor-pointer items-start gap-3 p-3 hover:bg-muted/40">
              <input
                type="checkbox"
                checked={checked}
                disabled={saving}
                onChange={(event) => controller.current?.select(skill.catalogId, event.target.checked)}
                className="mt-0.5 accent-primary focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-ring"
              />
              <span className="min-w-0 flex-1">
                <span className="flex flex-wrap items-center gap-2 font-mono text-xs">
                  {skill.name}
                  <span className="text-xs text-muted-foreground">v{skill.version}</span>
                  {installed && <span className="rounded bg-muted px-2 py-0.5 text-[11px] text-muted-foreground">已安装</span>}
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
                onChange={(event) => controller.current?.select(catalogId, event.target.checked)}
                className="mt-0.5 accent-primary focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-ring"
              />
              <span className="min-w-0 flex-1">
                <span className="break-all font-mono text-xs">{installed?.name ?? catalogId}</span>
                <span className="mt-1 block text-xs text-muted-foreground">
                  当前安装来源不可用；取消选择后仍可卸载 Axon 已登记的副本。
                </span>
              </span>
            </label>
          })}
        </div> : <p className="mt-2 rounded-md border border-dashed px-3 py-4 text-xs text-muted-foreground">
          暂无可安装 Skills。安装来源将在后续接入。
        </p>}
      </div>

      <div className="mt-4">
        <h3 className="text-xs font-medium">已发现的全局 Skills</h3>
        {snapshot?.discovered.length ? <div className="mt-2 divide-y divide-border-subtle overflow-hidden rounded-md border">
          {snapshot.discovered.map((skill) => <div
            key={`${skill.directoryKind}:${skill.relativeInstructionPath}`}
            className="flex flex-wrap items-start justify-between gap-2 p-3"
          >
            <div className="min-w-0 flex-1 basis-64">
              <p className="truncate font-mono text-xs">{skill.name}</p>
              <p className="mt-1 text-xs text-muted-foreground">{skill.description}</p>
            </div>
            <div className="flex flex-wrap items-center gap-2 text-[11px] text-muted-foreground">
              <span>{SOURCE_LABELS[skill.directoryKind]}</span>
              <span className="rounded bg-muted px-2 py-0.5">{skill.effective ? '有效' : '已覆盖'}</span>
            </div>
          </div>)}
        </div> : <p className="mt-2 rounded-md border border-dashed px-3 py-4 text-xs text-muted-foreground">
          尚未在 ~/.axon/skills 或 ~/.agents/skills 中发现 Skill。
        </p>}
      </div>

      {failures.length ? <div className="mt-3 rounded-md border border-destructive/30 bg-destructive/5 p-3 text-xs text-destructive">
        <p className="mb-1">最近一次应用结果</p>
        {failures.map((failure) => <p key={failure.catalogId}>{failure.catalogId}：{failure.message}</p>)}
      </div> : null}

      <div className="mt-4 flex flex-wrap items-center gap-3">
        <button
          type="button"
          disabled={!skillSettingsCanApply(state)}
          onClick={() => void controller.current?.apply()}
          className="h-8 rounded-md bg-primary px-3 text-xs text-primary-foreground hover:opacity-90 focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-ring disabled:opacity-50"
        >
          {saving ? '正在应用…' : '应用 Skills 设置'}
        </button>
        <button type="button" disabled={refreshing || saving} onClick={() => controller.current?.refresh()} className="h-8 rounded-md border px-3 text-xs hover:bg-muted disabled:opacity-50">刷新状态</button>
        <p className="text-xs text-muted-foreground" role="status">{message}</p>
      </div>
    </>}
  </div>
}
