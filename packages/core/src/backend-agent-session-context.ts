/** 应用装配规则：业务归属、项目目录与独立目录不进入通用 Agent 执行器。 */
import type { AgentSessionMeta } from '@axon/shared'
import { canonicalizeAgentWorkspace } from './agent/agent-execution-context'
import type { AgentExecutionContext } from './agent/agent-execution-context'

export interface BackendAgentContextOptions {
  getSession: (id: string) => AgentSessionMeta | undefined
  resolveProjectCwd: (projectId: string) => string
}

/** 上层为根和子会话解析同一可信目录；普通项目规则和固定目录失效校验在此落实。 */
export function resolveBackendAgentContext(session: AgentSessionMeta, options: BackendAgentContextOptions): AgentExecutionContext {
  const root = session.parentSessionId && session.rootSessionId ? options.getSession(session.rootSessionId) : session
  if (root?.creationOrigin === 'loop') {
    if (root.parentSessionId || session.parentSessionId && root.id !== session.rootSessionId
      || session.projectId !== root.projectId || !root.creationWorkspacePath) throw new Error('Loop 会话归属无效')
    const workspacePath = canonicalizeAgentWorkspace(root.creationWorkspacePath)
    if (workspacePath !== root.creationWorkspacePath) throw new Error('Loop 工作目录已改变')
    return { workspacePath }
  }
  if (!session.projectId) throw new Error('Agent 会话尚未归入项目')
  const workspacePath = options.resolveProjectCwd(session.projectId)
  if (!workspacePath) throw new Error('Agent 项目无法解析运行目录')
  return { workspacePath }
}
