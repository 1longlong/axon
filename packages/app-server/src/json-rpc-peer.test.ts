import { afterEach, describe, expect, test } from 'bun:test'
import { PassThrough, Writable } from 'node:stream'
import type { RpcFrame } from '@axon/shared'
import { JsonRpcPeer, RpcFault } from './index'

const cleanups: Array<() => void> = []
afterEach(() => { for (const cleanup of cleanups.splice(0)) cleanup() })

function pair(options: ConstructorParameters<typeof JsonRpcPeer>[2] = {}) {
  const upstream = new PassThrough()
  const downstream = new PassThrough()
  const parent = new JsonRpcPeer(downstream, upstream, options)
  const child = new JsonRpcPeer(upstream, downstream, options)
  cleanups.push(() => { parent.close(); child.close(); upstream.destroy(); downstream.destroy() })
  return { parent, child }
}
function raw(options: ConstructorParameters<typeof JsonRpcPeer>[2] = {}) {
  const input = new PassThrough()
  const output = new PassThrough()
  const peer = new JsonRpcPeer(input, output, options)
  output.resume()
  cleanups.push(() => { peer.close(); input.destroy(); output.destroy() })
  return { peer, input, output }
}

describe('双向换行 JSON-RPC', () => {
  test('长业务显式关闭普通时限，仍可取消/断开；默认短请求继续超时', async () => {
    const { parent, child } = pair({ requestTimeoutMs: 5 })
    const gate = Promise.withResolvers<string>()
    child.handle('long', () => gate.promise)
    const long = parent.request('long', {}, { timeoutMs: 0 })
    const short = parent.request('long').catch((error: unknown) => error)
    expect(await short).toMatchObject({ code: 'timeout' })
    gate.resolve('完整结果')
    expect(await long).toBe('完整结果')
    child.handle('waiting', async (_params, { signal }) => {
      await new Promise<void>((resolve) => signal.addEventListener('abort', () => resolve(), { once: true }))
      return null
    })
    const controller = new AbortController()
    const waiting = parent.request('waiting', {}, { timeoutMs: 0, signal: controller.signal }).catch((error: unknown) => error)
    controller.abort()
    expect(await waiting).toMatchObject({ code: 'canceled' })
    const closed = parent.request('waiting', {}, { timeoutMs: 0 }).catch((error: unknown) => error)
    parent.close()
    expect(await closed).toMatchObject({ code: 'closed' })
  })

  test('并发请求按 ID 关联，较晚发起的请求可先完成', async () => {
    const { parent, child } = pair()
    const gate = Promise.withResolvers<string>()
    child.handle('slow', () => gate.promise)
    child.handle('fast', (params) => params)
    const slow = parent.request('slow')
    expect(await parent.request('fast', { value: '中文' })).toEqual({ value: '中文' })
    gate.resolve('慢请求完成')
    expect(await slow).toBe('慢请求完成')
  })

  test('长运行等待反向请求时仍可处理停止请求，通知按到达顺序执行', async () => {
    const { parent, child } = pair()
    const approval = Promise.withResolvers<string>()
    const received = Promise.withResolvers<void>()
    const events: string[] = []
    parent.handleNotification('event', (params) => { events.push(String((params as { value: string }).value)) })
    parent.handle('host.confirm', () => { received.resolve(); return approval.promise })
    child.handle('run', async () => {
      child.notify('event', { value: '开始' })
      const result = await child.request('host.confirm')
      child.notify('event', { value: '结束' })
      return result
    })
    child.handle('stop', () => '已收到停止')
    const running = parent.request('run')
    await received.promise
    expect(await parent.request('stop')).toBe('已收到停止')
    expect(events).toEqual(['开始'])
    approval.resolve('已批准')
    expect(await running).toBe('已批准')
    expect(events).toEqual(['开始', '结束'])
  })

  test('显式错误保留代码，未知异常脱敏，未注册方法返回明确错误', async () => {
    const { parent, child } = pair()
    child.handle('bad', () => { throw new Error('sk-secret /private/credentials') })
    child.handle('invalid', () => { throw new RpcFault(-32602, '参数错误', { field: 'id' }) })
    await expect(parent.request('missing')).rejects.toMatchObject({ code: -32601 })
    await expect(parent.request('bad')).rejects.toMatchObject({ code: -32603, message: 'RPC 请求处理失败' })
    await expect(parent.request('invalid')).rejects.toMatchObject({ code: -32602, message: '参数错误', data: { field: 'id' } })
  })

  test('中文半包、多帧及 CRLF 正确解码，半包不提前执行', () => {
    const { peer, input } = raw()
    const values: unknown[] = []
    peer.handleNotification('event', (params) => { values.push(params) })
    const frame = Buffer.from('{"jsonrpc":"2.0","method":"event","params":{"value":"中文"}}\r\n')
    const split = frame.indexOf(Buffer.from('中')) + 1
    input.write(frame.subarray(0, split))
    expect(values).toEqual([])
    input.write(Buffer.concat([frame.subarray(split), frame]))
    expect(values).toEqual([{ value: '中文' }, { value: '中文' }])
  })

  test.each([
    '日志 sk-secret', '', '[]', '{"jsonrpc":"1.0","method":"event"}',
    '{"jsonrpc":"2.0","method":"event","params":null}',
    '{"jsonrpc":"2.0","id":"x","result":1,"error":{"code":1,"message":"bad"}}',
    '{"jsonrpc":"2.0","id":"x","error":{"code":1.5,"message":"bad"}}',
    '{"jsonrpc":"2.0","id":"x","result":1e309}',
  ])('污染或无效帧关闭连接且不回显内容：%s', (line) => {
    const { peer, input } = raw()
    let error: Error | undefined
    peer.onClose((value) => { error = value })
    input.write(`${line}\n`)
    expect(peer.closed).toBe(true)
    expect(error?.message).not.toContain('sk-secret')
  })

  test('非法 UTF-8、超长半包和过深 JSON 均被拒绝', () => {
    const invalid = raw()
    invalid.input.write(Buffer.from([0xff, 10]))
    expect(invalid.peer.closed).toBe(true)
    const large = raw({ maxFrameBytes: 16 })
    for (let index = 0; index < 17; index += 1) large.input.write(Buffer.from('x'))
    expect(large.peer.closed).toBe(true)
    const deep = raw()
    deep.input.write(`{"jsonrpc":"2.0","id":"deep","result":${'['.repeat(70)}0${']'.repeat(70)}}\n`)
    expect(deep.peer.closed).toBe(true)
  })

  test('EOF 拒绝所有等待并取消在途处理，清理回调失败不阻止其他回调', async () => {
    const { peer, input } = raw()
    let signal: AbortSignal | undefined
    const finish = Promise.withResolvers<string>()
    peer.handle('incoming', (_params, context) => { signal = context.signal; return finish.promise })
    input.write('{"jsonrpc":"2.0","id":"in","method":"incoming"}\n')
    const pending = peer.request('outgoing')
    let closes = 0
    peer.onClose(() => { throw new Error('清理夹具异常') })
    peer.onClose(() => { closes += 1 })
    const rejected = pending.catch((error: unknown) => error)
    input.end('{"半截')
    expect(await rejected).toMatchObject({ code: 'eof' })
    expect(signal?.aborted).toBe(true)
    expect(closes).toBe(1)
    peer.close()
    expect(closes).toBe(1)
    finish.resolve('迟到结束')
  })

  test('取消与超时传给对端信号，迟到回复被忽略且不重发', async () => {
    const { parent, child } = pair({ requestTimeoutMs: 20 })
    let calls = 0
    child.handle('wait', (_params, { signal }) => new Promise((resolve) => {
      calls += 1
      signal.addEventListener('abort', () => resolve('迟到'), { once: true })
    }))
    const stop = new AbortController()
    const request = parent.request('wait', {}, { signal: stop.signal })
    const canceled = request.catch((error: unknown) => error)
    stop.abort()
    expect(await canceled).toMatchObject({ code: 'canceled' })
    await expect(parent.request('wait')).rejects.toMatchObject({ code: 'timeout' })
    child.handle('echo', () => '仍可使用')
    expect(await parent.request('echo')).toBe('仍可使用')
    expect(calls).toBe(2)
    await expect(parent.request('wait', {}, { signal: stop.signal })).rejects.toMatchObject({ code: 'canceled' })
    expect(calls).toBe(2)
  })

  test('重复在途 ID 拒绝；请求数量有界但拒绝额外请求不破坏原请求', async () => {
    const { peer, input } = raw()
    const gate = Promise.withResolvers<string>()
    peer.handle('wait', () => gate.promise)
    const line = '{"jsonrpc":"2.0","id":"same","method":"wait"}\n'
    input.write(line + line)
    expect(peer.closed).toBe(true)
    gate.resolve('结束')
    const { parent, child } = pair({ maxPendingRequests: 1 })
    const finish = Promise.withResolvers<string>()
    child.handle('wait', () => finish.promise)
    const first = parent.request('wait')
    await expect(parent.request('wait')).rejects.toMatchObject({ code: 'overflow' })
    finish.resolve('成功')
    expect(await first).toBe('成功')
  })

  test('关闭后稍晚的管道错误不会成为未捕获异常，管道关闭后移除错误监听', async () => {
    const { peer, input, output } = raw()
    peer.close()
    expect(() => { input.emit('error', new Error('迟到')); output.emit('error', new Error('迟到')) }).not.toThrow()
    input.destroy()
    output.destroy()
    await Bun.sleep(0)
    expect(input.listenerCount('error')).toBe(0)
    expect(output.listenerCount('error')).toBe(0)
  })

  test('不可序列化参数不写入管道，序列化失败不会保留请求等待', async () => {
    const { parent, child } = pair()
    child.handle('echo', () => 'ok')
    await expect(parent.request('echo', { value: undefined } as unknown as { value: string })).rejects.toThrow()
    expect(await parent.request('echo')).toBe('ok')
  })

  test('无法编码的处理结果返回内部错误，连错误响应都超限时明确断开', async () => {
    const { parent, child } = pair({ maxFrameBytes: 256, requestTimeoutMs: 20 })
    child.handle('undefined', () => undefined as unknown as null)
    await expect(parent.request('undefined')).rejects.toMatchObject({ code: -32603 })
    child.handle('oversized-fault', () => { throw new RpcFault(-32602, '参数错误', 'x'.repeat(300)) })
    await expect(parent.request('oversized-fault')).rejects.toMatchObject({ code: 'timeout' })
    expect(child.closed).toBe(true)
  })
})

describe('有界输出与控制优先级', () => {
  function blockedPeer(options: ConstructorParameters<typeof JsonRpcPeer>[2] = {}) {
    const input = new PassThrough()
    const frames: RpcFrame[] = []
    const callbacks: Array<(error?: Error | null) => void> = []
    const output = new Writable({ highWaterMark: 1, write(chunk: Buffer, _encoding, callback) {
      frames.push(JSON.parse(chunk.toString()) as RpcFrame)
      callbacks.push(callback)
    } })
    const peer = new JsonRpcPeer(input, output, options)
    cleanups.push(() => { peer.close(); input.destroy(); output.destroy() })
    const release = (): Promise<void> => new Promise((resolve) => { output.once('drain', resolve); callbacks.shift()?.() })
    return { peer, input, output, frames, callbacks, release }
  }

  test('事件积压时控制请求优先，事件之间顺序不变', async () => {
    const { peer, input, frames, release } = blockedPeer()
    peer.notify('event', { order: 1 })
    peer.notify('event', { order: 2 })
    peer.notify('event', { order: 3 })
    const control = peer.request('stop')
    expect(frames).toHaveLength(1)
    await release()
    expect(frames[1]).toMatchObject({ method: 'stop' })
    const second = frames[1]
    if (!second || !('id' in second)) throw new Error('控制帧缺少 ID')
    input.write(`${JSON.stringify({ jsonrpc: '2.0', id: second.id, result: true })}\n`)
    expect(await control).toBe(true)
    await release()
    await release()
    expect(frames.filter((frame) => 'params' in frame).map((frame) => 'params' in frame ? frame.params : undefined))
      .toEqual([{ order: 1 }, {}, { order: 2 }, { order: 3 }])
  })

  test('未写入的请求取消后从队列删除，不会在解除积压后执行', async () => {
    const { peer, frames, release } = blockedPeer()
    peer.notify('event')
    const stop = new AbortController()
    const canceled = peer.request('must-not-run', {}, { signal: stop.signal })
    const rejection = canceled.catch((error: unknown) => error)
    stop.abort()
    expect(await rejection).toMatchObject({ code: 'canceled' })
    await release()
    expect(frames).toHaveLength(1)
    expect(peer.closed).toBe(false)
  })

  test('输出数量与字节积压超过限制时明确关闭并拒绝等待', async () => {
    const full = blockedPeer({ maxQueuedMessages: 1 })
    full.peer.notify('event')
    const request = full.peer.request('waiting')
    const rejected = request.catch((error: unknown) => error)
    expect(() => full.peer.notify('overflow')).toThrow('积压')
    expect(await rejected).toMatchObject({ code: 'overflow' })
    expect(full.peer.closed).toBe(true)
    const bytes = blockedPeer({ maxQueuedBytes: 100 })
    bytes.peer.notify('event')
    expect(() => bytes.peer.notify('event', { value: 'x'.repeat(100) })).toThrow('积压')
    expect(bytes.peer.closed).toBe(true)
  })
})
