import * as React from 'react'
import { Check, Copy } from 'lucide-react'
import { normalizeShikiLanguage, trimMarkdownCodeFenceNewline } from '@/lib/chat-markdown'

interface HighlightToken {
  content: string
  color?: string
}

interface HighlightResult {
  lines: HighlightToken[][]
  foreground: string
}

/** 按需加载 Shiki 并把 token 渲染为 React 节点，避免注入高亮器生成的 HTML。 */
export function ShikiCodeBlock({ code: rawCode, language: rawLanguage }: { code: string; language?: string }): React.ReactElement {
  // 高亮器与背景都读取 DOM 最终主题，避免 atom 更新和 .dark class 更新之间出现混色。
  const [theme, setTheme] = React.useState<'light' | 'dark'>(() => (
    typeof document !== 'undefined' && document.documentElement.classList.contains('dark') ? 'dark' : 'light'
  ))
  const code = trimMarkdownCodeFenceNewline(rawCode)
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

  const lines: HighlightToken[][] = highlight?.lines ?? code.split('\n').map((line) => [{ content: line }])
  const fallbackForeground = theme === 'dark' ? '#e1e4e8' : '#24292f'
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
