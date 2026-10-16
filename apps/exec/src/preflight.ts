import { execFile } from 'node:child_process'
import { lstatSync, realpathSync } from 'node:fs'
import { dirname, isAbsolute, join, parse, relative, resolve, sep } from 'node:path'
import { StringDecoder } from 'node:string_decoder'
import type { ExecArguments } from './arguments'
import { ExecInputError } from './arguments'
import { readExecJson, resolveExecConfiguration } from './config'
import type { ExecConfiguration } from './config'

export interface PreparedExec {
  args: ExecArguments
  configuration: ExecConfiguration
  originalCwd: string
  homeDir: string
  cwd: string
  dataDir: string
  outputLastMessage?: string
  outputSchema?: unknown
  prompt: string
}

const MAX_PROMPT_CHARS = 100_000

/** stdin 有界流读取，保留 UTF-8 和原始换行；不提前结束并丢弃余下输入。 */
export async function readExecStdin(input: AsyncIterable<string | Uint8Array>): Promise<string> {
  const decoder = new StringDecoder('utf8')
  let content = ''
  for await (const chunk of input) {
    content += typeof chunk === 'string' ? chunk : decoder.write(Buffer.from(chunk))
    if (content.length > MAX_PROMPT_CHARS) throw new ExecInputError('stdin 超过 100000 字符限制')
  }
  content += decoder.end()
  if (content.length > MAX_PROMPT_CHARS) throw new ExecInputError('stdin 超过 100000 字符限制')
  return content
}

/** 位置任务与管道数据均属于用户输入，不提升为系统指令，不修剪原始文本。 */
export function resolveExecPrompt(prompt: string | undefined, stdin: string | undefined, isTTY: boolean): string {
  let combined: string
  if (prompt === '-' || prompt === undefined) {
    if (isTTY) throw new ExecInputError('缺少任务；请提供 PROMPT 或通过管道/stdin 输入')
    combined = stdin ?? ''
  } else combined = stdin === undefined || stdin.length === 0 ? prompt : `${prompt}\n\n[附加用户输入]\n${stdin}`
  if (!combined.trim() || combined.includes('\0') || combined.length > MAX_PROMPT_CHARS) {
    throw new ExecInputError('任务不能为空、含空字符或超过 100000 字符')
  }
  return combined
}

function realDirectory(path: string, label: string): string {
  try {
    const real = realpathSync(path)
    if (!lstatSync(real).isDirectory()) throw new Error()
    return real
  } catch { throw new ExecInputError(`${label}必须是已存在且可访问的目录`) }
}

/** 不创建业务目录；对尚不存在的尾段也解析其现有祖先，避免符号链接绕过目录隔离。 */
function futureDirectory(path: string): string {
  let current = path
  const missing: string[] = []
  while (true) {
    try {
      const stat = lstatSync(current)
      if (!stat.isDirectory() && !stat.isSymbolicLink()) throw new ExecInputError('数据目录的祖先不是目录')
      return join(realDirectory(current, '数据目录祖先'), ...missing)
    } catch (error) {
      if (error instanceof ExecInputError) throw error
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw new ExecInputError('数据目录无法访问')
      const parent = dirname(current)
      if (parent === current) throw new ExecInputError('数据目录无法解析')
      missing.unshift(current.slice(parent.length).replace(/^[/\\]/, ''))
      current = parent
    }
  }
}

function contains(parent: string, child: string): boolean {
  const path = relative(parent, child)
  return path === '' || path !== '..' && !path.startsWith(`..${sep}`) && !isAbsolute(path)
}

/** 只读 Git 仓库存在性检查；清除继承的仓库定位变量，始终检查指定真实工作区。 */
async function checkGitRepository(cwd: string, signal?: AbortSignal): Promise<void> {
  const env = { ...process.env }
  for (const key of Object.keys(env)) if (key.startsWith('GIT_') || key === 'AXON_API_KEY') delete env[key]
  await new Promise<void>((resolvePromise, reject) => {
    execFile('git', ['-C', cwd, 'rev-parse', '--show-toplevel'], { cwd, env, signal, timeout: 5_000, maxBuffer: 64 * 1024 }, (error, stdout) => {
      if (error || !stdout.trim()) reject(new ExecInputError('工作区不是可识别的 Git 仓库；非 Git 任务可显式使用 --skip-git-repo-check'))
      else resolvePromise()
    })
  })
}

/** 恢复可选原项目目录，仍复用数据隔离与 Git 预检；不能因 --all 把模型带进业务目录。 */
export async function validateExecWorkspace(prepared: Pick<PreparedExec, 'dataDir' | 'homeDir' | 'args'>,
  path: string, signal?: AbortSignal): Promise<string> {
  signal?.throwIfAborted()
  const cwd = realDirectory(path, '工作区')
  if (contains(prepared.dataDir, cwd) || contains(cwd, prepared.dataDir)) throw new ExecInputError('恢复工作区不能与 CLI 数据目录重叠')
  if (!prepared.args.flags.skipGitRepoCheck) await checkGitRepository(cwd, signal)
  signal?.throwIfAborted()
  return cwd
}

/** 配置、真实路径、任务和平台的纯预检；不创建业务记录，不联网、不初始化 Shell 快照。 */
export async function prepareExec(
  args: ExecArguments,
  context: { originalCwd: string; homeDir: string; platform: NodeJS.Platform; stdin?: string; isTTY: boolean;
    /** 可信入口在读 stdin 前解析期限；复用同一配置，避免执行中重复读取变更的文件。 */
    configuration?: ExecConfiguration; signal?: AbortSignal },
): Promise<PreparedExec> {
  context.signal?.throwIfAborted()
  const originalCwd = realDirectory(context.originalCwd, '调用目录')
  const homeDir = realDirectory(context.homeDir, '用户目录')
  const configuration = context.configuration ?? resolveExecConfiguration(args, originalCwd, homeDir)
  if (context.platform !== 'darwin' || configuration.settings.runtime !== 'pi') {
    throw new ExecInputError('非交互执行首版仅支持 macOS/Pi，不回退为无沙箱执行')
  }
  if (args.flags.cd !== undefined && !args.flags.cd.trim()) throw new ExecInputError('--cd 不能为空')
  const cwd = realDirectory(resolve(originalCwd, args.flags.cd ?? '.'), '工作区')
  if (args.flags.dataDir !== undefined && !args.flags.dataDir.trim()) throw new ExecInputError('--data-dir 不能为空')
  const dataDir = futureDirectory(resolve(originalCwd, args.flags.dataDir ?? join(homeDir, '.axon-exec')))
  for (const protectedPath of [join(homeDir, '.axon'), join(homeDir, '.axon-dev')]) {
    const canonical = futureDirectory(protectedPath)
    if (contains(canonical, dataDir) || contains(dataDir, canonical)) throw new ExecInputError('CLI 数据目录不能与桌面数据目录重叠')
  }
  if (dataDir === parse(dataDir).root || contains(dataDir, cwd) || contains(dataDir, homeDir)) {
    throw new ExecInputError('CLI 数据目录不能使用文件系统根、用户目录或工作区的祖先')
  }
  // 持久化目录和锁不能成为模型可写的项目内容，即使本次选择只读也不放宽。
  if (contains(cwd, dataDir)) throw new ExecInputError('CLI 数据目录不能位于工作区内')
  // 恢复的真正执行目录来自原项目，选定后再检查 Git；调用目录仍做路径隔离和文件参数解析。
  if (args.kind === 'exec' && !args.flags.skipGitRepoCheck) await checkGitRepository(cwd, context.signal)
  context.signal?.throwIfAborted()
  const prompt = resolveExecPrompt(args.prompt, context.stdin, context.isTTY)
  for (const path of [args.flags.outputLastMessage, args.flags.outputSchema]) {
    if (path !== undefined && (!path.trim() || path.includes('\0'))) throw new ExecInputError('输出文件参数不能为空或含空字符')
  }
  const outputLastMessage = args.flags.outputLastMessage === undefined ? undefined : resolve(cwd, args.flags.outputLastMessage)
  const outputSchema = args.flags.outputSchema === undefined ? undefined : readExecJson(resolve(cwd, args.flags.outputSchema))
  if (outputSchema !== undefined && typeof outputSchema !== 'boolean'
    && (!outputSchema || typeof outputSchema !== 'object' || Array.isArray(outputSchema))) {
    throw new ExecInputError('输出 Schema 必须是 JSON 对象或 boolean')
  }
  // 命令入口须在创建业务前编译 schema/校验输出目标；本地校验不等于模型协议强制格式。
  return { args, configuration, originalCwd, homeDir, cwd, dataDir, outputLastMessage, outputSchema, prompt }
}

/** 凭据仅来自渠道配置；清除残留的同名环境变量，不消费或传给后端/Shell/MCP。 */
export function createExecChildEnvironment(environment: NodeJS.ProcessEnv): NodeJS.ProcessEnv {
  delete environment.AXON_API_KEY
  return { ...environment }
}

/** 已知渠道要求凭据时即时失败；resume 的原渠道需后端解析后再次检查。 */
export function checkExecCredential(configuration: ExecConfiguration): void {
  if (configuration.channel?.apiKeyRequired && !configuration.channel.apiKey) {
    throw new ExecInputError('所选渠道需要在 CLI 配置的 channel.apiKey 中填写密钥；不会读取环境变量或桌面密钥')
  }
}
