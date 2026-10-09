/** 宿主 Shell 解析只读取账户与文件元信息，不执行用户启动配置。 */

import { accessSync, constants, statSync } from 'node:fs'
import { userInfo } from 'node:os'
import { basename, delimiter, extname, isAbsolute, resolve } from 'node:path'

export type AgentShellType = 'zsh' | 'bash' | 'sh'

export interface AgentShell {
  type: AgentShellType
  path: string
}

export interface AgentShellResolutionOptions {
  /** undefined 时读取系统账户，null 用于明确表示账户 Shell 不可用。 */
  userShellPath?: string | null
  path?: string
  platform?: NodeJS.Platform
}

const FALLBACK_PATHS: Record<AgentShellType, string[]> = {
  zsh: ['/bin/zsh'],
  bash: ['/bin/bash', '/usr/bin/bash'],
  sh: ['/bin/sh'],
}

function shellType(path: string): AgentShellType | undefined {
  const name = basename(path, extname(path))
  return name === 'zsh' || name === 'bash' || name === 'sh' ? name : undefined
}

function isExecutableFile(path: string): boolean {
  if (!isAbsolute(path) || path.includes('\0')) return false
  try {
    if (!statSync(path).isFile()) return false
    accessSync(path, constants.X_OK)
    return true
  } catch {
    return false
  }
}

function accountShellPath(): string | null {
  try { return userInfo().shell }
  catch { return null }
}

/**
 * 为宿主命令选择账户默认 Shell；同类型优先账户路径，再查 PATH 与系统路径。
 * 账户类型无法使用时按平台顺序回退，结果只包含已存在的绝对可执行路径。
 */
export function resolveAgentShell(options: AgentShellResolutionOptions = {}): AgentShell | undefined {
  const userShellPath = options.userShellPath === undefined ? accountShellPath() : options.userShellPath
  const preferredType = userShellPath ? shellType(userShellPath) : undefined
  const fallbackTypes: AgentShellType[] = (options.platform ?? process.platform) === 'darwin'
    ? ['zsh', 'bash', 'sh']
    : ['bash', 'zsh', 'sh']
  const types = [...new Set(preferredType ? [preferredType, ...fallbackTypes] : fallbackTypes)]
  const pathEntries = (options.path ?? process.env.PATH ?? '').split(delimiter)

  for (const type of types) {
    const candidates = [
      ...(userShellPath && preferredType === type ? [userShellPath] : []),
      ...pathEntries.map((entry) => resolve(entry, type)),
      ...FALLBACK_PATHS[type],
    ]
    const path = candidates.find(isExecutableFile)
    if (path) return { type, path }
  }
  return undefined
}
