import { describe, expect, test } from 'bun:test'
import { BackendClientRegistry } from './backend-client-registry'

describe('后端客户端登记与断开', () => {
  test('身份由登记表生成且相互独立；断开先失效并取消信号，不影响其他客户端', () => {
    const clients = new BackendClientRegistry()
    const first = clients.register()
    const second = clients.register()
    expect(first).not.toBe(second)
    expect(clients.has('自报身份')).toBe(false)
    const signal = clients.getSignal(first)!
    const observations: boolean[] = []
    const unsubscribe = clients.subscribeDetached((id) => {
      observations.push(id === first && !clients.has(first) && signal.aborted)
    })
    expect(clients.detach(first)).toBe(true)
    expect(clients.detach(first)).toBe(false)
    expect(observations).toEqual([true])
    expect(clients.getSignal(first)).toBeUndefined()
    expect(clients.getSignal(second)?.aborted).toBe(false)
    unsubscribe()
    clients.dispose()
    expect(clients.has(second)).toBe(false)
    expect(() => clients.register()).toThrow('客户端登记表已释放')
  })

  test('注销通知失败不阻止其他资源清理；整体释放幂等', () => {
    const clients = new BackendClientRegistry()
    const first = clients.register()
    const second = clients.register()
    const detached: string[] = []
    clients.subscribeDetached(() => { throw new Error('夹具监听器失败') })
    clients.subscribeDetached((id) => { detached.push(id) })
    clients.dispose()
    clients.dispose()
    expect(detached).toEqual([first, second])
    expect(clients.has(first)).toBe(false)
    expect(clients.has(second)).toBe(false)
  })
})
