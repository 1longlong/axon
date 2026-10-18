/** 用户确认任务、计划与权限；首次技术配置交给后台准备轮，设置页不覆盖生成结果。 */
import { useEffect, useMemo, useRef, useState } from 'react'
import { createPortal } from 'react-dom'
import { FolderOpen } from 'lucide-react'
import type { FormEvent } from 'react'
import { useSetAtom } from 'jotai'
import { loopFormEditingAtom } from '@/atoms/loop-page'
import type { Channel, LoopComposeInput, LoopSummary, LoopMcpToolOption, McpProjectConfig } from '@axon/shared'
import { McpConfigDialog } from '../agent/McpProjectDialog'
import type { McpConfigDialogApi } from '../agent/McpProjectDialog'
import { btn, btnPrimary, inputCls, labelCls } from './views/ui'

export function LoopForm({ initial, onSaved, onCancel }: { initial?: LoopSummary; onSaved: (id: string, runId?: string, warning?: string) => void; onCancel: () => void }) {
  const setEditing = useSetAtom(loopFormEditingAtom)
  const [channels, setChannels] = useState<Channel[]>([])
  const [form, setForm] = useState<LoopComposeInput>(() => initial ?? { name: '', workspacePath: '', channelId: '', modelId: '', task: '', cron: '0 * * * *', timezone: Intl.DateTimeFormat().resolvedOptions().timeZone, allowControl: true, notify: 'auto', sandboxMode: 'workspaceWrite', enabled: true })
  const draftConfig = useRef<McpProjectConfig>({ version: 1, servers: {} })
  const [editingMcp, setEditingMcp] = useState(false)
  const [picking, setPicking] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [busy, setBusy] = useState(false)
  const [mcpTools, setMcpTools] = useState<LoopMcpToolOption[]>([])
  const [discovering, setDiscovering] = useState(false)
  const [toolsLoaded, setToolsLoaded] = useState(false)
  const [serverCount, setServerCount] = useState<number | null>(initial ? null : 0)
  const discoverySequence = useRef(0)
  const submitting = useRef(false)
  const mounted = useRef(true)
  useEffect(() => { mounted.current = true; return () => {
    mounted.current = false
    discoverySequence.current++
    setEditing({ dirty: false, busy: false })
  } }, [setEditing])
  /** 查询只刷新候选工具，不改变用户授权；旧目录/配置的迟到列表不能更新当前表单。 */
  const discovery = async (): Promise<void> => {
    const sequence = ++discoverySequence.current
    setDiscovering(true); setError(null)
    try { const tools = await window.axon.loops.mcpTools(initial ? { loopId: initial.id } : { workspacePath: form.workspacePath }, initial ? undefined : draftConfig.current); if (sequence === discoverySequence.current) { setMcpTools(tools); setToolsLoaded(true) } }
    catch (cause) { if (sequence === discoverySequence.current) setError(cause instanceof Error ? cause.message : String(cause)) }
    finally { if (sequence === discoverySequence.current) setDiscovering(false) }
  }
  useEffect(() => {
    let alive = true
    void window.axon.channels.list().then((c) => {
      if (!alive) return
      setChannels(c.filter((channel) => channel.enabled))
      setForm((value) => ({ ...value, channelId: value.channelId || c.find((channel) => channel.enabled)?.id || '' }))
    }).catch((cause: unknown) => { if (alive) setError(String(cause)) })
    return () => { alive = false }
  }, [])
  useEffect(() => {
    if (!initial) return
    let alive = true
    void window.axon.loops.getMcpConfig(initial.id).then((config) => {
      if (alive) setServerCount(Object.keys(config.servers).length)
    }).catch(() => { if (alive) setError('读取 Loop MCP 配置失败，可打开配置窗口检查') })
    return () => { alive = false }
  }, [initial?.id])
  const channel = channels.find((item) => item.id === form.channelId)
  const models = channel?.models.filter((model) => model.enabled) ?? []
  const patch = (value: Partial<LoopComposeInput>): void => {
    setEditing((previous) => ({ ...previous, dirty: true }))
    setForm((previous) => ({ ...previous, ...value }))
  }
  /** 原生选择只返回候选目录；保存时后端再解析真实根，编辑阶段不能改绑。 */
  const chooseDirectory = async (): Promise<void> => {
    if (picking || initial || busy) return
    setPicking(true); setError(null)
    try {
      const selection = await window.axon.agentProjects.pickLocalWorkspace()
      if (mounted.current && selection && !selection.canceled) {
        discoverySequence.current++; setDiscovering(false); setMcpTools([]); setToolsLoaded(false)
        patch({ workspacePath: selection.path })
      }
    } catch { if (mounted.current) setError('选择工作目录失败') }
    finally { if (mounted.current) setPicking(false) }
  }
  const mcpApi = useMemo<McpConfigDialogApi>(() => ({
    getConfig: () => initial ? window.axon.loops.getMcpConfig(initial.id) : Promise.resolve(structuredClone(draftConfig.current)),
    saveConfig: async (config) => {
      if (initial) await window.axon.loops.saveMcpConfig(initial.id, config)
      else draftConfig.current = structuredClone(config)
      if (!mounted.current) return
      discoverySequence.current++; setDiscovering(false); setMcpTools([]); setToolsLoaded(false)
      setServerCount(Object.keys(config.servers).length)
      setEditing((previous) => ({ ...previous, dirty: true }))
      setForm((previous) => ({ ...previous, allowedMcpTools: [] }))
    },
    testConnection: (input) => window.axon.loops.testMcpConnection({ ...input, target: initial ? { loopId: initial.id } : { workspacePath: form.workspacePath } }),
    cancelConnectionTest: (id) => window.axon.loops.cancelMcpTest(id),
  }), [initial?.id, form.workspacePath, setEditing])
  /** 创建发送所选目录、编辑不改绑；仅提交用户字段，不回传内部执行身份。 */
  const save = async (event: FormEvent, runImmediately: boolean): Promise<void> => {
    event.preventDefault()
    if (submitting.current) return
    if (!form.workspacePath) { setError('请先选择工作目录'); return }
    submitting.current = true; setError(null); setBusy(true)
    setEditing((previous) => ({ ...previous, busy: true }))
    try {
      const { name, workspacePath, channelId, modelId, task, cron, timezone, goal, allowControl, notify, sandboxMode, enabled, thinkingLevel, precheckNetworkAccess, allowedMcpTools } = form
      const input = { name, channelId, modelId: modelId || models[0]?.id || '', task, cron, timezone, goal, allowControl, notify, sandboxMode, enabled, thinkingLevel, precheckNetworkAccess, allowedMcpTools }
      const saved = initial ? await window.axon.loops.update(initial.id, input) : await window.axon.loops.create({ ...input, workspacePath,
        ...(Object.keys(draftConfig.current.servers).length ? { mcpConfig: draftConfig.current } : {}), runImmediately })
      setEditing({ dirty: false, busy: true })
      // 准备和后续立即执行由服务端一次接受；页面不串发运行请求，避免交付未知时重复执行。
      onSaved(saved.id)
    } catch (cause) { setError(cause instanceof Error ? cause.message : String(cause)) }
    finally { submitting.current = false; setBusy(false); setEditing((previous) => ({ ...previous, busy: false })) }
  }
  const configureReason = busy ? '正在保存任务，请稍后操作' : initial?.running || initial?.queued ? '请先停止此 Loop，再修改 MCP 配置' : undefined
  const discoverReason = busy ? '正在保存任务，请稍后操作' : !form.workspacePath ? '请先选择工作目录，再读取工具列表'
    : serverCount === 0 ? '请先配置至少一个 MCP 服务器' : undefined
  const visibleTools = [...mcpTools, ...(form.allowedMcpTools ?? []).filter((name) => !mcpTools.some((tool) => tool.name === name))
    .map((name) => ({ name, description: '已授权的工具，刷新列表后可核对当前定义；也可以取消勾选以撤销授权。' }))]
  return <form onSubmit={(event) => void save(event, (event.nativeEvent as SubmitEvent).submitter?.getAttribute('value') === 'run')} className="space-y-4 rounded-card border border-hairline bg-surface p-6">
    <label className={labelCls}>名称<input required maxLength={160} className={inputCls} value={form.name} onChange={(event) => patch({ name: event.target.value })} /></label>
    <div className="grid grid-cols-2 gap-4">
      <section className="col-span-2" aria-labelledby="loop-workspace-label">
        <p id="loop-workspace-label" className={labelCls}>工作目录</p>
        <div className="flex flex-wrap items-center gap-3">
          {!initial && <button type="button" className={btn} disabled={picking || busy} onClick={() => void chooseDirectory()}><FolderOpen size={16} aria-hidden />{picking ? '选择中…' : form.workspacePath ? '更换文件夹' : '选择文件夹'}</button>}
          <p data-testid="loop-workspace-path" className="min-w-0 break-all text-sm text-primary">{form.workspacePath || '尚未选择本地文件夹'}</p>
        </div>
        <p className="mt-2 text-xs text-secondary">创建后目录固定；不需要 Agent 项目，删除 Loop 不删除此文件夹。</p>
      </section>
      <label className={labelCls}>渠道<select required className={inputCls} value={form.channelId} onChange={(event) => patch({ channelId: event.target.value, modelId: '' })}><option value="">选择渠道</option>{channels.map((item) => <option key={item.id} value={item.id}>{item.name}</option>)}</select></label>
      <label className={labelCls}>模型<select required className={inputCls} value={form.modelId || models[0]?.id || ''} onChange={(event) => patch({ modelId: event.target.value })}><option value="">选择模型</option>{models.map((model) => <option key={model.id} value={model.id}>{model.name}</option>)}</select></label>
      <label className={labelCls}>沙箱<select className={inputCls} value={form.sandboxMode} onChange={(event) => patch({ sandboxMode: event.target.value === 'readOnly' ? 'readOnly' : 'workspaceWrite' })}><option value="workspaceWrite">允许工作区写入</option><option value="readOnly">只读</option></select></label>
      <label className={labelCls}>Cron（五字段）<input required className={inputCls} value={form.cron} onChange={(event) => patch({ cron: event.target.value })} /></label>
      <label className={labelCls}>时区<input required className={inputCls} value={form.timezone} onChange={(event) => patch({ timezone: event.target.value })} /></label>
    </div>
    <label className={labelCls}>每次执行的任务<textarea required rows={7} maxLength={32000} className={inputCls} value={form.task} onChange={(event) => patch({ task: event.target.value })} placeholder="描述要做什么、使用哪些来源、希望看到什么结果；面板和预检由 Agent 按需生成" /></label>
    <label className={labelCls}>完成目标（留空则持续巡检）<textarea rows={2} className={inputCls} value={form.goal ?? ''} onChange={(event) => patch({ goal: event.target.value || null })} /></label>
    <div className="flex flex-wrap items-center gap-5 text-sm">
      <label><input type="checkbox" checked={form.enabled !== false} onChange={(event) => patch({ enabled: event.target.checked })} /> 启用计划</label>
      <label><input type="checkbox" checked={form.allowControl !== false} onChange={(event) => patch({ allowControl: event.target.checked })} /> 允许模型调整计划</label>
      <label>通知 <select className="rounded border bg-surface p-1" value={form.notify ?? 'auto'} onChange={(event) => patch({ notify: event.target.value as 'auto' | 'always' | 'never' })}><option value="auto">自动</option><option value="always">每次</option><option value="never">关闭</option></select></label>
    </div>
    <details><summary className="cursor-pointer text-sm text-secondary">后台权限</summary>
      <label className={`${labelCls} flex gap-2`}><input type="checkbox" checked={form.precheckNetworkAccess === true} onChange={(event) => patch({ precheckNetworkAccess: event.target.checked })} /> 允许预检联网（不自动放行模型 Bash 联网）</label>
      <p className={`${labelCls} mt-4`}>MCP 外部工具（可选）</p>
      <div className="mt-2 flex flex-wrap gap-2"><button type="button" className={btn} disabled={!!configureReason} title={configureReason} onClick={() => setEditingMcp(true)}>配置 MCP</button><button type="button" className={btn} disabled={discovering || !!discoverReason} title={discoverReason} onClick={() => void discovery()}>{discovering ? '正在读取工具…' : '刷新工具列表'}</button></div>
      {configureReason && <p className="mt-2 text-xs text-secondary">{configureReason}</p>}
      {discoverReason && <p className="mt-2 text-xs text-secondary">{discoverReason}。{!form.workspacePath && '配置服务器可以先完成。'}</p>}
      {serverCount === 0 && <p className="mt-2 text-xs text-secondary">未配置 MCP 也能创建 Loop，仍可使用文件、Shell 等内置工具。</p>}
      <p className="mt-3 text-sm font-medium text-primary">允许后台自动调用的工具（已选 {form.allowedMcpTools?.length ?? 0} 项）</p>
      <p className="mt-1 text-xs text-secondary">Loop 在后台运行时不会等待人工审批。仅允许自动调用你勾选的 MCP 工具；未勾选的工具不会获得后台调用授权。请确认工具是否会发消息、改数据等。</p>
      <p className="mt-2 text-xs text-secondary">服务器只供此 Loop 使用，不继承项目配置。修改服务器后需要重新勾选并保存授权；测试连接不会自动授权。</p>
      <div className="mt-2 max-h-56 space-y-2 overflow-auto">{visibleTools.map((tool) => <label key={tool.name} className="block rounded border border-hairline p-2 text-xs"><span className="flex items-start gap-2"><input type="checkbox" checked={form.allowedMcpTools?.includes(tool.name) ?? false} onChange={(event) => patch({ allowedMcpTools: event.target.checked ? [...new Set([...(form.allowedMcpTools ?? []), tool.name])] : (form.allowedMcpTools ?? []).filter((name) => name !== tool.name) })} /><code className="break-all">{tool.name}</code></span><span className="mt-1 block text-secondary">{tool.description}</span></label>)}</div>
      {toolsLoaded && !mcpTools.length && <p role="status" className="mt-2 text-xs text-secondary">当前未发现可用工具，请检查服务器是否启用、连接是否正常。原有授权不会因空列表自动增加或撤销。</p>}
    </details>
    <p className="text-xs text-secondary">{initial ? '面板、指标和预检由 Agent 维护；需要调整时，在任务详情选择“让 Agent 修改”。保存基本设置不会清空它们。' : '创建后 Agent 会先核实任务并按需生成持续面板、指标和预检；准备成功后才按计划执行，无需填写代码。'}</p>
    <p className="text-xs text-secondary">仅本机 Pi 执行。需要审批的工具会被拒绝；退出应用后不再调度，不会唤醒休眠的电脑。不同任务可同时修改同一工作区，请自行安排。</p>
    {error && <p role="alert" className="whitespace-pre-wrap text-sm text-destructive">{error}</p>}
    <div className="flex flex-wrap gap-3"><button type="submit" value="save" className={btnPrimary} disabled={busy || picking}>{busy ? '保存中…' : initial ? '保存' : '创建并准备'}</button>{!initial && <button type="submit" value="run" className={btn} disabled={busy || picking || form.enabled === false} title={form.enabled === false ? '请先启用计划' : '准备成功后立即执行一次'}>创建后立即执行</button>}<button type="button" className={btn} disabled={busy} onClick={onCancel}>取消</button></div>
    {editingMcp && createPortal(<McpConfigDialog name={form.name || '新 Loop'} description={initial ? '仅此 Loop 使用；保存立即生效并清空旧工具授权，关闭不会撤销已保存配置。' : '新任务的 MCP 草稿；创建时加密保存，不与项目或其他 Loop 共享。'} api={mcpApi} testUnavailableReason={!form.workspacePath ? '请先在创建页选择工作目录，再测试连接；现在可以填写并保存 MCP 草稿。' : undefined} onClose={() => setEditingMcp(false)} />, document.body)}
  </form>
}
