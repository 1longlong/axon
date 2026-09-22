import { describe, expect, test } from 'bun:test'
import { AgentMemoryWatcher } from './agent-memory-watcher'

interface FakeWatch {
  rootPath: string
  listener(filename: string | null): void
  error?(): void
  closed: boolean
}

function harness(): { watcher: AgentMemoryWatcher; watches: FakeWatch[] } {
  const watches: FakeWatch[] = []
  const watcher = new AgentMemoryWatcher({
    debounceMs: 5,
    now: () => 99,
    watchDirectory: (rootPath, listener) => {
      const active: FakeWatch = { rootPath, listener, closed: false }
      watches.push(active)
      const handle = {
        close: () => { active.closed = true },
        on: (_event: 'error', onError: () => void) => { active.error = onError; return handle },
      }
      return handle
    },
  })
  return { watcher, watches }
}

describe('AgentMemoryWatcher', () => {
  test('忽略普通项目文件，合并 memory 密集变化并保留单文件路径', async () => {
    const { watcher, watches } = harness()
    const changes: Array<{ changedAt: number; path?: string }> = []
    watcher.watch(1, 'project-1', '/workspace', (changedAt, path) => changes.push({ changedAt, path }))
    expect(watches[0]!.rootPath).toBe('/workspace')

    watches[0]!.listener('src/app.ts')
    await Bun.sleep(8)
    expect(changes).toEqual([])
    watches[0]!.listener('memory/preferences.md')
    await Bun.sleep(8)
    expect(changes).toEqual([{ changedAt: 99, path: 'preferences.md' }])

    watches[0]!.listener('memory/one.md')
    watches[0]!.listener('memory/two.md')
    await Bun.sleep(8)
    expect(changes.at(-1)).toEqual({ changedAt: 99, path: undefined })
  })

  test('目录首次创建、Windows 分隔符和异常路径只触发安全的整体刷新', async () => {
    const { watcher, watches } = harness()
    const paths: Array<string | undefined> = []
    watcher.watch(1, 'project-1', '/workspace', (_changedAt, path) => paths.push(path))
    watches[0]!.listener('memory')
    await Bun.sleep(8)
    watches[0]!.listener('memory\\nested\\topic.md')
    await Bun.sleep(8)
    watches[0]!.listener('memory/../escape.md')
    await Bun.sleep(8)
    expect(paths).toEqual([undefined, 'nested/topic.md', undefined])
  })

  test('重复订阅、owner 清理和监听错误都会释放正确句柄', () => {
    const { watcher, watches } = harness()
    watcher.watch(1, 'project-1', '/one', () => {})
    watcher.watch(1, 'project-1', '/two', () => {})
    watcher.watch(2, 'project-1', '/three', () => {})
    expect(watches[0]!.closed).toBe(true)
    watcher.clearOwner(1)
    expect(watches[1]!.closed).toBe(true)
    expect(watches[2]!.closed).toBe(false)
    watches[2]!.error?.()
    expect(watches[2]!.closed).toBe(true)
  })
})
