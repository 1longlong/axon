import { describe, expect, test } from 'bun:test'
import { WorkspaceWatcher } from './workspace-watcher'

interface FakeWatch {
  rootPath: string
  listener(filename: string | null): void
  closed: boolean
}

function harness(now = 99): { watcher: WorkspaceWatcher; watches: FakeWatch[] } {
  const watches: FakeWatch[] = []
  const watcher = new WorkspaceWatcher({
    debounceMs: 5,
    now: () => now,
    watchDirectory: (rootPath, listener) => {
      const active: FakeWatch = { rootPath, listener, closed: false }
      watches.push(active)
      return { close: () => { active.closed = true } }
    },
  })
  return { watcher, watches }
}

describe('WorkspaceWatcher', () => {
  test('合并密集变化并忽略大型目录事件', async () => {
    const { watcher, watches } = harness()
    const changes: number[] = []
    watcher.watch(1, 'workspace-1', '/project', (changedAt) => changes.push(changedAt))

    watches[0]!.listener('.git/index')
    watches[0]!.listener('src/one.ts')
    watches[0]!.listener('src/two.ts')
    await Bun.sleep(12)

    expect(changes).toEqual([99])
    watcher.dispose()
    expect(watches[0]!.closed).toBe(true)
  })

  test('重复订阅会替换旧句柄，清理只影响对应 renderer', () => {
    const { watcher, watches } = harness()
    watcher.watch(1, 'workspace-1', '/one', () => {})
    watcher.watch(1, 'workspace-1', '/two', () => {})
    watcher.watch(2, 'workspace-1', '/three', () => {})

    expect(watches[0]!.closed).toBe(true)
    expect(watches[1]!.closed).toBe(false)
    expect(watches[2]!.closed).toBe(false)
    watcher.clearOwner(1)
    expect(watches[1]!.closed).toBe(true)
    expect(watches[2]!.closed).toBe(false)
    watcher.unwatch(2, 'workspace-1')
    expect(watches[2]!.closed).toBe(true)
  })
})
