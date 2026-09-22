import { describe, expect, test } from 'bun:test'
import {
  DocumentParseError,
  MAX_DOCUMENT_PARSE_BYTES,
  MAX_DOCUMENT_TEXT_LENGTH,
  createDocumentParser,
} from './document-parser'

/**
 * 构造带正确 xref 偏移的最小合法 PDF，让默认加载器（真实 pdf-parse）在单测中
 * 就能覆盖 PDF 分发路径，而不需要构建期外的测试资源文件。
 */
function minimalPdf(text: string): Buffer {
  const content = `BT /F1 24 Tf 72 720 Td (${text}) Tj ET`
  const objects = [
    '<< /Type /Catalog /Pages 2 0 R >>',
    '<< /Type /Pages /Kids [3 0 R] /Count 1 >>',
    '<< /Type /Page /Parent 2 0 R /MediaBox [0 0 612 792] /Contents 4 0 R /Resources << /Font << /F1 5 0 R >> >> >>',
    `<< /Length ${content.length} >>\nstream\n${content}\nendstream`,
    '<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>',
  ]
  let body = '%PDF-1.4\n'
  const offsets: number[] = []
  objects.forEach((object, index) => {
    offsets.push(body.length)
    body += `${index + 1} 0 obj\n${object}\nendobj\n`
  })
  const xrefOffset = body.length
  let xref = `xref\n0 ${objects.length + 1}\n0000000000 65535 f \n`
  for (const offset of offsets) xref += `${String(offset).padStart(10, '0')} 00000 n \n`
  const trailer = `trailer\n<< /Size ${objects.length + 1} /Root 1 0 R >>\nstartxref\n${xrefOffset}\n%%EOF`
  return Buffer.from(body + xref + trailer, 'latin1')
}

describe('document-parser 文档提取', () => {
  test('文本类与未知扩展名按 UTF-8 直读并去除 BOM', async () => {
    const parser = createDocumentParser()
    const withBom = Buffer.from('\uFEFF# 标题\n正文', 'utf8')
    expect(await parser({ filename: '笔记.md', mediaType: 'text/markdown', buffer: withBom })).toBe('# 标题\n正文')
    expect(await parser({ filename: '数据.json', mediaType: 'application/json', buffer: Buffer.from('{"a":1}', 'utf8') })).toBe('{"a":1}')
    // 未知扩展名同样直读，交给模型自行判断内容质量。
    expect(await parser({ filename: '无扩展名', mediaType: 'application/octet-stream', buffer: Buffer.from('内容', 'utf8') })).toBe('内容')
  })

  test('默认加载器解析真实 PDF', async () => {
    const parser = createDocumentParser()
    const text = await parser({ filename: '说明.pdf', mediaType: 'application/pdf', buffer: minimalPdf('Hello Axon 2026') })
    expect(text).toContain('Hello Axon 2026')
  })

  test('注入的 PDF/DOCX 解析器生效，解析异常归一为 parse_failed', async () => {
    const parser = createDocumentParser({
      parsePdf: async () => ({ text: '  PDF 正文  ' }),
      parseDocx: async () => ({ value: ' DOCX 正文 ' }),
    })
    expect(await parser({ filename: 'a.pdf', mediaType: 'application/pdf', buffer: Buffer.from('%PDF') })).toBe('PDF 正文')
    expect(await parser({ filename: 'b.docx', mediaType: 'application/vnd.openxmlformats-officedocument.wordprocessingml.document', buffer: Buffer.from('PK') })).toBe('DOCX 正文')

    const broken = createDocumentParser({
      parsePdf: async () => { throw new Error('secret pdf.js failure') },
      parseDocx: async () => ({ value: '' }),
    })
    // 底层实现细节被归一为稳定错误消息，不透传给上层。
    await expect(broken({ filename: 'a.pdf', mediaType: 'application/pdf', buffer: Buffer.from('%PDF') }))
      .rejects.toMatchObject({ code: 'parse_failed', message: '文档解析失败' })
    await expect(broken({ filename: 'b.docx', mediaType: 'text/plain', buffer: Buffer.from('PK') }))
      .rejects.toMatchObject({ code: 'parse_failed' })
  })

  test('超大文档与旧版 .doc 按稳定错误拒绝', async () => {
    const parser = createDocumentParser()
    await expect(parser({
      filename: 'big.txt',
      mediaType: 'text/plain',
      buffer: Buffer.alloc(MAX_DOCUMENT_PARSE_BYTES + 1),
    })).rejects.toMatchObject({ code: 'too_large' })
    await expect(parser({ filename: '旧.doc', mediaType: 'application/msword', buffer: Buffer.from('x') }))
      .rejects.toMatchObject({ code: 'unsupported' })
  })

  test('提取文本超长时截断并标注', async () => {
    const parser = createDocumentParser({
      parsePdf: async () => ({ text: '甲'.repeat(MAX_DOCUMENT_TEXT_LENGTH + 100) }),
    })
    const text = await parser({ filename: 'long.pdf', mediaType: 'application/pdf', buffer: Buffer.from('%PDF') })
    expect(text.length).toBe(MAX_DOCUMENT_TEXT_LENGTH + '\n……（文档过长，已截断）'.length)
    expect(text.endsWith('（文档过长，已截断）')).toBe(true)
  })

  test('非 Buffer 输入与空提取结果按 parse_failed 处理', async () => {
    const parser = createDocumentParser()
    await expect(parser({ filename: 'a.txt', mediaType: 'text/plain', buffer: undefined as unknown as Buffer }))
      .rejects.toMatchObject({ code: 'parse_failed' })
    const empty = createDocumentParser({ parsePdf: async () => ({ text: '   ' }) })
    await expect(empty({ filename: 'a.pdf', mediaType: 'application/pdf', buffer: Buffer.from('%PDF') }))
      .rejects.toMatchObject({ code: 'parse_failed' })
  })
})

test('默认加载器加载真实 mammoth，非法 DOCX 归一为 parse_failed', async () => {
  const parser = createDocumentParser()
  await expect(parser({
    filename: '损坏.docx',
    mediaType: 'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
    buffer: Buffer.from('PK\x03\x04 not a real zip'),
  })).rejects.toMatchObject({ code: 'parse_failed' })
})
