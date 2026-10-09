/** 后端数据路径由入口明确传入；本模块不探测 Electron、HOME 或开发环境。 */
import { mkdirSync } from 'node:fs'
import { isAbsolute, join, resolve } from 'node:path'

export interface BackendPathsInput {
  dataDir: string
  /** 管理 Skills 与用户 Skills 仍使用用户目录，不随开发数据目录切换。 */
  homeDir: string
}

export interface BackendPaths {
  dataDir: string
  settingsPath: string
  userProfilePath: string
  channelsPath: string
  conversationsIndexPath: string
  conversationsDir: string
  attachmentsDir: string
  agentSessionsIndexPath: string
  agentSessionsDir: string
  agentProjectsIndexPath: string
  agentProjectsDir: string
  runtimeConfigDir: string
  runtimeSessionsDir: string
  shellSnapshotsDir: string
  managedSkillsDir: string
  skillInstallationsPath: string
  userSkillsDir: string
}

/** 将入口选定的绝对目录映射到现行存储布局；只计算路径，不创建目录或迁移数据。 */
export function createBackendPaths(input: BackendPathsInput): BackendPaths {
  if (!isAbsolute(input.dataDir) || !isAbsolute(input.homeDir)
    || input.dataDir.includes('\0') || input.homeDir.includes('\0')) {
    throw new Error('后端数据目录与用户目录必须是有效绝对路径')
  }
  const dataDir = resolve(input.dataDir)
  const managedDir = join(input.homeDir, '.axon')
  const runtimeConfigDir = join(dataDir, 'runtime')
  return {
    dataDir,
    settingsPath: join(dataDir, 'settings.json'),
    userProfilePath: join(dataDir, 'user-profile.json'),
    channelsPath: join(dataDir, 'channels.json'),
    conversationsIndexPath: join(dataDir, 'conversations.json'),
    conversationsDir: join(dataDir, 'conversations'),
    attachmentsDir: join(dataDir, 'attachments'),
    agentSessionsIndexPath: join(dataDir, 'agent-sessions.json'),
    agentSessionsDir: join(dataDir, 'agent-sessions'),
    agentProjectsIndexPath: join(dataDir, 'agent-projects.json'),
    agentProjectsDir: join(dataDir, 'agent-projects'),
    runtimeConfigDir,
    runtimeSessionsDir: join(runtimeConfigDir, 'sessions'),
    shellSnapshotsDir: join(dataDir, 'shell_snapshots'),
    managedSkillsDir: join(managedDir, 'skills'),
    skillInstallationsPath: join(managedDir, 'skill-installations.json'),
    userSkillsDir: join(input.homeDir, '.agents', 'skills'),
  }
}

/** 装配入口在开放服务前创建业务目录；快照/Skills 的私有权限仍由各自发布流程管理。 */
export function initializeBackendDirectories(paths: BackendPaths): void {
  for (const directory of [
    paths.dataDir, paths.conversationsDir, paths.attachmentsDir,
    paths.agentSessionsDir, paths.agentProjectsDir, paths.runtimeConfigDir, paths.runtimeSessionsDir,
  ]) mkdirSync(directory, { recursive: true, mode: 0o700 })
}
