/** Axon Loop 展示组件与纯计算；第三方许可见 THIRD_PARTY_NOTICES.md。 */
import { useState } from 'react'
import { Tooltip } from '@base-ui/react/tooltip'
import type { JobSummary, RunSummary } from '../types'
import { dotColor, dotLabel, dur, fmt, isCompleted, money, until } from '../lib/format'
import { runPulseAnim, useHydrated } from './ui'

export const WINDOW = 16
const PAGE = WINDOW
const RAD = 'rounded-[4px]'
const SEG = `h-5 w-[18px] shrink-0 ${RAD}`

function RunSeg({ run, onClick }: { run: RunSummary; onClick: () => void }) {
  const body = run.error || run.message || ''
  const meta =
    (run.durationMs ? ` · ${dur(run.durationMs)}` : '') +
    (run.costUsd != null ? ` · ${money(run.costUsd)}` : '')
  return (
    <Tooltip.Root>
      <Tooltip.Trigger
        render={
          <button
            type="button"
            onClick={(e) => {
              e.stopPropagation()
              onClick()
            }}
            aria-label={dotLabel(run)}
            className={`${SEG} cursor-pointer transition-opacity hover:opacity-70`}
            style={{ background: dotColor(run), ...(run.running ? runPulseAnim : {}) }}
          />
        }
      />
      <Tooltip.Portal>
        <Tooltip.Positioner sideOffset={8}>
          <Tooltip.Popup className="axon-loop-ui glass-strong pointer-events-none max-w-[340px] rounded-control px-3.5 py-2.5 text-meta leading-snug text-primary">
            <div className="flex items-center gap-1.5 font-medium">
              {/* 方块表示历史执行，圆点保留给下一次计划。 */}
              <span className="size-2 shrink-0 rounded-[2px]" style={{ background: dotColor(run) }} />
              {dotLabel(run)}
              <span className="ml-auto whitespace-nowrap pl-3 font-mono text-caption font-normal text-secondary">
                {fmt(run.ts)}
                {meta}
              </span>
            </div>
            {body && (
              <div
                className={`mt-1.5 max-h-[150px] overflow-hidden whitespace-pre-wrap ${
                  run.error ? 'text-accent' : 'text-secondary'
                }`}
              >
                {body}
              </div>
            )}
          </Tooltip.Popup>
        </Tooltip.Positioner>
      </Tooltip.Portal>
    </Tooltip.Root>
  )
}

function Pager({ count, onClick, loading }: { count: number; onClick: () => void; loading?: boolean }) {
  if (!count) return null
  return (
    <button
      type="button"
      onClick={(e) => {
        e.stopPropagation()
        onClick()
      }}
      className={`flex h-5 w-[18px] shrink-0 items-center justify-center overflow-hidden border border-wire px-0 font-mono text-[9px] leading-none text-disabled transition-colors hover:border-display hover:text-primary ${RAD} ${
        loading ? 'animate-pulse' : 'cursor-pointer'
      }`}
      title={`${count} more - click to reveal`}
    >
      {loading ? '…' : count}
    </button>
  )
}

/** Axon Loop 界面：按输入数据渲染并管理本地交互，不访问后端实现。 */
export function Timeline({
  job,
  runs,
  total,
  onLoadMore,
  onPickRun,
}: {
  job: JobSummary


  runs: RunSummary[]

  total: number

  onLoadMore: () => Promise<number>
  onPickRun: (run: RunSummary) => void
}) {
  const all = runs
  const en = job.enabled
  const done = isCompleted(job)
  const L = all.length


  const unloaded = Math.max(0, total - L)
  const hydrated = useHydrated()



  const [winStart, setWinStart] = useState(-1)
  const [loading, setLoading] = useState(false)
  const maxStart = Math.max(0, L - WINDOW)
  const start = winStart < 0 ? maxStart : Math.min(winStart, maxStart)
  const end = Math.min(start + WINDOW, L)
  const visible = all.slice(start, end)
  const olderHidden = unloaded + start
  const newerHidden = L - end
  const atLatest = newerHidden === 0

  const pageBack = async () => {
    const target = start - PAGE


    if (target < 0 && unloaded > 0 && !loading) {
      setLoading(true)
      const added = await onLoadMore().catch(() => 0)
      setLoading(false)
      setWinStart(Math.max(0, start + added - PAGE))
      return
    }
    setWinStart(Math.max(0, target))
  }
  const pageFwd = () => {
    const next = start + PAGE
    setWinStart(next >= maxStart ? -1 : next)
  }






  const running = (!!job.running || !!job.queued) && atLatest



  const showNext = atLatest && en && !done && !!job.nextRun && !running

  return (








    <div className="flex min-w-0 items-center gap-[3px] overflow-x-auto">
      <Pager count={olderHidden} onClick={pageBack} loading={loading} />
      {visible.map((r) => (
        <RunSeg key={r.id} run={r} onClick={() => onPickRun(r)} />
      ))}
      {showNext ? (
        <div className="ml-1 flex items-center gap-2">
          <span className="w-12 border-t border-dashed border-wire" />
          <span
            className="size-[11px] shrink-0 rounded-full border border-wire"
            title={hydrated ? `Next scheduled run · ${fmt(job.nextRun)}` : undefined}
          />
          <span className="text-caption text-disabled">{hydrated ? until(job.nextRun) : ''}</span>
        </div>
      ) : (
        !atLatest && <Pager count={newerHidden} onClick={pageFwd} />
      )}
    </div>
  )
}
