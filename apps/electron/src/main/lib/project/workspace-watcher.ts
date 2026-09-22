/** 工作区文件监听：按 renderer + workspace 隔离资源，并合并短时间内的密集变化。 */

import { watch } from 'node:fs'
import type { FSWatcher } from 'node:fs'

const DEFAULT_DEBOUNCE_MS = 120
const IGNORED_ROOT_NAMES = new Set(['.git', 'node_modules', 'dist', 'build', 'coverage'])

interface WatchHandle {
  close(): void
  on?(event: 'error', listener: () => void): WatchHandle
}

export interface WorkspaceWatcherOptions {
  debounceMs?: number
  now?: () => number
  watchDirectory?: (rootPath: string, listener: (filename: string | null) => void) => WatchHandle
}

interface ActiveWatch {
  handle: WatchHandle
  timer?: ReturnType<typeof setTimeout>
}

function defaultWatchDirectory(rootPath: string, listener: (filename: string | null) => void): FSWatcher {
  return watch(rootPath, { recursive: true }, (_eventType, filename) => {
    listener(filename)
  })
}

function isIgnored(filename: string | null): boolean {
  if (!filename) return false
  const rootName = filename.replaceAll('\\', '/').split('/')[0]
  return Boolean(rootName && IGNORED_ROOT_NAMES.has(rootName))
}

export class WorkspaceWatcher {
  private readonly active = new Map<string, ActiveWatch>()
  private readonly debounceMs: number
  private readonly now: () => number
  private readonly watchDirectory: NonNullable<WorkspaceWatcherOptions['watchDirectory']>

  constructor(options: WorkspaceWatcherOptions = {}) {
    this.debounceMs = options.debounceMs ?? DEFAULT_DEBOUNCE_MS
    this.now = options.now ?? Date.now
    this.watchDirectory = options.watchDirectory ?? defaultWatchDirectory
  }

  /** 同一 renderer 对同一工作区只保留一个监听器；重新订阅会先释放旧资源。 */
  watch(ownerId: number, projectId: string, rootPath: string, emit: (changedAt: number) => void): void {
    const key = this.key(ownerId, projectId)
    this.close(key)
    let active: ActiveWatch | undefined
    const handle = this.watchDirectory(rootPath, (filename) => {
      if (isIgnored(filename) || !active) return
      if (active.timer) clearTimeout(active.timer)
      active.timer = setTimeout(() => {
        if (!active) return
        active.timer = undefined
        emit(this.now())
      }, this.debounceMs)
    })
    active = { handle }
    // 监听器错误后主动释放，避免失效句柄一直占用资源。
    active.handle.on?.('error', () => this.close(key))
    this.active.set(key, active)
  }

  unwatch(ownerId: number, projectId: string): void {
    this.close(this.key(ownerId, projectId))
  }

  /** renderer 销毁或重载时释放它创建的全部监听器。 */
  clearOwner(ownerId: number): void {
    const prefix = `${ownerId}:`
    for (const key of this.active.keys()) {
      if (key.startsWith(prefix)) this.close(key)
    }
  }

  dispose(): void {
    for (const key of [...this.active.keys()]) this.close(key)
  }

  private close(key: string): void {
    const active = this.active.get(key)
    if (!active) return
    if (active.timer) clearTimeout(active.timer)
    active.handle.close()
    this.active.delete(key)
  }

  private key(ownerId: number, projectId: string): string {
    return `${ownerId}:${projectId}`
  }
}
