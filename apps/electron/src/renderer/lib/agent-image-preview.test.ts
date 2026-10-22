import { describe, expect, test } from 'bun:test'
import { createHash } from 'node:crypto'
import { MAX_AGENT_ATTACHMENT_CHUNK_BYTES } from '@axon/shared'
import type { AgentImageChunk } from '@axon/shared'
import { readAgentImageBlob } from './agent-image-preview'

const source = { kind: 'draft' as const, draftId: 'draft' }
function packet(bytes: Buffer, offset: number): AgentImageChunk {
  return { attachmentId: 'image', variant: 'image', offset, totalBytes: bytes.length, mediaType: 'image/png',
    sha256: createHash('sha256').update(bytes).digest('hex'), data: bytes.subarray(offset, offset + MAX_AGENT_ATTACHMENT_CHUNK_BYTES).toString('base64') }
}
describe('图片预览有界读取', () => {
  test('固定来源/ID 分块拉取并核对完整哈希，返回 Blob 而非本地路径 URL', async () => {
    const bytes = Buffer.alloc(300_000, 17), offsets: number[] = []
    const blob = await readAgentImageBlob(source, 'image', 'image', new AbortController().signal, async (input) => {
      expect(input.source).toEqual(source); expect('path' in input).toBe(false)
      offsets.push(input.offset); return packet(bytes, input.offset)
    })
    expect(offsets).toEqual([0, MAX_AGENT_ATTACHMENT_CHUNK_BYTES]); expect(blob.type).toBe('image/png')
    expect(Buffer.from(await blob.arrayBuffer()).equals(bytes)).toBe(true)
  })
  test('取消后不读取下一块，也不交付迟到图片', async () => {
    const bytes = Buffer.alloc(300_000), controller = new AbortController(); let calls = 0
    await expect(readAgentImageBlob(source, 'image', 'image', controller.signal, async (input) => {
      calls += 1; controller.abort(); return packet(bytes, input.offset)
    })).rejects.toMatchObject({ name: 'AbortError' })
    expect(calls).toBe(1)
  })
  test('错误归属/偏移/容量/短块/哈希明确失败，不创建可显示 Blob', async () => {
    const bytes = Buffer.from('not-displayed'), valid = packet(bytes, 0)
    for (const patch of [{ attachmentId: 'wrong' }, { offset: 1 }, { totalBytes: 6 * 1024 * 1024 }, { data: 'eA==' }, { sha256: '0'.repeat(64) }, { mediaType: 'image/svg+xml' }]) {
      await expect(readAgentImageBlob(source, 'image', 'image', new AbortController().signal, async () => ({ ...valid, ...patch } as AgentImageChunk))).rejects.toThrow()
    }
  })
})
