import { describe, expect, test } from 'bun:test'
import { WorkspaceWatcher } from './workspace-watcher'
import type { WorkspaceWatcherOptions } from './workspace-watcher'
import { AgentMemoryWatcher } from '../memory/agent-memory-watcher'

interface Handle {
  listener(filename: string | null): void
  error?(): void
  closes: number
  failClose: boolean
}

const factories: Array<{ name: string; create(options: WorkspaceWatcherOptions): WorkspaceWatcher | AgentMemoryWatcher }> = [
  { name: '工作区', create: (options) => new WorkspaceWatcher(options) },
  { name: '记忆', create: (options) => new AgentMemoryWatcher(options) },
]

for (const factory of factories) describe(`${factory.name}订阅生命周期`, () => {
  function harness() {
    const handles: Handle[] = []
    const watcher = factory.create({ debounceMs: 5, now: () => 99, watchDirectory: (_root, listener) => {
      const value: Handle = { listener, closes: 0, failClose: false }
      handles.push(value)
      const handle = {
        close: () => { value.closes += 1; if (value.failClose) throw new Error('隔离关闭失败') },
        on: (_event: 'error', error: () => void) => { value.error = error; return handle },
      }
      return handle
    } })
    return { watcher, handles }
  }

  test('替换后旧事件、旧错误和旧定时器不触发投递或关闭新句柄', async () => {
    const { watcher, handles } = harness()
    const oldEvents: number[] = []
    const newEvents: number[] = []
    watcher.watch('client', 'project', '/one', (time) => oldEvents.push(time))
    handles[0]!.listener('memory/old.md')
    watcher.watch('client', 'project', '/two', (time) => newEvents.push(time))
    handles[0]!.listener('memory/late.md')
    handles[0]!.error?.()
    handles[1]!.listener('memory/current.md')
    await Bun.sleep(20)
    expect(oldEvents).toEqual([])
    expect(newEvents).toEqual([99])
    expect(handles.map((handle) => handle.closes)).toEqual([1, 0])
    watcher.dispose()
  })

  test('客户端与项目组合不碰撞；注销只清理精确 owner 并阻止迟到投递', async () => {
    const { watcher, handles } = harness()
    const events: number[] = []
    watcher.watch('client', 'part:project', '/one', (time) => events.push(time))
    watcher.watch('client:part', 'project', '/two', () => {})
    watcher.watch('client', 'other', '/three', (time) => events.push(time))
    handles[0]!.listener('memory/queued.md')
    watcher.clearOwner('client')
    handles[0]!.listener('memory/late.md')
    handles[2]!.listener('memory/late.md')
    await Bun.sleep(20)
    expect(events).toEqual([])
    expect(handles.map((handle) => handle.closes)).toEqual([1, 0, 1])
    watcher.unwatch('client:part', 'project')
    expect(handles[1]!.closes).toBe(1)
    watcher.dispose()
  })

  test('关闭失败仍取消定时器和清理其余句柄，释放幂等且不允许重建订阅', async () => {
    const { watcher, handles } = harness()
    const events: number[] = []
    watcher.watch('client', 'one', '/one', (time) => events.push(time))
    watcher.watch('client', 'two', '/two', () => {})
    handles[0]!.failClose = true
    handles[0]!.listener('memory/queued.md')
    expect(() => watcher.clearOwner('client')).toThrow(AggregateError)
    handles[0]!.listener('memory/late.md')
    handles[0]!.error?.()
    await Bun.sleep(20)
    expect(events).toEqual([])
    expect(handles.map((handle) => handle.closes)).toEqual([1, 1])
    watcher.watch('other', 'project', '/three', () => {})
    watcher.dispose()
    watcher.dispose()
    expect(handles[2]!.closes).toBe(1)
    expect(() => watcher.watch('client', 'new', '/new', () => {})).toThrow('已释放')
  })

  test('异步消费者或错误关闭失败不产生未捕获异常，也不影响其他客户端', async () => {
    const { watcher, handles } = harness()
    const events: number[] = []
    watcher.watch('one', 'project', '/one', () => { throw new Error('隔离投递失败') })
    watcher.watch('two', 'project', '/two', (time) => events.push(time))
    handles[0]!.listener('memory/one.md')
    handles[1]!.listener('memory/two.md')
    await Bun.sleep(20)
    handles[0]!.failClose = true
    expect(() => handles[0]!.error?.()).not.toThrow()
    handles[1]!.listener('memory/three.md')
    await Bun.sleep(20)
    expect(events).toEqual([99, 99])
    watcher.dispose()
  })
})
