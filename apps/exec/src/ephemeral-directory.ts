import { lstatSync, mkdirSync, mkdtempSync, realpathSync } from 'node:fs'
import { rm } from 'node:fs/promises'
import { join } from 'node:path'
import { ExecInputError } from './arguments'
import type { PreparedExec } from './preflight'

interface DirectoryIdentity { path: string; dev: number; ino: number }

export class ExecEphemeralCleanupError extends Error {
  constructor() { super('临时业务目录未能安全清理，已保留以便检查'); this.name = 'ExecEphemeralCleanupError' }
}

function identity(path: string): DirectoryIdentity {
  const info = lstatSync(path)
  if (!info.isDirectory() || realpathSync(path) !== path) throw new Error()
  return { path, dev: info.dev, ino: info.ino }
}

function checkIdentity(expected: DirectoryIdentity): void {
  const actual = identity(expected.path)
  if (actual.dev !== expected.dev || actual.ino !== expected.ino) throw new Error()
}

/** 预检后的数据目录只作容器；每次创建私有业务根，后端业务数据只写此根，不读取既有会话。 */
export class ExecEphemeralDirectory {
  private disposing?: Promise<void>
  private constructor(private readonly parent: DirectoryIdentity, private readonly root: DirectoryIdentity) {}
  get dataDir(): string { return this.root.path }

  /** 预检完成后同步分配并登记临时根；原配置/持久目录不复制到临时业务上下文。 */
  static create(prepared: PreparedExec): ExecEphemeralDirectory {
    try {
      mkdirSync(prepared.dataDir, { recursive: true, mode: 0o700 })
      const parent = identity(prepared.dataDir)
      // mkdtemp 原子创建 0700 根；同步完成资源登记，取消不能落在创建与取得所有权之间。
      const root = identity(mkdtempSync(join(parent.path, '.axon-ephemeral-')))
      return new ExecEphemeralDirectory(parent, root)
    } catch { throw new ExecInputError('无法创建私有临时业务目录，不启动任务') }
  }

  /** 仅后端正常 drain/close 后调用；拒绝被替换的父目录/根，不跟随内部符号链接删除外部文件。 */
  dispose(): Promise<void> {
    this.disposing ??= (async () => {
      try {
        checkIdentity(this.parent); checkIdentity(this.root)
        await rm(this.root.path, { recursive: true, force: false })
      } catch { throw new ExecEphemeralCleanupError() }
    })()
    return this.disposing
  }
}
