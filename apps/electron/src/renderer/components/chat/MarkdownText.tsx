import * as React from 'react'
import Markdown from 'react-markdown'
import remarkGfm from 'remark-gfm'
import remarkMath from 'remark-math'
import rehypeKatex from 'rehype-katex'
import { extractMarkdownHeadings, normalizeLatexDelimiters, sanitizeMarkdownImageSource } from '@/lib/chat-markdown'
import { ShikiCodeBlock } from './ShikiCodeBlock'
import { MermaidBlock } from './MermaidBlock'

/** 安全渲染模型 Markdown：不解析原始 HTML，远程图片降级为外部链接。 */
export const MarkdownText = React.memo(function MarkdownText({ children }: { children: string }): React.ReactElement {
  const headings = React.useMemo(() => extractMarkdownHeadings(children), [children])
  const headingCounts = new Map<string, number>()
  const headingId = (text: string): string => {
    const base = text.toLowerCase().replace(/[^\p{Letter}\p{Number}\s-]/gu, '').trim().replace(/\s+/g, '-') || 'section'
    const occurrence = headingCounts.get(base) ?? 0
    headingCounts.set(base, occurrence + 1)
    return occurrence === 0 ? base : `${base}-${occurrence + 1}`
  }
  return (
    <div className="markdown-content prose max-w-none break-words dark:prose-invert prose-headings:my-3 prose-p:my-1.5 prose-pre:m-0 prose-li:my-0.5 prose-table:block prose-table:overflow-x-auto">
      {headings.length >= 3 && (
        <details className="not-prose mb-4 rounded-md border bg-muted/20 px-3 py-2 text-xs">
          <summary className="cursor-pointer select-none font-medium">目录（{headings.length}）</summary>
          <nav aria-label="消息目录" className="mt-2 space-y-1">
            {headings.map((heading) => <a key={heading.id} href={`#${heading.id}`} className="block truncate text-muted-foreground hover:text-foreground" style={{ paddingLeft: `${(heading.level - 1) * 10}px` }}>{heading.text}</a>)}
          </nav>
        </details>
      )}
      <Markdown
        // 原始 HTML 保持关闭；这是模型 Markdown 进入 DOM 前的安全边界。
        skipHtml
        remarkPlugins={[remarkGfm, remarkMath]}
        rehypePlugins={[rehypeKatex]}
        components={{
          h1: ({ children: headingChildren }) => <h1 id={headingId(String(headingChildren))}>{headingChildren}</h1>,
          h2: ({ children: headingChildren }) => <h2 id={headingId(String(headingChildren))}>{headingChildren}</h2>,
          h3: ({ children: headingChildren }) => <h3 id={headingId(String(headingChildren))}>{headingChildren}</h3>,
          h4: ({ children: headingChildren }) => <h4 id={headingId(String(headingChildren))}>{headingChildren}</h4>,
          h5: ({ children: headingChildren }) => <h5 id={headingId(String(headingChildren))}>{headingChildren}</h5>,
          h6: ({ children: headingChildren }) => <h6 id={headingId(String(headingChildren))}>{headingChildren}</h6>,
          a: ({ children: linkChildren, ...props }) => (
            <a {...props} target="_blank" rel="noopener noreferrer">{linkChildren}</a>
          ),
          img: ({ src, alt }) => {
            const safeSource = sanitizeMarkdownImageSource(src)
            if (!safeSource) return <span>[图片链接已拦截：{alt || '不安全地址'}]</span>
            return <img src={safeSource} alt={alt || '模型图片'} loading="lazy" referrerPolicy="no-referrer" className="max-h-[32rem] max-w-full rounded-md object-contain" />
          },
          pre: ({ children: preChildren }) => <>{preChildren}</>,
          code: ({ className, children: codeChildren, ...props }) => {
            const text = String(codeChildren)
            const language = className?.match(/language-(\S+)/)?.[1]
            if (language?.toLowerCase() === 'mermaid') return <MermaidBlock code={text} />
            const block = Boolean(language || text.endsWith('\n'))
            return block
              ? <ShikiCodeBlock code={text} language={language} />
              : <code {...props} className="rounded bg-foreground/10 px-1 py-0.5 font-mono text-[0.875em]">{codeChildren}</code>
          },
        }}
      >
        {normalizeLatexDelimiters(children)}
      </Markdown>
    </div>
  )
})
