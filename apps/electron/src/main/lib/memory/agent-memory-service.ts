/** Agent 项目记忆文件服务：把所有访问限制在已启用项目的 workspace/memory 内。 */

import {
  chmodSync,
  existsSync,
  lstatSync,
  mkdirSync,
  readFileSync,
  readdirSync,
  realpathSync,
  statSync,
} from 'node:fs'
import { isAbsolute, join, relative, resolve } from 'node:path'
import {
  AGENT_MEMORY_DIRECTORY,
  AGENT_MEMORY_INDEX_FILE,
  MAX_AGENT_MEMORY_FILE_BYTES,
  MAX_AGENT_MEMORY_FILES,
  MAX_AGENT_MEMORY_TOTAL_BYTES,
} from '@axon/shared'
import type { AgentMemoryFile, AgentMemoryFileEntry, AgentMemorySummary } from '@axon/shared'
import type { AgentProjectManager } from '../project/agent-project-manager'
import { writeTextFileAtomic } from '../core/safe-file'

const MAX_MEMORY_DEPTH = 4
const MAX_RELATIVE_PATH_BYTES = 512

export class AgentMemoryServiceError extends Error {
  constructor(
    readonly code: 'invalid_input' | 'project_unavailable' | 'disabled' | 'not_found' | 'limit_exceeded' | 'storage_error',
    message: string,
  ) {
    super(message)
    this.name = 'AgentMemoryServiceError'
  }
}

export interface AgentMemoryServiceOptions {
  projects: Pick<AgentProjectManager, 'get' | 'resolveProjectCwd'>
}

interface MemoryRoot {
  path: string
  exists: boolean
}

function isInside(root: string, target: string): boolean {
  const value = relative(root, target)
  return value === '' || (!value.startsWith('..') && !isAbsolute(value))
}

/** 只接受正斜杠分隔的项目相对 Markdown 路径，保证跨平台持久化形状一致。 */
function normalizeMemoryPath(value: unknown): string {
  if (typeof value !== 'string' || !value.trim() || Buffer.byteLength(value, 'utf8') > MAX_RELATIVE_PATH_BYTES) {
    throw new AgentMemoryServiceError('invalid_input', '记忆文件路径无效')
  }
  const normalized = value.trim()
  if (
    normalized.startsWith('/')
    || normalized.includes('\\')
    || normalized.includes('\0')
    || !normalized.endsWith('.md')
  ) throw new AgentMemoryServiceError('invalid_input', '记忆文件路径必须是 memory 内的 Markdown 相对路径')
  const segments = normalized.split('/')
  if (
    segments.length > MAX_MEMORY_DEPTH
    || segments.some((segment) => !segment || segment === '.' || segment === '..' || /[\u0000-\u001f:]/u.test(segment))
  ) throw new AgentMemoryServiceError('invalid_input', '记忆文件路径无效')
  return segments.join('/')
}

/** UTF-8 必须完整可解码；损坏字节不能被静默替换后再次写回。 */
function decodeUtf8(buffer: Buffer): string {
  try { return new TextDecoder('utf-8', { fatal: true }).decode(buffer) }
  catch { throw new AgentMemoryServiceError('storage_error', '记忆文件不是有效 UTF-8 文本') }
}

/**
 * 读写项目长期记忆；项目开关是所有入口的第一道边界，关闭后即使 memory/ 仍存在也不可访问。
 * MEMORY.md 仅作为索引，其他 Markdown 文件按任务需要读取。
 */
export class AgentMemoryService {
  constructor(private readonly options: AgentMemoryServiceOptions) {}

  list(projectId: string): AgentMemorySummary {
    const root = this.resolveRoot(projectId, false)
    if (!root.exists) return { projectId, indexExists: false, totalBytes: 0, files: [] }
    const files: AgentMemoryFileEntry[] = []
    let totalBytes = 0

    // 目录递归有深度、数量和总大小上限，避免一次 UI 刷新扫描无界工作区内容。
    const visit = (directory: string, prefix: string, depth: number): void => {
      if (depth > MAX_MEMORY_DEPTH) throw new AgentMemoryServiceError('limit_exceeded', '记忆目录层级过深')
      for (const entry of readdirSync(directory, { withFileTypes: true })) {
        const path = join(directory, entry.name)
        if (entry.isSymbolicLink()) continue
        const relativePath = prefix ? `${prefix}/${entry.name}` : entry.name
        if (entry.isDirectory()) {
          visit(path, relativePath, depth + 1)
          continue
        }
        if (!entry.isFile() || !entry.name.endsWith('.md')) continue
        const stats = statSync(path)
        if (stats.size > MAX_AGENT_MEMORY_FILE_BYTES) {
          throw new AgentMemoryServiceError('limit_exceeded', `记忆文件过大：${relativePath}`)
        }
        totalBytes += stats.size
        if (totalBytes > MAX_AGENT_MEMORY_TOTAL_BYTES || files.length >= MAX_AGENT_MEMORY_FILES) {
          throw new AgentMemoryServiceError('limit_exceeded', '项目记忆总量超过限制')
        }
        files.push({ relativePath, size: stats.size, updatedAt: stats.mtimeMs })
      }
    }
    try { visit(root.path, '', 1) }
    catch (error) {
      if (error instanceof AgentMemoryServiceError) throw error
      throw new AgentMemoryServiceError('storage_error', '读取项目记忆目录失败')
    }
    files.sort((left, right) => left.relativePath.localeCompare(right.relativePath, 'zh-CN'))
    return {
      projectId,
      indexExists: files.some((file) => file.relativePath === AGENT_MEMORY_INDEX_FILE),
      totalBytes,
      files,
    }
  }

  read(projectId: string, relativePathValue: unknown): AgentMemoryFile {
    const relativePath = normalizeMemoryPath(relativePathValue)
    const root = this.resolveRoot(projectId, false)
    if (!root.exists) throw new AgentMemoryServiceError('not_found', '记忆文件不存在')
    const path = this.resolveExistingFile(root.path, relativePath)
    try {
      const stats = statSync(path)
      if (stats.size > MAX_AGENT_MEMORY_FILE_BYTES) throw new AgentMemoryServiceError('limit_exceeded', '记忆文件过大')
      return { projectId, relativePath, content: decodeUtf8(readFileSync(path)), size: stats.size, updatedAt: stats.mtimeMs }
    } catch (error) {
      if (error instanceof AgentMemoryServiceError) throw error
      throw new AgentMemoryServiceError('storage_error', '读取记忆文件失败')
    }
  }

  /** 写入前逐级拒绝符号链接；临时文件与目标文件位于同一目录，rename 保持原子替换。 */
  write(projectId: string, relativePathValue: unknown, contentValue: unknown): AgentMemoryFile {
    const relativePath = normalizeMemoryPath(relativePathValue)
    if (typeof contentValue !== 'string') throw new AgentMemoryServiceError('invalid_input', '记忆内容必须是文本')
    if (Buffer.byteLength(contentValue, 'utf8') > MAX_AGENT_MEMORY_FILE_BYTES) {
      throw new AgentMemoryServiceError('limit_exceeded', '记忆文件过大')
    }
    const root = this.resolveRoot(projectId, true)
    const segments = relativePath.split('/')
    const fileName = segments.pop()!
    let directory = root.path
    try {
      for (const segment of segments) {
        const next = join(directory, segment)
        if (existsSync(next)) {
          const stats = lstatSync(next)
          if (stats.isSymbolicLink() || !stats.isDirectory()) {
            throw new AgentMemoryServiceError('storage_error', '记忆目录包含不安全路径')
          }
        } else {
          mkdirSync(next)
          if (process.platform !== 'win32') chmodSync(next, 0o700)
        }
        directory = realpathSync(next)
        if (!isInside(root.path, directory)) throw new AgentMemoryServiceError('storage_error', '记忆文件路径越界')
      }
      const path = join(directory, fileName)
      if (existsSync(path)) {
        const stats = lstatSync(path)
        if (stats.isSymbolicLink() || !stats.isFile()) {
          throw new AgentMemoryServiceError('storage_error', '记忆文件路径不安全')
        }
      }
      const temporaryPath = `${path}.tmp`
      if (existsSync(temporaryPath)) {
        const temporaryStats = lstatSync(temporaryPath)
        if (temporaryStats.isSymbolicLink() || !temporaryStats.isFile()) {
          throw new AgentMemoryServiceError('storage_error', '记忆临时文件路径不安全')
        }
      }
      const summary = this.list(projectId)
      const previousSize = summary.files.find((file) => file.relativePath === relativePath)?.size ?? 0
      if (previousSize === 0 && summary.files.length >= MAX_AGENT_MEMORY_FILES) {
        throw new AgentMemoryServiceError('limit_exceeded', '项目记忆文件数量超过限制')
      }
      if (summary.totalBytes - previousSize + Buffer.byteLength(contentValue, 'utf8') > MAX_AGENT_MEMORY_TOTAL_BYTES) {
        throw new AgentMemoryServiceError('limit_exceeded', '项目记忆总量超过限制')
      }
      writeTextFileAtomic(path, contentValue)
      return this.read(projectId, relativePath)
    } catch (error) {
      if (error instanceof AgentMemoryServiceError) throw error
      throw new AgentMemoryServiceError('storage_error', '保存记忆文件失败')
    }
  }

  /** 从项目管理器取得可信 cwd；关闭开关时不探测 memory/ 是否存在，避免形成旁路。 */
  private resolveRoot(projectId: string, create: boolean): MemoryRoot {
    try {
      const project = this.options.projects.get(projectId)
      if (!project) throw new AgentMemoryServiceError('project_unavailable', 'Agent 项目不存在')
      if (!project.memoryEnabled) throw new AgentMemoryServiceError('disabled', '该项目尚未启用记忆')
      const workspaceRoot = realpathSync(this.options.projects.resolveProjectCwd(projectId))
      const candidate = resolve(workspaceRoot, AGENT_MEMORY_DIRECTORY)
      if (!isInside(workspaceRoot, candidate)) throw new AgentMemoryServiceError('storage_error', '记忆目录路径越界')
      if (!existsSync(candidate)) {
        if (!create) return { path: candidate, exists: false }
        mkdirSync(candidate)
        if (process.platform !== 'win32') chmodSync(candidate, 0o700)
      }
      const stats = lstatSync(candidate)
      if (stats.isSymbolicLink() || !stats.isDirectory()) {
        throw new AgentMemoryServiceError('storage_error', 'memory 路径不是安全目录')
      }
      const root = realpathSync(candidate)
      if (!isInside(workspaceRoot, root)) throw new AgentMemoryServiceError('storage_error', '记忆目录路径越界')
      return { path: root, exists: true }
    } catch (error) {
      if (error instanceof AgentMemoryServiceError) throw error
      throw new AgentMemoryServiceError('project_unavailable', 'Agent 项目工作区不可用')
    }
  }

  private resolveExistingFile(root: string, relativePath: string): string {
    let current = root
    for (const segment of relativePath.split('/')) {
      current = join(current, segment)
      if (!existsSync(current)) throw new AgentMemoryServiceError('not_found', '记忆文件不存在')
      const stats = lstatSync(current)
      if (stats.isSymbolicLink()) throw new AgentMemoryServiceError('storage_error', '记忆文件路径包含符号链接')
    }
    if (!lstatSync(current).isFile()) throw new AgentMemoryServiceError('not_found', '记忆文件不存在')
    const canonical = realpathSync(current)
    if (!isInside(root, canonical)) throw new AgentMemoryServiceError('storage_error', '记忆文件路径越界')
    return canonical
  }
}
