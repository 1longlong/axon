/** Axon Loop 展示组件与纯计算；第三方许可见 THIRD_PARTY_NOTICES.md。 */
import { useMemo } from 'react'
import { renderMarkdown } from '../lib/markdown'
import { parseFrontMatter } from '../lib/frontmatter'

const FRONT_MATTER_RE = /^\uFEFF?---[ \t]*\r?\n[\s\S]*?\r?\n---[ \t]*(?:\r?\n|$)/

function splitFrontMatter(content: string): { meta: Record<string, string> | null; body: string } {
  const meta = parseFrontMatter(content)
  if (!meta) return { meta: null, body: content }
  const m = FRONT_MATTER_RE.exec(content)
  if (!m) return { meta: null, body: content }
  return { meta, body: content.slice(m[0].length) }
}

function FrontMatterBlock({ meta }: { meta: Record<string, string> }) {
  const entries = Object.entries(meta)
  if (!entries.length) return null
  return (
    <div className="mb-4 flex flex-col gap-1 rounded-control border border-hairline px-3.5 py-2.5">
      {entries.map(([k, v]) => (
        <div key={k} className="flex min-w-0 items-baseline gap-2">
          <span className="shrink-0 font-mono text-caption text-disabled">{k}</span>
          <span className="min-w-0 break-words text-caption text-secondary">{v}</span>
        </div>
      ))}
    </div>
  )
}

/** Axon Loop 界面：按输入数据渲染并管理本地交互，不访问后端实现。 */
export function TaskFileView({ content }: { content: string }) {
  const { meta, body } = useMemo(() => splitFrontMatter(content), [content])
  const html = useMemo(() => renderMarkdown(body), [body])

  return (
    <div className="px-5 py-4">
      {meta && <FrontMatterBlock meta={meta} />}
      <div className="taskmd" dangerouslySetInnerHTML={{ __html: html }} />
    </div>
  )
}
