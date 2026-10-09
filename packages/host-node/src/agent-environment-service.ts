/** Agent 运行前环境检查：只读验证工作目录与本机开发工具，不执行用户命令。 */

import { access, constants, stat } from 'node:fs/promises'
import { spawn } from 'node:child_process'
import { cwd as processCwd } from 'node:process'
import { resolve } from 'node:path'
import type { AgentEnvironmentCheckResult, AgentEnvironmentCommandCheck } from '@axon/shared'

const COMMAND_TIMEOUT_MS = 2_000
const KILL_GRACE_MS = 500

interface AgentEnvironmentProbeInput {
  /** 只由可信装配入口传入已解析的项目目录。 */
  cwd?: string
}

function ensureActive(signal?: AbortSignal): void {
  if (signal?.aborted) throw new DOMException('环境检查已取消', 'AbortError')
}

/** 固定版本探测以实际 close 为完成边界；取消/超时先 TERM，宽限后 KILL 自有进程。 */
async function checkCommand(command: string, signal?: AbortSignal): Promise<AgentEnvironmentCommandCheck> {
  ensureActive(signal)
  const result = await new Promise<{ output: string; available: boolean }>((done) => {
    const grouped = process.platform !== 'win32'
    const child = spawn(command, ['--version'], { windowsHide: true, detached: grouped, stdio: ['ignore', 'pipe', 'pipe'] })
    const chunks: Buffer[] = []
    let bytes = 0, failed = false, stopping = false
    let killTimer: ReturnType<typeof setTimeout> | undefined
    const kill = (kind: NodeJS.Signals): void => {
      if (child.pid === undefined) return
      try { if (grouped) process.kill(-child.pid, kind); else child.kill(kind) }
      catch { /* 仍以 close 为结束边界，不把发信号当作已经退出。 */ }
    }
    const stop = (): void => {
      if (stopping) return
      stopping = true; failed = true
      kill('SIGTERM')
      killTimer = setTimeout(() => kill('SIGKILL'), KILL_GRACE_MS)
    }
    const collect = (chunk: Buffer): void => {
      bytes += chunk.length
      if (bytes > 16 * 1024) stop()
      else chunks.push(chunk)
    }
    child.stdout.on('data', collect)
    child.stderr.on('data', collect)
    child.once('error', stop)
    const timeout = setTimeout(stop, COMMAND_TIMEOUT_MS)
    signal?.addEventListener('abort', stop, { once: true })
    if (signal?.aborted) stop()
    child.once('close', (code) => {
      clearTimeout(timeout)
      if (killTimer) clearTimeout(killTimer)
      signal?.removeEventListener('abort', stop)
      done({ output: Buffer.concat(chunks).toString('utf8'), available: !failed && code === 0 })
    })
  })
  ensureActive(signal)
  if (result.available) {
    const version = result.output.trim().split(/\r?\n/)[0]
    return { available: true, ...(version ? { version } : {}), message: '可用' }
  }
  return { available: false, message: `${command} 不可用` }
}

/** 目录检查先于命令检查；失败只返回稳定提示，不回显底层异常。 */
export async function checkAgentEnvironment(
  input: AgentEnvironmentProbeInput = {},
  signal?: AbortSignal,
): Promise<AgentEnvironmentCheckResult> {
  ensureActive(signal)
  const cwd = typeof input.cwd === 'string' && input.cwd.trim()
    ? resolve(input.cwd.trim())
    : processCwd()
  let available = false
  let writable = false
  try {
    available = (await stat(cwd)).isDirectory()
    ensureActive(signal)
    if (available) {
      await access(cwd, constants.R_OK | constants.W_OK)
      writable = true
    }
  } catch {
    ensureActive(signal)
    available = false
    writable = false
  }
  const directory = {
    available,
    writable,
    message: !available ? '工作目录不存在或不是目录' : !writable ? '工作目录不可读写' : '工作目录可用',
  }
  // 元信息读取不支持信号；在启动固定探测命令前复核，取消不被误记作工具缺失。
  ensureActive(signal)
  // 一个探测先收到取消不能让整个端口提前返回，必须等另外两个真实进程也关闭。
  const results = await Promise.allSettled([
    checkCommand('git', signal),
    checkCommand('node', signal),
    checkCommand('bun', signal),
  ])
  ensureActive(signal)
  const checks = results.map((result) => {
    if (result.status === 'rejected') throw result.reason
    return result.value
  })
  const [git, node, bun] = checks as [AgentEnvironmentCommandCheck, AgentEnvironmentCommandCheck, AgentEnvironmentCommandCheck]
  return { cwd, directory, git, node, bun }
}
