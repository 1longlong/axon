/** 通用执行上下文只描述运行条件；业务归属由宿主装配层解析。 */
import { realpathSync, statSync } from 'node:fs'
import { isAbsolute } from 'node:path'
import type { AgentToolEnvironment } from '@axon/shared'

export interface AgentExecutionContext {
  workspacePath: string
  toolEnvironment?: AgentToolEnvironment
}

/** 可信创建入口规范化绝对目录；不创建缺失目录，也不回退到进程 cwd 或 HOME。 */
export function canonicalizeAgentWorkspace(value: string): string {
  if (typeof value !== 'string' || !isAbsolute(value) || value.length > 4096 || value.includes('\0')) {
    throw new Error('执行工作目录无效')
  }
  const path = realpathSync(value)
  if (!statSync(path).isDirectory()) throw new Error('执行工作目录不是文件夹')
  return path
}
