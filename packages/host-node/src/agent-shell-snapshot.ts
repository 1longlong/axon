/** 会话初始化时捕获宿主 Shell 状态；捕获与验证不承载模型命令，不进入工具沙箱。 */

import { spawn } from 'node:child_process'
import { randomUUID } from 'node:crypto'
import { existsSync, rmSync } from 'node:fs'
import { chmod, lstat, mkdir, readdir, rename, unlink, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import type { AgentShell } from './agent-shell'

export interface AgentShellSnapshotCommandInput {
  argv: string[]
  cwd: string
  environmentOverrides?: Record<string, string | undefined>
  pathPrepend?: string[]
}

export interface AgentPreparedShellCommand {
  argv: string[]
  environment: Record<string, string>
}

export interface AgentShellSnapshot {
  path: string
  cwd: string
  shell: AgentShell
}

export type AgentShellSnapshotFailure = 'shellUnavailable' | 'captureFailed' | 'invalidCapture'
  | 'validationFailed' | 'publishFailed' | 'cancelled'

export interface AgentShellSnapshotOptions {
  sessionId: string
  cwd: string
  shell?: AgentShell
  directory: string
  environment?: NodeJS.ProcessEnv
  timeoutMs?: number
  maxOutputBytes?: number
  onFailure?: (reason: AgentShellSnapshotFailure) => void
}

const DEFAULT_TIMEOUT_MS = 10_000
const DEFAULT_MAX_OUTPUT_BYTES = 16 * 1024 * 1024

export interface AgentShellSnapshotCleanupOptions {
  directory: string
  sessionActivity: ReadonlyMap<string, number>
  isReferenced: (sessionId: string) => boolean
  now?: number
}

/**
 * 只清理缓存目录内可识别的普通文件：无归属立即清理，归属会话三天不活跃则过期。
 * 活跃引用（含预热）始终保留；不读取快照正文，不跟随符号链接或递归删除目录。
 */
export async function pruneAgentShellSnapshots(options: AgentShellSnapshotCleanupOptions): Promise<void> {
  const cutoff = (options.now ?? Date.now()) - 3 * 24 * 60 * 60 * 1_000
  let names: string[]
  try { names = await readdir(options.directory) }
  catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return
    throw error
  }
  for (const name of names) {
    const match = /^([A-Za-z0-9_-]+)-[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}\.sh(?:\.tmp)?$/.exec(name)
    const sessionId = match?.[1]
    if (!sessionId || options.isReferenced(sessionId)) continue
    const updatedAt = options.sessionActivity.get(sessionId)
    if (updatedAt !== undefined && updatedAt >= cutoff) continue
    const path = join(options.directory, name)
    try {
      const metadata = await lstat(path)
      // await 期间可能开始预热，删除前再次检查引用，不能按旧的活跃快照判断。
      if (metadata.isFile() && !options.isReferenced(sessionId)) await unlink(path)
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error
    }
  }
}

function quoteShell(value: string): string {
  return `'${value.replaceAll("'", "'\\''")}'`
}

/**
 * 仅在快照就绪、cwd 和登录参数匹配时准备进程 argv；调用方仍保留原始输入做审批与归因。
 * 覆盖值从进程环境暂存，不能把密钥嵌进包装 argv；普通导出声明不做二次过滤。
 */
export function prepareAgentShellSnapshotCommand(
  input: AgentShellSnapshotCommandInput,
  snapshot?: AgentShellSnapshot,
): AgentPreparedShellCommand {
  if (!snapshot || input.cwd !== snapshot.cwd || input.argv[0] !== snapshot.shell.path
    || input.argv[1] !== '-lc' || input.argv.length < 3 || !existsSync(snapshot.path)) {
    return { argv: input.argv, environment: {} }
  }
  const keys = [...new Set([
    ...Object.keys(input.environmentOverrides ?? {}), 'TMPDIR', 'TMP', 'TEMP',
  ])].filter((key) => /^[A-Za-z_][A-Za-z0-9_]*$/.test(key)).sort()
  const prefix = `__AXON_SNAPSHOT_${randomUUID().replaceAll('-', '')}`
  const captures: string[] = []
  const restores: string[] = []
  keys.forEach((key, index) => {
    const saved = `${prefix}_${index}`
    const present = `${saved}_SET`
    captures.push(`${present}="\${${key}+x}"\n${saved}="\${${key}-}"`)
    restores.push(`if [ -n "$${present}" ]; then
export ${key}="$${saved}"
else
unset ${key}
fi
unset ${present} ${saved}`)
  })
  const environment: Record<string, string> = {}
  // PATH 的普通继承值不能压过快照；只有额外程序目录或显式 PATH 覆盖才重放。
  if (input.pathPrepend?.length && !Object.hasOwn(input.environmentOverrides ?? {}, 'PATH')) {
    const pathKey = `${prefix}_PATH`
    environment[pathKey] = input.pathPrepend.join(':')
    captures.push(`${prefix}_PATH_SAVED="$${pathKey}"\nunset ${pathKey}`)
    restores.push(`export PATH="$${prefix}_PATH_SAVED\${PATH:+:$PATH}"\nunset ${prefix}_PATH_SAVED`)
  }
  const original = input.argv.slice(3).map((value) => ` ${quoteShell(value)}`).join('')
  return {
    // 启动配置可能打开 xtrace，内部暂存/恢复也必须静音，不能暴露覆盖值。
    argv: [snapshot.shell.path, '-c', `{
${captures.join('\n')}
} >/dev/null 2>&1
{
if [ -r ${quoteShell(snapshot.path)} ]; then
if . ${quoteShell(snapshot.path)} >/dev/null 2>&1; then :; fi
fi
${restores.join('\n')}
} >/dev/null 2>&1
exec ${quoteShell(input.argv[0]!)} -c ${quoteShell(input.argv[2]!)}${original}`],
    environment,
  }
}

// 只展开 ENV 的路径形式，不使用 eval；不支持的 Shell 表达式保留字面值。
const POSIX_ENV_PATH_EXPANSION = `
function expand(path, body, key, suffix, splitAt, fallback, hasFallback, firstPath) {
  if (substr(path,1,2)=="~/") return ENVIRON["HOME"] substr(path,2)
  if (index(path,"\${PATH%%:*}")==1 && (length(path)==11 || substr(path,12,1)=="/")) {
    firstPath=ENVIRON["PATH"]; sub(/:.*/,"",firstPath); return firstPath substr(path,12)
  }
  if (substr(path,1,2)=="\${") {
    splitAt=index(path,"}"); if (!splitAt) return path
    body=substr(path,3,splitAt-3); suffix=substr(path,splitAt+1)
    if (suffix!="" && substr(suffix,1,1)!="/") return path
    splitAt=index(body,":-")
    if (splitAt) { key=substr(body,1,splitAt-1); fallback=substr(body,splitAt+2); hasFallback=1 }
    else key=body
  } else if (substr(path,1,1)=="$") {
    splitAt=index(path,"/")
    if (splitAt) { key=substr(path,2,splitAt-2); suffix=substr(path,splitAt) }
    else key=substr(path,2)
  } else return path
  if (key !~ /^[A-Za-z_][A-Za-z0-9_]*$/) return path
  if (key in ENVIRON && (ENVIRON[key]!="" || !hasFallback)) return ENVIRON[key] suffix
  if (hasFallback) return expand(fallback) suffix
  return path
}
{ printf "%s", expand($0) }
`

/** 捕获固定的本机初始化脚本，用 NUL 边界隔离启动噪声与多行声明。 */
function captureScript(shell: AgentShell, marker: string): string {
  const startup = shell.type === 'zsh'
    ? 'if [ -n "${ZDOTDIR-}" ]; then __axon_rc="$ZDOTDIR/.zshrc"; else __axon_rc="${HOME-}/.zshrc"; fi\n[ -r "$__axon_rc" ] && . "$__axon_rc"\nunset __axon_rc'
    : shell.type === 'bash'
      ? 'if [ -z "${BASH_ENV-}" ] && [ -n "${HOME-}" ] && [ -r "$HOME/.bashrc" ]; then . "$HOME/.bashrc"; fi'
      // ENV 支持用户环境变量展开；展开结果仅用作初始化文件名，不执行其命令替换。
      : `if [ -n "\${ENV-}" ]; then
__axon_rc=$(printf '%s' "$ENV" | /usr/bin/awk ${quoteShell(POSIX_ENV_PATH_EXPANSION)})
if [ -r "$__axon_rc" ] && [ ! -d "$__axon_rc" ]; then case "$__axon_rc" in /*) . "$__axon_rc" ;; *) . "./$__axon_rc" ;; esac; fi
unset __axon_rc
fi`
  const state = shell.type === 'zsh'
    ? `builtin functions
builtin setopt | while IFS= read -r __axon_opt; do printf 'setopt %s\n' "$__axon_opt"; done`
    : `${shell.type === 'bash' ? 'builtin shopt -p || true\nbuiltin declare -f' : 'if [ -n "${BASH_VERSION-}" ]; then shopt -p || true; fi\nif command -v typeset >/dev/null 2>&1; then typeset -f; elif command -v declare >/dev/null 2>&1; then declare -f; fi'}
set -o | while read -r __axon_opt __axon_enabled; do [ "$__axon_enabled" != on ] || printf 'set -o %s\n' "$__axon_opt"; done`
  const aliases = shell.type === 'zsh' ? 'builtin alias -L' : shell.type === 'bash' ? 'builtin alias -p' : 'alias'
  const exports = shell.type === 'zsh'
    ? `(
unsetopt rcquotes
for __axon_name in \${(f)"$(builtin typeset +x)"}; do
case "$__axon_name" in ''|[0-9]*|*[!A-Za-z0-9_]*|PWD|OLDPWD|__axon_*) continue ;; esac
case "\${(tP)__axon_name}" in *readonly*) continue ;; *export*) ;; *) continue ;; esac
builtin typeset -xp "$__axon_name"
done
)`
    : shell.type === 'bash'
      ? `while IFS= read -r __axon_name; do
case "$__axon_name" in ''|[0-9]*|*[!A-Za-z0-9_]*|PWD|OLDPWD|__axon_*) continue ;; esac
builtin declare -xp "$__axon_name"
done < <(builtin compgen -e)`
      : '(unset PWD OLDPWD; export -p)'
  return `${startup}
printf '\\0%s\\0' ${quoteShell(marker)}
printf '%s\\n' '# Axon Shell 会话快照' 'unalias -a 2>/dev/null || true'
${state}
printf '\\0'
${aliases}
printf '\\0'
${exports}
printf '\\0%s\\0' ${quoteShell(marker)}
`
}

/** 只接受完整的 UTF-8 捕获段，不能把截断或启动配置输出误当作可加载脚本。 */
function decodeCapture(output: Buffer, marker: string): string {
  const separator = Buffer.from(`\0${marker}\0`)
  const start = output.indexOf(separator)
  if (start < 0) throw new Error('invalidCapture')
  const end = output.indexOf(separator, start + separator.length)
  if (end < 0) throw new Error('invalidCapture')
  const body = new TextDecoder('utf-8', { fatal: true }).decode(output.subarray(start + separator.length, end))
  const sections = body.split('\0')
  if (sections.length !== 3 || !sections[0]?.startsWith('# Axon Shell 会话快照\n')) throw new Error('invalidCapture')
  return `${sections[0]}\n${sections[1]}\n# 原生导出声明\n${sections[2]}\n`
}

/** 限制初始化进程的耗时和输出，终止整组后代；异常输出可能含凭据，不返回给日志。 */
function runInitialization(
  shell: AgentShell,
  flag: '-lc' | '-c',
  script: string,
  options: AgentShellSnapshotOptions,
  signal: AbortSignal,
): Promise<Buffer> {
  return new Promise((resolve, reject) => {
    if (signal.aborted) { reject(new Error('cancelled')); return }
    const child = spawn(shell.path, [flag, script], {
      cwd: options.cwd, env: options.environment ?? process.env,
      detached: true, stdio: ['ignore', 'pipe', 'pipe'],
    })
    const chunks: Buffer[] = []
    let bytes = 0
    let failed = false
    let killTimer: ReturnType<typeof setTimeout> | undefined
    const kill = (kind: NodeJS.Signals): void => {
      if (!child.pid) return
      try { process.kill(-child.pid, kind) } catch { /* 进程组可能已退出。 */ }
    }
    const stop = (): void => {
      if (failed) return
      failed = true
      kill('SIGTERM')
      killTimer = setTimeout(() => kill('SIGKILL'), 500)
    }
    const timer = setTimeout(stop, options.timeoutMs ?? DEFAULT_TIMEOUT_MS)
    signal.addEventListener('abort', stop, { once: true })
    child.stdout.on('data', (chunk: Buffer) => {
      bytes += chunk.length
      if (bytes > (options.maxOutputBytes ?? DEFAULT_MAX_OUTPUT_BYTES)) stop()
      if (!failed) chunks.push(chunk)
    })
    // stderr 只计数并排空，避免阻塞与未经脱敏的启动信息泄漏。
    child.stderr.on('data', (chunk: Buffer) => {
      bytes += chunk.length
      if (bytes > (options.maxOutputBytes ?? DEFAULT_MAX_OUTPUT_BYTES)) stop()
    })
    const cleanup = (): void => {
      clearTimeout(timer)
      if (killTimer) clearTimeout(killTimer)
      signal.removeEventListener('abort', stop)
      kill('SIGKILL')
    }
    // error 只标失败并请求终止；仍等 close 才释放等待，避免提前进入发布/清理阶段。
    child.once('error', stop)
    child.once('close', (code) => {
      cleanup()
      if (failed || code !== 0) reject(new Error('initializationFailed'))
      else resolve(Buffer.concat(chunks))
    })
  })
}

/** 精确清理自有缓存；清理失败不能变成未处理的异步异常或阻止应用退出。 */
function removeSnapshotFile(path: string): void {
  try { rmSync(path, { force: true }) }
  catch { console.warn('[agent-shell] 快照文件清理失败，留待缓存清理处理') }
}

/**
 * 上游初始化即启动预热，ready 只返回可用快照或 undefined，不阻塞会话。
 * 引用释放会取消在途初始化并删除自己发布的文件；工具是否消费快照由宿主另行决定。
 */
export class AgentShellSnapshotEnvironment {
  readonly ready: Promise<AgentShellSnapshot | undefined>
  snapshot?: AgentShellSnapshot
  private readonly controller = new AbortController()
  private disposed = false

  constructor(readonly options: AgentShellSnapshotOptions) {
    this.ready = this.capture()
  }

  /** 先捕获、再私有临时写入与加载验证，最后原子发布；任何失败只降级快照。 */
  private async capture(): Promise<AgentShellSnapshot | undefined> {
    let reason: AgentShellSnapshotFailure = 'captureFailed'
    let temporaryPath: string | undefined
    let publishedPath: string | undefined
    try {
      const shell = this.options.shell
      if (!shell) { reason = 'shellUnavailable'; throw new Error(reason) }
      if (!/^[A-Za-z0-9_-]+$/.test(this.options.sessionId)) throw new Error('invalidSessionId')
      const marker = randomUUID()
      const output = await runInitialization(shell, '-lc', captureScript(shell, marker), this.options, this.controller.signal)
      if (this.disposed) throw new Error('cancelled')
      reason = 'invalidCapture'
      const source = decodeCapture(output, marker)
      reason = 'publishFailed'
      await mkdir(this.options.directory, { recursive: true, mode: 0o700 })
      if (this.disposed) throw new Error('cancelled')
      await chmod(this.options.directory, 0o700)
      if (this.disposed) throw new Error('cancelled')
      publishedPath = join(this.options.directory, `${this.options.sessionId}-${marker}.sh`)
      temporaryPath = `${publishedPath}.tmp`
      await writeFile(temporaryPath, source, { mode: 0o600, flag: 'wx' })
      if (this.disposed) throw new Error('cancelled')
      reason = 'validationFailed'
      await runInitialization(shell, '-c', `set -e; . ${quoteShell(temporaryPath)}`, this.options, this.controller.signal)
      // 取消可能发生在任意 await 后；已释放引用不得晚到发布一个无人清理的文件。
      if (this.disposed) throw new Error('cancelled')
      reason = 'publishFailed'
      await rename(temporaryPath, publishedPath)
      if (this.disposed) throw new Error('cancelled')
      this.snapshot = { path: publishedPath, cwd: this.options.cwd, shell }
      return this.snapshot
    } catch {
      if (this.disposed) reason = 'cancelled'
      if (reason !== 'cancelled') this.options.onFailure?.(reason)
      return undefined
    } finally {
      if (temporaryPath) removeSnapshotFile(temporaryPath)
      if (publishedPath && !this.snapshot) removeSnapshotFile(publishedPath)
    }
  }

  /** 释放当前引用拥有的文件，不触碰其他会话或历史数据。 */
  dispose(): void {
    this.disposed = true
    this.controller.abort()
    if (this.snapshot) removeSnapshotFile(this.snapshot.path)
    this.snapshot = undefined
  }

  /** ready 包含原生进程 close、发布与 finally 清理；取消后仍须等待它真实完成。 */
  async drain(): Promise<void> { await this.ready }
}
