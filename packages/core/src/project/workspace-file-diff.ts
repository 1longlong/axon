import { spawn } from 'node:child_process'
import { lstat, realpath } from 'node:fs/promises'
import { isAbsolute, relative, resolve } from 'node:path'
import type { AgentWorkspaceFileDiff } from '@axon/shared'

const MAX_DIFF_BYTES = 512 * 1024
const MAX_GIT_OUTPUT_BYTES = MAX_DIFF_BYTES * 2
const GIT_KILL_GRACE_MS = 500

function ensureActive(signal?: AbortSignal): void {
  if (signal?.aborted) throw new DOMException('工作区 Diff 已取消', 'AbortError')
}

export class WorkspaceFileDiffError extends Error {
  constructor(readonly code: 'invalid_path' | 'outside_workspace' | 'unavailable') {
    super('无法读取该文件的 Diff')
    this.name = 'WorkspaceFileDiffError'
  }
}

/** 从可信根解析相对路径，拒绝越界/链接；取消后不进入下一次元信息读取。 */
async function validatePath(rootPath: string, value: unknown, signal?: AbortSignal): Promise<{ relativePath: string; absolutePath: string }> {
  ensureActive(signal)
  if (typeof value !== 'string' || !value.trim() || value.includes('\0') || isAbsolute(value)) {
    throw new WorkspaceFileDiffError('invalid_path')
  }
  const root = await realpath(rootPath)
  ensureActive(signal)
  const absolutePath = resolve(root, value)
  const relativePath = relative(root, absolutePath)
  if (!relativePath || relativePath.startsWith('..') || isAbsolute(relativePath)) {
    throw new WorkspaceFileDiffError('outside_workspace')
  }
  try {
    const status = await lstat(absolutePath)
    ensureActive(signal)
    if (status.isSymbolicLink()) throw new WorkspaceFileDiffError('outside_workspace')
  } catch (error) {
    ensureActive(signal)
    if (error instanceof WorkspaceFileDiffError) throw error
    // 删除中的文件可能已经不存在，Git 仍可从索引提供 Diff。
  }
  return { relativePath: relativePath.replaceAll('\\', '/'), absolutePath }
}

/** 参数数组执行 Git；取消先终止自有进程组，宽限后强制结束，实际 close 才完成等待。 */
async function runGit(cwd: string, args: string[], signal?: AbortSignal): Promise<{ stdout: string; exitCode: number }> {
  ensureActive(signal)
  const result = await new Promise<{ stdout: string; exitCode: number }>((done) => {
    const grouped = process.platform !== 'win32'
    const child = spawn('git', args, { cwd, detached: grouped, stdio: ['ignore', 'pipe', 'pipe'] })
    const chunks: Buffer[] = []
    let stdoutBytes = 0, stderrBytes = 0, failed = false, terminating = false
    let timer: ReturnType<typeof setTimeout> | undefined
    const kill = (kind: NodeJS.Signals): void => {
      if (child.pid === undefined) return
      try {
        if (grouped) process.kill(-child.pid, kind)
        else child.kill(kind)
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== 'ESRCH') failed = true
      }
    }
    const terminate = (): void => {
      if (terminating) return
      terminating = true
      kill('SIGTERM')
      // Git 的 helper 可能仍持有管道；不能看到主进程 exit 就取消兜底或提前完成。
      timer = setTimeout(() => kill('SIGKILL'), GIT_KILL_GRACE_MS)
    }
    child.stdout.on('data', (chunk: Buffer) => {
      const room = MAX_GIT_OUTPUT_BYTES - stdoutBytes
      if (room > 0) chunks.push(chunk.subarray(0, room))
      stdoutBytes += chunk.length
      if (stdoutBytes > MAX_GIT_OUTPUT_BYTES) { failed = true; terminate() }
    })
    child.stderr.on('data', (chunk: Buffer) => {
      stderrBytes += chunk.length
      if (stderrBytes > MAX_GIT_OUTPUT_BYTES) { failed = true; terminate() }
    })
    child.on('error', () => { failed = true })
    child.once('close', (code) => {
      if (timer) clearTimeout(timer)
      signal?.removeEventListener('abort', terminate)
      done({ stdout: Buffer.concat(chunks).toString('utf8'), exitCode: failed ? -1 : code ?? -1 })
    })
    signal?.addEventListener('abort', terminate, { once: true })
    if (signal?.aborted) terminate()
  })
  ensureActive(signal)
  return result
}

/** 在可信项目 cwd 内读取单文件 Diff；只允许 git 参数数组，不经过 shell。 */
export async function readWorkspaceFileDiff(
  projectId: string,
  rootPath: string,
  relativePathValue: unknown,
  signal?: AbortSignal,
): Promise<AgentWorkspaceFileDiff> {
  const { relativePath, absolutePath } = await validatePath(rootPath, relativePathValue, signal)
  const root = await realpath(rootPath)
  ensureActive(signal)
  const repository = await runGit(root, ['rev-parse', '--is-inside-work-tree'], signal)
  if (repository.exitCode !== 0 || repository.stdout.trim() !== 'true') {
    return { projectId, relativePath, status: 'unavailable', message: '当前工作区不是 Git 仓库，暂时无法查看 Diff' }
  }

  const status = await runGit(root, ['status', '--porcelain=v1', '--', relativePath], signal)
  if (status.exitCode !== 0) {
    return { projectId, relativePath, status: 'unavailable', message: '无法读取 Git 文件状态' }
  }
  const isUntracked = status.stdout.split('\n').some((line) => line.startsWith('?? '))
  // HEAD 比较同时覆盖已暂存和未暂存修改；尚无首个提交时退回索引比较。
  const hasHead = await runGit(root, ['rev-parse', '--verify', 'HEAD'], signal)
  const diff = isUntracked
    ? await runGit(root, ['diff', '--no-index', '--no-ext-diff', '--unified=80', '--', '/dev/null', absolutePath], signal)
    : hasHead.exitCode === 0
      ? await runGit(root, ['diff', '--no-ext-diff', '--unified=80', 'HEAD', '--', relativePath], signal)
      : await runGit(root, ['diff', '--cached', '--no-ext-diff', '--unified=80', '--', relativePath], signal)
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
