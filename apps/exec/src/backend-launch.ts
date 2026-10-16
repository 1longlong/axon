import { realpathSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import type { ExecBackendLaunch } from './backend-process'

declare const AXON_EXEC_COMPILED: boolean

/** 源码宿主显式禁 dotenv，固定 Bun 配置；任务目录的 preload 不能先于审批/沙箱执行。 */
export function sourceExecRuntimeArguments(entry: string): string[] {
  return ['run', '--no-env-file', `--config=${fileURLToPath(new URL('../resources/bun-runtime.toml', import.meta.url))}`, entry]
}

/** 构建只替换可信启动位置；同一业务/协议链不依赖 cwd、PATH 或用户指定的后端脚本。 */
export function defaultExecBackendLaunch(): ExecBackendLaunch {
  if (typeof AXON_EXEC_COMPILED !== 'undefined' && AXON_EXEC_COMPILED) {
    return { executable: join(dirname(realpathSync(process.execPath)), 'backend', 'axon-app-server'), entryArgs: [] }
  }
  return { executable: process.execPath,
    entryArgs: sourceExecRuntimeArguments(fileURLToPath(new URL('../../app-server/src/main.ts', import.meta.url))) }
}
