/**
 * 文档附件文本提取（主进程）。
 *
 * 链路位置：ChatService 组装模型历史时，对用户消息携带的非图片附件调用本模块，
 * 把提取文本以 `<file name="…">` 块注入请求；提取结果不持久化，每轮按需重提取。
 * pdf/DOCX 的重型解析库按需动态加载，且在 esbuild 构建中标记 external，
 * 保证不拖累应用启动和不加载 PDF 时不打进内存。
 */

/** 允许进入解析的附件字节上限；超大文档不解析，由编排层降级为提示。 */
export const MAX_DOCUMENT_PARSE_BYTES = 20 * 1024 * 1024

/** 注入请求的提取文本上限，超出截断，避免单个附件占满上下文预算。 */
export const MAX_DOCUMENT_TEXT_LENGTH = 400_000

export class DocumentParseError extends Error {
  constructor(
    readonly code: 'too_large' | 'unsupported' | 'parse_failed',
    message: string,
  ) {
    super(message)
    this.name = 'DocumentParseError'
  }
}

export interface DocumentParseInput {
  filename: string
  mediaType: string
  buffer: Buffer
}

export type PdfParseFunction = (buffer: Buffer) => Promise<{ text: string }>
export type DocxParseFunction = (buffer: Buffer) => Promise<{ value: string }>

export interface DocumentParserOptions {
  /** 默认延迟加载 pdf-parse 1.x 的 lib 子路径；测试注入假实现。 */
  parsePdf?: PdfParseFunction
  /** 默认延迟加载 mammoth extractRawText；测试注入假实现。 */
  parseDocx?: DocxParseFunction
}

/** 文档类附件判定：所有非图片附件都尝试按文档提取。 */
export function isDocumentAttachment(mediaType: string): boolean {
  return typeof mediaType === 'string' && !mediaType.startsWith('image/')
}

function fileExtension(filename: string): string {
  const dot = filename.lastIndexOf('.')
  return dot <= 0 || dot === filename.length - 1 ? '' : filename.slice(dot + 1).toLowerCase()
}

/** 提取结果统一截断，防止单个文档占满上下文预算。 */
function clampText(text: string): string {
  const trimmed = text.trim()
  if (trimmed.length <= MAX_DOCUMENT_TEXT_LENGTH) return trimmed
  return `${trimmed.slice(0, MAX_DOCUMENT_TEXT_LENGTH)}\n……（文档过长，已截断）`
}

function decodeUtf8(buffer: Buffer): string {
  // 去掉 UTF-8 BOM，避免它混入发给模型的正文开头。
  return buffer.toString('utf8').replace(/^\uFEFF/, '')
}

/** pdf-parse 1.x 主入口有调试副作用，必须从 lib 子路径加载；兼容函数/默认导出两种互操作形态。 */
async function loadDefaultPdfParser(): Promise<PdfParseFunction> {
  const module = (await import('pdf-parse/lib/pdf-parse.js')) as unknown as
    | PdfParseFunction
    | { default: PdfParseFunction }
  return typeof module === 'function' ? module : module.default
}

/** mammoth 的真实 API 形状：extractRawText 接收 { buffer } 并返回 { value }。 */
interface MammothLike {
  extractRawText: (input: { buffer: Buffer }) => Promise<{ value: string }>
}

async function loadDefaultDocxParser(): Promise<DocxParseFunction> {
  const module = (await import('mammoth')) as unknown as MammothLike | { default: MammothLike }
  const resolved = 'extractRawText' in module ? module : module.default
  return async (buffer) => {
    const result = await resolved.extractRawText({ buffer })
    return { value: result.value }
  }
}

/**
 * 创建文档提取函数：按扩展名分发到 PDF/DOCX 解析器或 UTF-8 直读；
 * 失败抛出稳定错误码，由编排层降级为文本提示，而不是中断生成。
 */
export function createDocumentParser(options: DocumentParserOptions = {}): (input: DocumentParseInput) => Promise<string> {
  return async (input) => {
    if (!input || typeof input !== 'object' || !Buffer.isBuffer(input.buffer)) {
      throw new DocumentParseError('parse_failed', '文档内容无效')
    }
    if (input.buffer.byteLength > MAX_DOCUMENT_PARSE_BYTES) {
      throw new DocumentParseError('too_large', '文档超过解析大小上限')
    }
    const extension = fileExtension(input.filename)
    try {
      if (extension === 'pdf') {
        const parsePdf = options.parsePdf ?? (await loadDefaultPdfParser())
        const result = await parsePdf(input.buffer)
        if (typeof result?.text !== 'string' || !result.text.trim()) {
          throw new DocumentParseError('parse_failed', 'PDF 未提取到文本')
        }
        return clampText(result.text)
      }
      if (extension === 'docx') {
        const parseDocx = options.parseDocx ?? (await loadDefaultDocxParser())
        const result = await parseDocx(input.buffer)
        if (typeof result?.value !== 'string' || !result.value.trim()) {
          throw new DocumentParseError('parse_failed', 'DOCX 未提取到文本')
        }
        return clampText(result.value)
      }
      if (extension === 'doc') {
        // 旧版二进制 .doc 需要单独的解析器，明确不支持而不是当文本读出乱码。
        throw new DocumentParseError('unsupported', '暂不支持旧版 .doc，请另存为 .docx')
      }
      // 文本类与未知扩展名统一按 UTF-8 直读；二进制内容会得到低质量文本，由模型自行判断。
      return clampText(decodeUtf8(input.buffer))
    } catch (error) {
      if (error instanceof DocumentParseError) throw error
      throw new DocumentParseError('parse_failed', '文档解析失败')
    }
  }
}
