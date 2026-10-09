import { describe, expect, test } from 'bun:test'
import { ProjectWatchRegistry, parseProjectWatchTarget } from './project-watch-registry'
import type { AgentMemoryChangedEvent, AgentProjectWatchClosedEvent } from '@axon/shared'

function open() {
  const registry = new ProjectWatchRegistry()
  const changes: AgentMemoryChangedEvent[] = [], closed: AgentProjectWatchClosedEvent[] = []
  const callbacks = new Map<string, (time: number) => void>(), releases: string[] = []
  const watch = (owner: string, kind: 'workspace' | 'memory', name: string, fail = false) => registry.watch(owner, kind, 'project', {
    start: (emit) => { callbacks.set(name, emit); if (fail) throw new Error('启动失败') },
    release: () => { releases.push(name) }, changed: (event) => { changes.push(event) }, closed: (event) => { closed.push(event) },
  })
  return { registry, changes, closed, callbacks, releases, watch }
}

describe('共用项目监听登记表', () => {
  test('替换/跨入口/跨种类取消不能释放当前句柄，旧回调不复活', () => {
    const f = open(), first = f.watch('main', 'workspace', 'first'), next = f.watch('main', 'workspace', 'next')
    const memory = f.watch('main', 'memory', 'memory'), quick = f.watch('quick', 'workspace', 'quick')
    expect(f.releases).toEqual(['first'])
    expect(f.registry.unwatch('main', 'workspace', first)).toBe(false)
    expect(f.registry.unwatch('quick', 'workspace', next)).toBe(false)
    expect(f.registry.unwatch('main', 'memory', next)).toBe(false)
    f.callbacks.get('first')!(1); f.callbacks.get('next')!(2)
    expect(f.changes.map((event) => event.subscriptionId)).toEqual([next.subscriptionId])
    expect(f.registry.unwatch('main', 'memory', memory)).toBe(true)
    f.registry.detach('main'); f.callbacks.get('next')!(3); f.callbacks.get('quick')!(4)
    expect(f.changes.at(-1)?.subscriptionId).toBe(quick.subscriptionId)
    f.registry.close(); f.registry.close()
    expect(f.releases).toEqual(['first', 'memory', 'next', 'quick'])
    expect(() => f.watch('quick', 'workspace', 'late')).toThrow('已关闭')
  })

  test('启动失败也释放部分句柄，清理错误/关闭通知错误不跳过其他监听', () => {
    const f = open()
    expect(() => f.watch('main', 'workspace', 'failed', true)).toThrow('启动失败')
    f.callbacks.get('failed')!(1)
    expect(f.changes).toEqual([]); expect(f.releases).toEqual(['failed'])
    f.registry.watch('main', 'workspace', 'project', { start: () => {}, release: () => { throw new Error('关闭失败') },
      changed: () => {}, closed: () => { throw new Error('通知失败') } })
    f.watch('quick', 'memory', 'memory')
    f.registry.invalidate('project', 'project_deleted')
    expect(f.closed).toHaveLength(1)
    expect(f.releases).toEqual(['failed', 'memory'])
    f.registry.close()
  })

  test('取消只接受两项标识，不保留项目字符串或完整登记 DTO 兼容', () => {
    expect(parseProjectWatchTarget({ projectId: ' p ', subscriptionId: ' s ' })).toEqual({ projectId: 'p', subscriptionId: 's' })
    for (const value of ['p', { projectId: 'p' }, { projectId: 'p', subscriptionId: ' ' },
      { projectId: 'p', subscriptionId: 's', kind: 'memory' }, { projectId: 'p', subscriptionId: 's', owner: 'main' }]) {
      expect(() => parseProjectWatchTarget(value)).toThrow()
    }
  })
})
