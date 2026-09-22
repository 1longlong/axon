const SHIKI_LANGUAGE_ALIASES: Record<string, string> = {
  js: 'javascript',
  jsx: 'jsx',
  ts: 'typescript',
  tsx: 'tsx',
  py: 'python',
  sh: 'shellscript',
  bash: 'shellscript',
  shell: 'shellscript',
  yml: 'yaml',
}

const LATEX_PLACEHOLDER = (index: number): string => `AXON_LATEX_PROTECT_${index}`
const LATEX_PLACEHOLDER_PATTERN = /AXON_LATEX_PROTECT_(\d+)/g

/** 在 Markdown 解析前统一 LaTeX 分隔符，并保护代码中的字面量。 */
export function normalizeLatexDelimiters(text: string): string {
  if (!text || (!text.includes('\\(') && !text.includes('\\['))) return text

  const protectedSegments: string[] = []
  const protect = (segment: string): string => {
    protectedSegments.push(segment)
    return LATEX_PLACEHOLDER(protectedSegments.length - 1)
  }

  // 先保护代码，避免代码示例被误判为公式；再转换模型常见的原生 LaTeX 分隔符。
  let working = text.replace(/```[\s\S]*?```/g, protect)
  working = working.replace(/`[^`\n]*`/g, protect)
  working = working.replace(/\\\[([\s\S]+?)\\\]/g, (_match, inner: string) => `$$${inner}$$`)
  working = working.replace(/\\\(([\s\S]+?)\\\)/g, (_match, inner: string) => `$${inner}$`)
  return working.replace(LATEX_PLACEHOLDER_PATTERN, (_match, index: string) => protectedSegments[Number(index)] ?? _match)
}

/** 规范 fenced code 的语言标识；未知语言交给高亮层回退为纯文本。 */
export function normalizeShikiLanguage(language: string | undefined): string {
  const normalized = language?.trim().toLowerCase() ?? ''
  return (SHIKI_LANGUAGE_ALIASES[normalized] ?? normalized) || 'text'
}

export function trimMarkdownCodeFenceNewline(code: string): string {
  return code.endsWith('\n') ? code.slice(0, -1) : code
}

/** 只允许 HTTPS 或小型 data:image，拒绝脚本、文件和协议相对地址。 */
export function sanitizeMarkdownImageSource(source: string | undefined): string | null {
  if (!source) return null
  if (source.startsWith('data:image/') && source.length <= 2_000_000) return source
  try {
    const url = new URL(source)
    return url.protocol === 'https:' ? url.href : null
  } catch {
    return null
  }
}

export interface MarkdownHeading {
  level: number
  text: string
  id: string
}

/** 提取正文标题供目录使用；围栏代码内的井号不参与目录。 */
export function extractMarkdownHeadings(markdown: string): MarkdownHeading[] {
  const headings: MarkdownHeading[] = []
  const counts = new Map<string, number>()
  let fenced = false
  for (const line of markdown.split('\n')) {
    if (/^\s*```/.test(line)) {
      fenced = !fenced
      continue
    }
    if (fenced) continue
    const match = /^\s*(#{1,6})\s+(.+?)\s*#*\s*$/.exec(line)
    if (!match) continue
    const text = match[2]!
    const base = text.toLowerCase().replace(/[^\p{Letter}\p{Number}\s-]/gu, '').trim().replace(/\s+/g, '-') || 'section'
    const occurrence = counts.get(base) ?? 0
    counts.set(base, occurrence + 1)
    headings.push({ level: match[1]!.length, text, id: occurrence === 0 ? base : `${base}-${occurrence + 1}` })
  }
  return headings
}
