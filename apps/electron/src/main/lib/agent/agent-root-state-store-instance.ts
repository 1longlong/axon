/** 根会话聚合状态存储的生产环境单例，供会话与任务管理器共享。 */

import { AgentRootStateStore } from './agent-root-state-store'
import { getAgentSessionsDir } from '../core/config-paths'

let store: AgentRootStateStore | null = null

export function getAgentRootStateStore(): AgentRootStateStore {
  store ??= new AgentRootStateStore(getAgentSessionsDir())
  return store
}
