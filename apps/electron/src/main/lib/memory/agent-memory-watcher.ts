/** 项目记忆监听：只转发 workspace/memory/ 下的变化，并合并密集事件。 */

import { watch } from 'node:fs'
import type { FSWatcher } from 'node:fs'

const DEFAULT_DEBOUNCE_MS = 120

interface WatchHandle {
  close(): void
  on?(event: 'error', listener: () => void): WatchHandle
}

export interface AgentMemoryWatcherOptions {
  debounceMs?: number
  now?: () => number
  watchDirectory?: (rootPath: string, listener: (filename: string | null) => void) => WatchHandle
}

interface ActiveWatch {
  handle: WatchHandle
  paths: Set<string>
  timer?: ReturnType<typeof setTimeout>
}

function defaultWatchDirectory(rootPath: string, listener: (filename: string | null) => void): FSWatcher {
  return watch(rootPath, { recursive: true }, (_eventType, filename) => listener(filename))
}

function toMemoryPath(filename: string | null): string | null {
  if (!filename) return null
  const normalized = filename.replaceAll('\\', '/').replace(/^\.\//, '')
  if (normalized === 'memory') return ''
  if (!normalized.startsWith('memory/')) return null
  const relativePath = normalized.slice('memory/'.length)
  if (!relativePath || relativePath.split('/').some((part) => !part || part === '.' || part === '..')) return ''
  return relativePath
}

export class AgentMemoryWatcher {
  private readonly active = new Map<string, ActiveWatch>()
  private readonly debounceMs: number
  private readonly now: () => number
  private readonly watchDirectory: NonNullable<AgentMemoryWatcherOptions['watchDirectory']>

  constructor(options: AgentMemoryWatcherOptions = {}) {
    this.debounceMs = options.debounceMs ?? DEFAULT_DEBOUNCE_MS
    this.now = options.now ?? Date.now
    this.watchDirectory = options.watchDirectory ?? defaultWatchDirectory
  }

  /** 监听工作区根目录，确保 memory/ 尚不存在时也能捕获首次创建。 */
  watch(
    ownerId: number,
    projectId: string,
    workspaceRoot: string,
    emit: (changedAt: number, relativePath?: string) => void,
  ): void {
    const key = this.key(ownerId, projectId)
    this.close(key)
    let active: ActiveWatch | undefined
    const handle = this.watchDirectory(workspaceRoot, (filename) => {
      const relativePath = toMemoryPath(filename)
      if (relativePath === null || !active) return
      active.paths.add(relativePath)
      if (active.timer) clearTimeout(active.timer)
      active.timer = setTimeout(() => {
        if (!active) return
        const paths = [...active.paths]
        active.paths.clear()
        active.timer = undefined
        // 一次只变化一个 Markdown 文件时附带路径；批量或目录变化只通知整体刷新。
        const path = paths.length === 1 && paths[0]?.toLowerCase().endsWith('.md') ? paths[0] : undefined
        emit(this.now(), path)
      }, this.debounceMs)
    })
    active = { handle, paths: new Set() }
    active.handle.on?.('error', () => this.close(key))
    this.active.set(key, active)
  }

  unwatch(ownerId: number, projectId: string): void {
    this.close(this.key(ownerId, projectId))
  }

  /** renderer 销毁或重载时释放它创建的全部记忆监听器。 */
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
