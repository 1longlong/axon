import { afterEach, expect, spyOn, test } from 'bun:test'
import { PassThrough, Writable } from 'node:stream'
import { APP_SERVER_SHUTDOWN_TIMEOUT_MS, APP_SERVER_STOP_TIMEOUT_MS } from '@axon/shared'
import { AppServerShutdown } from './server-shutdown'

const cleanups: Array<() => void | Promise<void>> = []
afterEach(async () => { for (const cleanup of cleanups.splice(0).reverse()) await cleanup() })

/** 模型无关的生命周期端口；真实 Writable final 控制协议 flush，资源 Promise 控制 drain。 */
function fixture(timeoutMs = 500) {
  const resource = Promise.withResolvers<void>(), flush = Promise.withResolvers<void>()
  const draining = Promise.withResolvers<void>(), flushing = Promise.withResolvers<void>()
  const exited = Promise.withResolvers<number>()
  const trace: string[] = [], input = new PassThrough()
  let diagnoses = 0
  const output = new Writable({ write(_chunk, _encoding, done) { done() }, final(done) {
    trace.push('flush'); flushing.resolve(); void flush.promise.then(() => done())
  } })
  const connection = { close() { trace.push('close') }, async drain() {
    trace.push('drain'); draining.resolve(); await resource.promise; trace.push('drained')
  } }
  const shutdown = new AppServerShutdown({ connection, input, output, timeoutMs,
    diagnostic: () => { diagnoses += 1 }, exit: (code) => { trace.push(`exit:${code}`); exited.resolve(code) } })
  cleanups.push(async () => {
    resource.resolve(); flush.resolve(); shutdown.close(0)
    await exited.promise; input.destroy(); output.destroy()
  })
  return { shutdown, connection, input, output, trace, resource, flush, draining, flushing, exited,
    get diagnoses() { return diagnoses } }
}

test('默认期限早于父端 TERM，后端真实结束后才 flush，重复关闭不重复清理', async () => {
  expect(APP_SERVER_SHUTDOWN_TIMEOUT_MS).toBeLessThan(APP_SERVER_STOP_TIMEOUT_MS)
  const f = fixture()
  f.shutdown.close(0); f.shutdown.close(0)
  await f.draining.promise
  expect(f.input.destroyed).toBe(true)
  expect(f.trace).toEqual(['close', 'drain'])
  f.resource.resolve()
  await f.flushing.promise
  expect(f.trace).toEqual(['close', 'drain', 'drained', 'flush'])
  expect(f.output.writableFinished).toBe(false)
  f.flush.resolve()
  expect(await f.exited.promise).toBe(0)
  f.shutdown.close(1)
  expect(f.trace.filter((step) => step.startsWith('exit:'))).toEqual(['exit:0'])
  expect(f.diagnoses).toBe(0)
})

test('关闭中的异常升级退出码但不重启清理，诊断只输出一次', async () => {
  const f = fixture()
  f.shutdown.close(0)
  await f.draining.promise
  f.shutdown.close(1); f.shutdown.close(1)
  expect(f.trace).toEqual(['close', 'drain'])
  expect(f.diagnoses).toBe(1)
  f.resource.resolve(); f.flush.resolve()
  expect(await f.exited.promise).toBe(1)
})

test('同步关闭失败不跳过 stdin 销毁或实际 drain', async () => {
  const f = fixture()
  const fail = spyOn(f.connection, 'close').mockImplementation(() => { throw new Error('sk-private-close') })
  cleanups.push(() => fail.mockRestore())
  f.shutdown.close(0)
  await f.draining.promise
  expect(f.input.destroyed).toBe(true)
  expect(f.trace).toEqual(['drain'])
  f.resource.resolve(); f.flush.resolve()
  expect(await f.exited.promise).toBe(1)
  expect(f.diagnoses).toBe(1)
})

test('stdin 销毁失败也继续真实资源等待', async () => {
  const f = fixture()
  const fail = spyOn(f.input, 'destroy').mockImplementation(() => { throw new Error('sk-private-stdin') })
  cleanups.push(() => fail.mockRestore())
  f.shutdown.close(0)
  await f.draining.promise
  expect(f.trace).toEqual(['close', 'drain'])
  f.resource.resolve(); f.flush.resolve()
  expect(await f.exited.promise).toBe(1)
})

test('异步资源失败收束后仍 flush 并以错误退出，不透传异常正文', async () => {
  const f = fixture()
  const drain = f.connection.drain.bind(f.connection)
  const fail = spyOn(f.connection, 'drain').mockImplementation(async () => {
    await drain(); throw new Error('sk-private-resource')
  })
  cleanups.push(() => fail.mockRestore())
  f.shutdown.close(0)
  await f.draining.promise
  expect(f.diagnoses).toBe(0)
  f.resource.resolve(); await f.flushing.promise
  expect(f.diagnoses).toBe(1)
  f.flush.resolve()
  expect(await f.exited.promise).toBe(1)
})

test('管道故障不会在资源结束前提前退出', async () => {
  const f = fixture()
  const closed = new Promise<void>((done) => f.output.once('close', done))
  f.output.destroy(new Error('sk-private-pipe'))
  await closed; await f.draining.promise
  expect(f.trace).toEqual(['close', 'drain'])
  f.resource.resolve()
  expect(await f.exited.promise).toBe(1)
  expect(f.trace).not.toContain('flush')
  expect(f.diagnoses).toBe(1)
})

test('输出 end 同步失败退出为错误，不能变成未捕获 Promise 拒绝', async () => {
  const f = fixture()
  const fail = spyOn(f.output, 'end').mockImplementation(() => { throw new Error('sk-private-end') })
  cleanups.push(() => fail.mockRestore())
  f.shutdown.close(0); f.resource.resolve()
  expect(await f.exited.promise).toBe(1)
  expect(f.diagnoses).toBe(1)
})

test('总期限覆盖挂住的资源，超时后迟到 drain 不再次 flush/退出', async () => {
  const f = fixture(30)
  f.shutdown.close(0)
  await f.draining.promise
  expect(await f.exited.promise).toBe(1)
  expect(f.trace).toEqual(['close', 'drain', 'exit:1'])
  f.resource.resolve(); await Bun.sleep(0)
  expect(f.trace).toEqual(['close', 'drain', 'exit:1', 'drained'])
  expect(f.diagnoses).toBe(1)
})

test('总期限也覆盖挂住的最后 flush，迟到 callback 不重复退出', async () => {
  const f = fixture(30)
  f.shutdown.close(0); f.resource.resolve()
  await f.flushing.promise
  expect(await f.exited.promise).toBe(1)
  f.flush.resolve(); await Bun.sleep(0)
  expect(f.trace).toEqual(['close', 'drain', 'drained', 'flush', 'exit:1'])
  expect(f.diagnoses).toBe(1)
})
