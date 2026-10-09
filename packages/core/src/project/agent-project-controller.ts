/** 项目协调：校验 CRUD 与文件请求，并按可信客户端管理工作区订阅。 */

import type {
  AgentProjectCreateInput,
  AgentProjectUpdateInput,
  AgentSessionMeta,
  AgentWorkspaceDirectoryListing,
  AgentWorkspaceFilePreview,
  AgentWorkspaceFileDiff,
  BackendClientId,
} from '@axon/shared'
import type { BackendClientRegistry } from '../backend-client-registry'
import type { AgentProjectManager } from './agent-project-manager'
import { AgentProjectManagerError } from './agent-project-manager'
import { listWorkspaceDirectory } from './workspace-directory-listing'
import type { WorkspaceWatcher } from './workspace-watcher'
import { readWorkspaceFilePreview } from './workspace-file-preview'
import { readWorkspaceFileDiff } from './workspace-file-diff'
import { AsyncWorkTracker } from '../async/async-work-tracker'
import { waitWithSignal } from '../async/wait-with-signal'

export interface AgentProjectControllerOptions {
  clients: Pick<BackendClientRegistry, 'has' | 'subscribeDetached'>
  projects: Pick<AgentProjectManager, 'list' | 'get' | 'create' | 'update' | 'delete' | 'resolveProjectCwd'>
  sessions: { list(): AgentSessionMeta[] }
  watcher?: Pick<WorkspaceWatcher, 'watch' | 'unwatch' | 'clearOwner'>
}

function invalid(): never {
  throw new AgentProjectManagerError('invalid_input', '项目请求格式无效')
}

function parseId(value: unknown): string {
  if (typeof value !== 'string' || !value.trim()) return invalid()
  return value.trim()
}

function parseWorkspace(value: unknown): AgentProjectCreateInput['workspace'] {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return invalid()
  const workspace = value as Record<string, unknown>
  if (workspace.kind === 'managed' && Object.keys(workspace).length === 1) return { kind: 'managed' }
  if (
    workspace.kind === 'local'
    && typeof workspace.path === 'string'
    && Object.keys(workspace).every((key) => key === 'kind' || key === 'path')
  ) return { kind: 'local', path: workspace.path }
  return invalid()
}

function parseCreateInput(value: unknown): AgentProjectCreateInput {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return invalid()
  const input = value as Record<string, unknown>
  if (Object.keys(input).some((key) => key !== 'name' && key !== 'workspace')) return invalid()
  if (typeof input.name !== 'string') return invalid()
  return { name: input.name, ...(input.workspace === undefined ? {} : { workspace: parseWorkspace(input.workspace) }) }
}

function parseUpdateInput(value: unknown): AgentProjectUpdateInput {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return invalid()
  const input = value as Record<string, unknown>
  if (
    Object.keys(input).length === 0
    || Object.keys(input).some((key) => key !== 'name' && key !== 'workspace' && key !== 'memoryEnabled')
  ) return invalid()
  if (input.name !== undefined && typeof input.name !== 'string') return invalid()
  if (input.memoryEnabled !== undefined && typeof input.memoryEnabled !== 'boolean') return invalid()
  return {
    ...(typeof input.name === 'string' ? { name: input.name } : {}),
    ...(input.workspace === undefined ? {} : { workspace: parseWorkspace(input.workspace) }),
    ...(typeof input.memoryEnabled === 'boolean' ? { memoryEnabled: input.memoryEnabled } : {}),
  }
}

export class AgentProjectController {
  private readonly owners = new Set<BackendClientId>()
  private readonly unsubscribeClients: () => void
  private readonly lifetime = new AbortController()
  private readonly work = new AsyncWorkTracker()
  private disposed = false

  /** 客户端注销时只释放其工作区订阅，入口无需额外登记窗口生命周期监听。 */
  constructor(private readonly options: AgentProjectControllerOptions) {
    this.unsubscribeClients = options.clients.subscribeDetached((id) => this.clearDirectoryWatches(id))
  }

  list() { this.ensureOpen(); return this.options.projects.list() }
  get(value: unknown) { this.ensureOpen(); return this.options.projects.get(parseId(value)) ?? null }
  create(value: unknown) { this.ensureOpen(); return this.options.projects.create(parseCreateInput(value)) }
  update(id: unknown, value: unknown) { this.ensureOpen(); return this.options.projects.update(parseId(id), parseUpdateInput(value)) }

  /** projectId 先解析为可信目录，再返回不含绝对路径的有界文件树。 */
  listDirectory(value: unknown, signal?: AbortSignal): Promise<AgentWorkspaceDirectoryListing> {
    return this.read(signal, async (stop) => {
      const projectId = parseId(value)
      const listing = await listWorkspaceDirectory(this.options.projects.resolveProjectCwd(projectId), { signal: stop })
      return { projectId, ...listing }
    })
  }

  /** 小文件预览继承入口/后端取消；取消等待后底层读取仍登记到实际结束。 */
  readFile(projectIdValue: unknown, relativePath: unknown, signal?: AbortSignal): Promise<AgentWorkspaceFilePreview> {
    return this.read(signal, async (stop) => {
      const projectId = parseId(projectIdValue)
      const preview = await readWorkspaceFilePreview(this.options.projects.resolveProjectCwd(projectId), relativePath, undefined, stop)
      return { projectId, ...preview }
    })
  }

  /** projectId 先解析可信 cwd，再返回有界、只读的 Git Diff。 */
  readDiff(projectIdValue: unknown, relativePath: unknown, signal?: AbortSignal): Promise<AgentWorkspaceFileDiff> {
    return this.read(signal, (stop) => {
      const projectId = parseId(projectIdValue)
      return readWorkspaceFileDiff(projectId, this.options.projects.resolveProjectCwd(projectId), relativePath, stop)
    })
  }

  /** 响应可立即取消，但真实文件/Git 工作另行登记；drain 不遗漏迟到清理。 */
  private read<T>(signal: AbortSignal | undefined, start: (stop: AbortSignal) => Promise<T>): Promise<T> {
    return this.work.run(async () => {
      const stop = signal ? AbortSignal.any([signal, this.lifetime.signal]) : this.lifetime.signal
      if (stop.aborted) throw new DOMException('工作区读取已取消', 'AbortError')
      const result = await waitWithSignal(this.work.run(() => start(stop)), stop)
      if (stop.aborted) throw new DOMException('工作区读取已取消', 'AbortError')
      return result
    })
  }

  private ensureOpen(): void {
    if (this.disposed) throw new AgentProjectManagerError('invalid_input', '项目服务已释放')
  }

  /** 监听键使用 projectId；项目切换工作区后 renderer 会重订阅并重新解析根目录。 */
  watchDirectory(ownerId: BackendClientId, value: unknown, emit: (changedAt: number) => void): void {
    if (this.disposed || !this.options.clients.has(ownerId)) {
      throw new AgentProjectManagerError('invalid_input', '订阅客户端未登记或已断开')
    }
    if (!this.options.watcher) throw new AgentProjectManagerError('storage_error', '工作区监听器不可用')
    const projectId = parseId(value)
    this.options.watcher.watch(ownerId, projectId, this.options.projects.resolveProjectCwd(projectId), (changedAt) => {
      if (!this.disposed && this.options.clients.has(ownerId)) emit(changedAt)
    })
    this.owners.add(ownerId)
  }

  unwatchDirectory(ownerId: BackendClientId, value: unknown): void {
    this.options.watcher?.unwatch(ownerId, parseId(value))
  }

  clearDirectoryWatches(ownerId: BackendClientId): void {
    this.owners.delete(ownerId)
    this.options.watcher?.clearOwner(ownerId)
  }

  /** 退出时先拒绝新订阅和投递，再逐项释放句柄；不误清其他协调器的资源。 */
  dispose(): void {
    if (this.disposed) return
    this.disposed = true
    this.lifetime.abort(new DOMException('工作区读取已取消', 'AbortError'))
    const errors: unknown[] = []
    try { this.unsubscribeClients() } catch (error) { errors.push(error) }
    for (const owner of [...this.owners]) {
      try { this.clearDirectoryWatches(owner) } catch (error) { errors.push(error) }
    }
    if (errors.length) throw new AggregateError(errors, '项目订阅清理失败')
  }

  /** 取消并非读取或进程已结束；等待真实目录/文件操作和 Git close。 */
  drain(): Promise<void> { return this.work.drain() }

  /** 有会话归属时禁止删除项目，避免留下无法运行的 projectId。 */
  delete(value: unknown) {
    this.ensureOpen()
    const id = parseId(value)
    if (this.options.sessions.list().some((session) => session.projectId === id)) {
      throw new AgentProjectManagerError('invalid_input', '仍有 Agent 会话属于该项目')
    }
    return this.options.projects.delete(id)
  }
}
