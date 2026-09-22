/** Agent Skills 设置控制器的生产装配。 */

import { emptyAgentSkillCatalogProvider } from './agent-skill-catalog'
import { agentSkillInstallationService } from './agent-skill-installation-service-instance'
import { AgentSkillSettingsController } from './agent-skill-settings-controller'
import { discoverGlobalAgentSkills } from './project-skill-discovery'

export const agentSkillSettingsController = new AgentSkillSettingsController({
  catalog: emptyAgentSkillCatalogProvider,
  installations: agentSkillInstallationService,
  discoverGlobalSkills: () => discoverGlobalAgentSkills(),
})
