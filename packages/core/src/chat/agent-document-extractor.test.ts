import { afterEach, beforeEach, describe, expect, test } from 'bun:test'
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { extractAgentDocument } from './agent-document-extractor'
import { docxFixture, pdfFixture } from '../../test-support/document-fixtures'

let root: string
beforeEach(() => { root = mkdtempSync(join(tmpdir(), 'axon-document-test-')) })
afterEach(() => rmSync(root, { recursive: true, force: true }))
describe('受管文档实际提取', () => {
  test('PDF 按页保留文字并支持范围/截断/后续标志', async () => {
    const path = join(root, 'sample.pdf'); writeFileSync(path, pdfFixture())
    const first = await extractAgentDocument({ path, start: 1, end: 1 })
    expect(first.totalSections).toBe(2); expect(first.hasMore).toBe(true)
    expect(first.sections).toEqual([{ kind: 'page', number: 1, text: 'Axon first page' }])
    const second = await extractAgentDocument({ path, start: 2, end: 2 })
    expect(second.sections[0]?.text).toBe('Axon second page'); expect(second.hasMore).toBe(false)
    const clipped = await extractAgentDocument({ path, maxChars: 4 })
    expect(clipped.sections[0]?.text).toBe('Axon'); expect(clipped.truncated).toBe(true)
  })
  test('DOCX 提取段落/表格行，编号不是页码', async () => {
    const path = join(root, 'sample.docx'); writeFileSync(path, docxFixture())
    const result = await extractAgentDocument({ path })
    expect(result.sections.map((section) => [section.kind, section.text])).toEqual([
      ['paragraph', 'Axon 正文 & 内容'], ['tableRow', '名称 | 数量'], ['tableRow', '附件 | 2'], ['paragraph', '末尾段落'],
    ])
    expect(result.totalSections).toBe(4)
    expect((await extractAgentDocument({ path, start: 2, end: 3 })).sections.map((section) => section.number)).toEqual([2, 3])
  })
  test('无文字 PDF 明确说明，不冒充 OCR 成功', async () => {
    const path = join(root, 'empty.pdf'); writeFileSync(path, pdfFixture(['']))
    expect((await extractAgentDocument({ path })).note).toContain('不提供 OCR')
  })
  test('拒绝伪格式、损坏、加大原件和无效范围', async () => {
    const path = join(root, 'bad.pdf'); writeFileSync(path, 'not a PDF')
    await expect(extractAgentDocument({ path })).rejects.toThrow()
    writeFileSync(path, '%PDF-1.4\ninvalid')
    await expect(extractAgentDocument({ path })).rejects.toThrow()
    writeFileSync(path, Buffer.alloc(20 * 1024 * 1024 + 1))
    await expect(extractAgentDocument({ path })).rejects.toThrow()
    for (const input of [{ start: 0 }, { end: -1 }, { start: 5, end: 4 }, { end: 1001 }, { maxChars: 100_001 }]) await expect(extractAgentDocument({ path, ...input })).rejects.toThrow()
    await expect(extractAgentDocument({ path: join(root, 'unknown.exe') })).rejects.toThrow()
  })
})
