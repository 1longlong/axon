/** 通用可信会话创建器；业务归属由调用方装配，不在此区分项目、Loop 或其他入口。 */
import type { AgentSessionCreateInput } from '@axon/shared'
import type { AgentSessionManager } from './agent-session-manager'
import { canonicalizeAgentWorkspace } from './agent-execution-context'
import { AsyncWorkTracker } from '../async/async-work-tracker'

export interface AgentSessionFactoryOptions {
  sessions: Pick<AgentSessionManager, 'create'>
  validateCreate?: (input: AgentSessionCreateInput) => void | Promise<void>
}

export class AgentSessionFactory {
  private readonly work = new AsyncWorkTracker()
  private disposed = false
  constructor(private readonly options: AgentSessionFactoryOptions) {}

  /** 可信配置先快照，再预检；迟到校验、取消或目录改指向都不能产生会话。 */
  create(input: AgentSessionCreateInput, signal?: AbortSignal) {
    return this.work.run(async () => {
      this.ensureOpen(signal)
      const config = structuredClone(input)
      const workspacePath = config.creationWorkspacePath === undefined ? undefined : canonicalizeAgentWorkspace(config.creationWorkspacePath)
      if (workspacePath !== undefined) config.creationWorkspacePath = workspacePath
      await this.options.validateCreate?.(config)
      this.ensureOpen(signal)
      if (workspacePath !== undefined && canonicalizeAgentWorkspace(workspacePath) !== workspacePath) throw new Error('执行工作目录已改变')
      return this.options.sessions.create(config)
    })
  }

  private ensureOpen(signal?: AbortSignal): void {
    signal?.throwIfAborted()
    if (this.disposed) throw new Error('会话创建器已关闭')
  }
  dispose(): void { this.disposed = true }
  async drain(): Promise<void> { await this.work.drain() }
}
