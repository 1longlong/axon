/** 项目工作区的目录可用状态；托管目录由应用保证存在，因此不需要状态字段。 */
export type AgentProjectWorkspaceStatus = 'available' | 'missing' | 'not_directory' | 'unavailable'

export type AgentProjectWorkspace =
  | { kind: 'managed' }
  | { kind: 'local'; path: string; status?: AgentProjectWorkspaceStatus }

/** Agent 项目是左侧导航容器，并持有其全部会话共享的唯一工作区。 */
export interface AgentProject {
  id: string
  name: string
  /** 创建后保持稳定，用作托管工作区目录名。 */
  slug: string
  workspace: AgentProjectWorkspace
  /** 项目级长期记忆总开关；关闭时不读取、注入或写入 memory/。 */
  memoryEnabled: boolean
  createdAt: number
  updatedAt: number
}

export type AgentProjectWorkspaceInput =
  | { kind: 'managed' }
  | { kind: 'local'; path: string }

export interface AgentProjectCreateInput {
  name: string
  /** 不传时创建应用管理的默认工作区。 */
  workspace?: AgentProjectWorkspaceInput
}

export interface AgentProjectUpdateInput {
  name?: string
  workspace?: AgentProjectWorkspaceInput
  memoryEnabled?: boolean
}

/** 项目及其唯一工作区的四层 IPC 通道。 */
export const AGENT_PROJECT_IPC_CHANNELS = {
  LIST: 'axon:agent:projects:list',
  GET: 'axon:agent:projects:get',
  CREATE: 'axon:agent:projects:create',
  UPDATE: 'axon:agent:projects:update',
  DELETE: 'axon:agent:projects:delete',
  PICK_LOCAL_WORKSPACE: 'axon:agent:projects:pick-local-workspace',
  LIST_DIRECTORY: 'axon:agent:projects:list-directory',
  WATCH_DIRECTORY: 'axon:agent:projects:watch-directory',
  UNWATCH_DIRECTORY: 'axon:agent:projects:unwatch-directory',
  DIRECTORY_CHANGED: 'axon:agent:projects:directory-changed',
  READ_FILE: 'axon:agent:projects:read-file',
  READ_DIFF: 'axon:agent:projects:read-diff',
} as const
