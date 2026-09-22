import * as React from 'react'

interface MermaidBlockProps {
  code: string
}

const MAX_MERMAID_SOURCE_LENGTH = 20_000

function toMermaidId(code: string): string {
  let hash = 0
  for (const char of code) hash = (hash * 31 + char.charCodeAt(0)) >>> 0
  return `axon-mermaid-${hash.toString(16)}`
}

/** 在独立 DOM 容器中渲染 Mermaid；失败时回退到可复制的源码，避免阻断整条消息。 */
export function MermaidBlock({ code }: MermaidBlockProps): React.ReactElement {
  const containerRef = React.useRef<HTMLDivElement>(null)
  const [error, setError] = React.useState(false)

  React.useEffect(() => {
    let disposed = false
    const container = containerRef.current
    if (!container) return () => { disposed = true }
    container.replaceChildren()
    if (code.length > MAX_MERMAID_SOURCE_LENGTH) {
      setError(true)
      return () => { disposed = true }
    }
    setError(false)

    // 动态加载图表引擎，避免普通 Markdown 消息承担 Mermaid 首屏体积。
    void import('mermaid').then(({ default: mermaid }) => {
      if (disposed || !container) return
      mermaid.initialize({ startOnLoad: false, securityLevel: 'strict', theme: document.documentElement.classList.contains('dark') ? 'dark' : 'default' })
      return mermaid.render(toMermaidId(code), code)
    }).then((result) => {
      if (disposed || !container || !result) return
      container.innerHTML = result.svg
      result.bindFunctions?.(container)
    }).catch(() => {
      if (!disposed) setError(true)
    })

    return () => { disposed = true }
  }, [code])

  return error ? (
    <div className="rounded-md border border-destructive/40 bg-destructive/5 p-3 text-xs">
      <p className="mb-2 text-destructive">Mermaid 图表无法渲染，已保留源码：</p>
      <pre className="overflow-x-auto whitespace-pre-wrap break-words">{code}</pre>
    </div>
  ) : <div ref={containerRef} className="my-3 flex min-h-8 justify-center overflow-x-auto" aria-label="Mermaid 图表" />
}
