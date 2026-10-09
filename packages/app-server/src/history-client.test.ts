import { afterEach, describe, expect, test } from 'bun:test'
import { PassThrough } from 'node:stream'
import { APP_SERVER_METHODS as methods } from '@axon/shared'
import type { RpcJsonObject, RpcJsonValue, RpcParams } from '@axon/shared'
import { AppServerHistoryClient, JsonRpcPeer, RpcFault } from './index'
import type { RpcHandlerContext } from './index'

const cleanups: Array<() => void> = []
afterEach(() => { for (const cleanup of cleanups.splice(0).reverse()) cleanup() })
function open(read: (params: RpcParams, context: RpcHandlerContext) => RpcJsonValue | Promise<RpcJsonValue>, failClose = false) {
  const upstream = new PassThrough(), downstream = new PassThrough()
  const parent = new JsonRpcPeer(downstream, upstream, { requestTimeoutMs: 1_000 })
  const child = new JsonRpcPeer(upstream, downstream, { requestTimeoutMs: 1_000 })
  const closed: RpcParams[] = []
  child.handle(methods.HISTORY_READ, read)
  child.handle(methods.HISTORY_CLOSE, (params) => {
    closed.push(params)
    if (failClose) throw new RpcFault(-32029, '清理失败')
    return true
  })
  cleanups.push(() => { parent.close(); child.close(); upstream.destroy(); downstream.destroy() })
  return { parent, child, closed, history: new AppServerHistoryClient(parent, 'trusted-client'),
    disconnect() { upstream.destroy(); downstream.destroy() } }
}
const scope = { kind: 'agent', sessionId: 'session' } as const
const first: RpcJsonObject = { historyId: 'history', messages: [{ type: 'assistant', uuid: 'first' }], cursor: 'cursor-1' }

describe('完整历史客户端的失败边界', () => {
  test('按顺序传原范围和服务端游标，只在 null 返回完整数组，最后关闭一次', async () => {
    const inputs: RpcParams[] = []
    const f = open((params) => {
      inputs.push(params)
      return inputs.length === 1 ? first : { historyId: 'history', messages: [{ type: 'result', uuid: 'last' }], cursor: null }
    })
    expect(await f.history.read(scope)).toEqual([{ type: 'assistant', uuid: 'first' }, { type: 'result', uuid: 'last' }])
    expect(inputs).toEqual([{ clientId: 'trusted-client', input: { scope } },
      { clientId: 'trusted-client', input: { scope, historyId: 'history', cursor: 'cursor-1' } }])
    expect(f.closed).toEqual([{ clientId: 'trusted-client', input: 'history' }])
  })

  test('续页取消不返回首屏、不重发读取；独立关闭已知快照，迟到响应不复活读取', async () => {
    const started = Promise.withResolvers<void>(), released = Promise.withResolvers<void>()
    let reads = 0, canceled = false
    const f = open(async (_params, { signal }) => {
      if (++reads === 1) return first
      signal.addEventListener('abort', () => { canceled = true; released.resolve() }, { once: true })
      started.resolve()
      await released.promise
      return { historyId: 'history', messages: [{ type: 'result', uuid: 'late' }], cursor: null }
    })
    const abort = new AbortController(), outcome = f.history.read(scope, abort.signal).catch((error: unknown) => error)
    await started.promise
    abort.abort()
    expect(await outcome).toMatchObject({ code: 'canceled' })
    expect(canceled).toBe(true)
    expect(reads).toBe(2)
    expect(f.closed).toEqual([{ clientId: 'trusted-client', input: 'history' }])
  })

  test('预取消不发起读取；第二页失败和管道断开不返回部分历史，也不自动重试', async () => {
    let reads = 0
    const f = open(() => { reads += 1; throw new RpcFault(-32029, '历史读取失败') })
    const abort = new AbortController(); abort.abort()
    await expect(f.history.read(scope, abort.signal)).rejects.toThrow()
    expect(reads).toBe(0)
    const error = open(() => ++reads === 1 ? first : Promise.reject(new RpcFault(-32029, '历史读取失败')))
    await expect(error.history.read(scope)).rejects.toMatchObject({ code: -32029 })
    expect(reads).toBe(2)
    expect(error.closed).toHaveLength(1)
    let disconnectedReads = 0
    const disconnected = open(() => {
      if (++disconnectedReads === 1) return first
      disconnected.disconnect()
      return { historyId: 'history', messages: [], cursor: null }
    })
    await expect(disconnected.history.read(scope)).rejects.toBeInstanceOf(Error)
    expect(disconnectedReads).toBe(2)
  })

  test('错误结构、重复游标、空续页或换快照明确失败；清理失败不遮盖读取错误', async () => {
    const invalid: RpcJsonValue[] = [null, { ...first, messages: 'text' }, { ...first, cursor: 1 }, { ...first, messages: Array(101).fill({}) },
      { ...first, cursor: 'cursor-1' }, { ...first, historyId: 'different' }, { ...first, messages: [], cursor: 'cursor-2' }]
    for (const value of invalid) {
      let reads = 0
      const f = open(() => ++reads === 1 ? first : value, true)
      await expect(f.history.read(scope)).rejects.toThrow(/历史/)
      expect(reads).toBe(2)
    }
  })
})
