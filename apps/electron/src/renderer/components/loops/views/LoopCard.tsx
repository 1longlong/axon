/** Axon Loop 展示组件与纯计算；第三方许可见 THIRD_PARTY_NOTICES.md。 */
import { useMemo, useState } from 'react'
import type { JobSummary, RunSummary } from '../types'
import { cronText, dotLabel, fmt, isClosed, isCompleted, lastRunOf, rel } from '../lib/format'
import { mergeRuns } from '../lib/runs'
import { loadOlderRuns } from '../data/loop-api'
import { Timeline, WINDOW } from './Timeline'
import { Pill, useHydrated } from './ui'

/** Axon Loop 界面：按输入数据渲染并管理本地交互，不访问后端实现。 */
export function LoopCard({
  job,
  onOpen,
  onPickRun,
}: {
  job: JobSummary
  onOpen: (id: string) => void
  onPickRun: (id: string, run: RunSummary) => void
}) {
  const en = job.enabled
  const last = lastRunOf(job)
  const completed = isCompleted(job)


  const closedActive = isClosed(job) && !completed
  const hydrated = useHydrated()





  const [older, setOlder] = useState<RunSummary[]>([])


  const runs = useMemo(
    () => (older.length ? mergeRuns(job.runs ?? [], older) : (job.runs ?? [])),
    [job.runs, older],
  )

  const loadMore = async (): Promise<number> => {
    const oldest = runs[0]
    if (!oldest) return 0
    const more = await loadOlderRuns({ data: { loopId: job.id, beforeRunId: oldest.id, limit: WINDOW } })
    if (more.length) setOlder((prev) => mergeRuns(prev, more))
    return more.length
  }




  return (
    <div
      onClick={() => onOpen(job.id)}
      className={`mb-[18px] cursor-pointer rounded-card border border-hairline bg-surface px-[26px] pb-5 pt-[22px] shadow-card transition-colors hover:border-wire ${
        en ? '' : 'opacity-60'
      }`}
      style={{ animation: 'fadeIn .25s cubic-bezier(0.25,0.1,0.25,1) both' }}
    >
      <div className="mb-6 flex flex-wrap items-center gap-3">
        <button
          type="button"
          onClick={(e) => {
            e.stopPropagation()
            onOpen(job.id)
          }}
          className="cursor-pointer rounded-sm text-left text-[17px] font-semibold tracking-[-0.01em] text-display outline-none focus-visible:ring-2 focus-visible:ring-interactive focus-visible:ring-offset-4 focus-visible:ring-offset-surface"
        >
          {job.name}
        </button>
        {job.running && (
          <Pill tone="running" dot="pulse">
            {job.preparation === 'pending' ? '准备配置中' : 'Running'}
          </Pill>
        )}
        {/* 等待不冒充正在执行，也不播放运行脉冲。 */}
        {!job.running && job.queued && <Pill>Queued</Pill>}
        {job.preparation === 'failed' && <Pill>配置待完成</Pill>}
        {job.graduation && <Pill>{job.graduation}</Pill>}
        {completed && (
          <Pill tone="success" dot="green">
            Completed
          </Pill>
        )}
        {!completed && closedActive && (
          <Pill tone="success" title={job.goal ?? undefined}>
            Goal
          </Pill>
        )}
        {!completed && !en && <Pill>Paused</Pill>}
        <div className="ml-auto whitespace-nowrap text-meta text-secondary">
          <span className="text-primary" title={job.cron}>
            {cronText(job.cron)}
          </span>
          <span className="mx-2.5 text-wire">·</span>
          {job.kind}
        </div>
      </div>

      <Timeline
        job={job}
        runs={runs}
        total={job.runCount}
        onLoadMore={loadMore}
        onPickRun={(run) => onPickRun(job.id, run)}
      />

      <div className="mt-[18px] flex items-center gap-2 text-label text-secondary">
        <span>{job.runCount} runs</span>
        {last && (
          <span>
            · last {dotLabel(last)}
            {hydrated && ` · ${rel(last.ts)}`}
          </span>
        )}
      </div>

      {completed && (
        <div className="mt-1.5 text-label text-success">
          Completed{job.completedAt ? ` · ${fmt(job.completedAt)}` : ''}
          {job.completionReason && <span className="text-secondary"> - {job.completionReason}</span>}
        </div>
      )}
    </div>
  )
}
