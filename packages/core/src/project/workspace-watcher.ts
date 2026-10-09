/** 工作区文件监听：按调用方 owner + project 隔离资源，并合并密集变化。 */

import { watch } from 'node:fs'
import type { FSWatcher } from 'node:fs'
import type { BackendClientId } from '@axon/shared'

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
  ownerId: BackendClientId
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
  private disposed = false

  constructor(options: WorkspaceWatcherOptions = {}) {
    this.debounceMs = options.debounceMs ?? DEFAULT_DEBOUNCE_MS
    this.now = options.now ?? Date.now
    this.watchDirectory = options.watchDirectory ?? defaultWatchDirectory
  }

  /** 同一 owner 对同一工作区只保留一个监听器；重新订阅先释放旧资源。 */
  watch(ownerId: BackendClientId, projectId: string, rootPath: string, emit: (changedAt: number) => void): void {
    if (this.disposed) throw new Error('工作区监听器已释放')
    const key = this.key(ownerId, projectId)
    this.close(key)
    let active: ActiveWatch | undefined
    const handle = this.watchDirectory(rootPath, (filename) => {
      if (isIgnored(filename) || !active || this.active.get(key) !== active) return
      if (active.timer) clearTimeout(active.timer)
      active.timer = setTimeout(() => {
        if (!active || this.active.get(key) !== active) return
        active.timer = undefined
        try { emit(this.now()) } catch { console.warn('[工作区监听] 变化投递失败') }
      }, this.debounceMs)
    })
    active = { ownerId, handle }
    // 监听器错误后主动释放，避免失效句柄一直占用资源。
    this.active.set(key, active)
    active.handle.on?.('error', () => {
      if (this.active.get(key) !== active) return
      try { this.close(key) } catch { console.warn('[工作区监听] 失效句柄关闭失败') }
    })
  }

  unwatch(ownerId: BackendClientId, projectId: string): void {
    this.close(this.key(ownerId, projectId))
  }

  /** 入口注销 owner 时释放它创建的全部监听器。 */
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
    if (errors.length) throw new AggregateError(errors, '工作区监听清理失败')
  }

  private key(ownerId: BackendClientId, projectId: string): string {
    return JSON.stringify([ownerId, projectId])
  }
}
