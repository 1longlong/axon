/** Agent 项目 IPC：校验项目 CRUD，并通过项目解析唯一工作区的文件能力。 */

import type {
  AgentProjectCreateInput,
  AgentProjectUpdateInput,
  AgentSessionMeta,
  AgentWorkspaceDirectoryListing,
  AgentWorkspaceFilePreview,
  AgentWorkspaceFileDiff,
} from '@axon/shared'
import type { AgentProjectManager } from './agent-project-manager'
import { AgentProjectManagerError } from './agent-project-manager'
import { listWorkspaceDirectory } from './workspace-directory-listing'
import type { WorkspaceWatcher } from './workspace-watcher'
import { readWorkspaceFilePreview } from './workspace-file-preview'
import { readWorkspaceFileDiff } from './workspace-file-diff'

export interface AgentProjectIpcControllerOptions {
  projects: Pick<AgentProjectManager, 'list' | 'get' | 'create' | 'update' | 'delete' | 'resolveProjectCwd'>
  sessions: { list(): AgentSessionMeta[] }
  watcher?: Pick<WorkspaceWatcher, 'watch' | 'unwatch' | 'clearOwner'>
}

function invalid(): never {
  throw new AgentProjectManagerError('invalid_input', '项目 IPC 请求格式无效')
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

export class AgentProjectIpcController {
  constructor(private readonly options: AgentProjectIpcControllerOptions) {}

  list() { return this.options.projects.list() }
  get(value: unknown) { return this.options.projects.get(parseId(value)) ?? null }
  create(value: unknown) { return this.options.projects.create(parseCreateInput(value)) }
  update(id: unknown, value: unknown) { return this.options.projects.update(parseId(id), parseUpdateInput(value)) }

  /** projectId 先解析为可信目录，再返回不含绝对路径的有界文件树。 */
  async listDirectory(value: unknown): Promise<AgentWorkspaceDirectoryListing> {
    const projectId = parseId(value)
    const listing = await listWorkspaceDirectory(this.options.projects.resolveProjectCwd(projectId))
    return { projectId, ...listing }
  }

  async readFile(projectIdValue: unknown, relativePath: unknown): Promise<AgentWorkspaceFilePreview> {
    const projectId = parseId(projectIdValue)
    const preview = await readWorkspaceFilePreview(this.options.projects.resolveProjectCwd(projectId), relativePath)
    return { projectId, ...preview }
  }

  /** projectId 先解析可信 cwd，再返回有界、只读的 Git Diff。 */
  async readDiff(projectIdValue: unknown, relativePath: unknown): Promise<AgentWorkspaceFileDiff> {
    const projectId = parseId(projectIdValue)
    return readWorkspaceFileDiff(projectId, this.options.projects.resolveProjectCwd(projectId), relativePath)
  }

  /** 监听键使用 projectId；项目切换工作区后 renderer 会重订阅并重新解析根目录。 */
  watchDirectory(ownerId: number, value: unknown, emit: (changedAt: number) => void): void {
    if (!this.options.watcher) throw new AgentProjectManagerError('storage_error', '工作区监听器不可用')
    const projectId = parseId(value)
    this.options.watcher.watch(ownerId, projectId, this.options.projects.resolveProjectCwd(projectId), emit)
  }

  unwatchDirectory(ownerId: number, value: unknown): void {
    this.options.watcher?.unwatch(ownerId, parseId(value))
  }

  clearDirectoryWatches(ownerId: number): void {
    this.options.watcher?.clearOwner(ownerId)
  }

  /** 有会话归属时禁止删除项目，避免留下无法运行的 projectId。 */
  delete(value: unknown) {
    const id = parseId(value)
    if (this.options.sessions.list().some((session) => session.projectId === id)) {
      throw new AgentProjectManagerError('invalid_input', '仍有 Agent 会话属于该项目')
    }
    return this.options.projects.delete(id)
  }
}
