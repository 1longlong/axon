import { expect, test } from 'bun:test'
import { mkdtempSync, realpathSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { PassThrough, Writable } from 'node:stream'
import { acquireBackendDirectoryLease } from '@axon/host-node'
import { AppServerShutdown } from './server-shutdown'

/** 实际 OS 租约与退出协调器，控制 drain/flush 完成时机以验证释放顺序。 */
test.skipIf(process.platform !== 'darwin')('关闭入口后 drain/flush 仍持锁，实际退出回调才释放', async () => {
  const directory = realpathSync(mkdtempSync(join(tmpdir(), 'axon-server-lock-drain-')))
  const lease = acquireBackendDirectoryLease(directory)
  const drain = Promise.withResolvers<void>(), flush = Promise.withResolvers<void>(), flushing = Promise.withResolvers<void>()
  const exited = Promise.withResolvers<number>(), draining = Promise.withResolvers<void>()
  const input = new PassThrough()
  const output = new Writable({ write(_chunk, _encoding, done) { done() }, final(done) {
    flushing.resolve(); void flush.promise.then(() => done())
  } })
  const shutdown = new AppServerShutdown({ connection: { close() {}, async drain() { draining.resolve(); await drain.promise } },
    input, output, exit: (code) => { lease.release(); exited.resolve(code) }, diagnostic() {}, timeoutMs: 3_000 })
  try {
    shutdown.close(0)
    await draining.promise
    expect(input.destroyed).toBe(true)
    expect(() => acquireBackendDirectoryLease(directory)).toThrow('已有后端运行')
    drain.resolve()
    await flushing.promise
    expect(() => acquireBackendDirectoryLease(directory)).toThrow('已有后端运行')
    flush.resolve()
    expect(await exited.promise).toBe(0)
    const next = acquireBackendDirectoryLease(directory); next.release()
  } finally {
    drain.resolve(); flush.resolve(); shutdown.close(0); await exited.promise
    lease.release(); input.destroy(); output.destroy()
    rmSync(directory, { recursive: true, force: true })
  }
})
