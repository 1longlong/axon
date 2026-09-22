import { execFile } from 'node:child_process'
import { lstat, realpath } from 'node:fs/promises'
import { promisify } from 'node:util'
import { isAbsolute, relative, resolve } from 'node:path'
import type { AgentWorkspaceFileDiff } from '@axon/shared'

const execFileAsync = promisify(execFile)
const MAX_DIFF_BYTES = 512 * 1024
const MAX_GIT_OUTPUT_BYTES = MAX_DIFF_BYTES * 2

export class WorkspaceFileDiffError extends Error {
  constructor(readonly code: 'invalid_path' | 'outside_workspace' | 'unavailable') {
    super('无法读取该文件的 Diff')
    this.name = 'WorkspaceFileDiffError'
  }
}

async function validatePath(rootPath: string, value: unknown): Promise<{ relativePath: string; absolutePath: string }> {
  if (typeof value !== 'string' || !value.trim() || value.includes('\0') || isAbsolute(value)) {
    throw new WorkspaceFileDiffError('invalid_path')
  }
  const root = await realpath(rootPath)
  const absolutePath = resolve(root, value)
  const relativePath = relative(root, absolutePath)
  if (!relativePath || relativePath.startsWith('..') || isAbsolute(relativePath)) {
    throw new WorkspaceFileDiffError('outside_workspace')
  }
  try {
    const status = await lstat(absolutePath)
    if (status.isSymbolicLink()) throw new WorkspaceFileDiffError('outside_workspace')
  } catch (error) {
    if (error instanceof WorkspaceFileDiffError) throw error
    // 删除中的文件可能已经不存在，Git 仍可从索引提供 Diff。
  }
  return { relativePath: relativePath.replaceAll('\\', '/'), absolutePath }
}

async function runGit(cwd: string, args: string[]): Promise<{ stdout: string; exitCode: number }> {
  try {
    const result = await execFileAsync('git', args, { cwd, maxBuffer: MAX_GIT_OUTPUT_BYTES })
    return { stdout: result.stdout, exitCode: 0 }
  } catch (error) {
    const result = error as { stdout?: string; code?: number | string }
    return { stdout: typeof result.stdout === 'string' ? result.stdout : '', exitCode: typeof result.code === 'number' ? result.code : -1 }
  }
}

/** 在可信项目 cwd 内读取单文件 Diff；只允许 git 参数数组，不经过 shell。 */
export async function readWorkspaceFileDiff(
  projectId: string,
  rootPath: string,
  relativePathValue: unknown,
): Promise<AgentWorkspaceFileDiff> {
  const { relativePath, absolutePath } = await validatePath(rootPath, relativePathValue)
  const root = await realpath(rootPath)
  const repository = await runGit(root, ['rev-parse', '--is-inside-work-tree'])
  if (repository.exitCode !== 0 || repository.stdout.trim() !== 'true') {
    return { projectId, relativePath, status: 'unavailable', message: '当前工作区不是 Git 仓库，暂时无法查看 Diff' }
  }

  const status = await runGit(root, ['status', '--porcelain=v1', '--', relativePath])
  if (status.exitCode !== 0) {
    return { projectId, relativePath, status: 'unavailable', message: '无法读取 Git 文件状态' }
  }
  const isUntracked = status.stdout.split('\n').some((line) => line.startsWith('?? '))
  // HEAD 比较同时覆盖已暂存和未暂存修改；尚无首个提交时退回索引比较。
  const hasHead = await runGit(root, ['rev-parse', '--verify', 'HEAD'])
  const diff = isUntracked
    ? await runGit(root, ['diff', '--no-index', '--no-ext-diff', '--unified=80', '--', '/dev/null', absolutePath])
    : hasHead.exitCode === 0
      ? await runGit(root, ['diff', '--no-ext-diff', '--unified=80', 'HEAD', '--', relativePath])
      : await runGit(root, ['diff', '--cached', '--no-ext-diff', '--unified=80', '--', relativePath])
  if (diff.exitCode !== 0 && !isUntracked) {
    return { projectId, relativePath, status: 'unavailable', message: '无法读取 Git Diff' }
  }
  const patch = diff.stdout.replaceAll(absolutePath, `b/${relativePath}`)
  if (!patch.trim()) return { projectId, relativePath, status: 'clean', message: '当前文件没有未提交变更' }
  if (new TextEncoder().encode(patch).byteLength > MAX_DIFF_BYTES) {
    return { projectId, relativePath, status: 'unavailable', message: 'Diff 内容过大，暂不展示' }
  }
  return { projectId, relativePath, status: 'changed', patch }
}
