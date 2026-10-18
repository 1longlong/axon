/** Axon Loop 展示组件与纯计算；第三方许可见 THIRD_PARTY_NOTICES.md。 */
import { useLayoutEffect, useRef, useState } from 'react'
import type { ArtifactSummary } from '../types'
import { artifactKind } from '../lib/artifactKind'
import { isTaskPath } from '../lib/fileEntries'
import { fmt } from '../lib/format'
import { matchArtifacts, newestMatch } from '../lib/productDate'
import { ArtifactBody, ViewerHead } from './artifactView'

const COLLAPSE_PX = 300

const norm = (p: string) => p.replace(/\\/g, '/').replace(/^\.\//, '')

/** Axon Loop 界面：按输入数据渲染并管理本地交互，不访问后端实现。 */
export function LoopEmbed({
  loopId,
  artifacts,
  file,
  match,
  full,
  taskFile,
}: {
  loopId: string

  artifacts: ArtifactSummary[] | null
  file?: string
  match?: string
  full?: boolean

  taskFile?: string
}) {
  const requested = file ?? match
  const shell = 'min-w-0 overflow-hidden rounded-card border border-hairline bg-surface shadow-card'


  if (!requested)
    return (
      <div className={shell}>
        <div className="px-5 py-5 font-mono text-label text-disabled">
          &lt;axon-embed&gt; needs file="&lt;path&gt;" or match="&lt;glob&gt;"
        </div>
      </div>
    )

  if (artifacts == null)
    return (
      <div className={shell}>
        <ViewerHead path={requested} />
        <div className="px-5 py-6 text-label text-secondary">Loading…</div>
      </div>
    )

  const matchable = file ? artifacts : artifacts.filter((a) => !isTaskPath(taskFile, a.path))
  const target = file
    ? artifacts.find((a) => norm(a.path) === norm(file))
    : newestMatch(matchable, match)



  if (!target)
    return (
      <div className={shell}>
        <ViewerHead path={requested} />
        <div className="px-5 py-6 text-body text-disabled">
          No synced file matches yet. It appears here after the loop's next run syncs it.
        </div>
      </div>
    )

  const resolution = match ? `newest of ${matchArtifacts(matchable, match).length} matching ${match} · ` : ''
  const meta = `${resolution}synced ${fmt(target.updatedAt)}`




  const kind = artifactKind(target.path)
  const selfBounded = kind === 'html' || kind === 'image'
  const collapse = !full && !selfBounded && !target.binary && !target.oversize

  return (
    <div className={shell}>
      <ViewerHead
        path={target.path}
        meta={meta}
        action={
          <a
            href="#files"
            className="text-caption font-medium text-interactive transition-colors hover:text-display"
          >
            Open in files →
          </a>
        }
      />
      <CollapsibleBody collapse={collapse}>
        <ArtifactBody loopId={loopId} file={target} />
      </CollapsibleBody>
    </div>
  )
}

/** Axon Loop 界面：按输入数据渲染并管理本地交互，不访问后端实现。 */
export function CollapsibleBody({ collapse, children }: { collapse: boolean; children: React.ReactNode }) {
  const ref = useRef<HTMLDivElement>(null)
  const [expanded, setExpanded] = useState(false)
  const [overflowing, setOverflowing] = useState(false)






  useLayoutEffect(() => {
    const el = ref.current
    if (!el) return
    const over = el.scrollHeight > COLLAPSE_PX + 1
    if (over !== overflowing) setOverflowing(over)
  })

  const collapsed = collapse && !expanded && overflowing
  if (!collapse) return <div className="min-w-0">{children}</div>

  return (
    <>
      <div className="relative min-w-0">
        <div
          ref={ref}
          className={collapsed ? 'overflow-hidden' : ''}
          style={collapsed ? { maxHeight: COLLAPSE_PX } : undefined}
        >
          {children}
        </div>
        {collapsed && (
          <div
            aria-hidden
            className="pointer-events-none absolute inset-x-0 bottom-0 h-16"
            style={{ background: 'linear-gradient(to bottom, transparent, var(--color-surface))' }}
          />
        )}
      </div>
      {overflowing && (
        <div className="flex border-t border-hairline px-3.5 py-1.5">
          <button
            type="button"
            onClick={() => setExpanded(!expanded)}
            className="cursor-pointer border-none bg-transparent p-0 text-caption font-medium text-secondary transition-colors hover:text-display"
          >
            {expanded ? 'Collapse ▴' : 'Show all ▾'}
          </button>
        </div>
      )}
    </>
  )
}
