import { expect, test } from 'bun:test'
import { spawn } from 'node:child_process'
import { createHash } from 'node:crypto'
import { mkdtempSync, readFileSync, rmSync, statSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { PassThrough } from 'node:stream'
import { APP_SERVER_RPC_OPTIONS, MAX_ATTACHMENT_SIZE } from '@axon/shared'
import type { AttachmentSaveResult, RpcJsonObject } from '@axon/shared'
import { JsonRpcPeer } from './index'

/** 真实 stdio 保存完整 100 MiB；只测当前分段/仓储，不能代替完整 app-server 验收。 */
test('真实 stdio 分段：100 MiB 附件精确落盘，大响应无损且每行仍有界', async () => {
  const directory = mkdtempSync(join(tmpdir(), 'axon-rpc-large-'))
  const child = spawn(process.execPath, [join(import.meta.dir, '../test-support/chunk-stdio-fixture.ts'), directory], {
    stdio: ['pipe', 'pipe', 'pipe'],
  })
  const exited = new Promise<number | null>((resolve, reject) => { child.once('exit', resolve); child.once('error', reject) })
  const upstream = new PassThrough()
  upstream.pipe(child.stdin)
  let maxLine = 0
  let chunks = 0
  const observe = () => {
    let pending = 0
    return (value: Buffer): void => {
      let start = 0
      while (start < value.length) {
        const newline = value.indexOf(10, start)
        pending += (newline < 0 ? value.length : newline) - start
        maxLine = Math.max(maxLine, pending)
        if (newline < 0) return
        pending = 0; start = newline + 1
      }
    }
  }
  const inspect = observe()
  upstream.on('data', (value: Buffer) => { inspect(value); chunks += 1 })
  child.stdout.on('data', observe())
  const peer = new JsonRpcPeer(child.stdout, upstream, { ...APP_SERVER_RPC_OPTIONS, requestTimeoutMs: 15_000 })
  let stderr = ''
  child.stderr.on('data', (buffer: Buffer) => { stderr += buffer.toString() })
  try {
    expect(await peer.request('ready')).toEqual({ pid: child.pid! })
    const text = '分段中文🙂'.repeat(150_000)
    const echoed = await peer.request('echo', { text }) as RpcJsonObject
    expect(typeof echoed.text).toBe('string')
    expect(createHash('sha256').update(String(echoed.text)).digest('hex'))
      .toBe(createHash('sha256').update(text).digest('hex'))
    const bytes = Buffer.alloc(MAX_ATTACHMENT_SIZE, 0x61)
    const expected = createHash('sha256').update(bytes).digest('hex')
    const result = await peer.request('save', { conversationId: 'large-fixture', filename: 'exact.bin',
      mediaType: 'application/octet-stream', data: bytes.toString('base64') }) as unknown as AttachmentSaveResult
    expect(result.success).toBe(true)
    if (!result.success) throw new Error('完整附件保存失败')
    expect(result.attachment.size).toBe(MAX_ATTACHMENT_SIZE)
    const file = join(directory, 'attachments', result.attachment.localPath)
    expect(statSync(file).size).toBe(MAX_ATTACHMENT_SIZE)
    expect(createHash('sha256').update(readFileSync(file)).digest('hex')).toBe(expected)
    expect(maxLine).toBeLessThanOrEqual(APP_SERVER_RPC_OPTIONS.maxFrameBytes)
    expect(chunks).toBeGreaterThan(100)
    expect(await peer.request('ready')).toEqual({ pid: child.pid! })
    upstream.end()
    expect(await exited).toBe(0)
    expect(stderr).toContain('[分段夹具] 已就绪')
  } finally {
    peer.close()
    if (child.exitCode === null && child.signalCode === null) child.kill()
    upstream.destroy(); child.stdin.destroy(); child.stdout.destroy(); child.stderr.destroy()
    rmSync(directory, { recursive: true, force: true })
  }
}, 30_000)
