/** 主进程唯一的本地工具边界：命令经 Seatbelt，文件操作经同一真实路径策略。 */

import { spawn } from 'node:child_process'
import { constants, existsSync, mkdtempSync, realpathSync, rmSync, statSync } from 'node:fs'
import {
  access as accessFile,
  mkdir,
  open,
  readFile,
  readdir,
  stat,
  writeFile,
} from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { basename, dirname, isAbsolute, join, relative, resolve } from 'node:path'
import { StringDecoder } from 'node:string_decoder'
import { AgentSandboxEscalationError } from '@axon/shared'
import type {
  AgentSandboxCommandRequest,
  AgentSandboxCommandResult,
  AgentSandboxCommandOutputHandlers,
  AgentSandboxFileContext,
  AgentSandboxGlobOptions,
  AgentSandboxPathStat,
  AgentSandboxTextSearchOptions,
  AgentSandboxTextSearchResult,
  AgentSandboxGrant,
  AgentSandboxPolicy,
} from '@axon/shared'
import {
  compileSeatbeltProfile,
  detectSeatbeltCapability,
  type SeatbeltCapability,
} from './agent-seatbelt-profile'
import { hasAgentCommandNetworkIntent } from './agent-command-rules'

const DEFAULT_TIMEOUT_MS = 120_000
const MAX_TIMEOUT_MS = 3_600_000
const DEFAULT_MAX_OUTPUT_BYTES = 1_048_576
const DEFAULT_KILL_GRACE_MS = 500
const MAX_GLOB_PATTERN_LENGTH = 4_096
const MAX_GLOB_RESULTS = 10_000
const MAX_SEARCH_RESULTS = 1_000

export type AgentSandboxExecutionErrorCode =
  | 'sandboxUnavailable'
  | 'invalidRequest'
  | 'spawnFailed'

export class AgentSandboxExecutionError extends Error {
  constructor(readonly code: AgentSandboxExecutionErrorCode, message: string) {
    super(message)
    this.name = 'AgentSandboxExecutionError'
  }
}

export interface AgentSandboxCommandServiceOptions {
  capability?: SeatbeltCapability
  maxOutputBytes?: number
  killGraceMs?: number
  createTempDirectory?: () => string
}

interface CapturedOutput {
  chunks: Buffer[]
  bytes: number
  truncated: boolean
}

/** 将不存在的目标锚定到最近的真实父目录，防止授权路径通过符号链接逃逸。 */
function canonicalPotentialPath(path: string): string {
  if (!path || !isAbsolute(path) || path.includes('\0')) {
    throw new AgentSandboxExecutionError('invalidRequest', '沙箱路径必须是有效绝对路径')
  }
  let existing = resolve(path)
  const suffix: string[] = []
  while (!existsSync(existing)) {
    const parent = dirname(existing)
    if (parent === existing) throw new AgentSandboxExecutionError('invalidRequest', '沙箱路径无法解析')
    suffix.unshift(basename(existing))
    existing = parent
  }
  return resolve(realpathSync(existing), ...suffix)
}

function canonicalPolicy(policy: AgentSandboxPolicy): AgentSandboxPolicy {
  return {
    ...policy,
    workingDirectory: canonicalPotentialPath(policy.workingDirectory),
    writableRoots: policy.writableRoots.map(canonicalPotentialPath),
    protectedReadOnlyRoots: policy.protectedReadOnlyRoots.map(canonicalPotentialPath),
  }
}

function isWithinRoot(root: string, candidate: string): boolean {
  const child = relative(root, candidate)
  return child === '' || (!child.startsWith('..') && !isAbsolute(child))
}

function throwIfAborted(signal?: AbortSignal): void {
  if (signal?.aborted) throw new AgentSandboxExecutionError('invalidRequest', '文件操作已取消')
}

function boundedLimit(value: number, maximum: number): number {
  return Number.isFinite(value) ? Math.max(1, Math.min(Math.trunc(value), maximum)) : 1
}

function escapeRegExp(value: string): string {
  return value.replace(/[|\\{}()[\]^$+?.]/g, '\\$&')
}

/** 支持 coding 工具常用的 *, ** 与 ?，路径统一按 POSIX 分隔符匹配。 */
function globRegExp(pattern: string): RegExp {
  if (pattern.length > MAX_GLOB_PATTERN_LENGTH || pattern.includes('\0')) {
    throw new AgentSandboxExecutionError('invalidRequest', 'Glob 模式无效或过长')
  }
  let source = ''
  for (let index = 0; index < pattern.length; index += 1) {
    const char = pattern[index]
    if (char === '*') {
      if (pattern[index + 1] === '*') {
        index += 1
        if (pattern[index + 1] === '/') {
          index += 1
          source += '(?:.*/)?'
        } else source += '.*'
      } else source += '[^/]*'
    } else if (char === '?') source += '[^/]'
    else source += escapeRegExp(char ?? '')
  }
  return new RegExp(`^${source}$`)
}

function posixRelative(root: string, path: string): string {
  return relative(root, path).split('\\').join('/')
}

function collectGrantOverrides(grants: AgentSandboxGrant[]): {
  writableRoots: string[]
  networkAccess: boolean
} {
  const writableRoots: string[] = []
  let networkAccess = false
  for (const grant of grants) {
    if (grant.permission.type === 'network') networkAccess = true
    else writableRoots.push(...grant.permission.roots.map(canonicalPotentialPath))
  }
  return { writableRoots: [...new Set(writableRoots)], networkAccess }
}

function appendCaptured(output: CapturedOutput, chunk: Buffer, limit: number): void {
  const remaining = limit - output.bytes
  if (remaining <= 0) {
    output.truncated = true
    return
  }
  const kept = chunk.subarray(0, remaining)
  output.chunks.push(kept)
  output.bytes += kept.byteLength
  if (kept.byteLength < chunk.byteLength) output.truncated = true
}

function terminateProcessGroup(pid: number | undefined, signal: NodeJS.Signals): void {
  if (!pid) return
  try { process.kill(-pid, signal) }
  catch { /* 进程组已经退出时无需再处理。 */ }
}

function shellCommand(argv: string[]): string | undefined {
  const executable = basename(argv[0] ?? '')
  return ['sh', 'bash', 'zsh'].includes(executable) && argv[1] === '-lc' && typeof argv[2] === 'string'
    ? argv[2]
    : undefined
}

/** 从常见命令错误行提取被 Seatbelt 拒绝的绝对路径，不接受模糊相对路径。 */
function operationNotPermittedPaths(output: string): string[] {
  const results: string[] = []
  for (const line of output.split(/\r?\n/)) {
    if (!/operation not permitted/i.test(line)) continue
    const prefix = line.slice(0, line.search(/:\s*operation not permitted/i)).trim()
    const match = prefix.match(/(?:^|:\s+|[`'"])(\/.*?)[`'"]?$/)
    const path = match?.[1]?.trim()
    if (path && isAbsolute(path)) results.push(path)
  }
  return [...new Set(results)]
}

/**
 * 承接 runtime 的本地工具操作。
 * 上游提供基础策略和已批准授权；本层统一规范化路径，命令再应用 Seatbelt 并管理整棵进程树。
 */
export class AgentSandboxCommandService {
  private readonly capability: SeatbeltCapability
  private readonly maxOutputBytes: number
  private readonly killGraceMs: number
  private readonly createTempDirectory: () => string

  constructor(options: AgentSandboxCommandServiceOptions = {}) {
    this.capability = options.capability ?? detectSeatbeltCapability()
    this.maxOutputBytes = options.maxOutputBytes ?? DEFAULT_MAX_OUTPUT_BYTES
    this.killGraceMs = options.killGraceMs ?? DEFAULT_KILL_GRACE_MS
    this.createTempDirectory = options.createTempDirectory
      ?? (() => mkdtempSync(join(tmpdir(), 'axon-agent-tool-')))
  }

  getCapability(): SeatbeltCapability {
    return this.capability
  }

  /** 全盘读取遵循基础策略；写入必须命中可写根且不能越过保护目录，除非有精确额外授权。 */
  private resolveFilePath(
    path: string,
    access: 'read' | 'write',
    context: AgentSandboxFileContext,
  ): string {
    throwIfAborted(context.abortSignal)
    const candidate = canonicalPotentialPath(path)
    if (access === 'read') return candidate

    const policy = canonicalPolicy(context.policy)
    const grants = collectGrantOverrides(context.grants).writableRoots
    if (grants.some((root) => isWithinRoot(root, candidate))) return candidate
    if (!policy.writableRoots.some((root) => isWithinRoot(root, candidate))) {
      throw new AgentSandboxEscalationError({
        reason: 'filesystemWriteOutsideWorkspace',
        permission: { type: 'filesystemWrite', roots: [candidate] },
        target: candidate,
        message: '文件写入目标越过沙箱可写根',
      })
    }
    if (policy.protectedReadOnlyRoots.some((root) => isWithinRoot(root, candidate))) {
      throw new AgentSandboxEscalationError({
        reason: 'protectedPathWrite',
        permission: { type: 'filesystemWrite', roots: [candidate] },
        target: candidate,
        message: '文件写入目标位于受保护目录',
      })
    }
    return candidate
  }

  async readFile(path: string, context: AgentSandboxFileContext): Promise<Buffer> {
    return readFile(this.resolveFilePath(path, 'read', context))
  }

  async assertFileAccess(
    path: string,
    requestedAccess: 'read' | 'write',
    context: AgentSandboxFileContext,
  ): Promise<void> {
    const candidate = this.resolveFilePath(path, requestedAccess, context)
    await accessFile(candidate, requestedAccess === 'read' ? constants.R_OK : constants.R_OK | constants.W_OK)
  }

  async writeFile(path: string, content: string, context: AgentSandboxFileContext): Promise<void> {
    await writeFile(this.resolveFilePath(path, 'write', context), content, 'utf8')
  }

  async createDirectory(path: string, context: AgentSandboxFileContext): Promise<void> {
    const candidate = this.resolveFilePath(path, 'read', context)
    // recursive mkdir 对已存在目录没有副作用，不应把父目录误申请成宽泛写授权。
    if (existsSync(candidate) && (await stat(candidate)).isDirectory()) return
    await mkdir(this.resolveFilePath(candidate, 'write', context), { recursive: true })
  }

  async pathExists(path: string, context: AgentSandboxFileContext): Promise<boolean> {
    try {
      await accessFile(this.resolveFilePath(path, 'read', context), constants.F_OK)
      return true
    } catch (error) {
      if (error instanceof AgentSandboxExecutionError) throw error
      return false
    }
  }

  async statPath(path: string, context: AgentSandboxFileContext): Promise<AgentSandboxPathStat> {
    const result = await stat(this.resolveFilePath(path, 'read', context))
    return { isDirectory: result.isDirectory(), size: result.size }
  }

  async readDirectory(path: string, context: AgentSandboxFileContext): Promise<string[]> {
    return (await readdir(this.resolveFilePath(path, 'read', context))).sort((a, b) => a.localeCompare(b))
  }

  /** 在已校验的读取根内遍历，不跟随目录符号链接，并以调用方上限返回绝对路径。 */
  async glob(
    pattern: string,
    cwd: string,
    options: AgentSandboxGlobOptions,
    context: AgentSandboxFileContext,
  ): Promise<string[]> {
    const root = this.resolveFilePath(cwd, 'read', context)
    if (!(await stat(root)).isDirectory()) throw new AgentSandboxExecutionError('invalidRequest', 'Glob 根不是目录')
    const matcher = globRegExp(pattern)
    const ignores = options.ignore.map(globRegExp)
    const limit = boundedLimit(options.limit, MAX_GLOB_RESULTS)
    const results: string[] = []

    const visit = async (directory: string): Promise<void> => {
      throwIfAborted(context.abortSignal)
      const entries = await readdir(directory, { withFileTypes: true })
      entries.sort((a, b) => a.name.localeCompare(b.name))
      for (const entry of entries) {
        if (results.length >= limit) return
        const absolute = join(directory, entry.name)
        const relativePath = posixRelative(root, absolute)
        const directoryPath = entry.isDirectory() ? `${relativePath}/` : relativePath
        if (ignores.some((ignore) => ignore.test(directoryPath) || ignore.test(relativePath))) continue
        if (matcher.test(relativePath) || matcher.test(directoryPath)) results.push(absolute)
        // 不跟随目录符号链接，避免循环与搜索根外的意外遍历。
        if (entry.isDirectory()) await visit(absolute)
      }
    }
    await visit(root)
    return results
  }

  /** 文本检索经 Seatbelt 内的系统 grep 执行，避免在 Electron 主进程解释模型提供的正则。 */
  async searchText(
    path: string,
    options: AgentSandboxTextSearchOptions,
    context: AgentSandboxFileContext,
  ): Promise<AgentSandboxTextSearchResult> {
    const root = this.resolveFilePath(path, 'read', context)
    const rootStat = await stat(root)
    const fileMatcher = options.glob ? globRegExp(options.glob) : undefined
    const contextLines = Math.max(0, Math.min(options.context ?? 0, 20))
    const limit = boundedLimit(options.limit, MAX_SEARCH_RESULTS)
    const argv = [
      '/usr/bin/grep',
      ...(rootStat.isDirectory() ? ['-R'] : []),
      '-n', '-H', '-I',
      ...(options.ignoreCase ? ['-i'] : []),
      options.literal ? '-F' : '-E',
      '--exclude-dir=.git', '--exclude-dir=node_modules',
      '--', options.pattern, root,
    ]
    const command = await this.executeCommand({
      argv,
      cwd: context.policy.workingDirectory,
      policy: context.policy,
      grants: context.grants,
      ...(context.abortSignal ? { abortSignal: context.abortSignal } : {}),
    })
    if (command.aborted) throw new AgentSandboxExecutionError('invalidRequest', 'Grep 已取消')
    if (command.timedOut) throw new AgentSandboxExecutionError('invalidRequest', 'Grep 执行超时')
    if (command.exitCode !== 0 && command.exitCode !== 1) {
      throw new AgentSandboxExecutionError('invalidRequest', command.stderr.trim() || 'Grep 执行失败')
    }

    const matches: AgentSandboxTextSearchResult['matches'] = []
    const fileLines = new Map<string, string[]>()
    for (const outputLine of command.stdout.split('\n')) {
      throwIfAborted(context.abortSignal)
      const parsed = /^(.*):(\d+):(.*)$/.exec(outputLine)
      if (!parsed?.[1] || !parsed[2]) continue
      const absolutePath = canonicalPotentialPath(parsed[1])
      const relativePath = rootStat.isDirectory() ? posixRelative(root, absolutePath) : basename(absolutePath)
      if (fileMatcher && !fileMatcher.test(relativePath)) continue
      const line = Number(parsed[2])
      let lines = fileLines.get(absolutePath)
      if (!lines) {
        lines = (await readFile(absolutePath, 'utf8')).replace(/\r\n/g, '\n').replace(/\r/g, '\n').split('\n')
        fileLines.set(absolutePath, lines)
      }
      matches.push({
        path: relativePath,
        line,
        text: parsed[3] ?? '',
        before: lines.slice(Math.max(0, line - contextLines - 1), line - 1),
        after: lines.slice(line, line + contextLines),
      })
      if (matches.length >= limit) return { matches, limitReached: true }
    }
    return { matches, limitReached: false }
  }

  async detectImageMimeType(path: string, context: AgentSandboxFileContext): Promise<string | undefined> {
    const candidate = this.resolveFilePath(path, 'read', context)
    const handle = await open(candidate, 'r')
    try {
      const signature = Buffer.alloc(12)
      const { bytesRead } = await handle.read(signature, 0, signature.length, 0)
      const bytes = signature.subarray(0, bytesRead)
      if (bytes.subarray(0, 8).equals(Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]))) return 'image/png'
      if (bytes[0] === 0xff && bytes[1] === 0xd8 && bytes[2] === 0xff) return 'image/jpeg'
      if (bytes.subarray(0, 6).toString('ascii') === 'GIF87a' || bytes.subarray(0, 6).toString('ascii') === 'GIF89a') return 'image/gif'
      if (bytes.subarray(0, 4).toString('ascii') === 'RIFF' && bytes.subarray(8, 12).toString('ascii') === 'WEBP') return 'image/webp'
      if (bytes.subarray(0, 2).toString('ascii') === 'BM') return 'image/bmp'
      return undefined
    } finally {
      await handle.close()
    }
  }

  async executeCommand(
    request: AgentSandboxCommandRequest,
    handlers: AgentSandboxCommandOutputHandlers = {},
  ): Promise<AgentSandboxCommandResult> {
    if (!this.capability.available) {
      throw new AgentSandboxExecutionError('sandboxUnavailable', '当前宿主无法应用 macOS Seatbelt 沙箱')
    }
    if (request.argv.length === 0 || !isAbsolute(request.argv[0] ?? '')
      || request.argv.some((value) => value.includes('\0'))) {
      throw new AgentSandboxExecutionError('invalidRequest', '沙箱命令必须使用非空绝对 argv')
    }
    const timeoutMs = request.timeoutMs ?? DEFAULT_TIMEOUT_MS
    if (!Number.isInteger(timeoutMs) || timeoutMs <= 0 || timeoutMs > MAX_TIMEOUT_MS) {
      throw new AgentSandboxExecutionError('invalidRequest', '沙箱命令超时时间无效')
    }
    if (request.abortSignal?.aborted) return this.emptyResult(false, true)

    let temporaryDirectory = ''
    try {
      const policy = canonicalPolicy(request.policy)
      const cwd = canonicalPotentialPath(request.cwd)
      if (!statSync(cwd).isDirectory()) {
        throw new AgentSandboxExecutionError('invalidRequest', '沙箱命令工作目录不是目录')
      }
      if (!isWithinRoot(policy.workingDirectory, cwd)) {
        throw new AgentSandboxExecutionError('invalidRequest', '沙箱命令工作目录越过项目根')
      }
      temporaryDirectory = realpathSync(this.createTempDirectory())
      const grants = collectGrantOverrides(request.grants)
      const profile = compileSeatbeltProfile(policy, {
        additionalWritableRoots: [temporaryDirectory, ...grants.writableRoots],
        networkAccess: grants.networkAccess,
      })
      const result = await this.spawnSandboxedCommand(request, cwd, temporaryDirectory, profile, handlers)
      const escalation = this.detectCommandEscalation(request, policy, result)
      if (escalation) throw escalation
      return result
    } catch (error) {
      if (error instanceof AgentSandboxExecutionError || error instanceof AgentSandboxEscalationError) throw error
      throw new AgentSandboxExecutionError('invalidRequest', '沙箱策略、路径或临时目录无效')
    } finally {
      if (temporaryDirectory) {
        try { rmSync(temporaryDirectory, { recursive: true, force: true }) }
        catch (error) { console.warn('[Agent 沙箱] 临时目录清理失败:', error) }
      }
    }
  }

  /** 只把可归因的 OS 拒绝提升为审批；普通非零退出码仍作为命令结果返回。 */
  private detectCommandEscalation(
    request: AgentSandboxCommandRequest,
    policy: AgentSandboxPolicy,
    result: AgentSandboxCommandResult,
  ): AgentSandboxEscalationError | undefined {
    if (result.exitCode === 0 || result.timedOut || result.aborted) return undefined
    const output = `${result.stderr}\n${result.stdout}`
    if (!/operation not permitted/i.test(output) || /sandbox-exec:\s+sandbox_apply/i.test(output)) return undefined

    const context: AgentSandboxFileContext = { policy, grants: request.grants }
    for (const path of operationNotPermittedPaths(output)) {
      try { this.resolveFilePath(path, 'write', context) }
      catch (error) {
        if (error instanceof AgentSandboxEscalationError) {
          return new AgentSandboxEscalationError({
            ...error.escalation,
            message: `${error.escalation.message}；命令可能已在沙箱内产生部分副作用`,
          })
        }
      }
    }

    const command = shellCommand(request.argv)
    const networkGranted = collectGrantOverrides(request.grants).networkAccess
    if (!policy.networkAccess && !networkGranted && command && hasAgentCommandNetworkIntent(command)) {
      return new AgentSandboxEscalationError({
        reason: 'networkAccess',
        permission: { type: 'network' },
        message: '命令的网络访问被基础沙箱拒绝；重试前请确认，命令可能已产生部分本地副作用',
      })
    }
    return undefined
  }

  /** 启动独立进程组；超时或 AbortSignal 都先 TERM，短暂宽限后再 KILL。 */
  private spawnSandboxedCommand(
    request: AgentSandboxCommandRequest,
    cwd: string,
    temporaryDirectory: string,
    profile: string,
    handlers: AgentSandboxCommandOutputHandlers,
  ): Promise<AgentSandboxCommandResult> {
    return new Promise((resolveResult, reject) => {
      const stdout: CapturedOutput = { chunks: [], bytes: 0, truncated: false }
      const stderr: CapturedOutput = { chunks: [], bytes: 0, truncated: false }
      const stdoutDecoder = new StringDecoder('utf8')
      const stderrDecoder = new StringDecoder('utf8')
      let timedOut = false
      let aborted = false
      let settled = false
      let stopRequested = false
      let killTimer: ReturnType<typeof setTimeout> | undefined

      const child = spawn(this.capability.available ? this.capability.executablePath : '', [
        '-p', profile, request.argv[0]!, ...request.argv.slice(1),
      ], {
        cwd,
        detached: true,
        env: {
          ...process.env,
          ...request.environment,
          TMPDIR: temporaryDirectory,
          TMP: temporaryDirectory,
          TEMP: temporaryDirectory,
        },
        stdio: ['ignore', 'pipe', 'pipe'],
      })

      const forceKill = (): void => terminateProcessGroup(child.pid, 'SIGKILL')
      const requestStop = (): void => {
        if (stopRequested) return
        stopRequested = true
        terminateProcessGroup(child.pid, 'SIGTERM')
        killTimer = setTimeout(forceKill, this.killGraceMs)
        killTimer.unref()
      }
      const abortListener = (): void => {
        aborted = true
        clearTimeout(timeout)
        requestStop()
      }
      request.abortSignal?.addEventListener('abort', abortListener, { once: true })
      const timeout = setTimeout(() => { timedOut = true; requestStop() }, request.timeoutMs ?? DEFAULT_TIMEOUT_MS)
      timeout.unref()
      if (request.abortSignal?.aborted) abortListener()

      child.stdout.on('data', (chunk: Buffer) => {
        appendCaptured(stdout, chunk, this.maxOutputBytes)
        const text = stdoutDecoder.write(chunk)
        try { if (text) handlers.onStdout?.(text) } catch { /* 渲染回调不能打断工具进程。 */ }
      })
      child.stderr.on('data', (chunk: Buffer) => {
        appendCaptured(stderr, chunk, this.maxOutputBytes)
        const text = stderrDecoder.write(chunk)
        try { if (text) handlers.onStderr?.(text) } catch { /* 渲染回调不能打断工具进程。 */ }
      })
      child.once('error', (error) => {
        if (settled) return
        settled = true
        clearTimeout(timeout)
        if (killTimer) clearTimeout(killTimer)
        request.abortSignal?.removeEventListener('abort', abortListener)
        reject(new AgentSandboxExecutionError('spawnFailed', error.message))
      })
      child.once('close', (exitCode, signal) => {
        if (settled) return
        settled = true
        clearTimeout(timeout)
        if (killTimer) clearTimeout(killTimer)
        request.abortSignal?.removeEventListener('abort', abortListener)
        // 若命令把后代转入后台，主进程退出后仍要收束原进程组。
        terminateProcessGroup(child.pid, 'SIGTERM')
        try {
          const stdoutTail = stdoutDecoder.end()
          const stderrTail = stderrDecoder.end()
          if (stdoutTail) handlers.onStdout?.(stdoutTail)
          if (stderrTail) handlers.onStderr?.(stderrTail)
        } catch { /* 渲染回调不能改变命令终态。 */ }
        resolveResult({
          exitCode,
          ...(signal ? { terminationSignal: signal } : {}),
          timedOut,
          aborted,
          stdout: Buffer.concat(stdout.chunks).toString('utf8'),
          stderr: Buffer.concat(stderr.chunks).toString('utf8'),
          stdoutTruncated: stdout.truncated,
          stderrTruncated: stderr.truncated,
        })
      })
    })
  }

  private emptyResult(timedOut: boolean, aborted: boolean): AgentSandboxCommandResult {
    return {
      exitCode: null,
      timedOut,
      aborted,
      stdout: '',
      stderr: '',
      stdoutTruncated: false,
      stderrTruncated: false,
    }
  }
}
