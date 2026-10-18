/** Axon Loop 展示组件与纯计算；第三方许可见 THIRD_PARTY_NOTICES.md。 */
import { useEffect, useRef, useState, type ReactNode } from 'react'
import type { ArtifactSummary } from '../types'
import { isTaskPath } from '../lib/fileEntries'
import { fmt } from '../lib/format'
import { matchArtifacts, productDate, type ProductDate } from '../lib/productDate'
import { ArtifactBody, isMarkdown } from './artifactView'
import { Modal, ModalHead } from './Modal'

const OVERFLOW_LABEL = 'Other'

const OVERFLOW_KEY: unique symbol = Symbol('kanban-overflow')

const OVERFLOW_REACT_KEY = 'overflow,'

interface Card {
  file: ArtifactSummary
  title: string
  date: ProductDate
}

const basename = (path: string): string => path.split('/').pop() || path

const sortKey = (c: Card): string => `${c.date.date}|${c.file.updatedAt}`

/** Axon Loop 界面：按输入数据渲染并管理本地交互，不访问后端实现。 */
export function LoopKanban({
  loopId,
  artifacts,
  columns,
  match,
  taskFile,
}: {
  loopId: string

  artifacts: ArtifactSummary[] | null

  columns?: string
  match?: string

  taskFile?: string
}) {
  const [reviewing, setReviewing] = useState<Card | null>(null)
  const cols = [
    ...new Set(
      (columns ?? '')
        .split(',')
        .map((s) => s.trim())
        .filter(Boolean),
    ),
  ]
  const shell = 'min-w-0'


  if (!cols.length)
    return (
      <div className={`${shell} rounded-card border border-hairline bg-surface shadow-card`}>
        <div className="px-5 py-5 font-mono text-label text-disabled">
          &lt;axon-kanban&gt; needs columns="&lt;a,b,c&gt;"
        </div>
      </div>
    )

  if (artifacts == null)
    return (
      <div className={shell}>
        <div className="py-4 text-label text-secondary">Loading…</div>
      </div>
    )


  const cards: Card[] = matchArtifacts(artifacts, match)
    .filter((a) => isMarkdown(a.path) && !!a.meta?.type && !isTaskPath(taskFile, a.path))
    .map((file) => ({ file, title: file.meta?.title?.trim() || basename(file.path), date: productDate(file) }))


  const declared = new Set(cols)
  const grouped = new Map<string | symbol, Card[]>()
  for (const card of cards) {
    const type = card.file.meta!.type!.trim()
    const key: string | symbol = declared.has(type) ? type : OVERFLOW_KEY
    const list = grouped.get(key) ?? []
    list.push(card)
    grouped.set(key, list)
  }
  for (const list of grouped.values()) list.sort((a, b) => (sortKey(a) < sortKey(b) ? 1 : -1))

  const board = cols.map((name) => ({ name, cards: grouped.get(name) ?? [], overflow: false }))
  const overflow = grouped.get(OVERFLOW_KEY) ?? []
  if (overflow.length) board.push({ name: OVERFLOW_LABEL, cards: overflow, overflow: true })

  return (






    <div className={`${shell} flex max-h-[420px] gap-3 overflow-x-auto pb-1`}>
      {board.map((col) => (
        <div key={col.overflow ? OVERFLOW_REACT_KEY : col.name} className="flex min-h-0 w-[248px] shrink-0 flex-col">
          <div className="mb-2 flex shrink-0 items-center gap-2 border-b border-hairline pb-1.5">
            <span
              className={`text-label font-semibold ${
                col.overflow ? 'text-disabled' : 'text-primary'
              }`}
            >
              {col.name}
            </span>
            <span className="text-caption text-disabled">{col.cards.length}</span>
          </div>
          <ColumnCards count={col.cards.length}>
            {col.cards.length === 0 ? (
              <div className="shrink-0 rounded-control border border-dashed border-hairline px-2.5 py-3 text-center text-caption text-disabled">
                Empty
              </div>
            ) : (
              col.cards.map((card) => (
                <KanbanCard key={card.file.path} card={card} onOpen={() => setReviewing(card)} />
              ))
            )}
          </ColumnCards>
        </div>
      ))}
      {reviewing && (
        <Modal open onClose={() => setReviewing(null)}>
          <ModalHead
            title={reviewing.title}
            sub={
              <span className="font-mono">
                {reviewing.file.path}
                {reviewing.date.source !== 'sync' && ` · ${reviewing.date.date}`} · synced{' '}
                {fmt(reviewing.file.updatedAt)}
              </span>
            }
          />
          <div className="mt-4 min-w-0">
            <ArtifactBody loopId={loopId} file={reviewing.file} />
          </div>
        </Modal>
      )}
    </div>
  )
}

function ColumnCards({ count, children }: { count: number; children: ReactNode }) {
  const ref = useRef<HTMLDivElement>(null)
  const [below, setBelow] = useState(false)
  const update = () => {
    const el = ref.current
    if (el) setBelow(el.scrollTop + el.clientHeight < el.scrollHeight - 4)
  }


  useEffect(update, [count])
  return (
    <div className="relative flex min-h-0 flex-col">
      <div ref={ref} onScroll={update} className="flex min-h-0 flex-col gap-2 overflow-y-auto pb-1 pr-0.5">
        {children}
      </div>
      {below && (
        <div className="pointer-events-none absolute inset-x-0 bottom-0 flex h-12 items-end justify-center bg-gradient-to-t from-surface to-transparent">
          <span className="mb-1 rounded-full border border-hairline bg-surface px-2 py-0.5 text-micro text-secondary shadow-card">
            ↓ scroll
          </span>
        </div>
      )}
    </div>
  )
}

function KanbanCard({ card, onOpen }: { card: Card; onOpen: () => void }) {
  const dated = card.date.source !== 'sync'
  return (
    <div className="min-w-0 shrink-0 overflow-hidden rounded-control border border-hairline bg-surface shadow-card transition-colors hover:border-wire">
      <button
        type="button"
        onClick={onOpen}
        className="flex w-full min-w-0 cursor-pointer flex-col items-start gap-1 border-none bg-transparent px-2.5 py-2 text-left"
      >
        <span className="w-full min-w-0 truncate text-meta text-primary" title={card.file.path}>
          {card.title}
        </span>
        {dated && (
          <span className="font-mono text-micro text-disabled">{card.date.date}</span>
        )}
      </button>
    </div>
  )
}
