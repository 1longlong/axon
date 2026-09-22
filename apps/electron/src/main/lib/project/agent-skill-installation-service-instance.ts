/** Axon 管理 Skill 安装服务的生产装配；catalog 来源与 IPC 在下一阶段注入。 */

import {
  getAgentManagedSkillsDir,
  getAgentSkillInstallationsPath,
} from '../core/config-paths'
import { getSettings, updateSettings } from '../settings/settings-service'
import { AgentSkillInstallationService } from './agent-skill-installation-service'

export const agentSkillInstallationService = new AgentSkillInstallationService({
  managedSkillsRoot: getAgentManagedSkillsDir(),
  statePath: getAgentSkillInstallationsPath(),
  getDesiredCatalogIds: () => getSettings().agentSkillCatalogIds,
  setDesiredCatalogIds: (ids) => { updateSettings({ agentSkillCatalogIds: ids }) },
})
