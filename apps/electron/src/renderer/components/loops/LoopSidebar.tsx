/** Loop 导航只查询中立任务索引；任务执行及持久化仍由后端负责。 */
import { useEffect, useState } from 'react'
import { useAtomValue, useSetAtom } from 'jotai'
import { Check, Circle, Loader2, Plus, Search } from 'lucide-react'
import type { LoopSummary } from '@axon/shared'
import { loopPageAtom } from '@/atoms/loop-page'
import { navigateAppAtom } from '@/atoms/app-navigation'
import { cn } from '@/lib/utils'

/** 订阅前先登记刷新入口；通知合并读取，卸载后不接纳迟到结果。 */
export function LoopSidebar(): React.ReactElement {
  const page = useAtomValue(loopPageAtom)
  const navigate = useSetAtom(navigateAppAtom)
  const [jobs, setJobs] = useState<LoopSummary[]>([])
  const [query, setQuery] = useState('')
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState<string | null>(null)
  const [retry, setRetry] = useState(0)
  useEffect(() => {
    let alive = true, sequence = 0
    let timer: ReturnType<typeof setTimeout> | undefined
    const refresh = async (): Promise<void> => {
      const request = ++sequence
      try {
        const values = await window.axon.loops.list()
        if (alive && request === sequence) { setJobs(values); setError(null) }
      } catch (cause) {
        if (alive && request === sequence) setError(cause instanceof Error ? cause.message : '加载任务失败')
      } finally { if (alive && request === sequence) setLoading(false) }
    }
    const release = window.axon.loops.onChanged(() => {
      if (timer) return
      timer = setTimeout(() => { timer = undefined; void refresh() }, 150)
    })
    void refresh()
    return () => { alive = false; sequence++; release(); clearTimeout(timer) }
  }, [retry])
  const needle = query.trim().toLocaleLowerCase()
  const visible = jobs.filter((job) => `${job.name} ${job.workspacePath}`.toLocaleLowerCase().includes(needle))
  const button = 'flex h-8 w-full items-center gap-1.5 rounded-md px-2 text-left text-xs transition-colors hover:bg-muted focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-ring'
  return <nav aria-label="Loop 任务导航" className="mt-3 flex min-h-0 flex-1 flex-col gap-2">
    <button type="button" className={cn(button, 'justify-center rounded-full border bg-background', page?.kind === 'create' && 'bg-muted font-medium')} onClick={() => navigate({ page: { kind: 'create' } })}><Plus size={14} />新建 Loop</button>
    <button type="button" aria-current={page?.kind === 'overview' ? 'page' : undefined} className={cn(button, page?.kind === 'overview' ? 'bg-muted font-medium' : 'text-muted-foreground')} onClick={() => navigate({ page: { kind: 'overview' } })}>任务总览</button>
    <label className="relative block px-1">
      <Search size={12} className="pointer-events-none absolute left-3 top-1/2 -translate-y-1/2 text-muted-foreground" />
      <input type="search" aria-label="搜索 Loop 任务" placeholder="搜索任务或目录" value={query} onChange={(event) => setQuery(event.target.value)} className="h-7 w-full rounded border bg-muted/40 pl-7 pr-2 text-xs outline-none placeholder:text-muted-foreground focus:bg-background focus:ring-1 focus:ring-ring" />
    </label>
    <div className="min-h-0 flex-1 overflow-y-auto scrollbar-none">
      {loading && <p className="px-2 py-6 text-center text-xs text-muted-foreground">正在加载任务…</p>}
      {error && <div role="alert" className="px-2 py-3 text-xs text-destructive"><p>{error}</p><button type="button" className="mt-2 underline" onClick={() => setRetry((value) => value + 1)}>重新加载</button></div>}
      {!loading && !error && !visible.length && <p className="px-2 py-6 text-center text-xs text-muted-foreground">{needle ? '没有匹配的任务' : '暂无任务，请新建 Loop'}</p>}
      {[false, true].map((completed) => {
        const group = visible.filter((job) => (job.completedAt !== null) === completed)
        if (!group.length) return null
        return <section key={String(completed)} aria-label={completed ? '已完成任务' : 'Loop 任务'} className="mb-3">
          <h2 className="px-2 py-2 text-[11px] font-medium text-muted-foreground">{completed ? '已完成' : '任务'}<span className="ml-2 font-mono">{group.length}</span></h2>
          {group.map((job) => {
            const active = page && 'id' in page && page.id === job.id
            const status = job.preparation === 'pending' ? '准备配置中' : job.preparation === 'failed' ? '配置待完成' : job.running ? '运行中' : job.queued ? '排队中' : job.completedAt !== null ? '已完成' : job.enabled ? '已启用' : '已暂停'
            const Icon = job.running ? Loader2 : job.completedAt !== null ? Check : Circle
            return <button key={job.id} type="button" aria-label={`查看 Loop ${job.name}`} aria-current={active ? 'page' : undefined} title={`${job.name} · ${job.workspacePath} · ${status}`} onClick={() => navigate({ page: { kind: 'detail', id: job.id } })}
              className={cn(button, 'h-auto min-h-10 items-start py-1.5', active ? 'bg-muted text-foreground' : 'text-muted-foreground')}>
              <Icon size={12} aria-label={status} className={cn('mt-1 shrink-0', job.running && 'animate-spin motion-reduce:animate-none', job.enabled && job.completedAt === null && 'text-foreground')} />
              <span className="min-w-0 flex-1"><span className="block truncate">{job.name}</span><span className="block truncate text-[10px] text-muted-foreground">{job.workspacePath} · {status}</span></span>
            </button>
          })}
        </section>
      })}
    </div>
  </nav>
}
