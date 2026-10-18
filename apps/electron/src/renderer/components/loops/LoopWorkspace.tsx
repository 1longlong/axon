/** Loop 页面保留卡片、时间线、内容主栏与元数据侧栏；固定桥接替代 Web 路由/服务。 */
import { useCallback, useEffect, useRef, useState } from 'react'
import type { ReactNode } from 'react'
import { useAtom, useSetAtom } from 'jotai'
import { Tooltip } from '@base-ui/react/tooltip'
import { createTwoFilesPatch } from 'diff'
import type { LoopDetail, LoopRunDetail, SDKMessage } from '@axon/shared'
import { loopPageAtom } from '@/atoms/loop-page'
import type { LoopPage } from '@/atoms/loop-page'
import { navigateAppAtom } from '@/atoms/app-navigation'
import { AgentAssistantTurnItem, AgentMessageItem } from '@/components/agent/AgentMessageItem'
import { TaskProgressCard } from '@/components/agent/TaskProgressCard'
import { useAgentTaskController } from '@/components/agent/AgentStateProvider'
import { groupAgentTurns } from '@/lib/agent-turn-groups'
import { indexAgentToolMessages } from '@/lib/agent-tool-messages'
import { LoopForm } from './LoopForm'
import { toArtifact, toJob, toRun } from './data/loop-api'
import type { JobSummary, RunDiffFile } from './types'
import { LoopCard } from './views/LoopCard'
import { LoopView } from './views/LoopView'
import { LoopFilesPanel } from './views/LoopFilesPanel'
import { Timeline } from './views/Timeline'
import { DiffView } from './views/DiffView'
import { ArtifactBody } from './views/artifactView'
import { btn, btnPrimary, btnQuiet, inputCls, Pill, StatusPill } from './views/ui'
import { dotColor, dotLabel, dur, fmt, money, roleLabel, triggerLabel } from './lib/format'
import './loop.css'

function Card({ title, children }: { title: string; children: ReactNode }) {
  return <section className="min-w-0 rounded-card border border-hairline bg-surface p-5 shadow-card"><h2 className="mb-4 border-b border-hairline pb-2 text-label font-semibold text-secondary">{title}</h2>{children}</section>
}

/** 切页失效旧读取；隐藏时停止视图轮询但保留阅读状态，不停止后端运行。 */
export function LoopWorkspace({ active = true }: { active?: boolean }) {
  const [page, setPage] = useAtom(loopPageAtom)
  const navigate = useSetAtom(navigateAppAtom)
  const go = (next: LoopPage): void => { navigate({ page: next }) }
  const [jobs, setJobs] = useState<JobSummary[]>([])
  const [detail, setDetail] = useState<LoopDetail | null>(null)
  const [run, setRun] = useState<LoopRunDetail | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [notice, setNotice] = useState<{ loopId: string; text: string } | null>(null)
  const [busy, setBusy] = useState(false)
  const [loading, setLoading] = useState(true)
  const [instruction, setInstruction] = useState('')
  const [editing, setEditing] = useState(false)
  const [file, setFile] = useState<string | null>(null)
  const requestSequence = useRef(0)
  const mounted = useRef(true)
  useEffect(() => { mounted.current = true; return () => { mounted.current = false; requestSequence.current++ } }, [])
  const refresh = useCallback(async (): Promise<void> => {
    if (!page) return
    const sequence = ++requestSequence.current
    try {
      const value = page.kind === 'overview' ? await window.axon.loops.list()
        : page.kind === 'create' ? null : page.kind === 'run' ? await window.axon.loops.runDetail(page.id, page.runId) : await window.axon.loops.get(page.id)
      if (!mounted.current || sequence !== requestSequence.current) return
      if (Array.isArray(value)) setJobs(value.map(toJob))
      else if (value && 'run' in value) setRun(value)
      else if (value) setDetail(value)
      setError(null)
    } catch (cause) { if (mounted.current && sequence === requestSequence.current) setError(cause instanceof Error ? cause.message : String(cause)) }
    finally { if (mounted.current && sequence === requestSequence.current) setLoading(false) }
  }, [page])
  useEffect(() => {
    setDetail(null); setRun(null); setLoading(true); setEditing(false); setFile(null); setInstruction('')
  }, [page])
  useEffect(() => {
    if (!active) return
    // 模块切回只校准数据，不清空已展示详情或重置其滚动容器。
    void refresh()
    let timer: ReturnType<typeof setTimeout> | undefined
    const release = window.axon.loops.onChanged((event) => {
      if (page?.kind !== 'overview' && page && 'id' in page && page.id !== event.loopId) return
      if (timer) return
      timer = setTimeout(() => { timer = undefined; void refresh() }, 150)
    })
    const poll = setInterval(() => void refresh(), 4000)
    return () => { release(); clearInterval(poll); clearTimeout(timer); requestSequence.current++ }
  }, [active, page, refresh])
  /** 变更交付未知不自动重发；按钮锁定至原请求返回，再查询权威状态。 */
  const action = async (operation: () => Promise<unknown>): Promise<void> => {
    if (busy) return
    setBusy(true); setError(null)
    try { await operation(); if (mounted.current) await refresh() }
    catch (cause) { if (mounted.current) setError(cause instanceof Error ? cause.message : String(cause)) }
    finally { if (mounted.current) setBusy(false) }
  }
  const back = (): void => go(page && 'id' in page ? { kind: 'detail', id: page.id } : { kind: 'overview' })
  if (!page) return null
  const job = detail ? toJob(detail.job) : run ? toJob(run.job) : null
  const openRun = (id: string, runId: string): void => go({ kind: 'run', id, runId })
  return <Tooltip.Provider delay={120}><div className="axon-loop-ui h-full min-h-0 overflow-y-auto bg-background text-foreground">
    <header className="sticky top-0 z-20 flex min-h-14 items-center gap-3 border-b border-hairline bg-surface px-8 py-3 titlebar-drag-region">
      <button type="button" className={`${btnQuiet} titlebar-no-drag`} onClick={() => go({ kind: 'overview' })}>Axon · Loop</button>
      <span className="min-w-0 flex-1 truncate text-meta text-secondary">{job?.name ?? '本地周期任务'}</span>
      <button type="button" className={`${btnPrimary} titlebar-no-drag`} onClick={() => go({ kind: 'create' })}>新建 Loop</button>
    </header>
    <div className="mx-auto max-w-[1360px] px-8 pb-24 pt-8">
      {page.kind !== 'overview' && <button type="button" className={`${btnQuiet} mb-5`} onClick={page.kind === 'detail' ? () => go({ kind: 'overview' }) : back}>← {page.kind === 'detail' ? '全部 Loop' : '返回'}</button>}
      {error && <div role="alert" className="mb-5 flex items-start gap-4 rounded-control border border-destructive/30 p-4 text-sm text-destructive"><span className="flex-1 whitespace-pre-wrap">{error}</span><button type="button" onClick={() => void refresh()}>刷新</button></div>}
      {notice && page && 'id' in page && notice.loopId === page.id && <div role="alert" className="mb-5 flex gap-3 rounded-control border border-hairline p-4 text-sm"><span className="flex-1">{notice.text}</span><button onClick={() => setNotice(null)}>关闭</button></div>}
      {loading && !job && page.kind !== 'create' ? <p className="py-16 text-center text-secondary">正在读取任务…</p> : null}
      {page.kind === 'create' || page.kind === 'settings' && detail ? <><h1 className="mb-5 text-2xl font-semibold">{page.kind === 'create' ? '新建 Loop' : '手动设置'}</h1><LoopForm key={page.kind === 'settings' ? page.id : 'new'} initial={page.kind === 'settings' ? detail?.job : undefined} onSaved={(id, runId, warning) => { setNotice(warning ? { loopId: id, text: warning } : null); setPage(runId ? { kind: 'run', id, runId } : { kind: 'detail', id }) }} onCancel={back} /></> : null}
      {page.kind === 'overview' && !loading && <div className="mx-auto max-w-[1116px]">
        <section className="pb-2 pt-10 text-center"><h1 className="text-[32px] font-medium tracking-tight text-display">让任务持续推进</h1><p className="mt-3 text-sm text-secondary">本机运行 · 独立会话 · 结果与产物持续积累</p><button className={`${btnPrimary} mt-7`} onClick={() => go({ kind: 'create' })}>创建一个 Loop →</button></section>
        {[false, true].map((completed) => {
          const visible = jobs.filter((item) => !!item.completedAt === completed)
          if (completed && !visible.length) return null
          return <section key={String(completed)} className="mt-11"><h2 className="mb-5 flex items-baseline gap-3 text-sm font-semibold">{completed ? '已完成' : '进行中的 Loop'}<span className="text-label font-normal text-secondary">{visible.filter((item) => item.enabled).length} 个计划 · {visible.length} 个任务</span></h2>
            {visible.length ? visible.map((item) => <LoopCard key={item.id} job={item} onOpen={(id) => go({ kind: 'detail', id })} onPickRun={(id, value) => openRun(id, value.id)} />) : <p className="py-16 text-center text-sm text-secondary">暂无任务。创建 Loop 后，执行结果会显示在这里。</p>}</section>
        })}
      </div>}
      {page.kind === 'detail' && detail && job && <>
        <section className="rounded-card border border-hairline bg-surface px-6 py-5 shadow-card">
          <div className="flex flex-wrap items-center gap-3"><h1 className="text-[26px] font-medium text-display">{job.name}</h1><Pill>{job.preparation === 'pending' ? '准备配置中' : job.preparation === 'failed' ? '配置待完成' : job.completedAt ? '已完成' : job.running ? '运行中' : job.enabled ? '已启用' : '已暂停'}</Pill></div>
          <p className="mt-3 break-all text-meta text-secondary">{job.cron} · {job.timezone} · {job.modelId}<br />{job.workspacePath}</p>
          {job.nextFire !== null && <p className="mt-2 text-xs text-secondary">下次安排 · {fmt(new Date(job.nextFire).toISOString())}</p>}
          {job.goal && <p className="mt-4 whitespace-pre-wrap text-body"><span className="text-secondary">目标 · </span>{job.goal}</p>}
          {job.completionReason && <p className="mt-3 text-sm text-success">{job.completionReason}</p>}
          {job.storageError && <p role="alert" className="mt-3 text-sm text-destructive">{job.storageError}</p>}
          {detail.taskFileError && <p role="alert" className="mt-3 text-sm text-destructive">{detail.taskFileError}</p>}
          {job.preparation !== 'ready' && <div className="mt-4 rounded-control border border-hairline bg-raised p-4 text-sm">
            <p>{job.preparation === 'pending' ? 'Agent 正在核实任务并按需生成面板、指标和预检。准备完成前不会执行普通任务。' : '配置尚未准备完成，定时及手动任务均未启动。请查看准备记录，必要时调整任务或权限后重新准备。'}</p>
            {job.preparation === 'failed' && <button className={`${btn} mt-3`} disabled={busy || job.running || job.queued} onClick={() => void action(() => window.axon.loops.prepare(job.id))}>重新准备</button>}
          </div>}
          <div className="mt-5 flex flex-wrap gap-2 border-t border-hairline pt-4">
            <button className={btnPrimary} disabled={busy || job.preparation !== 'ready' || job.running || job.queued || !job.enabled} onClick={() => void action(async () => { const result = await window.axon.loops.run(job.id); if (result.runId) openRun(job.id, result.runId) })}>立即执行</button>
            <button className={btn} disabled={busy} onClick={() => void action(() => window.axon.loops.update(job.id, { enabled: !job.enabled }))}>{job.completedAt ? '重新开启' : job.enabled ? '暂停计划' : '启用计划'}</button>
            {(job.running || job.queued) && job.latestRun && <button className={btn} disabled={busy} onClick={() => void action(() => window.axon.loops.stop(job.id, job.latestRun!.id))}>停止本次</button>}
            <button className={btn} disabled={busy || job.preparation !== 'ready' || !job.enabled} onClick={() => setEditing(!editing)}>让 Agent 修改</button>
            <button className={btn} disabled={busy || job.preparation !== 'ready' || !job.enabled} onClick={() => void action(() => window.axon.loops.evolve(job.id))}>优化任务</button>
            <button className={btn} onClick={() => go({ kind: 'settings', id: job.id })}>手动设置</button>
            <button className={`${btnQuiet} ml-auto text-destructive`} disabled={busy || job.running || job.queued} title={job.running || job.queued ? '请先停止本次执行，等待结束后再删除' : '删除计划，保留任务文件和已保存历史'} onClick={() => { if (window.confirm('删除此 Loop 的计划？保留工作区中的任务文件和已保存历史；不会自动停止正在执行的任务。')) void action(async () => { await window.axon.loops.delete(job.id); go({ kind: 'overview' }) }) }}>删除</button>
          </div>
        </section>
        <MaintenanceStatus detail={detail} onPick={(runId) => openRun(job.id, runId)} />
        {editing && <Card title="让 Agent 修改"><textarea aria-label="修改要求" rows={3} className={inputCls} value={instruction} onChange={(event) => setInstruction(event.target.value)} placeholder="说明想怎样修改任务、计划或面板" /><button className={`${btnPrimary} mt-3`} disabled={busy || !instruction.trim()} onClick={() => void action(async () => { await window.axon.loops.edit(job.id, instruction); setEditing(false); setInstruction('') })}>提交修改</button></Card>}
        {job.preparation === 'ready' && job.ui && <div className="mt-6"><Card title="Dashboard"><LoopView html={job.ui} runs={detail.runs.map(toRun)} loopId={job.id} taskFile={job.taskFile} /></Card></div>}
        <div className="mt-6 grid grid-cols-1 gap-6 xl:grid-cols-[minmax(0,1fr)_minmax(300px,360px)]">
          <LoopFilesPanel loopId={job.id} taskFile={job.taskFile} taskFileContent={detail.taskFileContent} taskFileSyncedAt={new Date(job.updatedAt).toISOString()} running={job.running} />
          <RunsPanel detail={detail} onPick={(id) => openRun(job.id, id)} />
        </div>
      </>}
      {page.kind === 'run' && run && <RunPage detail={run} active={active} selectedFile={file} onSelectFile={setFile} onStop={() => void action(() => window.axon.loops.stop(run.job.id, run.run.id))} busy={busy} />}
    </div>
  </div></Tooltip.Provider>
}

/** 待办来自持久状态，进度与完成反馈绑定真实执行 ID；切页重开仍可查看最近结果。 */
function MaintenanceStatus({ detail, onPick }: { detail: LoopDetail; onPick: (runId: string) => void }) {
  const latest = (['setup', 'edit', 'evolve'] as const).flatMap((role) => {
    const run = detail.runs.find((item) => item.role === role)
    return run ? [run] : []
  })
  return <div className="mt-6 space-y-3">
    {detail.pendingMaintenance.map((pending) => <Card key={`pending-${pending.role}`} title={`${roleLabel[pending.role]}已排队`}>
      <p className="text-xs text-secondary">{triggerLabel[pending.trigger]} · {detail.job.enabled ? '将在当前执行结束或下次安排到达后处理，不与本次并行。' : '计划已暂停，启用后处理。'}</p>
      {pending.instruction && <p className="mt-2 whitespace-pre-wrap text-sm">{pending.instruction}</p>}
    </Card>)}
    {latest.map((run) => <Card key={run.id} title={`${roleLabel[run.role]} · ${run.running ? '进行中' : run.queued ? '等待执行' : run.phase === 'done' ? '已完成' : run.phase === 'canceled' ? '已取消' : run.phase === 'interrupted' ? '已中断' : '失败'}`}>
      <p className="text-xs text-secondary">{triggerLabel[run.trigger]} · {fmt(run.ts)}{run.costUsd !== undefined ? ` · ${money(run.costUsd)}` : ''}</p>
      {run.instruction && <p className="mt-2 line-clamp-2 whitespace-pre-wrap text-sm">{run.instruction}</p>}
      <p className={`mt-2 whitespace-pre-wrap text-sm ${run.error ? 'text-destructive' : ''}`}>{run.error || (run.running ? run.progress?.label || '正在处理…' : run.message || '暂无回报，请查看执行详情。')}</p>
      <button className={`${btnQuiet} mt-3`} onClick={() => onPick(run.id)}>查看执行详情</button>
    </Card>)}
  </div>
}

/** 分页采用执行 ID 而非时间戳，允许同毫秒产生的不同记录完整显示。 */
function RunsPanel({ detail, onPick }: { detail: LoopDetail; onPick: (id: string) => void }) {
  const [older, setOlder] = useState<LoopDetail['runs']>([])
  const runs = [...new Map([...detail.runs, ...older].map((run) => [run.id, run])).values()].sort((a, b) => b.queuedAt - a.queuedAt)
  const more = async (): Promise<number> => {
    const page = await window.axon.loops.runs(detail.job.id, runs.at(-1)?.id, 50)
    setOlder((previous) => [...previous, ...page]); return page.length
  }
  return <Card title={`运行记录（${detail.job.runCount}） · ${money(detail.job.totalCostUsd)}`}>
    <Timeline job={toJob(detail.job)} runs={runs.map(toRun).reverse()} total={detail.job.runCount} onLoadMore={more} onPickRun={(run) => onPick(run.id)} />
    <ul className="mt-5 max-h-[520px] divide-y divide-hairline overflow-auto border-t border-hairline">{runs.map((run) => <li key={run.id}><button className="flex w-full items-start gap-2.5 py-3 text-left hover:bg-raised" onClick={() => onPick(run.id)}><span className="mt-1 size-2.5 shrink-0 rounded-sm" style={{ background: dotColor(toRun(run)) }} /><span className="min-w-0 flex-1"><span className="flex justify-between font-mono text-caption text-secondary">{fmt(run.ts)}<span>{dur(run.durationMs)}</span></span><span className="mt-1 block text-xs text-secondary">{triggerLabel[run.trigger]} · {roleLabel[run.role]}</span><span className="mt-1 block line-clamp-2 text-meta">{run.progress?.label || run.error || run.message || dotLabel(toRun(run))}</span></span></button></li>)}</ul>
    {runs.length < detail.job.runCount && <button className={`${btnQuiet} mt-3`} onClick={() => void more()}>更早的记录</button>}
  </Card>
}

function Transcript({ running, sessionId, active }: { running: boolean; sessionId?: string; active: boolean }) {
  const controller = useAgentTaskController()
  const [messages, setMessages] = useState<SDKMessage[]>([])
  const [error, setError] = useState<string | null>(null)
  const sequence = useRef(0)
  useEffect(() => { setMessages([]); setError(null) }, [sessionId])
  useEffect(() => { if (active && sessionId) void controller.loadTasks(sessionId) }, [active, controller, sessionId])
  useEffect(() => {
    if (!active || !sessionId) return
    let alive = true
    // 复用分页历史桥，不把整份 JSONL 塞进每次 Loop 元数据刷新。
    const load = async (): Promise<void> => {
      const request = ++sequence.current
      try { const value = await window.axon.agent.getMessages(sessionId); if (alive && request === sequence.current) { setMessages(value); setError(null) } }
      catch { if (alive && request === sequence.current) setError('执行历史读取失败，请刷新页面重试。') }
    }
    void load()
    const timer = running ? setInterval(() => void load(), 3000) : undefined
    return () => { alive = false; sequence.current++; clearInterval(timer) }
  }, [active, sessionId, running])
  const groups = groupAgentTurns(messages)
  const index = indexAgentToolMessages(messages)
  return <div className="space-y-5">{error && <p role="alert" className="text-sm text-destructive">{error}</p>}{groups.map((group, i) => group.kind === 'user' ? <AgentMessageItem key={i} message={group.message} /> : <AgentAssistantTurnItem key={i} messages={group.messages} toolResultsById={index.resultsByToolUseId} hideToolResult={(id) => index.toolUsesById.has(id)} running={running && group.resultIndex === undefined}
    renderToolUse={(tool) => tool.name === 'Agent' && sessionId ? <TaskProgressCard rootSessionId={sessionId} toolUse={tool} /> : null} />)}{!messages.length && <p className="text-sm text-secondary">本次没有模型会话，或正在初始化。预检直接完成时不会创建模型会话。</p>}</div>
}

/** 单次结果只读取对应的应用历史和产物版本，不能用当前文件替代历史。 */
function RunPage({ detail, selectedFile, onSelectFile, onStop, busy, active }: { detail: LoopRunDetail; selectedFile: string | null; onSelectFile: (path: string) => void; onStop: () => void; busy: boolean; active: boolean }) {
  const { run, job } = detail
  const file = detail.artifacts.find((item) => item.path === selectedFile) ?? detail.artifacts[0]
  const changes: RunDiffFile[] = detail.changes.map((change) => {
    const binary = change.before === null && change.after === null
    const tooLarge = (change.before?.length ?? 0) + (change.after?.length ?? 0) > 128000
    return { path: change.path, status: change.status === 'deleted' ? 'removed' : change.status, binary, tooLarge, sizeDelta: null,
      ...(!binary && !tooLarge ? { diff: createTwoFilesPatch(change.path, change.path, change.before ?? '', change.after ?? '') } : {}) }
  })
  return <>
    <header className="rounded-card border border-hairline bg-surface p-6 shadow-card"><div className="flex flex-wrap items-center gap-3"><h1 className="text-[26px] font-medium">Run · {job.name}</h1><StatusPill run={toRun(run)} colorText /></div><div className="mt-3 flex flex-wrap gap-3 text-meta text-secondary">{fmt(run.ts)}<Pill>{roleLabel[run.role]}</Pill><span>{triggerLabel[run.trigger]}</span><span>{dur(run.durationMs)} · {money(run.costUsd)}</span><code className="break-all">{run.id}</code></div>{(run.running || run.queued) && <button disabled={busy} className={`${btn} mt-4`} onClick={onStop}>停止本次执行</button>}</header>
    <div className="mt-6 grid grid-cols-1 gap-6 xl:grid-cols-[minmax(0,1fr)_minmax(280px,340px)]"><div className="min-w-0 space-y-6">
      {(run.running || run.queued) && <Card title="当前活动"><p className="text-sm" aria-live="polite">{run.progress?.label ?? (run.queued ? '等待执行' : '正在执行…')}</p>{!!run.activity?.length && <ol className="mt-3 max-h-48 space-y-1 overflow-auto text-xs text-secondary">{run.activity.map((item) => <li key={item.step}><span className="mr-2 font-mono">{item.step}</span>{item.label}</li>)}</ol>}</Card>}
      {(run.message || run.finalText) && <Card title="Report"><p className="whitespace-pre-wrap break-words text-body">{run.message || run.finalText}</p></Card>}
      {run.error && <Card title="执行错误"><p role="alert" className="whitespace-pre-wrap break-words text-sm text-destructive">{run.error}</p></Card>}
      {changes.length > 0 && <Card title="历史变更"><DiffView files={changes} /></Card>}
      <Card title="Execution"><Transcript active={active} running={run.running} sessionId={run.sessionId} /></Card>
      {detail.artifacts.length > 0 && <Card title="本次产物"><div className="mb-3 flex flex-wrap gap-2">{detail.artifacts.map((item) => <button key={item.path} className={btnQuiet} aria-pressed={file?.path === item.path} onClick={() => onSelectFile(item.path)}>{item.path}</button>)}</div>{file && <ArtifactBody loopId={job.id} file={toArtifact(file, run.id)} />}</Card>}
    </div><aside className="min-w-0 space-y-6"><Card title="Details"><dl className="space-y-3 text-sm"><dt className="text-secondary">状态</dt><dd>{run.phase}</dd><dt className="text-secondary">指标</dt><dd className="break-all font-mono">{JSON.stringify(run.state ?? {})}</dd><dt className="text-secondary">用量</dt><dd className="break-all font-mono">{run.usage ? JSON.stringify(run.usage) : '—'}</dd><dt className="text-secondary">会话</dt><dd className="break-all font-mono text-xs">{run.sessionId ?? '无模型会话'}</dd></dl></Card>
      {detail.controls.length > 0 && <Card title="计划变更"><ul className="space-y-2 text-xs">{detail.controls.map((control, i) => <li key={i}><code>{control.verb}</code><p className="break-words text-secondary">{control.detail}</p></li>)}</ul></Card>}
      <details className="rounded-card border border-hairline bg-surface p-4"><summary className="cursor-pointer text-sm">本次发送的任务</summary><pre className="mt-3 max-h-96 overflow-auto whitespace-pre-wrap break-words text-xs">{detail.query || '未请求模型'}</pre></details>
    </aside></div>
  </>
}
