/** 工作区文件预览：验证相对路径和真实路径边界后，只读取小型 UTF-8 文本。 */

import { lstat, readFile, realpath, stat } from 'node:fs/promises'
import { basename, isAbsolute, relative, resolve } from 'node:path'
import type { AgentWorkspaceFilePreview } from '@axon/shared'

const DEFAULT_MAX_BYTES = 512 * 1024

type WorkspaceFilePreviewData =
  | (Omit<AgentWorkspaceFilePreview, 'projectId' | 'kind' | 'content'> & { kind: 'text'; content: string })
  | (Omit<AgentWorkspaceFilePreview, 'projectId' | 'kind' | 'content'> & { kind: 'binary' | 'too_large' })

export class WorkspaceFilePreviewError extends Error {
  constructor(readonly code: 'invalid_path' | 'not_found' | 'not_file' | 'outside_workspace') {
    super('无法预览该工作区文件')
    this.name = 'WorkspaceFilePreviewError'
  }
}

function resolveCandidate(root: string, value: unknown): { target: string; relativePath: string } {
  if (typeof value !== 'string' || !value.trim() || value.includes('\0') || isAbsolute(value)) {
    throw new WorkspaceFilePreviewError('invalid_path')
  }
  const target = resolve(root, value)
  const relativePath = relative(root, target)
  if (!relativePath || relativePath.startsWith('..') || isAbsolute(relativePath)) {
    throw new WorkspaceFilePreviewError('outside_workspace')
  }
  return { target, relativePath: relativePath.replaceAll('\\', '/') }
}

/**
 * 读取前同时检查词法路径和 realpath；符号链接、目录、越界路径都不会进入 readFile。
 */
export async function readWorkspaceFilePreview(
  rootPath: string,
  relativePathValue: unknown,
  maxBytes = DEFAULT_MAX_BYTES,
  signal?: AbortSignal,
): Promise<WorkspaceFilePreviewData> {
  const ensureActive = (): void => {
    if (signal?.aborted) throw new DOMException('工作区读取已取消', 'AbortError')
  }
  ensureActive()
  const root = await realpath(rootPath)
  ensureActive()
  const { target, relativePath } = resolveCandidate(root, relativePathValue)
  try {
    const linkStatus = await lstat(target)
    ensureActive()
    if (linkStatus.isSymbolicLink()) throw new WorkspaceFilePreviewError('outside_workspace')
    const realTarget = await realpath(target)
    ensureActive()
    const realRelative = relative(root, realTarget)
    if (!realRelative || realRelative.startsWith('..') || isAbsolute(realRelative)) {
      throw new WorkspaceFilePreviewError('outside_workspace')
    }
    const fileStatus = await stat(realTarget)
    ensureActive()
    if (!fileStatus.isFile()) throw new WorkspaceFilePreviewError('not_file')
    const base = { relativePath, name: basename(relativePath), size: fileStatus.size }
    if (fileStatus.size > maxBytes) return { ...base, kind: 'too_large' }

    const buffer = await readFile(realTarget)
    // 不把取消当作文件丢失；已开始的文件读取仍由上游登记到真实完成。
    ensureActive()
    if (buffer.includes(0)) return { ...base, kind: 'binary' }
    try {
      return { ...base, kind: 'text', content: new TextDecoder('utf-8', { fatal: true }).decode(buffer) }
    } catch {
      return { ...base, kind: 'binary' }
    }
  } catch (error) {
    ensureActive()
    if (error instanceof WorkspaceFilePreviewError) throw error
    throw new WorkspaceFilePreviewError('not_found')
  }
}
