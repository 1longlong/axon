/** AgentSessionManager 的生产环境单例装配。 */

import { AgentSessionManager } from './agent-session-manager'
import { getAgentSessionsDir, getAgentSessionsIndexPath } from '../core/config-paths'
import { getAgentRootStateStore } from './agent-root-state-store-instance'

let manager: AgentSessionManager | null = null

export function getAgentSessionManager(): AgentSessionManager {
  manager ??= new AgentSessionManager({
    indexPath: getAgentSessionsIndexPath(),
    sessionsDir: getAgentSessionsDir(),
    stateStore: getAgentRootStateStore(),
  })
  return manager
}
