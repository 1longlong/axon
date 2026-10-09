/** 可安装 Skill 目录边界；远程或市场来源后续只需替换 provider。 */

import type { InstallableSkillCatalog } from '@axon/shared'

export interface AgentSkillCatalogProvider {
  getCatalog: () => InstallableSkillCatalog | Promise<InstallableSkillCatalog>
}

/** 当前没有发布安装源，设置页必须展示真实空状态。 */
export const emptyAgentSkillCatalogProvider: AgentSkillCatalogProvider = {
  getCatalog: () => ({ packages: [] }),
}
