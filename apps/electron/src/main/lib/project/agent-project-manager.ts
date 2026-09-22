/** Agent 项目持久化：项目持有唯一工作区，会话只需引用项目。 */

import { randomUUID } from 'node:crypto'
import {
  accessSync,
  chmodSync,
  constants,
  existsSync,
  lstatSync,
  mkdirSync,
  realpathSync,
  rmSync,
  statSync,
} from 'node:fs'
import { dirname, isAbsolute, join, relative, resolve } from 'node:path'
import type {
  AgentProject,
  AgentProjectCreateInput,
  AgentProjectUpdateInput,
  AgentProjectWorkspace,
  AgentProjectWorkspaceInput,
  AgentProjectWorkspaceStatus,
} from '@axon/shared'
import { readJsonFileSafe, writeJsonFileAtomic } from '../core/safe-file'

const INDEX_VERSION = 2
const MAX_PROJECT_NAME_LENGTH = 100
const ID_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/
const SLUG_PATTERN = /^[a-z0-9][a-z0-9-]{0,127}$/
const WINDOWS_RESERVED_SLUGS = new Set([
  'con', 'prn', 'aux', 'nul',
  'com1', 'com2', 'com3', 'com4', 'com5', 'com6', 'com7', 'com8', 'com9',
  'lpt1', 'lpt2', 'lpt3', 'lpt4', 'lpt5', 'lpt6', 'lpt7', 'lpt8', 'lpt9',
])

interface AgentProjectsIndex {
  version: number
  projects: AgentProject[]
}

export class AgentProjectManagerError extends Error {
  constructor(
    readonly code: 'invalid_input' | 'duplicate' | 'not_found' | 'workspace_unavailable' | 'storage_error',
    message: string,
  ) {
    super(message)
    this.name = 'AgentProjectManagerError'
  }
}

export interface AgentProjectManagerOptions {
  indexPath: string
  /** 托管项目的受控目录根。 */
  projectsDir: string
  createId?: () => string
  now?: () => number
}

function clone<T>(value: T): T {
  return JSON.parse(JSON.stringify(value)) as T
}

function normalizeId(value: unknown): string {
  if (typeof value !== 'string' || !ID_PATTERN.test(value)) {
    throw new AgentProjectManagerError('invalid_input', '项目 ID 无效')
  }
  return value
}

function normalizeName(value: unknown): string {
  if (typeof value !== 'string' || !value.trim()) {
    throw new AgentProjectManagerError('invalid_input', '项目名称不能为空')
  }
  if (value.trim().length > MAX_PROJECT_NAME_LENGTH) {
    throw new AgentProjectManagerError('invalid_input', '项目名称过长')
  }
  return value.trim()
}

/** 本地工作区状态即时计算，目录在应用运行期间被移动也能反映。 */
export function getAgentProjectWorkspaceStatus(path: string): AgentProjectWorkspaceStatus {
  if (!existsSync(path)) return 'missing'
  try {
    if (!statSync(path).isDirectory()) return 'not_directory'
    accessSync(path, constants.R_OK | constants.W_OK | constants.X_OK)
    return 'available'
  } catch {
    return 'unavailable'
  }
}

function normalizeLocalPath(value: unknown): string {
  if (typeof value !== 'string' || !value.trim()) {
    throw new AgentProjectManagerError('invalid_input', '本地工作区目录不能为空')
  }
  try {
    const path = realpathSync(resolve(value.trim()))
    if (!statSync(path).isDirectory()) {
      throw new AgentProjectManagerError('invalid_input', '本地工作区路径不是目录')
    }
    if (getAgentProjectWorkspaceStatus(path) !== 'available') {
      throw new AgentProjectManagerError('workspace_unavailable', '本地工作区不可读写')
    }
    return path
  } catch (error) {
    if (error instanceof AgentProjectManagerError) throw error
    throw new AgentProjectManagerError('workspace_unavailable', '本地工作区不存在或不可访问')
  }
}

function normalizeWorkspaceInput(value: AgentProjectWorkspaceInput | undefined): AgentProjectWorkspace {
  if (value === undefined) return { kind: 'managed' }
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    throw new AgentProjectManagerError('invalid_input', '项目工作区配置无效')
  }
  if (value.kind === 'managed' && Object.keys(value).length === 1) return { kind: 'managed' }
  if (value.kind === 'local' && Object.keys(value).every((key) => key === 'kind' || key === 'path')) {
    return { kind: 'local', path: normalizeLocalPath(value.path) }
  }
  throw new AgentProjectManagerError('invalid_input', '项目工作区配置无效')
}

function slugify(name: string, fallback: string, existing: ReadonlySet<string>): string {
  let base = name.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '')
  if (!base) base = `project-${fallback.replace(/[^a-z0-9]/gi, '').slice(0, 12).toLowerCase() || 'local'}`
  if (WINDOWS_RESERVED_SLUGS.has(base)) base = `project-${base}`
  let slug = base
  let suffix = 2
  while (existing.has(slug)) {
    slug = `${base}-${suffix}`
    suffix += 1
  }
  return slug
}

function withWorkspaceStatus(project: AgentProject): AgentProject {
  const copy = clone(project)
  if (copy.workspace.kind === 'local') {
    copy.workspace.status = getAgentProjectWorkspaceStatus(copy.workspace.path)
  }
  return copy
}

/**
 * 管理项目索引及其唯一工作区。开发阶段直接启用新格式，不读取旧工作区索引，
 * 避免长期维护双索引和双字段分支。
 */
export class AgentProjectManager {
  private readonly createId: () => string
  private readonly now: () => number

  constructor(private readonly options: AgentProjectManagerOptions) {
    this.createId = options.createId ?? randomUUID
    this.now = options.now ?? Date.now
    mkdirSync(dirname(options.indexPath), { recursive: true })
    mkdirSync(options.projectsDir, { recursive: true })
    if (process.platform !== 'win32') chmodSync(options.projectsDir, 0o700)
  }

  list(): AgentProject[] {
    return this.readIndex().projects.map(withWorkspaceStatus)
  }

  get(id: string): AgentProject | undefined {
    const project = this.readIndex().projects.find((item) => item.id === normalizeId(id))
    return project ? withWorkspaceStatus(project) : undefined
  }

  /** 先验证工作区，再创建受控目录并原子更新项目索引。 */
  create(input: AgentProjectCreateInput): AgentProject {
    if (!input || typeof input !== 'object' || Array.isArray(input)) {
      throw new AgentProjectManagerError('invalid_input', '项目创建参数无效')
    }
    const name = normalizeName(input.name)
    const workspace = normalizeWorkspaceInput(input.workspace)
    const index = this.readIndex()
    if (index.projects.some((item) => item.name.toLocaleLowerCase() === name.toLocaleLowerCase())) {
      throw new AgentProjectManagerError('duplicate', '项目名称已存在')
    }
    const id = normalizeId(this.createId())
    const slug = slugify(name, id, new Set(index.projects.map((item) => item.slug)))
    const timestamp = this.timestamp()
    const project: AgentProject = {
      id,
      name,
      slug,
      workspace,
      memoryEnabled: false,
      createdAt: timestamp,
      updatedAt: timestamp,
    }
    this.ensureManagedWorkspace(project)
    index.projects.push(project)
    this.writeIndex(index)
    console.log(`[Agent 项目] 已创建: ${project.name} (${project.id})`)
    return withWorkspaceStatus(project)
  }

  /** 项目只持有一个 workspace；更新会整体替换目录配置，不形成多值状态。 */
  update(id: string, input: AgentProjectUpdateInput): AgentProject {
    const normalizedId = normalizeId(id)
    if (!input || typeof input !== 'object' || Array.isArray(input) || Object.keys(input).length === 0) {
      throw new AgentProjectManagerError('invalid_input', '项目更新参数无效')
    }
    if (Object.keys(input).some((key) => key !== 'name' && key !== 'workspace' && key !== 'memoryEnabled')) {
      throw new AgentProjectManagerError('invalid_input', '项目更新包含未知字段')
    }
    if (input.memoryEnabled !== undefined && typeof input.memoryEnabled !== 'boolean') {
      throw new AgentProjectManagerError('invalid_input', '项目记忆开关无效')
    }
    const index = this.readIndex()
    const position = index.projects.findIndex((item) => item.id === normalizedId)
    if (position < 0) throw new AgentProjectManagerError('not_found', '项目不存在')
    const existing = index.projects[position]!
    const name = input.name === undefined ? existing.name : normalizeName(input.name)
    if (index.projects.some((item) => item.id !== normalizedId && item.name.toLocaleLowerCase() === name.toLocaleLowerCase())) {
      throw new AgentProjectManagerError('duplicate', '项目名称已存在')
    }
    const workspace = input.workspace === undefined ? existing.workspace : normalizeWorkspaceInput(input.workspace)
    const updated: AgentProject = {
      id: existing.id,
      name,
      slug: existing.slug,
      workspace,
      memoryEnabled: input.memoryEnabled ?? existing.memoryEnabled,
      createdAt: existing.createdAt,
      updatedAt: Math.max(existing.updatedAt, this.timestamp()),
    }
    this.ensureManagedWorkspace(updated)
    index.projects[position] = updated
    this.writeIndex(index)
    console.log(`[Agent 项目] 已更新: ${updated.name} (${updated.id})`)
    return withWorkspaceStatus(updated)
  }

  /** 删除项目只清理其受控托管目录，绝不删除用户选择的本地目录。 */
  delete(id: string): AgentProject {
    const normalizedId = normalizeId(id)
    const index = this.readIndex()
    const position = index.projects.findIndex((item) => item.id === normalizedId)
    if (position < 0) throw new AgentProjectManagerError('not_found', '项目不存在')
    const [removed] = index.projects.splice(position, 1)
    this.writeIndex(index)
    // 即使当前绑定本地目录，也清理曾经切换到托管模式留下的受控目录。
    try { rmSync(this.managedProjectPath(removed!.slug), { recursive: true, force: true }) }
    catch { console.warn(`[Agent 项目] 清理托管目录失败: ${removed!.id}`) }
    console.log(`[Agent 项目] 已删除: ${removed!.name} (${removed!.id})`)
    return withWorkspaceStatus(removed!)
  }

  /** projectId 在主进程解析为可信 cwd；本地目录失效时硬失败。 */
  resolveProjectCwd(id: string): string {
    const project = this.readIndex().projects.find((item) => item.id === normalizeId(id))
    if (!project) throw new AgentProjectManagerError('not_found', '项目不存在')
    if (project.workspace.kind === 'local') {
      if (getAgentProjectWorkspaceStatus(project.workspace.path) !== 'available') {
        throw new AgentProjectManagerError('workspace_unavailable', '项目工作区不可用')
      }
      return project.workspace.path
    }
    this.ensureManagedWorkspace(project)
    return join(this.managedProjectPath(project.slug), 'workspace-files')
  }

  /** 为项目级私有配置解析受控目录；本地项目也绝不把应用配置写进用户工作区。 */
  resolveProjectDataDir(id: string): string {
    const project = this.readIndex().projects.find((item) => item.id === normalizeId(id))
    if (!project) throw new AgentProjectManagerError('not_found', '项目不存在')
    const directory = this.managedProjectPath(project.slug)
    if (existsSync(directory) && lstatSync(directory).isSymbolicLink()) {
      throw new AgentProjectManagerError('storage_error', '项目私有目录不能是符号链接')
    }
    mkdirSync(directory, { recursive: true })
    const root = realpathSync(this.options.projectsDir)
    const canonicalDirectory = realpathSync(directory)
    const relativePath = relative(root, canonicalDirectory)
    if (!relativePath || relativePath.startsWith('..') || isAbsolute(relativePath)) {
      throw new AgentProjectManagerError('storage_error', '项目私有目录越界')
    }
    if (process.platform !== 'win32') chmodSync(directory, 0o700)
    return canonicalDirectory
  }

  private readIndex(): AgentProjectsIndex {
    const hasProjectSnapshot = [this.options.indexPath, `${this.options.indexPath}.tmp`, `${this.options.indexPath}.bak`]
      .some(existsSync)
    const data = readJsonFileSafe<unknown>(this.options.indexPath)
    if (data) return this.normalizeIndex(data)
    if (hasProjectSnapshot) throw new AgentProjectManagerError('storage_error', '项目索引无法恢复')
    return { version: INDEX_VERSION, projects: [] }
  }

  private normalizeIndex(value: unknown): AgentProjectsIndex {
    if (!value || typeof value !== 'object' || Array.isArray(value)) {
      throw new AgentProjectManagerError('storage_error', '项目索引格式无效')
    }
    const candidate = value as { version?: unknown; projects?: unknown }
    if (candidate.version !== INDEX_VERSION || !Array.isArray(candidate.projects)) {
      throw new AgentProjectManagerError('storage_error', '项目索引版本或内容无效')
    }
    let projects: AgentProject[]
    try { projects = candidate.projects.map((item) => this.normalizeStored(item)) }
    catch { throw new AgentProjectManagerError('storage_error', '项目索引项无效') }
    this.assertUnique(projects)
    return { version: INDEX_VERSION, projects }
  }

  private normalizeStored(value: unknown): AgentProject {
    if (!value || typeof value !== 'object' || Array.isArray(value)) {
      throw new AgentProjectManagerError('storage_error', '项目索引项无效')
    }
    const item = value as Record<string, unknown>
    const workspace = item.workspace
    if (!workspace || typeof workspace !== 'object' || Array.isArray(workspace)) {
      throw new AgentProjectManagerError('storage_error', '项目工作区格式无效')
    }
    const rawWorkspace = workspace as Record<string, unknown>
    let normalizedWorkspace: AgentProjectWorkspace
    if (rawWorkspace.kind === 'managed' && Object.keys(rawWorkspace).length === 1) {
      normalizedWorkspace = { kind: 'managed' }
    } else if (
      rawWorkspace.kind === 'local'
      && typeof rawWorkspace.path === 'string'
      && isAbsolute(rawWorkspace.path)
      && Object.keys(rawWorkspace).every((key) => key === 'kind' || key === 'path')
    ) {
      normalizedWorkspace = { kind: 'local', path: rawWorkspace.path }
    } else {
      throw new AgentProjectManagerError('storage_error', '项目工作区格式无效')
    }
    return {
      id: normalizeId(item.id),
      name: normalizeName(item.name),
      slug: this.normalizeSlug(item.slug),
      workspace: normalizedWorkspace,
      memoryEnabled: this.normalizeMemoryEnabled(item.memoryEnabled),
      ...this.normalizeTimestamps(item.createdAt, item.updatedAt),
    }
  }

  private normalizeMemoryEnabled(value: unknown): boolean {
    if (typeof value !== 'boolean') {
      throw new AgentProjectManagerError('storage_error', '项目记忆开关无效')
    }
    return value
  }

  private normalizeSlug(value: unknown): string {
    if (typeof value !== 'string' || !SLUG_PATTERN.test(value)) {
      throw new AgentProjectManagerError('storage_error', '项目 slug 无效')
    }
    return value
  }

  private normalizeTimestamps(createdAt: unknown, updatedAt: unknown): Pick<AgentProject, 'createdAt' | 'updatedAt'> {
    if (
      typeof createdAt !== 'number' || !Number.isFinite(createdAt) || createdAt < 0
      || typeof updatedAt !== 'number' || !Number.isFinite(updatedAt) || updatedAt < createdAt
    ) throw new AgentProjectManagerError('storage_error', '项目时间无效')
    return { createdAt, updatedAt }
  }

  private assertUnique(projects: readonly AgentProject[]): void {
    if (
      new Set(projects.map((item) => item.id)).size !== projects.length
      || new Set(projects.map((item) => item.slug)).size !== projects.length
    ) throw new AgentProjectManagerError('storage_error', '项目索引包含重复标识')
  }

  private writeIndex(index: AgentProjectsIndex): void {
    try { writeJsonFileAtomic(this.options.indexPath, index) }
    catch { throw new AgentProjectManagerError('storage_error', '保存项目索引失败') }
  }

  private managedProjectPath(slug: string): string {
    const root = resolve(this.options.projectsDir)
    const target = resolve(root, slug)
    const relativePath = relative(root, target)
    if (!relativePath || relativePath.startsWith('..') || isAbsolute(relativePath)) {
      throw new AgentProjectManagerError('storage_error', '托管项目路径越界')
    }
    return target
  }

  private ensureManagedWorkspace(project: AgentProject): void {
    if (project.workspace.kind !== 'managed') return
    const directory = this.managedProjectPath(project.slug)
    mkdirSync(join(directory, 'workspace-files'), { recursive: true })
  }

  private timestamp(): number {
    const value = this.now()
    if (!Number.isFinite(value) || value < 0) throw new AgentProjectManagerError('invalid_input', '当前时间无效')
    return value
  }
}
