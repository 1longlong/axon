import { afterEach, describe, expect, test } from 'bun:test'
import { randomUUID } from 'node:crypto'
import { PassThrough, Writable } from 'node:stream'
import { AXON_RPC_CHUNK_METHOD, AXON_RPC_CHUNK_ABORT_METHOD, AXON_RPC_CANCEL_METHOD } from '@axon/shared'
import type { RpcFrame, RpcJsonObject } from '@axon/shared'
import { JsonRpcPeer, RpcFault } from './index'
import type { JsonRpcPeerOptions } from './index'

const cleanups: Array<() => void> = []
afterEach(() => { for (const cleanup of cleanups.splice(0)) cleanup() })
const options: JsonRpcPeerOptions = { maxFrameBytes: 1024, maxMessageBytes: 512 * 1024,
  maxBufferedMessageBytes: 512 * 1024, maxQueuedBytes: 1024 * 1024, chunkTimeoutMs: 2_000, requestTimeoutMs: 2_000 }
function pair() {
  const upstream = new PassThrough()
  const downstream = new PassThrough()
  const parent = new JsonRpcPeer(downstream, upstream, options)
  const child = new JsonRpcPeer(upstream, downstream, options)
  let maxLine = 0
  let parts = 0
  const inspect = (buffer: Buffer): void => {
    maxLine = Math.max(maxLine, buffer.length - 1)
    if ((JSON.parse(buffer.toString()) as { method?: string }).method === AXON_RPC_CHUNK_METHOD) parts += 1
  }
  upstream.on('data', inspect); downstream.on('data', inspect)
  cleanups.push(() => { parent.close(); child.close(); upstream.destroy(); downstream.destroy() })
  return { parent, child, get maxLine() { return maxLine }, get parts() { return parts } }
}
function raw(overrides: JsonRpcPeerOptions = {}) {
  const input = new PassThrough()
  const output = new PassThrough()
  output.resume()
  const peer = new JsonRpcPeer(input, output, { ...options, ...overrides })
  cleanups.push(() => { peer.close(); input.destroy(); output.destroy() })
  let calls = 0
  peer.handle('execute', () => { calls += 1; return true })
  const write = (params: RpcJsonObject, method = AXON_RPC_CHUNK_METHOD): void => {
    input.write(`${JSON.stringify({ jsonrpc: '2.0', method, params })}\n`)
  }
  return { peer, input, write, get calls() { return calls } }
}
function message(id = 'request'): Buffer {
  return Buffer.from(JSON.stringify({ jsonrpc: '2.0', id, method: 'execute', params: { text: '中文内容' } }))
}
function chunk(bytes: Buffer, offset: number, end: boolean, transferId: string, total: number, id = 'request'): RpcJsonObject {
  return { transferId, total, kind: 'request', id, offset, data: bytes.toString('base64'), end }
}

describe('有界大消息分段', () => {
  test('大请求/响应和受控错误完整往返，中文跨段无损且线上行帧不超限', async () => {
    const fixture = pair()
    const text = '中文🙂\n'.repeat(5_000)
    fixture.child.handle('echo', (params) => params)
    const value = await fixture.parent.request('echo', { text })
    expect(value).toEqual({ text })
    fixture.child.handle('error', () => { throw new RpcFault(-32602, '参数错误', { text }) })
    await expect(fixture.parent.request('error')).rejects.toMatchObject({ code: -32602, data: { text } })
    expect(fixture.parts).toBeGreaterThan(3)
    expect(fixture.maxLine).toBeLessThanOrEqual(options.maxFrameBytes!)
    expect(await fixture.parent.request('echo', { small: true })).toEqual({ small: true })
  })

  test('不完整消息不执行；中止释放半条消息，EOF 不产生业务', async () => {
    const fixture = raw()
    const bytes = message()
    const transferId = randomUUID()
    fixture.write(chunk(bytes.subarray(0, 20), 0, false, transferId, bytes.length))
    expect(fixture.calls).toBe(0)
    fixture.write({ transferId }, AXON_RPC_CHUNK_ABORT_METHOD)
    fixture.write(chunk(bytes, 0, true, randomUUID(), bytes.length))
    expect(fixture.calls).toBe(1)
    fixture.write(chunk(bytes.subarray(0, 20), 0, false, randomUUID(), bytes.length, 'incomplete'))
    const closed = new Promise<void>((resolve) => fixture.peer.onClose(() => resolve()))
    fixture.input.end()
    await closed
    expect(fixture.peer.closed).toBe(true)
    expect(fixture.calls).toBe(1)
  })

  test.each(['offset', 'total', 'identity', 'encoding', 'premature', 'nested', 'utf8', 'body'])('无效分段关闭连接不执行：%s', (mode) => {
    const fixture = raw()
    const transferId = randomUUID()
    const bytes = mode === 'utf8' ? Buffer.from([0xff]) : mode === 'nested'
      ? Buffer.from(JSON.stringify({ jsonrpc: '2.0', method: AXON_RPC_CHUNK_ABORT_METHOD, params: { transferId } })) : message()
    if (mode === 'premature') fixture.write(chunk(bytes.subarray(0, 20), 0, true, transferId, bytes.length))
    else if (mode === 'body') fixture.write(chunk(bytes, 0, true, transferId, bytes.length, 'other'))
    else if (mode === 'encoding') fixture.write({ ...chunk(bytes, 0, true, transferId, bytes.length), data: 'secret.invalid' })
    else if (['nested', 'utf8'].includes(mode)) fixture.write(chunk(bytes, 0, true, transferId, bytes.length))
    else {
      fixture.write(chunk(bytes.subarray(0, 20), 0, false, transferId, bytes.length))
      fixture.write({ ...chunk(bytes.subarray(20), mode === 'offset' ? 19 : 20, true, transferId, bytes.length),
        ...(mode === 'total' ? { total: bytes.length + 1 } : {}), ...(mode === 'identity' ? { id: 'other' } : {}) })
    }
    expect(fixture.peer.closed).toBe(true)
    expect(fixture.calls).toBe(0)
  })

  test('声明总量、并行传输与实际累计字节有界；重复请求 ID 拒绝', () => {
    const bytes = message()
    const total = raw({ maxMessageBytes: 1024 })
    total.write(chunk(bytes.subarray(0, 20), 0, false, randomUUID(), 1025))
    expect(total.peer.closed).toBe(true)
    const active = raw({ maxChunkTransfers: 1 })
    active.write(chunk(bytes.subarray(0, 20), 0, false, randomUUID(), bytes.length))
    active.write(chunk(bytes.subarray(0, 20), 0, false, randomUUID(), bytes.length, 'another'))
    expect(active.peer.closed).toBe(true)
    const buffered = raw({ maxBufferedMessageBytes: 30 })
    buffered.write(chunk(bytes.subarray(0, 20), 0, false, randomUUID(), bytes.length))
    buffered.write(chunk(bytes.subarray(0, 20), 0, false, randomUUID(), bytes.length, 'another'))
    expect(buffered.peer.closed).toBe(true)
    const duplicate = raw()
    duplicate.write(chunk(bytes.subarray(0, 20), 0, false, randomUUID(), bytes.length))
    duplicate.write(chunk(bytes.subarray(0, 20), 0, false, randomUUID(), bytes.length))
    expect(duplicate.peer.closed).toBe(true)
    for (const fixture of [total, active, buffered, duplicate]) expect(fixture.calls).toBe(0)
  })

  test('半条消息超时关闭并释放；内部方法不能被业务注册或伪造', async () => {
    const fixture = raw({ chunkTimeoutMs: 10 })
    const bytes = message()
    fixture.write(chunk(bytes.subarray(0, 20), 0, false, randomUUID(), bytes.length))
    const closed = new Promise<void>((resolve) => fixture.peer.onClose(() => resolve()))
    await closed
    expect(fixture.calls).toBe(0)
    const next = pair()
    for (const method of [AXON_RPC_CHUNK_METHOD, AXON_RPC_CHUNK_ABORT_METHOD, AXON_RPC_CANCEL_METHOD]) {
      expect(() => next.parent.handle(method, () => null)).toThrow()
      expect(() => next.parent.notify(method)).toThrow()
      await expect(next.parent.request(method)).rejects.toThrow('内部方法')
    }
    await expect(next.parent.request('echo', { values: new Array(1) } as unknown as RpcJsonObject)).rejects.toThrow()
  })

  test('限制碎片数量并区分容量错误；发送前超限不会留下半条消息', async () => {
    const fixture = raw({ maxChunkParts: 2 })
    let code: string | undefined
    fixture.peer.onClose((error) => { code = error.code })
    const bytes = message()
    const transferId = randomUUID()
    for (let offset = 0; offset < 3; offset += 1) fixture.write(chunk(bytes.subarray(offset, offset + 1), offset, false, transferId, bytes.length))
    expect(code).toBe('overflow')
    expect(fixture.calls).toBe(0)
    const sender = raw({ maxChunkParts: 2 })
    await expect(sender.peer.request('execute', { text: 'a'.repeat(3_000) })).rejects.toMatchObject({ code: 'overflow' })
    expect(sender.peer.closed).toBe(false)
  })

  test('已进入异步业务的正文仍占预算，不能用连续完整消息绕过累计上限', async () => {
    const fixture = raw({ maxBufferedMessageBytes: 150 })
    const gate = Promise.withResolvers<boolean>()
    fixture.peer.handle('wait', () => gate.promise)
    fixture.input.write(`${JSON.stringify({ jsonrpc: '2.0', id: 'first', method: 'wait', params: { text: 'a'.repeat(60) } })}\n`)
    expect(fixture.peer.closed).toBe(false)
    const bytes = message('second')
    fixture.write(chunk(bytes.subarray(0, 40), 0, false, randomUUID(), bytes.length, 'second'))
    expect(fixture.peer.closed).toBe(true)
    expect(fixture.calls).toBe(0)
    gate.resolve(true)
    await Bun.sleep(0)
  })

  test('异步通知也占接收预算，关闭不等待回调结束或丢失越界诊断', async () => {
    const fixture = raw({ maxBufferedMessageBytes: 150 })
    const gate = Promise.withResolvers<void>()
    let code: string | undefined
    fixture.peer.onClose((error) => { code = error.code })
    fixture.peer.handleNotification('hold', () => gate.promise)
    const line = JSON.stringify({ jsonrpc: '2.0', method: 'hold', params: { text: 'a'.repeat(40) } })
    fixture.input.write(`${line}\n${line}\n`)
    expect(code).toBe('overflow')
    gate.resolve()
    await Bun.sleep(0)
  })
})

describe('分段与背压/取消协同', () => {
  function blocked() {
    const input = new PassThrough()
    const output = new Writable({ highWaterMark: 1, write(buffer: Buffer, _encoding, callback) {
      frames.push(JSON.parse(buffer.toString()) as RpcFrame)
      callbacks.push(callback)
    } })
    const frames: RpcFrame[] = []
    const callbacks: Array<(error?: Error | null) => void> = []
    const peer = new JsonRpcPeer(input, output, options)
    cleanups.push(() => { peer.close(); input.destroy(); output.destroy() })
    const release = (): Promise<void> => new Promise((resolve) => { output.once('drain', resolve); callbacks.shift()?.() })
    return { peer, input, frames, release }
  }

  test('短控制穿过分段消息，通知仍按原顺序完成', async () => {
    const { peer, frames, release } = blocked()
    peer.notify('event', { text: 'a'.repeat(3_000), order: 1 })
    peer.notify('event', { order: 2 })
    const pending = peer.request('stop')
    const rejected = pending.catch((error: unknown) => error)
    await release()
    expect(frames[1]).toMatchObject({ method: 'stop' })
    while (true) {
      const last = frames.at(-1)
      if (last && 'method' in last && last.method === 'event') break
      await release()
    }
    expect(frames.at(-1)).toMatchObject({ method: 'event', params: { order: 2 } })
    const chunks = frames.filter((frame) => 'method' in frame && frame.method === AXON_RPC_CHUNK_METHOD)
    expect(chunks.length).toBeGreaterThan(1)
    expect(chunks.at(-1)).toMatchObject({ params: { end: true } })
    peer.close()
    expect(await rejected).toMatchObject({ code: 'closed' })
  })

  test('取消部分发送的大请求会发送中止，接收端从未执行且能继续处理其他请求', async () => {
    const { peer, frames, release } = blocked()
    const stop = new AbortController()
    const pending = peer.request('execute', { text: 'a'.repeat(3_000) }, { signal: stop.signal })
    const rejected = pending.catch((error: unknown) => error)
    expect(frames[0]).toMatchObject({ method: AXON_RPC_CHUNK_METHOD, params: { offset: 0, end: false } })
    stop.abort()
    expect(await rejected).toMatchObject({ code: 'canceled' })
    await release(); await release()
    expect(frames[1]).toMatchObject({ method: AXON_RPC_CHUNK_ABORT_METHOD })
    expect(frames[2]).toMatchObject({ method: AXON_RPC_CANCEL_METHOD })
    const receiver = raw()
    for (const frame of frames) receiver.input.write(`${JSON.stringify(frame)}\n`)
    expect(receiver.calls).toBe(0)
    expect(receiver.peer.closed).toBe(false)
    receiver.input.write(`${JSON.stringify({ jsonrpc: '2.0', id: 'next', method: 'execute' })}\n`)
    expect(receiver.calls).toBe(1)
    peer.close()
  })

  test('响应半途取消丢弃余段，不消费迟到结果，也不污染下一条消息', async () => {
    const { peer, input, frames, release } = blocked()
    const stop = new AbortController()
    const pending = peer.request('large', {}, { signal: stop.signal })
    const rejected = pending.catch((error: unknown) => error)
    const request = frames[0]
    if (!request || !('id' in request)) throw new Error('缺少请求 ID')
    const bytes = Buffer.from(JSON.stringify({ jsonrpc: '2.0', id: request.id, result: 'a'.repeat(2_000) }))
    const transferId = randomUUID()
    const write = (part: Buffer, offset: number, end: boolean): void => {
      input.write(`${JSON.stringify({ jsonrpc: '2.0', method: AXON_RPC_CHUNK_METHOD,
        params: { transferId, total: bytes.length, kind: 'response', id: request.id,
          offset, data: part.toString('base64'), end },
      })}\n`)
    }
    write(bytes.subarray(0, 500), 0, false)
    stop.abort()
    expect(await rejected).toMatchObject({ code: 'canceled' })
    for (let offset = 500; offset < bytes.length; offset += 500) {
      const part = bytes.subarray(offset, Math.min(offset + 500, bytes.length))
      write(part, offset, offset + part.length === bytes.length)
    }
    expect(peer.closed).toBe(false)
    await release()
    peer.close()
  })
})
