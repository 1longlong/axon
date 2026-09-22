import * as React from 'react'
import { Plus, Trash2, X } from 'lucide-react'
import {
  DEFAULT_MCP_REQUEST_TIMEOUT_MS,
  DEFAULT_MCP_STARTUP_TIMEOUT_MS,
  MCP_PROJECT_CONFIG_VERSION,
} from '@axon/shared'
import type { BuiltinMcpPresetSummary, McpConnectionTestResult, McpProjectConfig, McpServerConfig } from '@axon/shared'

interface McpServerDraft {
  id: string
  name: string
  type: 'stdio' | 'http'
  enabled: boolean
  required: boolean
  startupTimeoutMs: string
  requestTimeoutMs: string
  command: string
  argsJson: string
  envJson: string
  url: string
  headersJson: string
}

interface McpProjectDialogProps {
  projectId: string
  projectName: string
  onClose(): void
}

const SERVER_NAME_PATTERN = /^[a-z][a-z0-9-]{0,62}[a-z0-9]$|^[a-z]$/

function prettyJson(value: unknown): string {
  return JSON.stringify(value, null, 2)
}

function configToDraft(name: string, config: McpServerConfig): McpServerDraft {
  return {
    id: crypto.randomUUID(),
    name,
    type: config.type,
    enabled: config.enabled,
    required: config.required,
    startupTimeoutMs: String(config.startupTimeoutMs),
    requestTimeoutMs: String(config.requestTimeoutMs),
    command: config.type === 'stdio' ? config.command : '',
    argsJson: prettyJson(config.type === 'stdio' ? (config.args ?? []) : []),
    envJson: prettyJson(config.type === 'stdio' ? (config.env ?? {}) : {}),
    url: config.type === 'http' ? config.url : 'http://localhost:3000/mcp',
    headersJson: prettyJson(config.type === 'http' ? (config.headers ?? {}) : {}),
  }
}

function emptyDraft(existingNames: readonly string[]): McpServerDraft {
  let suffix = 1
  let name = 'server'
  while (existingNames.includes(name)) {
    suffix += 1
    name = `server-${suffix}`
  }
  return {
    id: crypto.randomUUID(),
    name,
    type: 'stdio',
    enabled: true,
    required: false,
    startupTimeoutMs: String(DEFAULT_MCP_STARTUP_TIMEOUT_MS),
    requestTimeoutMs: String(DEFAULT_MCP_REQUEST_TIMEOUT_MS),
    command: '',
    argsJson: '[]',
    envJson: '{}',
    url: 'http://localhost:3000/mcp',
    headersJson: '{}',
  }
}

function uniqueServerName(baseName: string, existingNames: readonly string[]): string {
  if (!existingNames.includes(baseName)) return baseName
  let suffix = 2
  while (existingNames.includes(`${baseName}-${suffix}`)) suffix += 1
  return `${baseName}-${suffix}`
}

function parseStringArray(value: string, field: string): string[] | undefined {
  let parsed: unknown
  try { parsed = JSON.parse(value) }
  catch { throw new Error(`${field} 必须是合法 JSON`) }
  if (!Array.isArray(parsed) || parsed.some((item) => typeof item !== 'string')) {
    throw new Error(`${field} 必须是字符串数组`)
  }
  return parsed.length > 0 ? parsed : undefined
}

function parseStringMap(value: string, field: string): Record<string, string> | undefined {
  let parsed: unknown
  try { parsed = JSON.parse(value) }
  catch { throw new Error(`${field} 必须是合法 JSON`) }
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
    throw new Error(`${field} 必须是字符串对象`)
  }
  const entries = Object.entries(parsed)
  if (entries.some(([, item]) => typeof item !== 'string')) {
    throw new Error(`${field} 的值必须全部是字符串`)
  }
  return entries.length > 0 ? Object.fromEntries(entries) as Record<string, string> : undefined
}

function parseTimeout(value: string, field: string): number {
  const parsed = Number(value)
  if (!Number.isInteger(parsed) || parsed < 100 || parsed > 600_000) {
    throw new Error(`${field} 必须是 100 到 600000 毫秒的整数`)
  }
  return parsed
}

/** 把表单草稿收束为共享契约；主进程仍会执行完整且权威的严格校验。 */
function draftsToConfig(drafts: readonly McpServerDraft[]): McpProjectConfig {
  const servers: Record<string, McpServerConfig> = {}
  for (const draft of drafts) {
    const name = draft.name.trim()
    if (!SERVER_NAME_PATTERN.test(name)) throw new Error('服务器名称必须是小写 kebab-case，长度为 1 到 64 位')
    if (servers[name]) throw new Error(`服务器名称重复：${name}`)
    const common = {
      enabled: draft.enabled,
      required: draft.required,
      startupTimeoutMs: parseTimeout(draft.startupTimeoutMs, '启动超时'),
      requestTimeoutMs: parseTimeout(draft.requestTimeoutMs, '请求超时'),
    }
    if (draft.type === 'stdio') {
      const command = draft.command.trim()
      if (!command) throw new Error(`服务器 ${name} 缺少启动命令`)
      const args = parseStringArray(draft.argsJson, `${name} 的参数`)
      const env = parseStringMap(draft.envJson, `${name} 的环境变量`)
      servers[name] = { type: 'stdio', ...common, command, ...(args ? { args } : {}), ...(env ? { env } : {}) }
    } else {
      if (!draft.url.trim()) throw new Error(`服务器 ${name} 缺少 URL`)
      const headers = parseStringMap(draft.headersJson, `${name} 的请求头`)
      servers[name] = { type: 'http', ...common, url: draft.url.trim(), ...(headers ? { headers } : {}) }
    }
  }
  return { version: MCP_PROJECT_CONFIG_VERSION, servers }
}

/** 项目级 MCP 编辑器：保存/取消只处理草稿，关闭动作由独立按钮负责。 */
export function McpProjectDialog({ projectId, projectName, onClose }: McpProjectDialogProps): React.ReactElement {
  const [drafts, setDrafts] = React.useState<McpServerDraft[]>([])
  const [savedDrafts, setSavedDrafts] = React.useState<McpServerDraft[]>([])
  const [presets, setPresets] = React.useState<BuiltinMcpPresetSummary[]>([])
  const [selectedId, setSelectedId] = React.useState<string | null>(null)
  const [loading, setLoading] = React.useState(true)
  const [loadFailed, setLoadFailed] = React.useState(false)
  const [saving, setSaving] = React.useState(false)
  const [testingId, setTestingId] = React.useState<string | null>(null)
  const [testResult, setTestResult] = React.useState<(McpConnectionTestResult & { id: string }) | null>(null)
  const [materializingId, setMaterializingId] = React.useState<string | null>(null)
  const [error, setError] = React.useState<string | null>(null)
  const [notice, setNotice] = React.useState<string | null>(null)

  React.useEffect(() => {
    let disposed = false
    void Promise.all([
      window.axon.mcpProjects.getConfig(projectId),
      window.axon.mcpProjects.listBuiltinPresets(),
    ]).then(([config, catalog]) => {
      if (disposed) return
      const loaded = Object.entries(config.servers).map(([name, server]) => configToDraft(name, server))
      setDrafts(loaded)
      setSavedDrafts(loaded.map((draft) => ({ ...draft })))
      setPresets(catalog)
      setSelectedId(loaded[0]?.id ?? null)
    }).catch((cause: unknown) => {
      if (!disposed) {
        setLoadFailed(true)
        setError(cause instanceof Error ? cause.message : '读取 MCP 配置失败')
      }
    }).finally(() => {
      if (!disposed) setLoading(false)
    })
    return () => { disposed = true }
  }, [projectId])

  React.useEffect(() => {
    const closeOnEscape = (event: KeyboardEvent): void => {
      if (event.key === 'Escape' && !saving && !testingId && !materializingId) onClose()
    }
    document.addEventListener('keydown', closeOnEscape)
    return () => document.removeEventListener('keydown', closeOnEscape)
  }, [onClose, saving, testingId, materializingId])

  const selected = drafts.find((draft) => draft.id === selectedId) ?? null
  const updateSelected = (update: Partial<McpServerDraft>): void => {
    if (!selectedId) return
    setDrafts((current) => current.map((draft) => draft.id === selectedId ? { ...draft, ...update } : draft))
    setTestResult(null)
    setNotice(null)
  }

  const addServer = (): void => {
    const draft = emptyDraft(drafts.map((item) => item.name))
    setDrafts((current) => [...current, draft])
    setSelectedId(draft.id)
    setError(null)
    setTestResult(null)
    setNotice(null)
  }

  /** 预设由主进程展开可信工作区路径；这里只加入未保存草稿，保留最终确认步骤。 */
  const addPreset = async (preset: BuiltinMcpPresetSummary): Promise<void> => {
    if (materializingId || saving) return
    setMaterializingId(preset.id)
    setError(null)
    try {
      const materialized = await window.axon.mcpProjects.materializeBuiltinPreset(projectId, preset.id)
      const name = uniqueServerName(materialized.name, drafts.map((item) => item.name))
      const draft = configToDraft(name, materialized.config)
      setDrafts((current) => [...current, draft])
      setSelectedId(draft.id)
      setTestResult(null)
      setNotice(null)
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : '添加 MCP 预设失败')
    } finally {
      setMaterializingId(null)
    }
  }

  const removeSelected = (): void => {
    if (!selectedId) return
    const index = drafts.findIndex((draft) => draft.id === selectedId)
    const next = drafts.filter((draft) => draft.id !== selectedId)
    setDrafts(next)
    setSelectedId(next[Math.min(index, next.length - 1)]?.id ?? null)
    setError(null)
    setTestResult(null)
    setNotice(null)
  }

  /** 取消只回退本弹窗尚未保存的整份项目草稿，不关闭窗口或改动磁盘配置。 */
  const cancel = (): void => {
    if (saving || testingId || materializingId) return
    const restored = savedDrafts.map((draft) => ({ ...draft }))
    setDrafts(restored)
    setSelectedId((current) => restored.some((draft) => draft.id === current) ? current : restored[0]?.id ?? null)
    setError(null)
    setTestResult(null)
    setNotice('已撤销未保存的修改')
  }

  /** 测试选中的未保存草稿；主进程独立连接并关闭，不改变项目已生效配置。 */
  const testConnection = async (): Promise<void> => {
    if (!selected || saving || testingId || materializingId) return
    setTestingId(selected.id)
    setTestResult(null)
    setError(null)
    try {
      const config = draftsToConfig([selected])
      const serverName = selected.name.trim()
      const result = await window.axon.mcpProjects.testConnection(projectId, serverName, config.servers[serverName]!)
      setTestResult({ id: selected.id, ...result })
    } catch (cause) {
      setTestResult({ id: selected.id, ok: false, message: cause instanceof Error ? cause.message : '连接测试失败' })
    } finally {
      setTestingId(null)
    }
  }

  const save = async (): Promise<void> => {
    if (saving || materializingId || testingId) return
    setSaving(true)
    setError(null)
    setNotice(null)
    try {
      const config = draftsToConfig(drafts)
      await window.axon.mcpProjects.saveConfig(projectId, config)
      setSavedDrafts(drafts.map((draft) => ({ ...draft })))
      setNotice('配置已保存')
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : '保存 MCP 配置失败')
    } finally {
      setSaving(false)
    }
  }

  return <div role="dialog" aria-modal="true" aria-label={`配置 ${projectName} 的 MCP 服务`}
    className="fixed inset-0 z-50 flex items-center justify-center bg-black/35 p-4">
    <div className="flex h-[min(680px,calc(100vh-32px))] w-full max-w-4xl flex-col rounded-lg border bg-background shadow-xl">
      <div className="flex items-start justify-between gap-3 border-b px-5 py-4">
        <div>
          <h2 className="text-sm font-medium">MCP 服务 · {projectName}</h2>
          <p className="mt-1 text-xs text-muted-foreground">项目下全部 Agent 会话共享这些服务器；配置仅保存在应用私有目录。</p>
        </div>
        <button type="button" aria-label="关闭 MCP 配置" title="关闭" disabled={saving || testingId !== null || materializingId !== null} onClick={onClose}
          className="flex size-7 shrink-0 items-center justify-center rounded-md text-muted-foreground hover:bg-muted hover:text-foreground disabled:opacity-40">
          <X size={16} />
        </button>
      </div>
      <div className="flex min-h-0 flex-1">
        <aside className="flex w-56 shrink-0 flex-col border-r p-3">
          <button type="button" disabled={loading || loadFailed || saving || testingId !== null || materializingId !== null || drafts.length >= 64} onClick={addServer}
            className="flex h-8 items-center justify-center gap-2 rounded-md border text-xs hover:bg-muted disabled:opacity-40">
            <Plus size={13} />添加服务器
          </button>
          {presets.length > 0 && <div className="mt-3 border-b pb-3">
            <p className="px-1 text-[10px] font-medium uppercase tracking-wide text-muted-foreground">内置预设</p>
            <div className="mt-1 space-y-1">
              {presets.map((preset) => <button key={preset.id} type="button" title={preset.description}
                disabled={loading || loadFailed || saving || testingId !== null || materializingId !== null || drafts.length >= 64}
                onClick={() => void addPreset(preset)}
                className="flex w-full items-center justify-between rounded-md px-2 py-1.5 text-left text-xs text-muted-foreground hover:bg-muted hover:text-foreground disabled:opacity-40">
                <span className="truncate">{materializingId === preset.id ? '正在添加…' : preset.displayName}</span>
                <Plus size={11} className="shrink-0" />
              </button>)}
            </div>
          </div>}
          <div className="mt-2 min-h-0 flex-1 space-y-1 overflow-y-auto">
            {loading ? <p className="px-2 py-4 text-xs text-muted-foreground">正在读取…</p>
              : drafts.length === 0 ? <p className="px-2 py-4 text-xs text-muted-foreground">尚未配置服务器</p>
                : drafts.map((draft) => <button key={draft.id} type="button" disabled={testingId !== null} onClick={() => { setSelectedId(draft.id); setTestResult(null) }}
                  className={`flex w-full items-center gap-2 rounded-md px-2 py-2 text-left text-xs ${selectedId === draft.id ? 'bg-muted text-foreground' : 'text-muted-foreground hover:bg-muted/60 hover:text-foreground'}`}>
                  <span className={`size-2 shrink-0 rounded-full ${draft.enabled ? 'bg-emerald-500' : 'bg-muted-foreground/40'}`} />
                  <span className="min-w-0 flex-1 truncate">{draft.name || '未命名'}</span>
                  <span className="text-[10px] uppercase">{draft.type}</span>
                </button>)}
          </div>
        </aside>
        <main className="min-w-0 flex-1 overflow-y-auto p-5">
          {!loading && selected && <>
            <ServerEditor draft={selected} disabled={saving || testingId !== null} onChange={updateSelected} onDelete={removeSelected} />
            {testResult?.id === selected.id && <div className="mt-4 space-y-2 text-xs">
              <p role="status" className={testResult.ok ? 'text-emerald-600' : 'text-destructive'}>
                {testResult.ok ? `连接成功，发现 ${testResult.tools.length} 个工具` : testResult.message}
              </p>
              {testResult.ok && <div className="rounded-md border bg-muted/30 p-3">
                <p className="mb-2 font-medium text-foreground">tools/list 返回的工具（分页汇总）</p>
                <pre className="max-h-72 overflow-auto whitespace-pre-wrap break-all font-mono text-[11px] leading-5 text-foreground">{JSON.stringify({ tools: testResult.tools }, null, 2)}</pre>
              </div>}
            </div>}
          </>}
          {!loading && !selected && <div className="flex h-full items-center justify-center text-xs text-muted-foreground">添加一个 stdio 或 HTTP MCP Server</div>}
        </main>
      </div>
      <div className="border-t px-5 py-3">
        {error && <p className="mb-2 text-xs text-destructive">{error}</p>}
        {notice && <p role="status" className="mb-2 text-xs text-emerald-600">{notice}</p>}
        <div className="flex justify-end gap-2">
          <button type="button" disabled={loading || loadFailed || saving || testingId !== null || materializingId !== null || !selected} onClick={() => void testConnection()} className="h-8 rounded-md border px-3 text-xs hover:bg-muted disabled:opacity-40">
            {testingId ? '正在测试…' : '测试连接'}
          </button>
          <button type="button" disabled={loading || loadFailed || saving || testingId !== null || materializingId !== null} onClick={cancel} title="撤销本项目所有未保存的 MCP 修改" className="h-8 rounded-md border px-3 text-xs hover:bg-muted disabled:opacity-40">取消</button>
          <button type="button" disabled={loading || loadFailed || saving || testingId !== null || materializingId !== null} onClick={() => void save()} title="保存本项目所有 MCP 配置" className="h-8 rounded-md bg-primary px-3 text-xs text-primary-foreground disabled:opacity-40">
            {saving ? '正在保存…' : '保存'}
          </button>
        </div>
      </div>
    </div>
  </div>
}

function ServerEditor({ draft, disabled, onChange, onDelete }: {
  draft: McpServerDraft
  disabled: boolean
  onChange(update: Partial<McpServerDraft>): void
  onDelete(): void
}): React.ReactElement {
  return <div className="space-y-4">
    <div className="flex items-start gap-3">
      <label className="min-w-0 flex-1 text-xs text-muted-foreground">服务器名称
        <input autoFocus value={draft.name} disabled={disabled} maxLength={64} onChange={(event) => onChange({ name: event.target.value })}
          placeholder="filesystem" className="mt-1 h-9 w-full rounded-md border bg-background px-3 text-sm text-foreground outline-none focus:ring-1 focus:ring-ring" />
        <span className="mt-1 block text-[10px]">小写 kebab-case；工具名会添加此前缀。</span>
      </label>
      <button type="button" disabled={disabled} onClick={onDelete} aria-label="删除 MCP 服务器"
        className="mt-5 flex size-9 items-center justify-center rounded-md border text-muted-foreground hover:bg-muted hover:text-destructive disabled:opacity-40">
        <Trash2 size={14} />
      </button>
    </div>
    <div className="grid grid-cols-2 gap-3">
      <FieldLabel label="通信方式">
        <select value={draft.type} disabled={disabled} onChange={(event) => onChange({ type: event.target.value as 'stdio' | 'http' })}
          className="h-9 w-full rounded-md border bg-background px-2 text-sm text-foreground outline-none focus:ring-1 focus:ring-ring">
          <option value="stdio">stdio（本地进程）</option>
          <option value="http">HTTP（Streamable HTTP）</option>
        </select>
      </FieldLabel>
      <div className="flex items-end gap-5 pb-2 text-xs">
        <CheckField label="启用" checked={draft.enabled} disabled={disabled} onChange={(enabled) => onChange({ enabled })} />
        <CheckField label="必需（失败时阻断本轮）" checked={draft.required} disabled={disabled} onChange={(required) => onChange({ required })} />
      </div>
    </div>
    {draft.type === 'stdio' ? <>
      <FieldLabel label="启动命令">
        <input value={draft.command} disabled={disabled} onChange={(event) => onChange({ command: event.target.value })}
          placeholder="npx" className="h-9 w-full rounded-md border bg-background px-3 text-sm text-foreground outline-none focus:ring-1 focus:ring-ring" />
      </FieldLabel>
      <JsonField label="参数（JSON 字符串数组）" value={draft.argsJson} disabled={disabled} onChange={(argsJson) => onChange({ argsJson })} placeholder={'["-y", "@modelcontextprotocol/server-filesystem", "/workspace"]'} />
      <JsonField label="环境变量（JSON 字符串对象）" value={draft.envJson} disabled={disabled} onChange={(envJson) => onChange({ envJson })} placeholder={'{"TOKEN": "..."}'} />
    </> : <>
      <FieldLabel label="Streamable HTTP URL">
        <input value={draft.url} disabled={disabled} onChange={(event) => onChange({ url: event.target.value })}
          placeholder="https://example.com/mcp" className="h-9 w-full rounded-md border bg-background px-3 text-sm text-foreground outline-none focus:ring-1 focus:ring-ring" />
      </FieldLabel>
      <JsonField label="请求头（JSON 字符串对象）" value={draft.headersJson} disabled={disabled} onChange={(headersJson) => onChange({ headersJson })} placeholder={'{"Authorization": "Bearer ..."}'} />
    </>}
    <div className="grid grid-cols-2 gap-3">
      <FieldLabel label="启动超时（毫秒）">
        <input type="number" min={100} max={600000} step={100} value={draft.startupTimeoutMs} disabled={disabled}
          onChange={(event) => onChange({ startupTimeoutMs: event.target.value })}
          className="h-9 w-full rounded-md border bg-background px-3 text-sm text-foreground outline-none focus:ring-1 focus:ring-ring" />
      </FieldLabel>
      <FieldLabel label="请求超时（毫秒）">
        <input type="number" min={100} max={600000} step={100} value={draft.requestTimeoutMs} disabled={disabled}
          onChange={(event) => onChange({ requestTimeoutMs: event.target.value })}
          className="h-9 w-full rounded-md border bg-background px-3 text-sm text-foreground outline-none focus:ring-1 focus:ring-ring" />
      </FieldLabel>
    </div>
  </div>
}

function FieldLabel({ label, children }: { label: string; children: React.ReactNode }): React.ReactElement {
  return <label className="block text-xs text-muted-foreground">{label}<span className="mt-1 block">{children}</span></label>
}

function CheckField({ label, checked, disabled, onChange }: {
  label: string
  checked: boolean
  disabled: boolean
  onChange(value: boolean): void
}): React.ReactElement {
  return <label className="flex items-center gap-2 text-muted-foreground">
    <input type="checkbox" checked={checked} disabled={disabled} onChange={(event) => onChange(event.target.checked)} />{label}
  </label>
}

function JsonField({ label, value, disabled, placeholder, onChange }: {
  label: string
  value: string
  disabled: boolean
  placeholder: string
  onChange(value: string): void
}): React.ReactElement {
  return <label className="block text-xs text-muted-foreground">{label}
    <textarea value={value} disabled={disabled} spellCheck={false} onChange={(event) => onChange(event.target.value)} placeholder={placeholder}
      className="mt-1 h-24 w-full resize-y rounded-md border bg-background p-3 font-mono text-xs text-foreground outline-none focus:ring-1 focus:ring-ring" />
  </label>
}
