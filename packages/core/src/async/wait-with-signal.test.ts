import { describe, expect, test } from 'bun:test'
import { waitWithSignal } from './wait-with-signal'

describe('中立异步取消等待', () => {
  test('正常完成和异常保留原始结果，不需要信号时直接返回原 Promise', async () => {
    const promise = Promise.resolve('ok')
    expect(waitWithSignal(promise)).toBe(promise)
    expect(await waitWithSignal(promise, new AbortController().signal)).toBe('ok')
    await expect(waitWithSignal(Promise.reject(new Error('failed')), new AbortController().signal)).rejects.toThrow('failed')
  })

  test('取消一个等待者不取消共享操作，也不必等待迟到结果才返回', async () => {
    let finish: (value: string) => void = () => { throw new Error('操作未启动') }
    const shared = new Promise<string>((resolve) => { finish = resolve })
    const controller = new AbortController()
    const cancelled = waitWithSignal(shared, controller.signal)
    const other = waitWithSignal(shared, new AbortController().signal)
    controller.abort()
    await expect(cancelled).rejects.toMatchObject({ name: 'AbortError' })
    finish('late-result')
    expect(await other).toBe('late-result')
  })

  test('预先取消与迟到拒绝都被消费，不产生未处理 Promise', async () => {
    const controller = new AbortController()
    controller.abort()
    await expect(waitWithSignal(Promise.reject(new Error('already-failed')), controller.signal)).rejects.toMatchObject({ name: 'AbortError' })
    let fail: (error: Error) => void = () => { throw new Error('操作未启动') }
    const delayed = new Promise<string>((_resolve, reject) => { fail = reject })
    await expect(waitWithSignal(delayed, controller.signal)).rejects.toMatchObject({ name: 'AbortError' })
    fail(new Error('late-failure'))
    await Promise.resolve()
  })
})
