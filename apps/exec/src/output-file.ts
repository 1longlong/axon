/** 用户指定的最终输出是 CLI 自有写入，不是模型工具权限；先预检，再在后端退出后原子替换。 */
import { randomUUID } from 'node:crypto'
import { constants, lstatSync, realpathSync, statSync } from 'node:fs'
import { open, rename, unlink } from 'node:fs/promises'
import { basename, dirname, isAbsolute, join, relative, resolve, sep } from 'node:path'
import { ExecInputError } from './arguments'
import type { PreparedExec } from './preflight'

export class ExecFileOutputError extends Error {
  constructor() { super('最终回复文件未能完整保存；未自动重跑任务'); this.name = 'ExecFileOutputError' }
}
function contains(parent: string, child: string): boolean {
  const path = relative(parent, child)
  return path === '' || path !== '..' && !path.startsWith(`..${sep}`) && !isAbsolute(path)
}

/** 父目录须已存在；拒绝设备/FIFO/链接和业务/配置/Schema 目标，不在预检阶段创建输出文件。 */
export class ExecOutputFile {
  private constructor(private readonly path: string, private readonly parent: { path: string; dev: number; ino: number }) {}

  static prepare(prepared: PreparedExec): ExecOutputFile | undefined {
    if (!prepared.outputLastMessage) return undefined
    try {
      const parentPath = realpathSync(dirname(prepared.outputLastMessage)), info = statSync(parentPath)
      if (!info.isDirectory()) throw new Error()
      const path = join(parentPath, basename(prepared.outputLastMessage))
      for (const root of [prepared.dataDir, join(prepared.homeDir, '.axon'), join(prepared.homeDir, '.axon-dev')]) {
        let canonical: string
        try { canonical = realpathSync(root) } catch { canonical = root }
        if (contains(canonical, path)) throw new Error()
      }
      for (const file of [prepared.configuration.configPath, prepared.args.flags.outputSchema === undefined ? undefined
        : resolve(prepared.cwd, prepared.args.flags.outputSchema)]) {
        if (file && (path === file || path === realpathSync(file))) throw new Error()
      }
      const output = new ExecOutputFile(path, { path: parentPath, dev: info.dev, ino: info.ino })
      output.checkTarget()
      return output
    } catch { throw new ExecInputError('输出目标须位于已存在目录，且不能是链接/非普通文件或覆盖业务数据、配置、Schema') }
  }

  private checkTarget(): void {
    const current = statSync(this.parent.path)
    if (!current.isDirectory() || current.dev !== this.parent.dev || current.ino !== this.parent.ino
      || realpathSync(this.parent.path) !== this.parent.path) throw new Error()
    try { if (!lstatSync(this.path).isFile()) throw new Error() }
    catch (error) { if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error }
  }

  /** 完整写入/同步私有临时文件，取消与目录变化检查后一次 rename；失败只清理本次自有临时文件。 */
  async write(text: string, signal: AbortSignal): Promise<void> {
    const temporary = join(this.parent.path, `.axon-output-${randomUUID()}.tmp`)
    let created = false
    try {
      signal.throwIfAborted(); this.checkTarget()
      const file = await open(temporary, constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | constants.O_NOFOLLOW, 0o600)
      created = true
      try { await file.writeFile(text, 'utf8'); await file.sync() }
      finally { await file.close() }
      signal.throwIfAborted(); this.checkTarget()
      await rename(temporary, this.path)
      created = false
    } catch {
      signal.throwIfAborted()
      throw new ExecFileOutputError()
    } finally {
      if (created) await unlink(temporary).catch(() => { /* 仅回收自有随机临时文件；不碰原输出。 */ })
    }
  }
}
