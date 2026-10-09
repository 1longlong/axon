/** 项目记忆监听：只转发 workspace/memory/ 下的变化，并合并密集事件。 */

import { watch } from 'node:fs'
import type { FSWatcher } from 'node:fs'
import type { BackendClientId } from '@axon/shared'

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
  ownerId: BackendClientId
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
  private disposed = false

  constructor(options: AgentMemoryWatcherOptions = {}) {
    this.debounceMs = options.debounceMs ?? DEFAULT_DEBOUNCE_MS
    this.now = options.now ?? Date.now
    this.watchDirectory = options.watchDirectory ?? defaultWatchDirectory
  }

  /** 监听工作区根目录，确保 memory/ 尚不存在时也能捕获首次创建。 */
  watch(
    ownerId: BackendClientId,
    projectId: string,
    workspaceRoot: string,
    emit: (changedAt: number, relativePath?: string) => void,
  ): void {
    if (this.disposed) throw new Error('记忆监听器已释放')
    const key = this.key(ownerId, projectId)
    this.close(key)
    let active: ActiveWatch | undefined
    const handle = this.watchDirectory(workspaceRoot, (filename) => {
      const relativePath = toMemoryPath(filename)
      if (relativePath === null || !active || this.active.get(key) !== active) return
      active.paths.add(relativePath)
      if (active.timer) clearTimeout(active.timer)
      active.timer = setTimeout(() => {
        if (!active || this.active.get(key) !== active) return
        const paths = [...active.paths]
        active.paths.clear()
        active.timer = undefined
        // 一次只变化一个 Markdown 文件时附带路径；批量或目录变化只通知整体刷新。
        const path = paths.length === 1 && paths[0]?.toLowerCase().endsWith('.md') ? paths[0] : undefined
        try { emit(this.now(), path) } catch { console.warn('[记忆监听] 变化投递失败') }
      }, this.debounceMs)
    })
    active = { ownerId, handle, paths: new Set() }
    this.active.set(key, active)
    active.handle.on?.('error', () => {
      if (this.active.get(key) !== active) return
      try { this.close(key) } catch { console.warn('[记忆监听] 失效句柄关闭失败') }
    })
  }

  unwatch(ownerId: BackendClientId, projectId: string): void {
    this.close(this.key(ownerId, projectId))
  }

  /** 入口注销 owner 时释放它创建的全部记忆监听器。 */
  clearOwner(ownerId: BackendClientId): void {
    this.closeAll([...this.active].filter(([, active]) => active.ownerId === ownerId).map(([key]) => key))
  }

  dispose(): void {
    if (this.disposed) return
    this.disposed = true
    this.closeAll([...this.active.keys()])
  }

  private close(key: string): void {
    const active = this.active.get(key)
    if (!active) return
    // 先失效、取消定时器，再关闭句柄；关闭失败或迟到回调不能复活旧订阅。
    this.active.delete(key)
    if (active.timer) clearTimeout(active.timer)
    active.handle.close()
  }

  /** 关闭失败不跳过同一客户端的其他项目或退出时的其他句柄。 */
  private closeAll(keys: string[]): void {
    const errors: unknown[] = []
    for (const key of keys) {
      try { this.close(key) } catch (error) { errors.push(error) }
    }
    if (errors.length) throw new AggregateError(errors, '记忆监听清理失败')
  }

  private key(ownerId: BackendClientId, projectId: string): string {
    return JSON.stringify([ownerId, projectId])
  }
}
