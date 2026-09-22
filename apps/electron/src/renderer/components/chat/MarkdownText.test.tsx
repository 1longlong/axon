import { describe, expect, test } from 'bun:test'
import { renderToStaticMarkup } from 'react-dom/server'
import { MarkdownText } from './MarkdownText'

describe('Chat Markdown 安全渲染', () => {
  test('支持 GFM 表格和代码块，并忽略原始 HTML', () => {
    const html = renderToStaticMarkup(
      <MarkdownText>{`| A | B |\n| - | - |\n| 1 | 2 |\n\n\`\`\`ts\nconst n = 1\n\`\`\`\n\n<script>alert('x')</script>`}</MarkdownText>,
    )
    expect(html).toContain('<table>')
    expect(html).toContain('const n = 1')
    expect(html).toContain('复制')
    expect(html).not.toContain('<script>')
    expect(html).not.toContain("alert('x')")
  })

  test('危险链接不会保留协议，图片只允许安全来源', () => {
    const html = renderToStaticMarkup(
      <MarkdownText>{`[危险](javascript:alert(1))\n\n![远程](javascript:alert(1))`}</MarkdownText>,
    )
    expect(html).not.toContain('javascript:')
    expect(html).not.toContain('<img')
    expect(html).toContain('[图片链接已拦截：远程]')
  })

  test('HTTPS 图片允许渲染并禁止携带来源地址', () => {
    const html = renderToStaticMarkup(<MarkdownText>{'![安全](https://example.com/a.png)'}</MarkdownText>)
    expect(html).toContain('<img')
    expect(html).toContain('referrerPolicy="no-referrer"')
  })

  test('渲染行内与块级数学公式', () => {
    const html = renderToStaticMarkup(<MarkdownText>{String.raw`内联 \(x^2\)

\[y^2\]`}</MarkdownText>)
    expect(html).toContain('class="katex"')
    expect(html).toContain('x^2')
    expect(html).toContain('y^2')
  })

  test('Mermaid fenced code 使用独立图表容器，不走代码高亮', () => {
    const html = renderToStaticMarkup(<MarkdownText>{'```mermaid\ngraph TD\n  A-->B\n```'}</MarkdownText>)
    expect(html).toContain('aria-label="Mermaid 图表"')
    expect(html).not.toContain('复制')
  })

  test('长 Markdown 显示可折叠目录并生成标题锚点', () => {
    const html = renderToStaticMarkup(<MarkdownText>{'# A\n\n## B\n\n### C'}</MarkdownText>)
    expect(html).toContain('目录（3）')
    expect(html).toContain('href="#a"')
    expect(html).toContain('id="c"')
  })
})
