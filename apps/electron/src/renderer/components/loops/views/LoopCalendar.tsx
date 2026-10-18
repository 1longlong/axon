/** Axon Loop 展示组件与纯计算；第三方许可见 THIRD_PARTY_NOTICES.md。 */
import { useEffect, useMemo, useRef, useState } from 'react'
import type { ArtifactSummary } from '../types'
import { fmt } from '../lib/format'
import { isTaskPath } from '../lib/fileEntries'
import { localDay, matchArtifacts, productDate, type ProductDate } from '../lib/productDate'
import { ArtifactBody } from './artifactView'
import { Modal, ModalHead } from './Modal'

const DOW = ['Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat', 'Sun']
const DOT_MODE_BELOW = 620
const CHIPS_PER_DAY = 2

interface Product {
  file: ArtifactSummary
  date: ProductDate['date']
  source: ProductDate['source']
}

const monthOf = (day: string): string => day.slice(0, 7)

const basename = (path: string): string => path.split('/').pop() || path

function dateSourceLabel(source: ProductDate['source']): string {
  if (source === 'frontmatter') return 'dated by front matter'
  if (source === 'filename') return 'dated by filename'
  return 'dated by sync time (no date in front matter/filename)'
}

const monthIndex = (ym: string): number => {
  const [y, m] = ym.split('-').map(Number)
  return y! * 12 + m!
}

function clampMonth(months: string[], shown: string | null): string {
  if (shown && months.includes(shown)) return shown
  let best = months[months.length - 1]!
  if (shown) {
    const target = monthIndex(shown)
    for (const m of months) {
      if (Math.abs(monthIndex(m) - target) < Math.abs(monthIndex(best) - target)) best = m
    }
  }
  return best
}

const monthLabel = (ym: string): string => {
  const [y, m] = ym.split('-').map(Number)



  return `${new Date(Date.UTC(y!, m! - 1, 1)).toLocaleString('en-US', { month: 'long', timeZone: 'UTC' })} ${y}`
}

function chipName(path: string): string {
  const base = path.split('/').pop() || path
  const noExt = base.replace(/\.[a-z0-9]+$/i, '')
  return noExt.replace(/[-_]?\d{4}([-_]?)\d{2}\1\d{2}$/, '') || noExt
}

function useContainerWidth(ref: React.RefObject<HTMLElement | null>): number {
  const [width, setWidth] = useState(0)
  useEffect(() => {
    const el = ref.current
    if (!el || typeof ResizeObserver === 'undefined') return
    const ro = new ResizeObserver((entries) => {
      const w = entries[0]?.contentRect.width
      if (w != null) setWidth(w)
    })
    ro.observe(el)
    return () => ro.disconnect()
  }, [ref])
  return width
}

/** Axon Loop 界面：按输入数据渲染并管理本地交互，不访问后端实现。 */
export function LoopCalendar({
  loopId,
  artifacts,
  match,
  taskFile,
}: {
  loopId: string

  artifacts: ArtifactSummary[] | null
  match?: string

  taskFile?: string
}) {
  const rootRef = useRef<HTMLDivElement>(null)
  const width = useContainerWidth(rootRef)
  const dotMode = width > 0 && width < DOT_MODE_BELOW



  const products = useMemo<Product[]>(() => {
    const files = matchArtifacts(artifacts ?? [], match)
    const kept = match ? files : files.filter((f) => !isTaskPath(taskFile, f.path))
    return kept.map((f) => ({ file: f, ...productDate(f) }))
  }, [artifacts, match, taskFile])

  const byDay = useMemo(() => {
    const m = new Map<string, Product[]>()
    for (const p of products) {
      const list = m.get(p.date) ?? []
      list.push(p)
      m.set(p.date, list)
    }
    for (const list of m.values()) list.sort((a, b) => (a.file.path < b.file.path ? -1 : 1))
    return m
  }, [products])


  const months = useMemo(() => [...new Set(products.map((p) => monthOf(p.date)))].sort(), [products])
  const [shown, setShown] = useState<string | null>(null)
  const [reviewing, setReviewing] = useState<Product | null>(null)






  const activeReview = reviewing && products.some((p) => p.file.path === reviewing.file.path) ? reviewing : null





  if (artifacts == null)
    return (
      <div ref={rootRef} className="min-w-0">
        <div className="py-4 text-label text-secondary">Loading…</div>
      </div>
    )

  if (!products.length)
    return (
      <div ref={rootRef} className="min-w-0">
        <div className="rounded-card border border-hairline px-5 py-8 text-center text-body text-disabled">
          No products yet. Files the loop writes appear here after its next run syncs them.
        </div>
      </div>
    )

  const month = clampMonth(months, shown)
  const mi = months.indexOf(month)
  const today = localDay(new Date().toISOString())

  const [y, m] = month.split('-').map(Number)
  const lead = (new Date(y!, m! - 1, 1).getDay() + 6) % 7
  const dayCount = new Date(y!, m!, 0).getDate()
  const trail = (7 - ((lead + dayCount) % 7)) % 7
  const monthCount = products.filter((p) => monthOf(p.date) === month).length

  const navBtn =
    'inline-flex size-7 cursor-pointer items-center justify-center rounded-control border border-hairline bg-surface text-body leading-none text-secondary transition-colors hover:border-wire hover:bg-raised hover:text-display disabled:cursor-default disabled:opacity-30 disabled:hover:border-hairline disabled:hover:bg-surface'

  return (
    <div ref={rootRef} className="min-w-0">
      {/* 月份导航与当天产物计数。 */}
      <div className="mb-3 flex flex-wrap items-center gap-x-3 gap-y-2">
        <div className="flex items-center gap-1.5">
          <button
            type="button"
            className={navBtn}
            disabled={mi <= 0}
            onClick={() => setShown(months[mi - 1]!)}
            aria-label="previous month"
          >
            ‹
          </button>
          <button
            type="button"
            className={navBtn}
            disabled={mi >= months.length - 1}
            onClick={() => setShown(months[mi + 1]!)}
            aria-label="next month"
          >
            ›
          </button>
        </div>
        <span className="text-body font-semibold tracking-tight text-display">{monthLabel(month)}</span>
        <span className="ml-auto rounded-full bg-raised px-2.5 py-0.5 text-caption font-medium text-secondary">
          {monthCount} product{monthCount === 1 ? '' : 's'}
        </span>
      </div>

      {/* 七列均可收窄，长标题仅在单元格内截断。 */}
      <div className="grid min-w-0 grid-cols-7 overflow-hidden rounded-card border-l border-t border-hairline">
        {DOW.map((d) => (
          <div
            key={d}
            className="border-b border-r border-hairline bg-raised/50 px-2 py-1.5 text-right text-micro font-semibold uppercase tracking-wide text-disabled"
          >
            {d}
          </div>
        ))}
        {Array.from({ length: lead }, (_, i) => (
          <div key={`lead${i}`} className="border-b border-r border-hairline bg-raised/20" />
        ))}
        {Array.from({ length: dayCount }, (_, i) => {
          const day = `${month}-${String(i + 1).padStart(2, '0')}`
          const fs = byDay.get(day) ?? []
          const isToday = day === today
          return (
            <div
              key={day}
              className={`relative min-w-0 border-b border-r border-hairline px-1.5 pb-1.5 transition-colors ${
                dotMode ? 'min-h-[48px] pt-5' : 'min-h-[76px] pt-6'
              } ${isToday ? 'bg-interactive-soft/40' : 'bg-surface'}`}
            >
              <span
                className={`absolute right-1.5 top-1 inline-flex h-[15px] min-w-[15px] items-center justify-center font-mono text-micro ${
                  isToday
                    ? 'rounded-full bg-display px-1 font-semibold text-paper'
                    : fs.length
                      ? 'text-secondary'
                      : 'text-disabled'
                }`}
              >
                {i + 1}
              </span>
              {fs.slice(0, CHIPS_PER_DAY).map((p) => (
                <ProductChip
                  key={p.file.path}
                  product={p}
                  dot={dotMode}
                  onPick={() => setReviewing(p)}
                />
              ))}
              {fs.length > CHIPS_PER_DAY && (
                <button
                  type="button"
                  onClick={() => setReviewing(fs[CHIPS_PER_DAY]!)}
                  className="mt-1 block cursor-pointer border-none bg-transparent p-0 px-1 font-mono text-[9.5px] font-medium text-disabled transition-colors hover:text-display"
                >
                  +{fs.length - CHIPS_PER_DAY} more
                </button>
              )}
            </div>
          )
        })}
        {Array.from({ length: trail }, (_, i) => (
          <div key={`trail${i}`} className="border-b border-r border-hairline bg-raised/20" />
        ))}
      </div>

      {/* 状态图例。 */}
      <div className="mt-3 flex flex-wrap gap-x-4 gap-y-1.5">
        <span className="inline-flex items-center gap-1.5 text-caption font-medium text-secondary">
          <span className="inline-block h-2.5 w-3.5 rounded-[3px] border border-hairline bg-raised" /> Dated by filename
        </span>
        <span className="inline-flex items-center gap-1.5 text-caption font-medium text-secondary">
          <span className="inline-block h-2.5 w-3.5 rounded-[3px] border border-dashed border-wire bg-raised" /> Fallback:
          dated by sync time
        </span>
      </div>

      {/* 选中产物在共用详情弹窗展示。 */}
      {activeReview && (
        <Modal open onClose={() => setReviewing(null)}>
          <ModalHead
            title={activeReview.file.meta?.title?.trim() || basename(activeReview.file.path)}
            sub={
              <span className="font-mono">
                {activeReview.file.path} · {dateSourceLabel(activeReview.source)} · synced{' '}
                {fmt(activeReview.file.updatedAt)}
              </span>
            }
          />
          <div className="mt-4 min-w-0">
            <ArtifactBody loopId={loopId} file={activeReview.file} />
          </div>
        </Modal>
      )}
    </div>
  )
}

function ProductChip({
  product,
  dot,
  onPick,
}: {
  product: Product
  dot: boolean
  onPick: () => void
}) {
  const fallback = product.source === 'sync'
  const title = product.file.path + (fallback ? ' · dated by sync time' : '')
  if (dot)
    return (
      <button
        type="button"
        onClick={onPick}
        title={title}
        aria-label={product.file.path}
        className={`mr-1 mt-1 inline-block size-2 cursor-pointer rounded-full border-none p-0 transition-transform hover:scale-125 ${
          fallback ? 'bg-disabled' : 'bg-interactive'
        }`}
      />
    )
  return (
    <button
      type="button"
      onClick={onPick}
      title={title}
      className={`mt-1 block w-full min-w-0 cursor-pointer truncate rounded-full border border-hairline bg-raised px-2 py-0.5 text-left font-mono text-micro text-secondary transition-colors hover:border-wire hover:bg-surface hover:text-display ${
        fallback ? 'border-dashed' : ''
      }`}
    >
      {chipName(product.file.path)}
    </button>
  )
}
