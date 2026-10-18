/** Axon Loop 展示组件与纯计算；第三方许可见 THIRD_PARTY_NOTICES.md。 */
import { useEffect, useMemo, useState } from 'react'
import DOMPurify, { type Config } from 'dompurify'
import parse, { domToReact, Element, type DOMNode, type HTMLReactParserOptions } from 'html-react-parser'
import type { ArtifactSummary, RunSummary } from '../types'
import { buildBindingContext, parseSeries, resolveBindings } from '../lib/binding'
import { numericSeries } from '../lib/stats'
import { getArtifacts } from '../data/loop-api'
import { LoopChart } from './LoopChart'
import { LoopEmbed } from './LoopEmbed'
import { LoopCalendar } from './LoopCalendar'
import { LoopKanban } from './LoopKanban'
import { LoopTabs } from './LoopTabs'
import { sanitizeLoopMarkup } from '../lib/safe-markup'

const LOOP_TAGS = ['axon-chart', 'axon-embed', 'axon-calendar', 'axon-kanban', 'axon-tabs']

const LOOP_ATTRS = ['series', 'file', 'match', 'full', 'columns', 'tabs']

const ARTIFACT_RETRY_MAX = 3
const ARTIFACT_RETRY_MS = 4000

const SANITIZE_CONFIG: Config = {
  ALLOWED_TAGS: [
    'h1', 'h2', 'h3', 'h4', 'h5', 'p', 'b', 'strong', 'i', 'em', 'u', 's', 'span', 'div',
    'ul', 'ol', 'li', 'table', 'thead', 'tbody', 'tr', 'td', 'th', 'code', 'pre', 'br',
    'hr', 'small', 'section', 'header', 'footer', 'a', 'figure', 'figcaption', 'mark',
    ...LOOP_TAGS,
  ],
  ALLOWED_ATTR: ['style', 'class', 'href', 'title', 'target', 'rel', ...LOOP_ATTRS],
  ADD_TAGS: LOOP_TAGS,
  CUSTOM_ELEMENT_HANDLING: {
    tagNameCheck: new RegExp(`^(?:${LOOP_TAGS.join('|')})$`),
    attributeNameCheck: new RegExp(`^(?:${LOOP_ATTRS.join('|')})$`),
    allowCustomizedBuiltInElements: false,
  },
}

DOMPurify.addHook('uponSanitizeAttribute', (node, data) => {
  const tag = node.nodeName?.toLowerCase()
  if (tag && LOOP_TAGS.includes(tag) && LOOP_ATTRS.includes(data.attrName)) {
    data.forceKeepAttr = true
  }
})

/** Axon Loop 界面：按输入数据渲染并管理本地交互，不访问后端实现。 */
export function LoopView({
  html,
  runs,
  loopId,
  taskFile,
}: {
  html: string
  runs: RunSummary[]
  loopId: string

  taskFile?: string
}) {
  const clean = useMemo(() => {
    const ctx = buildBindingContext(runs)
    return sanitizeLoopMarkup(resolveBindings(html, ctx), SANITIZE_CONFIG, true)
  }, [html, runs])


  const data = useMemo(() => numericSeries(runs), [runs])











  const wantsArtifacts = /<axon-(embed|calendar|kanban)\b/.test(clean)
  const [artifacts, setArtifacts] = useState<ArtifactSummary[] | null>(null)
  const newestRunId = runs[0]?.id
  const newestRunLive = runs[0]?.running === true
  useEffect(() => {
    if (!wantsArtifacts) return
    let alive = true
    let retries = 0
    let timer: ReturnType<typeof setTimeout> | undefined
    const load = () => {
      getArtifacts({ data: { loopId } })
        .then((list) => alive && setArtifacts(list))
        .catch(() => {
          if (alive && retries < ARTIFACT_RETRY_MAX) timer = setTimeout(load, ARTIFACT_RETRY_MS * ++retries)
        })
    }
    load()
    return () => {
      alive = false
      clearTimeout(timer)
    }
  }, [wantsArtifacts, loopId, newestRunId, newestRunLive])

  const options: HTMLReactParserOptions = useMemo(
    () => ({
      replace: (node) => {
        if (!(node instanceof Element)) return undefined
        const a = node.attribs ?? {}
        if (node.name === 'axon-chart') return <LoopChart data={data} series={parseSeries(a.series)} />
        if (node.name === 'axon-embed')
          return (
            <LoopEmbed
              loopId={loopId}
              artifacts={artifacts}
              file={a.file}
              match={a.match}
              full={'full' in a}
              taskFile={taskFile}
            />
          )
        if (node.name === 'axon-calendar')
          return <LoopCalendar loopId={loopId} artifacts={artifacts} match={a.match} taskFile={taskFile} />
        if (node.name === 'axon-kanban')
          return (
            <LoopKanban
              loopId={loopId}
              artifacts={artifacts}
              columns={a.columns}
              match={a.match}
              taskFile={taskFile}
            />
          )
        if (node.name === 'axon-tabs') {
          const labels = (a.tabs ?? '')
            .split(',')
            .map((s) => s.trim())
            .filter(Boolean)




          const panels = node.children
            .filter((c): c is Element => c instanceof Element && c.name === 'section')
            .map((sec) => domToReact(sec.children as DOMNode[], options))
          return <LoopTabs labels={labels} panels={panels} />
        }
        return undefined
      },
    }),
    [data, loopId, taskFile, artifacts],
  )




  return <div className="loopview text-[14px] leading-relaxed">{parse(clean, options)}</div>
}
