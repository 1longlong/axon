import { describe, expect, test } from 'bun:test'
import sharp from 'sharp'
import { prepareAgentImage } from './agent-image-preparation'
import { MAX_AGENT_IMAGE_PREPARED_BYTES } from '@axon/shared'

describe('真实图片解码和处理', () => {
  test('PNG 保留透明像素、重编码并生成有界 JPEG 缩略图', async () => {
    const input = await sharp({ create: { width: 320, height: 160, channels: 4, background: '#ff000080' } }).png().toBuffer()
    const prepared = await prepareAgentImage(input)
    expect(prepared.mediaType).toBe('image/png'); expect(prepared.width).toBe(320); expect(prepared.height).toBe(160)
    expect(prepared.bytes.length).toBeLessThanOrEqual(MAX_AGENT_IMAGE_PREPARED_BYTES)
    expect((await sharp(prepared.bytes).metadata()).hasAlpha).toBe(true)
    expect((await sharp(prepared.thumbnail.bytes).metadata()).format).toBe('jpeg')
    expect(prepared.thumbnail.width).toBe(256); expect(prepared.thumbnail.height).toBe(128)
  })
  test('JPEG 按 EXIF 方向旋转且处理版本不携带原元信息', async () => {
    const input = await sharp({ create: { width: 100, height: 50, channels: 3, background: '#123456' } }).jpeg().withMetadata({ orientation: 6 }).toBuffer()
    const prepared = await prepareAgentImage(input)
    expect(prepared.width).toBe(50); expect(prepared.height).toBe(100)
    expect((await sharp(prepared.bytes).metadata()).exif).toBeUndefined()
  })
  test('WebP/GIF 实际解码，GIF 明确说明只发首帧', async () => {
    const base = sharp({ create: { width: 12, height: 6, channels: 3, background: '#123456' } })
    const webp = await prepareAgentImage(await base.clone().webp().toBuffer())
    expect(webp.originalMediaType).toBe('image/webp')
    const gif = await prepareAgentImage(await base.clone().gif().toBuffer())
    expect(gif.originalMediaType).toBe('image/gif'); expect(gif.note).toContain('第一帧')
  })
  test('大边长等比缩小，不放大小图', async () => {
    const input = await sharp({ create: { width: 5000, height: 100, channels: 3, background: '#123456' } }).png().toBuffer()
    const result = await prepareAgentImage(input)
    expect(result.width).toBe(4096); expect(result.height).toBe(82)
  })
  test('SVG、伪图片、截断数据、空输入及超大原件拒绝', async () => {
    for (const input of [Buffer.from('<svg xmlns="http://www.w3.org/2000/svg"><script/></svg>'), Buffer.from('not an image'), Buffer.alloc(0), Buffer.alloc(20 * 1024 * 1024 + 1)]) await expect(prepareAgentImage(input)).rejects.toThrow()
    const valid = await sharp({ create: { width: 12, height: 6, channels: 3, background: 'red' } }).png().toBuffer()
    await expect(prepareAgentImage(valid.subarray(0, 30))).rejects.toThrow()
  })
})
