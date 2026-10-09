import { describe, expect, test } from 'bun:test'
import { EventEmitter } from 'node:events'
import type { WebContents } from 'electron'
import { McpConnectionTests } from './mcp-connection-tests'

class Page extends EventEmitter {
  isDestroyed(): boolean { return false }
  get sender(): WebContents { return this as unknown as WebContents }
}

describe('MCP 临时测试登记', () => {
  test('页面失效取消其全部测试，不取消其他页面，同名请求并不共享取消权', async () => {
    const tests = new McpConnectionTests(), main = new Page(), quick = new Page()
    const gate = Promise.withResolvers<void>(), signals: AbortSignal[] = []
    const execute = async (signal: AbortSignal): Promise<string> => { signals.push(signal); await gate.promise; return 'result' }
    const first = tests.run(main.sender, 'one', execute).catch((error: unknown) => error)
    const second = tests.run(main.sender, 'two', execute).catch((error: unknown) => error)
    const other = tests.run(quick.sender, 'one', execute)
    main.emit('render-process-gone')
    expect(signals.map((signal) => signal.aborted)).toEqual([true, true, false])
    expect(tests.cancel(main.sender, 'one')).toBe(false)
    gate.resolve()
    expect(await first).toMatchObject({ name: 'AbortError' }); expect(await second).toMatchObject({ name: 'AbortError' })
    expect(await other).toBe('result')
    expect(main.eventNames()).toEqual([]); expect(quick.eventNames()).toEqual([])
    tests.dispose()
  })

  test('同步失败释放代次；dispose 撤销实际信号且阻止新测试', async () => {
    const tests = new McpConnectionTests(), page = new Page(), gate = Promise.withResolvers<void>()
    await expect(tests.run(page.sender, 'one', async () => { throw new Error('失败') })).rejects.toThrow('失败')
    expect(page.eventNames()).toEqual([])
    let signal!: AbortSignal
    const pending = tests.run(page.sender, 'one', async (value) => { signal = value; await gate.promise; return true }).catch((error: unknown) => error)
    tests.dispose(); tests.dispose()
    expect(signal.aborted).toBe(true)
    await expect(tests.run(page.sender, 'new', async () => true)).rejects.toThrow('已关闭')
    gate.resolve(); expect(await pending).toMatchObject({ name: 'AbortError' })
    expect(page.eventNames()).toEqual([])
  })
})
