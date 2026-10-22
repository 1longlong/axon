/// <reference path="./pdf-parse.d.ts" />
/** 文档命令的只读解析：输入经宿主 FD 固定，输出按页/段/表格行编号并限制正文预算。 */
import { closeSync, constants, fstatSync, openSync, readSync, realpathSync } from 'node:fs'
import { basename, extname } from 'node:path'

const MAX_DOCUMENT_BYTES = 20 * 1024 * 1024
export interface AgentDocumentSection { number: number; kind: 'page' | 'paragraph' | 'tableRow'; text: string }
export interface AgentDocumentExtraction {
  filename: string
  format: 'pdf' | 'docx'
  totalSections: number
  sections: AgentDocumentSection[]
  truncated: boolean
  hasMore: boolean
  note?: string
}
export interface AgentDocumentExtractInput { path: string; start?: number; end?: number; maxChars?: number }
interface PdfPage {
  pageNumber: number
  getTextContent(options: { normalizeWhitespace: boolean; disableCombineTextItems: boolean }): Promise<{
    items: Array<{ str: string; transform: number[] }>
  }>
}
interface PdfParser { (data: Uint8Array, options: { max: number; pagerender: (page: PdfPage) => Promise<string> }): Promise<{ numpages: number }> }
interface MammothHtml {
  convertToHtml(input: { buffer: Buffer }, options: { externalFileAccess: boolean; includeEmbeddedStyleMap: boolean;
    convertImage: (image: unknown) => Promise<unknown[]> }): Promise<{ value: string }>
}

function positive(value: number | undefined, fallback: number, max: number): number {
  if (value === undefined) return fallback
  if (!Number.isSafeInteger(value) || value < 1 || value > max) throw new Error('文档读取范围或正文预算无效')
  return value
}

/** 读取固定大小的普通文件；拒绝超限、增长或读取期间被改写的来源。 */
function readSource(path: string): Buffer {
  const fd = openSync(realpathSync.native(path), constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK)
  try {
    const before = fstatSync(fd)
    if (!before.isFile() || before.size === 0 || before.size > MAX_DOCUMENT_BYTES) throw new Error('仅支持 20 MiB 以内的非空普通文档')
    const bytes = Buffer.alloc(before.size)
    let offset = 0
    while (offset < bytes.length) {
      const read = readSync(fd, bytes, offset, bytes.length - offset, offset)
      if (!read) throw new Error('文档读取不完整')
      offset += read
    }
    const after = fstatSync(fd)
    if (after.size !== before.size || after.mtimeMs !== before.mtimeMs || after.ctimeMs !== before.ctimeMs) throw new Error('文档在读取时发生变化，请重试读取')
    return bytes
  } finally { closeSync(fd) }
}

/** 只对解析器生成的文本实体解码，不渲染 HTML、不加载图片/链接或执行文档内容。 */
function decodeEntities(text: string): string {
  const named: Record<string, string> = { amp: '&', lt: '<', gt: '>', quot: '"', apos: "'", nbsp: ' ' }
  return text.replace(/&(#x[0-9a-f]+|#\d+|amp|lt|gt|quot|apos|nbsp);/gi, (all: string, entity: string) => {
    if (!entity.startsWith('#')) return named[entity.toLowerCase()] ?? all
    const hex = entity[1]?.toLowerCase() === 'x', point = Number.parseInt(entity.slice(hex ? 2 : 1), hex ? 16 : 10)
    return Number.isFinite(point) && point > 0 && point <= 0x10ffff ? String.fromCodePoint(point) : all
  })
}

/** 从生成的简化 HTML 提取段落及表格行；不把样式、超链接或嵌入对象当作正文执行。 */
function docxSections(html: string, emit: (kind: 'paragraph' | 'tableRow', text: string) => void): void {
  let paragraph = ''
  const tables: Array<{ cells: string[]; cell?: string }> = []
  const flush = (): void => { if (paragraph.trim()) emit('paragraph', paragraph.trim()); paragraph = '' }
  for (const match of html.matchAll(/<[^>]*>|[^<]+/g)) {
    const token = match[0]
    const table = tables.at(-1)
    if (!token.startsWith('<')) {
      if (table?.cell !== undefined) table.cell += decodeEntities(token)
      else paragraph += decodeEntities(token)
      continue
    }
    const tag = /^<\s*(\/)?\s*([a-z0-9]+)/i.exec(token)
    if (!tag) continue
    const closing = Boolean(tag[1]), name = tag[2]!.toLowerCase()
    if (name === 'br') { if (table?.cell !== undefined) table.cell += '\n'; else paragraph += '\n' }
    if (name === 'table' && !closing) { flush(); tables.push({ cells: [] }) }
    if (name === 'table' && closing) tables.pop()
    if (name === 'tr' && !closing && table) { flush(); table.cells = [] }
    if ((name === 'td' || name === 'th') && !closing && table) table.cell = ''
    if ((name === 'td' || name === 'th') && closing && table) { table.cells.push(table.cell?.trim() ?? ''); table.cell = undefined }
    if (/^(p|h[1-6]|li)$/.test(name) && closing) { if (table?.cell !== undefined) table.cell += '\n'; else flush() }
    if (name === 'tr' && closing && table?.cells.length) {
      const row = table.cells.join(' | ')
      emit('tableRow', row)
      const parent = tables.at(-2)
      if (parent?.cell !== undefined) parent.cell += `${row}\n`
      table.cells = []
    }
  }
  flush()
}

/** 只读本地 PDF/DOCX，模型可用范围参数继续读取，空提取不冒充 OCR 成功。 */
export async function extractAgentDocument(input: AgentDocumentExtractInput): Promise<AgentDocumentExtraction> {
  const start = positive(input.start, 1, 1_000_000), end = positive(input.end, Math.min(start + 19, 1_000_000), 1_000_000)
  const maxChars = positive(input.maxChars, 20_000, 100_000)
  if (end < start || end - start > 999) throw new Error('每次最多读取 1000 个页或段')
  const format = extname(input.path).toLowerCase().slice(1)
  if (format !== 'pdf' && format !== 'docx') throw new Error('此命令只支持 PDF 和 DOCX；其他文本请使用 Read')
  const bytes = readSource(input.path)
  const result: AgentDocumentExtraction = { filename: basename(input.path), format, totalSections: 0, sections: [], truncated: false, hasMore: false }
  let used = 0
  const emit = (kind: AgentDocumentSection['kind'], text: string, number = result.totalSections + 1): void => {
    result.totalSections = Math.max(result.totalSections, number)
    if (number < start || number > end) return
    const remaining = maxChars - used
    if (text.length > remaining) result.truncated = true
    if (remaining <= 0) return
    const visible = text.slice(0, remaining)
    result.sections.push({ number, kind, text: visible })
    used += visible.length
  }
  if (format === 'pdf') {
    if (!bytes.subarray(0, 1024).includes(Buffer.from('%PDF-'))) throw new Error('文件内容不是有效 PDF')
    const pdfModule = await import('pdf-parse/lib/pdf.js/v1.10.100/build/pdf.js')
    const pdfjs = pdfModule.default
    // 这里只提取文字，关闭旧解析器的动态求值和字体路径，不执行文档脚本。
    pdfjs.PDFJS.isEvalSupported = false
    pdfjs.PDFJS.disableFontFace = true
    pdfjs.PDFJS.disableWorker = true
    pdfjs.PDFJS.verbosity = 0
    const module = await import('pdf-parse/lib/pdf-parse.js') as unknown as PdfParser | { default: PdfParser }
    const parse = typeof module === 'function' ? module : module.default
    let pageFailed = false
    const visited = new Set<number>()
    const parsed = await parse(new Uint8Array(bytes), { max: end, pagerender: async (page) => {
      if (page.pageNumber < start || page.pageNumber > end) return ''
      visited.add(page.pageNumber)
      if (used >= maxChars) { result.truncated = true; return '' }
      try {
        const content = await page.getTextContent({ normalizeWhitespace: false, disableCombineTextItems: false })
        let text = '', previousY: number | undefined
        for (const item of content.items) {
          if (typeof item.str !== 'string') continue
          const y = item.transform?.[5]
          // 多保留一个字符来判断截断，不再累计超出本次预算的整页文本。
          const remaining = maxChars - used + 1 - text.length
          if (remaining <= 0) break
          text += `${previousY === undefined || previousY === y ? '' : '\n'}${item.str}`.slice(0, remaining)
          previousY = y
        }
        emit('page', text, page.pageNumber)
      } catch { pageFailed = true }
      // 结果只存 sections，防止解析器再累计一份完整正文。
      return ''
    } })
    if (pageFailed || visited.size !== Math.max(0, Math.min(parsed.numpages, end) - start + 1)) throw new Error('部分 PDF 页面读取失败，未返回不完整结果')
    result.totalSections = parsed.numpages
  } else {
    if (bytes[0] !== 0x50 || bytes[1] !== 0x4b) throw new Error('文件内容不是有效 DOCX')
    const module = await import('mammoth') as unknown as MammothHtml | { default: MammothHtml }
    const parser = 'default' in module ? module.default : module
    const html = await parser.convertToHtml({ buffer: bytes }, { externalFileAccess: false, includeEmbeddedStyleMap: false,
      convertImage: async () => [] })
    docxSections(html.value, emit)
  }
  result.hasMore = result.truncated || result.totalSections > end
  if (!result.sections.some((section) => section.text.trim())) result.note = '此范围未提取到文字；扫描文档需要 OCR，本命令不提供 OCR 或排版渲染。'
  return result
}
