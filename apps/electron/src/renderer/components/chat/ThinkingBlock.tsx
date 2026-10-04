import * as React from 'react'
import { ChevronDown, Loader2 } from 'lucide-react'
import { ThinkingIcon } from '@/components/icons/WorkbenchIcons'

interface ThinkingBlockProps {
  text: string
  isStreaming?: boolean
}

/** 接收两种会话的真实思考文本；展开后跟随新增内容，用户上翻时保留阅读位置。 */
export function ThinkingBlock({ text, isStreaming = false }: ThinkingBlockProps): React.ReactElement | null {
  const scrollerRef = React.useRef<HTMLDivElement>(null)
  const followOutputRef = React.useRef(true)
  const [open, setOpen] = React.useState(false)
  const [edges, setEdges] = React.useState({ top: false, bottom: false })

  const updateEdges = React.useCallback((): void => {
    const scroller = scrollerRef.current
    if (!scroller) return
    const top = scroller.scrollTop > 1
    const bottom = scroller.scrollHeight - scroller.scrollTop - scroller.clientHeight > 1
    setEdges((previous) => previous.top === top && previous.bottom === bottom ? previous : { top, bottom })
  }, [])

  React.useLayoutEffect(() => {
    const scroller = scrollerRef.current
    if (!scroller || !open) return
    // 历史内容从顶部读起；只有实时生成且用户停在底部时才自动跟随。
    if (isStreaming && followOutputRef.current) scroller.scrollTop = scroller.scrollHeight
    updateEdges()
  }, [text, isStreaming, open, updateEdges])

  React.useEffect(() => {
    const scroller = scrollerRef.current
    if (!scroller || !open) return
    const observer = new ResizeObserver(updateEdges)
    observer.observe(scroller)
    return () => observer.disconnect()
  }, [open, updateEdges])

  if (!text.trim()) return null

  return <details
    className="group/thinking min-w-0 text-xs text-muted-foreground"
    onToggle={(event) => setOpen(event.currentTarget.open)}
  >
    <summary className="flex cursor-pointer list-none select-none items-center gap-2 rounded-md px-2 py-1.5 hover:bg-muted/40 hover:text-foreground focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-ring [&::-webkit-details-marker]:hidden">
      {isStreaming
        ? <Loader2 size={14} aria-hidden="true" className="shrink-0 animate-spin motion-reduce:animate-none" />
        : <ThinkingIcon size={14} aria-hidden="true" className="shrink-0" />}
      <span className="min-w-0 flex-1">{isStreaming ? '正在思考' : '思考过程'}</span>
      <ChevronDown size={12} aria-hidden="true" className="shrink-0 transition-transform group-open/thinking:rotate-180 motion-reduce:transition-none" />
    </summary>
    <div className="relative mx-2 mb-1 mt-1 overflow-hidden rounded-md border border-border-subtle bg-muted/40">
      <div
        ref={scrollerRef}
        tabIndex={0}
        role="region"
        aria-label="思考内容"
        onScroll={(event) => {
          const scroller = event.currentTarget
          followOutputRef.current = scroller.scrollHeight - scroller.scrollTop - scroller.clientHeight < 24
          updateEdges()
        }}
        className="max-h-[150px] overflow-y-auto overscroll-contain px-3 py-2.5 focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-inset focus-visible:ring-ring"
      >
        <p className="whitespace-pre-wrap break-words [overflow-wrap:anywhere] leading-5">{text}</p>
      </div>
      {edges.top && <div aria-hidden="true" className="thinking-content-fade pointer-events-none absolute inset-x-0 top-0 h-4" />}
      {edges.bottom && <div aria-hidden="true" className="thinking-content-fade pointer-events-none absolute inset-x-0 bottom-0 h-4 rotate-180" />}
    </div>
  </details>
}
