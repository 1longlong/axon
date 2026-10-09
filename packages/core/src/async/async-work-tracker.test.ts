import { expect, test } from 'bun:test'
import { AsyncWorkTracker } from './async-work-tracker'

test('先登记后同步调用，等待真实拒绝和内部追加工作，不留下未处理拒绝', async () => {
  const tracker = new AsyncWorkTracker()
  let finish!: () => void
  const cleanup = new Promise<void>((done) => { finish = done })
  let entered = false
  const work = tracker.run(async () => {
    entered = true
    await Promise.resolve()
    void tracker.run(async () => { await cleanup; throw new Error('附属失败') }).catch(() => {})
    throw new Error('主工作失败')
  })
  expect(entered).toBe(true)
  await expect(work).rejects.toThrow('主工作失败')
  const drain = tracker.drain()
  expect(await Promise.race([drain.then(() => '结束'), Bun.sleep(10).then(() => '等待')])).toBe('等待')
  finish()
  await drain
  await tracker.drain()
  await expect(tracker.run(() => { throw new Error('同步失败') })).rejects.toThrow('同步失败')
  await tracker.drain()
})
