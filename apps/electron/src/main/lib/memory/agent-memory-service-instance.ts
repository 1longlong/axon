/** Agent 项目记忆服务的主进程单例装配。 */

import { getAgentProjectManager } from '../project/agent-project-manager-instance'
import { AgentMemoryService } from './agent-memory-service'

let instance: AgentMemoryService | undefined

export function getAgentMemoryService(): AgentMemoryService {
  instance ??= new AgentMemoryService({ projects: getAgentProjectManager() })
  return instance
}
