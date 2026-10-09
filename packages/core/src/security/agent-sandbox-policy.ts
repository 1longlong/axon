/** 从可信项目工作区生成 Runtime 中立的最小 OS 沙箱策略。 */

import { existsSync, readFileSync, realpathSync, statSync } from 'node:fs'
import { dirname, isAbsolute, join, resolve } from 'node:path'
import type { AgentSandboxMode, AgentSandboxPolicy } from '@axon/shared'

const PROTECTED_WORKSPACE_ENTRIES = ['.git', '.axon', '.agents'] as const

export interface BuildAgentSandboxPolicyInput {
  projectRoot: string
  mode: AgentSandboxMode
}

/** 已存在的路径解析符号链接；尚不存在的受保护路径锚定在已规范化的项目根。 */
function canonicalPath(path: string): string {
  return existsSync(path) ? realpathSync(path) : resolve(path)
}

/** worktree 的 .git 可能是指向外部真实 gitdir 的文本文件，该目录也必须保持只读。 */
function resolveGitDirectory(projectRoot: string): string | undefined {
  const dotGit = join(projectRoot, '.git')
  if (!existsSync(dotGit) || statSync(dotGit).isDirectory()) return undefined
  const match = /^gitdir:\s*(.+)\s*$/im.exec(readFileSync(dotGit, 'utf8'))
  if (!match?.[1]) return undefined
  const target = match[1].trim()
  return canonicalPath(isAbsolute(target) ? target : resolve(dirname(dotGit), target))
}

/**
 * 把项目管理器提供的可信工作区物化为一轮查询的基础策略。
 * 上游只传项目根和会话模式；下游 Seatbelt 编译器只能收窄，不能扩大这些根。
 */
export function buildAgentSandboxPolicy(input: BuildAgentSandboxPolicyInput): AgentSandboxPolicy {
  if (!input.projectRoot || !isAbsolute(input.projectRoot)) {
    throw new Error('Agent 沙箱工作区必须是绝对路径')
  }
  const projectRoot = realpathSync(input.projectRoot)
  if (!statSync(projectRoot).isDirectory()) throw new Error('Agent 沙箱工作区不是目录')

  // 先固定项目内保留目录，再补充 worktree 实际 gitdir，防止宽工作区写权限覆盖元数据。
  const protectedRoots = PROTECTED_WORKSPACE_ENTRIES.map((entry) => canonicalPath(join(projectRoot, entry)))
  const gitDirectory = resolveGitDirectory(projectRoot)
  if (gitDirectory && !protectedRoots.includes(gitDirectory)) protectedRoots.push(gitDirectory)

  return {
    platform: 'macos',
    mode: input.mode,
    workingDirectory: projectRoot,
    readAccess: { type: 'fullAccess' },
    writableRoots: input.mode === 'workspaceWrite' ? [projectRoot] : [],
    protectedReadOnlyRoots: protectedRoots,
    networkAccess: false,
  }
}
