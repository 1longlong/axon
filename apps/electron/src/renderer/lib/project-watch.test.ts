import { afterEach, describe, expect, test } from 'bun:test'
import { ProjectWatchRegistry } from '@axon/app-server'
import type { AgentMemoryChangedEvent, AgentProjectWatchClosedEvent, AgentProjectWatchSubscription, AgentProjectWatchTarget } from '@axon/shared'
import { observeProjectWatch } from './project-watch'
import type { ProjectWatchOptions } from './project-watch'

const cleanups: Array<() => void> = []
afterEach(() => { for (const cleanup of cleanups.splice(0).reverse()) cleanup() })
async function settle(): Promise<void> { await Promise.resolve(); await Promise.resolve() }
function subscription(id: string, kind: 'workspace' | 'memory' = 'workspace'): AgentProjectWatchSubscription {
  return { projectId: 'project', subscriptionId: id, kind }
}
function open(kind: 'workspace' | 'memory' = 'workspace') {
  const changes = new Set<(event: AgentMemoryChangedEvent) => void>()
  const closed = new Set<(event: AgentProjectWatchClosedEvent) => void>()
  const waits: Array<ReturnType<typeof Promise.withResolvers<AgentProjectWatchSubscription>>> = []
  const releases: AgentProjectWatchTarget[] = [], notes: string[] = []
  const options: ProjectWatchOptions = {
    kind, projectId: 'project',
    watch: async () => { notes.push('watch'); const wait = Promise.withResolvers<AgentProjectWatchSubscription>(); waits.push(wait); return wait.promise },
    unwatch: async (target) => { releases.push(target); return false },
    onChanged: (callback) => { notes.push('listen-change'); changes.add(callback); return () => changes.delete(callback) },
    onClosed: (callback) => { notes.push('listen-close'); closed.add(callback); return () => closed.delete(callback) },
    ready: () => { notes.push('read') }, changed: () => { notes.push('change') }, closed: (event) => { notes.push(event.reason) },
    failed: () => { notes.push('failed') },
  }
  const start = () => { const stop = observeProjectWatch(options); cleanups.push(stop); return stop }
  const emitClosed = (id: string, reason: AgentProjectWatchClosedEvent['reason'], projectId = 'project', eventKind = kind) => {
    for (const callback of closed) callback({ projectId, subscriptionId: id, kind: eventKind, reason })
  }
  const emit = (id: string, projectId = 'project') => { for (const callback of changes) callback({ projectId, subscriptionId: id, changedAt: 1 }) }
  return { options, waits, changes, closed, releases, notes, start, emitClosed, emit }
}

describe('面板项目监听代次', () => {
  test('先装事件再登记/读取；早到变化由初始快照补齐，随后只消费自己的代次', async () => {
    const f = open(), stop = f.start()
    expect(f.notes).toEqual(['listen-change', 'listen-close', 'watch'])
    f.emit('active')
    expect(f.notes).not.toContain('change')
    f.waits[0]!.resolve(subscription('active')); await settle()
    expect(f.notes.at(-1)).toBe('read')
    f.emit('older'); f.emit('active', 'other'); f.emit('active')
    expect(f.notes.filter((note) => note === 'change')).toHaveLength(1)
    stop(); stop()
    expect(f.releases).toEqual([{ projectId: 'project', subscriptionId: 'active' }])
    expect(f.changes.size).toBe(0); expect(f.closed.size).toBe(0)
  })

  test('关闭早于登记响应：仅匹配实际返回的代次，目录变化重新订阅后才读取', async () => {
    const f = open(); f.start()
    f.emitClosed('older', 'project_deleted')
    f.emitClosed('first', 'project_changed')
    f.waits[0]!.resolve(subscription('first')); await settle()
    expect(f.notes.filter((note) => note === 'read')).toEqual([])
    expect(f.waits).toHaveLength(2)
    f.emitClosed('first', 'project_changed'); f.emit('first')
    f.waits[1]!.resolve(subscription('second')); await settle()
    expect(f.notes.filter((note) => note === 'read')).toHaveLength(1)
    f.emit('second')
    expect(f.notes.at(-1)).toBe('change')
  })

  test('关闭记忆/删除项目在响应前后都不重订阅；终止后旧变化无效', async () => {
    for (const reason of ['memory_disabled', 'project_deleted'] as const) {
      for (const before of [true, false]) {
        const f = open('memory'); f.start()
        if (before) f.emitClosed('memory', reason)
        f.waits[0]!.resolve(subscription('memory', 'memory')); await settle()
        if (!before) f.emitClosed('memory', reason)
        f.emit('memory'); f.emitClosed('memory', 'project_changed'); await settle()
        expect(f.waits).toHaveLength(1)
        expect(f.notes.filter((note) => note === reason)).toHaveLength(1)
        expect(f.notes.filter((note) => note === 'read')).toHaveLength(before ? 0 : 1)
        expect(f.notes).not.toContain('change')
      }
    }
  })

  test('已生效监听的换目录只重建一次；旧项目/种类/代次事件以及释放后回调无效', async () => {
    const f = open(), stop = f.start()
    const change = [...f.changes][0]!, close = [...f.closed][0]!
    f.waits[0]!.resolve(subscription('first')); await settle()
    f.emitClosed('first', 'project_changed', 'other')
    f.emitClosed('first', 'project_changed', 'project', 'memory')
    f.emitClosed('old', 'project_changed')
    expect(f.waits).toHaveLength(1)
    f.emitClosed('first', 'project_changed'); f.emitClosed('first', 'project_changed')
    expect(f.waits).toHaveLength(2)
    f.waits[1]!.resolve(subscription('next')); await settle()
    stop()
    change({ projectId: 'project', subscriptionId: 'next', changedAt: 1 })
    close({ ...subscription('next'), reason: 'project_changed' })
    expect(f.notes).not.toContain('change')
    expect(f.waits).toHaveLength(2)
    expect(f.releases).toEqual([{ projectId: 'project', subscriptionId: 'next' }])
  })

  test('登记响应晚于卸载：精确释放旧代次，不取消新面板的原生资源', async () => {
    const registry = new ProjectWatchRegistry(), old = open(), next = open()
    const oldResponse = Promise.withResolvers<AgentProjectWatchSubscription>()
    const handles: Array<{ closed: boolean }> = []
    const targets: AgentProjectWatchTarget[] = []
    const register = () => {
      const handle = { closed: false }; handles.push(handle)
      return registry.watch('owner', 'workspace', 'project', { start: () => {}, release: () => { handle.closed = true }, changed: () => {}, closed: () => {} })
    }
    const first = register()
    old.options.watch = async () => oldResponse.promise
    for (const f of [old, next]) f.options.unwatch = async (target) => { targets.push(target); return registry.unwatch('owner', 'workspace', target) }
    const stopOld = old.start(); stopOld()
    next.options.watch = async () => register()
    const stopNext = next.start(); await settle()
    oldResponse.resolve(first); await settle()
    expect(handles.map((handle) => handle.closed)).toEqual([true, false])
    expect(targets).toEqual([{ projectId: 'project', subscriptionId: first.subscriptionId }])
    expect(old.notes).not.toContain('read')
    stopNext(); await settle()
    expect(handles.every((handle) => handle.closed)).toBe(true)
    registry.close()
  })

  test('登记失败/重建失败只报告当前面板一次，不重发未知交付或项目级取消', async () => {
    for (const rewatch of [false, true]) {
      const f = open(), stop = f.start()
      if (rewatch) {
        f.waits[0]!.resolve(subscription('first')); await settle(); f.emitClosed('first', 'project_changed')
      }
      f.waits.at(-1)!.reject(new Error('夹具失败')); await settle()
      expect(f.notes.filter((note) => note === 'failed')).toHaveLength(1)
      expect(f.waits).toHaveLength(rewatch ? 2 : 1)
      stop(); expect(f.releases).toEqual([])
    }
    const f = open(), stop = f.start(); stop()
    f.waits[0]!.reject(new Error('迟到失败')); await settle()
    expect(f.notes).not.toContain('failed')
  })

  test('订阅第二个事件失败清理第一个监听，不登记或留下局部资源', () => {
    const f = open()
    f.options.onClosed = () => { throw new Error('夹具注册失败') }
    expect(() => f.start()).toThrow('注册失败')
    expect(f.changes.size).toBe(0); expect(f.waits).toHaveLength(0)
  })
})
