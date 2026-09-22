import { AgentProjectManager } from './agent-project-manager'
import { getAgentProjectsDir, getAgentProjectsIndexPath } from '../core/config-paths'

let instance: AgentProjectManager | undefined

/** 主进程共享同一个项目管理器，保证项目索引和托管目录解析使用同一配置。 */
export function getAgentProjectManager(): AgentProjectManager {
  instance ??= new AgentProjectManager({
    indexPath: getAgentProjectsIndexPath(),
    projectsDir: getAgentProjectsDir(),
  })
  return instance
}
