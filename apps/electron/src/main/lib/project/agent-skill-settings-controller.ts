/** Agent Skills 设置编排：安全摘要、期望选择与安装服务之间的唯一桥梁。 */

import type {
  AgentSkillDiscoverySummary,
  AgentSkillSettingsSnapshot,
  InstallableSkillCatalog,
} from '@axon/shared'
import type { AgentSkillCatalogProvider } from './agent-skill-catalog'
import type { AgentSkillInstallationService } from './agent-skill-installation-service'
import type { AgentSkillCatalog } from './project-skill-discovery'

export interface AgentSkillSettingsControllerOptions {
  catalog: AgentSkillCatalogProvider
  installations: Pick<AgentSkillInstallationService, 'getState' | 'getDesiredCatalogIds' | 'reconcile'>
  discoverGlobalSkills: () => AgentSkillCatalog
}

function availableSummaries(catalog: InstallableSkillCatalog): AgentSkillSettingsSnapshot['available'] {
  return catalog.packages.map((item) => ({
    catalogId: item.catalogId,
    name: item.name,
    version: item.version,
    description: item.description,
    contentHash: item.contentHash,
  }))
}

function discoveredSummaries(catalog: AgentSkillCatalog): AgentSkillDiscoverySummary[] {
  return [
    ...catalog.skills.map((skill) => ({ ...skill, effective: true as const })),
    ...catalog.shadowedSkills.map((skill) => ({ ...skill, effective: false as const })),
  ].map((skill) => ({
    name: skill.name,
    description: skill.description,
    directoryKind: skill.directoryKind,
    relativeInstructionPath: skill.relativeInstructionPath,
    effective: skill.effective,
  })).sort((left, right) => left.name.localeCompare(right.name) || Number(right.effective) - Number(left.effective))
}

function parseDesiredIds(value: unknown): string[] {
  if (!Array.isArray(value) || value.length > 200) throw new Error('Skill 选择格式无效')
  if (!value.every((item) => typeof item === 'string')) throw new Error('Skill 选择格式无效')
  return value.map((item) => item.trim())
}

export class AgentSkillSettingsController {
  constructor(private readonly options: AgentSkillSettingsControllerOptions) {}

  /** 只返回安全摘要；安装包正文、绝对路径和暂存状态不会越过 IPC。 */
  async getSnapshot(): Promise<AgentSkillSettingsSnapshot> {
    const catalog = await this.options.catalog.getCatalog()
    const state = this.options.installations.getState()
    return {
      available: availableSummaries(catalog),
      desiredCatalogIds: this.options.installations.getDesiredCatalogIds(),
      installed: state.installed,
      discovered: discoveredSummaries(this.options.discoverGlobalSkills()),
      failures: [],
    }
  }

  /** 保存期望集合并立即核对磁盘；返回刷新后的发现结果和逐项失败。 */
  async apply(rawIds: unknown): Promise<AgentSkillSettingsSnapshot> {
    const desiredIds = parseDesiredIds(rawIds)
    const catalog = await this.options.catalog.getCatalog()
    const result = this.options.installations.reconcile(catalog, desiredIds)
    return {
      available: availableSummaries(catalog),
      desiredCatalogIds: result.desiredCatalogIds,
      installed: result.installed,
      discovered: discoveredSummaries(this.options.discoverGlobalSkills()),
      failures: result.failures,
    }
  }
}
