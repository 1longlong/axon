/** Agent Skills 的中立安装契约；目录来源和下载方式不属于该协议。 */

export interface InstallableSkillFile {
  /** Skill 根目录内的 POSIX 相对路径。 */
  path: string
  /** 文件原始字节的 Base64；安装层不假定引用资源都是文本。 */
  contentBase64: string
  sha256: string
  executable?: boolean
}

export interface InstallableSkillPackage {
  /** catalog 中稳定且全局唯一的选择键。 */
  catalogId: string
  name: string
  version: string
  description: string
  /** 按 path 排序后的 `path + NUL + file sha256 + LF` 整体 SHA-256。 */
  contentHash: string
  files: InstallableSkillFile[]
}

export interface InstallableSkillCatalog {
  packages: InstallableSkillPackage[]
}

export interface InstalledAgentSkill {
  catalogId: string
  name: string
  version: string
  contentHash: string
  files: Array<Pick<InstallableSkillFile, 'path' | 'sha256' | 'executable'>>
  installedAt: number
}

export interface AgentSkillInstallationState {
  version: 1
  installed: InstalledAgentSkill[]
}

export interface AgentSkillInstallationFailure {
  catalogId: string
  message: string
}

export interface AgentSkillReconcileResult {
  desiredCatalogIds: string[]
  installed: InstalledAgentSkill[]
  failures: AgentSkillInstallationFailure[]
}

export interface InstallableSkillSummary {
  catalogId: string
  name: string
  version: string
  description: string
  contentHash: string
}

export interface AgentSkillDiscoverySummary {
  name: string
  description: string
  directoryKind: 'axon' | 'agents' | 'builtin' | 'user'
  relativeInstructionPath: string
  effective: boolean
}

export interface AgentSkillSettingsSnapshot {
  available: InstallableSkillSummary[]
  desiredCatalogIds: string[]
  installed: InstalledAgentSkill[]
  discovered: AgentSkillDiscoverySummary[]
  failures: AgentSkillInstallationFailure[]
}

export const AGENT_SKILL_IPC_CHANNELS = {
  GET_SETTINGS: 'axon:agent:skills:get-settings',
  APPLY_SETTINGS: 'axon:agent:skills:apply-settings',
} as const
