/** macOS Seatbelt profile 编译与宿主能力探测；不负责启动真实工具进程。 */

import { accessSync, constants } from 'node:fs'
import { isAbsolute, resolve } from 'node:path'
import { spawnSync } from 'node:child_process'
import type { AgentSandboxPolicy } from '@axon/shared'

const DEFAULT_SANDBOX_EXECUTABLE = '/usr/bin/sandbox-exec'
const SEATBELT_PROBE_PROFILE = '(version 1)\n(allow default)'
const INVALID_PROFILE_PATH = /[\u0000-\u001f\u007f]/

export type SeatbeltUnavailableReason =
  | 'platformUnsupported'
  | 'executableUnavailable'
  | 'profileProbeFailed'

export type SeatbeltCapability =
  | { available: true; executablePath: string }
  | { available: false; reason: SeatbeltUnavailableReason }

interface SeatbeltProbeResult {
  status: number | null
  error?: Error
}

export interface DetectSeatbeltCapabilityOptions {
  platform?: NodeJS.Platform
  executablePath?: string
  accessExecutable?: (path: string) => void
  runProbe?: (executablePath: string, args: string[]) => SeatbeltProbeResult
}

export interface SeatbeltProfileOverrides {
  additionalWritableRoots?: string[]
  networkAccess?: boolean
}

/** SBPL 字符串只接受规范化绝对路径，并转义反斜杠与引号以阻断 profile 注入。 */
function encodeSeatbeltPath(path: string): string {
  if (!isAbsolute(path) || resolve(path) !== path || INVALID_PROFILE_PATH.test(path)) {
    throw new Error('Seatbelt profile 包含无效路径')
  }
  return `"${path.replaceAll('\\', '\\\\').replaceAll('"', '\\"')}"`
}

function uniquePaths(paths: string[]): string[] {
  return [...new Set(paths)]
}

/**
 * 把中立策略编译为不含命令文本的 SBPL。
 * 默认允许系统运行能力，再显式收紧全部写入和网络，最后仅开放可信写根并重新封闭保护目录。
 */
export function compileSeatbeltProfile(
  policy: AgentSandboxPolicy,
  overrides: SeatbeltProfileOverrides = {},
): string {
  if (policy.platform !== 'macos' || policy.readAccess.type !== 'fullAccess') {
    throw new Error('Seatbelt 仅接受 macOS 全盘只读基础策略')
  }
  encodeSeatbeltPath(policy.workingDirectory)
  if (policy.mode === 'readOnly' && policy.writableRoots.length > 0) {
    throw new Error('只读沙箱不能包含可写根')
  }

  const writableRoots = uniquePaths(policy.writableRoots)
  const protectedRoots = uniquePaths(policy.protectedReadOnlyRoots)
  const additionalWritableRoots = uniquePaths(overrides.additionalWritableRoots ?? [])
  if ([...writableRoots, ...additionalWritableRoots].some((root) => root === '/')) {
    throw new Error('Seatbelt 禁止开放根目录写权限')
  }

  const lines = [
    '(version 1)',
    '(allow default)',
    '(deny file-write*)',
    // 登录 shell 初始化和常见重定向依赖此字符设备；只开放精确路径，不放宽 /dev。
    '(allow file-write* (literal "/dev/null"))',
    ...(policy.networkAccess || overrides.networkAccess ? [] : ['(deny network*)']),
    ...writableRoots.map((root) => `(allow file-write* (subpath ${encodeSeatbeltPath(root)}))`),
    ...protectedRoots.map((root) => `(deny file-write* (subpath ${encodeSeatbeltPath(root)}))`),
    // 临时授权最后应用，才能只为本次命令打开保护目录中的精确子路径。
    ...additionalWritableRoots.map((root) => `(allow file-write* (subpath ${encodeSeatbeltPath(root)}))`),
  ]
  return `${lines.join('\n')}\n`
}

/**
 * 检测宿主是否真的能应用 Seatbelt，而不只检查二进制是否存在。
 * 上游据此 fail closed；下游执行器只接收探测成功后返回的固定绝对路径。
 */
export function detectSeatbeltCapability(
  options: DetectSeatbeltCapabilityOptions = {},
): SeatbeltCapability {
  const platform = options.platform ?? process.platform
  if (platform !== 'darwin') return { available: false, reason: 'platformUnsupported' }

  const executablePath = options.executablePath ?? DEFAULT_SANDBOX_EXECUTABLE
  try {
    const accessExecutable = options.accessExecutable ?? ((path: string) => accessSync(path, constants.X_OK))
    accessExecutable(executablePath)
  } catch {
    return { available: false, reason: 'executableUnavailable' }
  }

  const probe = options.runProbe ?? ((path, args) => {
    const result = spawnSync(path, args, { encoding: 'utf8', timeout: 3_000 })
    return { status: result.status, ...(result.error ? { error: result.error } : {}) }
  })
  const result = probe(executablePath, ['-p', SEATBELT_PROBE_PROFILE, '/usr/bin/true'])
  if (result.error || result.status !== 0) return { available: false, reason: 'profileProbeFailed' }
  return { available: true, executablePath }
}
