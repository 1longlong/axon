import * as React from 'react'
import { Check, Copy } from 'lucide-react'
import { normalizeShikiLanguage, trimMarkdownCodeFenceNewline } from '@/lib/chat-markdown'

interface HighlightToken {
  content: string
  color?: string
}

interface HighlightResult {
  source: string
  language: string
  theme: 'light' | 'dark'
  lines: HighlightToken[][]
  foreground: string
}

interface ShikiCodeBlockProps {
  code: string
  language?: string
  appearance?: 'message' | 'workspace'
}

/** 按需加载 Shiki 并把 token 渲染为 React 节点，避免注入高亮器生成的 HTML。 */
export function ShikiCodeBlock({ code: rawCode, language: rawLanguage, appearance = 'message' }: ShikiCodeBlockProps): React.ReactElement {
  // 高亮器与背景都读取 DOM 最终主题，避免 atom 更新和 .dark class 更新之间出现混色。
  const [theme, setTheme] = React.useState<'light' | 'dark'>(() => (
    typeof document !== 'undefined' && document.documentElement.classList.contains('dark') ? 'dark' : 'light'
  ))
  const code = appearance === 'workspace' ? rawCode : trimMarkdownCodeFenceNewline(rawCode)
  const language = normalizeShikiLanguage(rawLanguage)
  const [highlight, setHighlight] = React.useState<HighlightResult | null>(null)
  const [copied, setCopied] = React.useState(false)

  React.useEffect(() => {
    const syncTheme = (): void => setTheme(document.documentElement.classList.contains('dark') ? 'dark' : 'light')
    syncTheme()
    const observer = new MutationObserver(syncTheme)
    observer.observe(document.documentElement, { attributes: true, attributeFilter: ['class'] })
    return () => observer.disconnect()
  }, [])

  React.useEffect(() => {
    let cancelled = false
    // 流式代码先等待短暂稳定窗口，避免每个 token 都启动一次语法分析。
    const timer = window.setTimeout(() => {
      void import('shiki/bundle/web').then(async ({ codeToTokens }) => {
        type WebLanguage = Parameters<typeof codeToTokens>[1]['lang']
        let result
        try {
          result = await codeToTokens(code, {
            lang: language as WebLanguage,
            theme: theme === 'dark' ? 'github-dark' : 'github-light',
          })
        } catch {
          // 未知语言只降级为纯文本，消息正文仍保持可见和可复制。
          result = await codeToTokens(code, { lang: 'text', theme: theme === 'dark' ? 'github-dark' : 'github-light' })
        }
        if (cancelled) return
        setHighlight({
          source: code,
          language,
          theme,
          lines: result.tokens.map((line) => line.map((token) => ({
            content: token.content,
            ...(token.color ? { color: token.color } : {}),
          }))),
          foreground: result.fg ?? (theme === 'dark' ? '#e1e4e8' : '#24292f'),
        })
      }).catch(() => {
        if (!cancelled) setHighlight(null)
      })
    }, 80)
    return () => {
      cancelled = true
      window.clearTimeout(timer)
    }
  }, [code, language, theme])

  const copy = async (): Promise<void> => {
    try {
      await navigator.clipboard.writeText(code)
      setCopied(true)
      window.setTimeout(() => setCopied(false), 1600)
    } catch {
      setCopied(false)
    }
  }

  // 工作区切换文件、内容或主题时先展示当前源码；上一轮高亮不能配上新的文件标题。
  const visibleHighlight = appearance === 'workspace'
    && (highlight?.source !== code || highlight.language !== language || highlight.theme !== theme)
    ? null : highlight
  const lines: HighlightToken[][] = visibleHighlight?.lines ?? code.split('\n').map((line) => [{ content: line }])
  const fallbackForeground = theme === 'dark' ? '#e1e4e8' : '#24292f'
  if (appearance === 'workspace') return <pre className="min-w-max px-4 py-4 font-mono text-[12px] leading-6" style={{ color: visibleHighlight?.foreground ?? fallbackForeground }}><code>
    {lines.map((line, lineIndex) => <React.Fragment key={lineIndex}>
      {lineIndex > 0 && '\n'}
      <span aria-hidden="true" className="mr-4 inline-block w-8 select-none text-right text-muted-foreground/60">{lineIndex + 1}</span>
      {line.map((token, tokenIndex) => <span key={tokenIndex} style={token.color ? { color: token.color } : undefined}>{token.content}</span>)}
    </React.Fragment>)}
  </code></pre>
  return (
    <div
      className="my-2 overflow-hidden rounded-lg border border-border/60"
      style={{ backgroundColor: theme === 'dark' ? '#1e2228' : '#f6f8fa' }}
    >
      <div className="flex h-8 items-center justify-between bg-muted/60 px-2 text-xs text-muted-foreground">
        <span>{language}</span>
        <button type="button" onClick={() => void copy()} className="flex items-center gap-1 rounded px-1.5 py-1 hover:bg-foreground/10 hover:text-foreground">
          {copied ? <Check size={12} /> : <Copy size={12} />}
          {copied ? '已复制' : '复制'}
        </button>
      </div>
      <pre
        className="overflow-x-auto p-4 text-[13px] leading-6"
        // prose 会给 pre 设置默认背景；这里明确透明，背景统一由外层代码块容器控制。
        style={{ backgroundColor: 'transparent', color: highlight?.foreground ?? fallbackForeground }}
      >
        <code style={{ backgroundColor: 'transparent', color: 'inherit' }}>
          {lines.map((line, lineIndex) => (
            <React.Fragment key={lineIndex}>
              {lineIndex > 0 && '\n'}
              {line.map((token, tokenIndex) => (
                <span key={tokenIndex} style={token.color ? { color: token.color } : undefined}>{token.content}</span>
              ))}
            </React.Fragment>
          ))}
        </code>
      </pre>
    </div>
  )
}
