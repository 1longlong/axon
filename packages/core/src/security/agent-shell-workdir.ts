import { realpathSync, statSync } from 'node:fs'
import { resolve } from 'node:path'

/** 相对默认目录解析本次 cwd，供 adapter 在审批和执行前使用；不改变会话目录或沙箱基准。 */
export function resolveAgentShellWorkdir(defaultCwd: string, workdir: unknown): string {
  if (workdir !== undefined && (typeof workdir !== 'string' || workdir.includes('\0'))) {
    throw new Error('Shell workdir 必须是不含空字符的字符串')
  }
  const base = realpathSync(defaultCwd)
  let directory: string
  try {
    directory = realpathSync(resolve(base, (workdir as string | undefined) || '.'))
    if (!statSync(directory).isDirectory()) throw new Error('notDirectory')
  } catch {
    throw new Error('Shell 工作目录不存在或不是目录')
  }
  // 目录合法性与资源授权分开；项目外写入仍由原沙箱策略及审批约束。
  return directory
}
