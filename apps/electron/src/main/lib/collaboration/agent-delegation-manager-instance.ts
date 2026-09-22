/** AgentDelegationManager 的生产环境单例装配。 */

import { AgentDelegationManager } from './agent-delegation-manager'
import { getAgentSessionsDir } from '../core/config-paths'
import { getAgentRootStateStore } from '../agent/agent-root-state-store-instance'

let manager: AgentDelegationManager | null = null

export function getAgentDelegationManager(): AgentDelegationManager {
  manager ??= new AgentDelegationManager({
    sessionsDir: getAgentSessionsDir(),
    stateStore: getAgentRootStateStore(),
  })
  return manager
}
