/** 受管文档命令只提供固定本地执行入口；文件解析仍发生在调用方 Bash 沙箱内。 */
import { accessSync, chmodSync, constants, lstatSync, mkdirSync, mkdtempSync, realpathSync, readdirSync, rmdirSync, unlinkSync, writeFileSync } from 'node:fs'
import { isAbsolute, join } from 'node:path'
import { tmpdir } from 'node:os'

export interface AgentDocumentCommandOptions {
  executable: string
  entry: string
  runtime: 'bun' | 'node' | 'electron'
  /** 宿主先取消并等待真实运行和子进程，再允许移除命令文件。 */
  waitUntilUnused: () => Promise<void>
}
function quote(value: string): string { return `'${value.replaceAll("'", "'\\''")}'` }

export class AgentDocumentCommandEnvironment {
  readonly commandDirectory: string
  readonly readOnlyRoots: string[]
  private readonly directory: string
  private readonly identity: { dev: number; ino: number }
  private disposed = false
  private draining?: Promise<void>

  /** 使用确切执行器/编译资源，不搜索 PATH，不让任务目录提供 dotenv、preload 或配置。 */
  constructor(private readonly options: AgentDocumentCommandOptions) {
    if (!isAbsolute(options.executable) || !isAbsolute(options.entry) || !options.entry.endsWith('.mjs')
      || options.entry.includes('\0') || options.executable.includes('\0')) throw new Error('文档执行器配置无效')
    const executable = realpathSync(options.executable), entry = realpathSync(options.entry)
    accessSync(executable, constants.X_OK)
    accessSync(entry, constants.R_OK)
    if (!lstatSync(entry).isFile() || !lstatSync(executable).isFile()) throw new Error('文档执行资源不可用')
    this.directory = mkdtempSync(join(realpathSync(tmpdir()), 'axon-doc-'))
    const info = lstatSync(this.directory); this.identity = { dev: info.dev, ino: info.ino }
    chmodSync(this.directory, 0o700)
    this.commandDirectory = join(this.directory, 'bin')
    this.readOnlyRoots = [this.directory, entry]
    try {
      mkdirSync(this.commandDirectory, { mode: 0o700 })
      const config = join(this.directory, 'bun-runtime.toml'), tsconfig = join(this.directory, 'tsconfig.json')
      writeFileSync(config, '# Axon 文档命令固定运行配置\n', { flag: 'wx', mode: 0o600 })
      writeFileSync(tsconfig, '{"compilerOptions":{}}\n', { flag: 'wx', mode: 0o600 })
      const args = options.runtime === 'bun'
        ? [executable, 'run', '--no-env-file', `--config=${config}`, `--tsconfig-override=${tsconfig}`, entry]
        : [executable, '--max-old-space-size=256', entry]
      const electron = options.runtime === 'electron' ? 'ELECTRON_RUN_AS_NODE=1 ' : ''
      const script = `#!/bin/sh\nexec /usr/bin/env -u NODE_OPTIONS -u NODE_PATH -u BUN_OPTIONS ${electron}${args.map(quote).join(' ')} "$@"\n`
      writeFileSync(join(this.commandDirectory, 'axon-doc'), script, { flag: 'wx', mode: 0o755 })
    } catch (error) {
      try { this.cleanup() } catch { console.warn('[文档命令] 初始化失败后的私有目录已保留') }
      throw error
    }
  }

  dispose(): void { this.disposed = true }

  /** 入口封口后等待所有实际使用者；不能随 dispose 就移除正在执行的命令资源。 */
  drain(): Promise<void> {
    if (!this.disposed) return Promise.reject(new Error('须先关闭文档命令入口'))
    return this.draining ??= this.options.waitUntilUnused().then(() => this.cleanup())
  }

  private cleanup(): void {
    const current = lstatSync(this.directory)
    if (!current.isDirectory() || current.isSymbolicLink() || current.dev !== this.identity.dev || current.ino !== this.identity.ino
      || realpathSync(this.directory) !== this.directory) throw new Error('文档命令目录身份变化，已保留')
    const allowed = new Set(['bin', 'bun-runtime.toml', 'tsconfig.json'])
    if (readdirSync(this.directory).some((name) => !allowed.has(name))) throw new Error('文档命令目录包含陌生内容，已保留')
    const bin = join(this.directory, 'bin')
    let exists = false
    try {
      const metadata = lstatSync(bin)
      if (!metadata.isDirectory() || metadata.isSymbolicLink() || readdirSync(bin).some((name) => name !== 'axon-doc')) throw new Error('文档命令目录已变化')
      exists = true
    } catch (error) { if (!(error instanceof Error && 'code' in error && error.code === 'ENOENT')) throw error }
    for (const path of [join(bin, 'axon-doc'), join(this.directory, 'bun-runtime.toml'), join(this.directory, 'tsconfig.json')]) {
      try { unlinkSync(path) } catch (error) { if (!(error instanceof Error && 'code' in error && error.code === 'ENOENT')) throw error }
    }
    if (exists) rmdirSync(bin)
    rmdirSync(this.directory)
  }
}
