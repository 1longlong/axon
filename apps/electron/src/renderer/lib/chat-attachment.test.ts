import { describe, expect, test } from 'bun:test'
import {
  appendPendingAttachments,
  arrayBufferToBase64,
  formatAttachmentSize,
  pendingAttachmentPreview,
} from './chat-attachment'

function source(name: string, size: number, mediaType = 'text/plain', content = 'x'): {
  name: string
  mediaType: string
  size: number
  bytes: ArrayBuffer
} {
  // size 是声明值（校验只看声明），bytes 用最小内容即可，避免测试分配超大缓冲。
  return { name, mediaType, size, bytes: new TextEncoder().encode(content).buffer as ArrayBuffer }
}

describe('chat-attachment 待发送草稿', () => {
  test('ArrayBuffer 分块转 base64', () => {
    expect(arrayBufferToBase64(new TextEncoder().encode('hello').buffer as ArrayBuffer)).toBe(btoa('hello'))
    // 超过单个分块大小（0x8000）的内容仍能完整转换。
    const large = new Uint8Array(0x8000 + 16).fill(65)
    expect(arrayBufferToBase64(large.buffer as ArrayBuffer)).toBe(btoa(String.fromCharCode(...large)))
  })

  test('大小格式化进位 1024', () => {
    expect(formatAttachmentSize(512)).toBe('512 B')
    expect(formatAttachmentSize(2048)).toBe('2 KB')
    expect(formatAttachmentSize(1536)).toBe('2 KB')
    expect(formatAttachmentSize(5 * 1024 * 1024)).toBe('5.0 MB')
  })

  test('图片附件生成 data URL 预览，其他类型不生成', () => {
    const image = { id: 'a', filename: 'x.png', mediaType: 'image/png', size: 2, data: 'eHQ=' }
    expect(pendingAttachmentPreview(image)).toBe('data:image/png;base64,eHQ=')
    const file = { id: 'b', filename: 'x.txt', mediaType: 'text/plain', size: 2, data: 'eHQ=' }
    expect(pendingAttachmentPreview(file)).toBeUndefined()
  })

  test('追加附件保留原列表，生成独立 ID 与 base64 内容', () => {
    const existing = [{ id: 'old', filename: 'a.txt', mediaType: 'text/plain', size: 1, data: 'eA==' }]
    const batch = appendPendingAttachments(
      [source('报告.png', 4, 'image/png', '图片')],
      existing,
    )
    expect(batch.error).toBeUndefined()
    expect(batch.attachments).toHaveLength(1)
    expect(batch.attachments[0]).toMatchObject({
      filename: '报告.png',
      mediaType: 'image/png',
      size: 4,
      data: arrayBufferToBase64(new TextEncoder().encode('图片').buffer as ArrayBuffer),
    })
    expect(batch.attachments[0]!.id).not.toBe('old')
  })

  test('超限文件、数量上限与空文件按稳定规则处理', () => {
    const oversized = appendPendingAttachments(
      [source('big.bin', 101 * 1024 * 1024)],
      [],
    )
    expect(oversized.attachments).toEqual([])
    expect(oversized.error).toContain('上限')

    const many = Array.from({ length: 10 }, (_, index) => source(`f${index}.txt`, 10))
    const full = appendPendingAttachments(many, [])
    expect(full.attachments).toHaveLength(10)
    const overflow = appendPendingAttachments([source('extra.txt', 10)], full.attachments)
    expect(overflow.attachments).toEqual([])
    expect(overflow.error).toContain('最多携带 10 个附件')

    expect(appendPendingAttachments([source('empty.txt', 0)], []).attachments).toEqual([])
  })

  test('未识别 MIME 回退八位流，空文件名回退默认名', () => {
    const batch = appendPendingAttachments([source('', 4, '', 'data')], [])
    expect(batch.attachments[0]).toMatchObject({
      filename: 'attachment',
      mediaType: 'application/octet-stream',
    })
  })
})
