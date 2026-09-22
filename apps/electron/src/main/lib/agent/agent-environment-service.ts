/** Agent 运行前环境检查：只读验证工作目录与本机开发工具，不执行用户命令。 */

import { access, constants, stat } from 'node:fs/promises'
import { execFile } from 'node:child_process'
import { promisify } from 'node:util'
import { cwd as processCwd } from 'node:process'
import { resolve } from 'node:path'
import type { AgentEnvironmentCheckResult, AgentEnvironmentCommandCheck } from '@axon/shared'

const execFileAsync = promisify(execFile)
const COMMAND_TIMEOUT_MS = 2_000

interface AgentEnvironmentProbeInput {
  /** 只由主进程传入已解析的可信项目目录。 */
  cwd?: string
}

async function checkCommand(command: string): Promise<AgentEnvironmentCommandCheck> {
  try {
    const result = await execFileAsync(command, ['--version'], {
      timeout: COMMAND_TIMEOUT_MS,
      windowsHide: true,
      maxBuffer: 16 * 1024,
    })
    const version = `${result.stdout}${result.stderr}`.trim().split(/\r?\n/)[0]
    return { available: true, ...(version ? { version } : {}), message: '可用' }
  } catch {
    return { available: false, message: `${command} 不可用` }
  }
}

/** 目录检查先于命令检查；失败只返回稳定提示，不回显底层异常。 */
export async function checkAgentEnvironment(
  input: AgentEnvironmentProbeInput = {},
): Promise<AgentEnvironmentCheckResult> {
  const cwd = typeof input.cwd === 'string' && input.cwd.trim()
    ? resolve(input.cwd.trim())
    : processCwd()
  let available = false
  let writable = false
  try {
    available = (await stat(cwd)).isDirectory()
    if (available) {
      await access(cwd, constants.R_OK | constants.W_OK)
      writable = true
    }
  } catch {
    available = false
    writable = false
  }
  const directory = {
    available,
    writable,
    message: !available ? '工作目录不存在或不是目录' : !writable ? '工作目录不可读写' : '工作目录可用',
  }
  const [git, node, bun] = await Promise.all([
    checkCommand('git'),
    checkCommand('node'),
    checkCommand('bun'),
  ])
  return { cwd, directory, git, node, bun }
}
