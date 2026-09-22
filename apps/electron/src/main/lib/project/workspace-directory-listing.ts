/** 工作区目录枚举：只返回相对路径，不跟随符号链接，并限制读取规模。 */

import { readdir } from 'node:fs/promises'
import { relative, resolve, sep } from 'node:path'
import type { AgentWorkspaceTreeEntry } from '@axon/shared'

const DEFAULT_MAX_DEPTH = 8
const DEFAULT_MAX_ENTRIES = 2_000
const IGNORED_NAMES = new Set(['.git', 'node_modules', 'dist', 'build', 'coverage'])

export interface WorkspaceDirectoryListingOptions {
  maxDepth?: number
  maxEntries?: number
  ignoredNames?: ReadonlySet<string>
}

export interface WorkspaceDirectoryListingResult {
  entries: AgentWorkspaceTreeEntry[]
  truncated: boolean
}

function compareEntries(left: AgentWorkspaceTreeEntry, right: AgentWorkspaceTreeEntry): number {
  if (left.kind === 'directory' && right.kind !== 'directory') return -1
  if (left.kind !== 'directory' && right.kind === 'directory') return 1
  return left.name.localeCompare(right.name, 'zh-CN')
}

function toRelativePath(root: string, target: string): string {
  return relative(root, target).split(sep).join('/')
}

/**
 * 从可信工作区根构造有界文件树；目录项读取失败只跳过该分支，根目录失败则交给上游处理。
 */
export async function listWorkspaceDirectory(
  rootPath: string,
  options: WorkspaceDirectoryListingOptions = {},
): Promise<WorkspaceDirectoryListingResult> {
  const root = resolve(rootPath)
  const maxDepth = options.maxDepth ?? DEFAULT_MAX_DEPTH
  const maxEntries = options.maxEntries ?? DEFAULT_MAX_ENTRIES
  const ignoredNames = options.ignoredNames ?? IGNORED_NAMES
  let count = 0
  let truncated = false

  const visit = async (directory: string, depth: number, isRoot: boolean): Promise<AgentWorkspaceTreeEntry[]> => {
    let dirents
    try {
      dirents = await readdir(directory, { withFileTypes: true })
    } catch (error) {
      if (isRoot) throw error
      return []
    }

    const entries: AgentWorkspaceTreeEntry[] = []
    for (const dirent of dirents) {
      if (ignoredNames.has(dirent.name)) continue
      if (count >= maxEntries) {
        truncated = true
        break
      }
      count += 1
      const target = resolve(directory, dirent.name)
      const kind = dirent.isSymbolicLink()
        ? 'symlink'
        : dirent.isDirectory() ? 'directory' : 'file'
      const entry: AgentWorkspaceTreeEntry = {
        name: dirent.name,
        relativePath: toRelativePath(root, target),
        kind,
      }
      // 符号链接只展示不递归，避免链接把读取范围带出工作区根。
      if (kind === 'directory') {
        if (depth < maxDepth) entry.children = await visit(target, depth + 1, false)
        else {
          entry.children = []
          truncated = true
        }
      }
      entries.push(entry)
    }
    return entries.sort(compareEntries)
  }

  return { entries: await visit(root, 0, true), truncated }
}
