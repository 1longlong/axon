import { describe, expect, test } from 'bun:test'
import { extractMarkdownHeadings, normalizeLatexDelimiters, normalizeShikiLanguage, sanitizeMarkdownImageSource, trimMarkdownCodeFenceNewline } from './chat-markdown'

describe('Chat Markdown 代码块', () => {
  test('规范常见语言别名并为空语言提供文本回退', () => {
    expect(normalizeShikiLanguage('TS')).toBe('typescript')
    expect(normalizeShikiLanguage('bash')).toBe('shellscript')
    expect(normalizeShikiLanguage(undefined)).toBe('text')
    expect(normalizeShikiLanguage('custom-lang')).toBe('custom-lang')
  })

  test('只移除 Markdown fenced code 产生的末尾换行', () => {
    expect(trimMarkdownCodeFenceNewline('a\n')).toBe('a')
    expect(trimMarkdownCodeFenceNewline('a\n\n')).toBe('a\n')
    expect(trimMarkdownCodeFenceNewline('a')).toBe('a')
  })

  test('转换常见 LaTeX 分隔符但保护代码字面量', () => {
    const normalized = normalizeLatexDelimiters(String.raw`内联 \(x^2\)，块级 \[y^2\]`)
    expect(normalized).toContain('$x^2$')
    expect(normalized).toContain('$$y^2$$')
    const code = '`' + String.raw`\(x\)` + '`\n\n```txt\n' + String.raw`\(y\)` + '\n```'
    expect(normalizeLatexDelimiters(code)).toBe(code)
  })

  test('图片来源只允许 HTTPS 或受限 data:image', () => {
    expect(sanitizeMarkdownImageSource('https://example.com/a.png')).toBe('https://example.com/a.png')
    expect(sanitizeMarkdownImageSource('http://example.com/a.png')).toBeNull()
    expect(sanitizeMarkdownImageSource('javascript:alert(1)')).toBeNull()
    expect(sanitizeMarkdownImageSource('data:image/png;base64,abc')).toBe('data:image/png;base64,abc')
  })

  test('目录提取跳过 fenced code 并为重复标题生成稳定 ID', () => {
    expect(extractMarkdownHeadings('# A\n\n```md\n# hidden\n```\n\n## A\n\n### B')).toEqual([
      { level: 1, text: 'A', id: 'a' },
      { level: 2, text: 'A', id: 'a-2' },
      { level: 3, text: 'B', id: 'b' },
    ])
  })
})
