/** Agent 项目长期记忆的中立文件契约。 */

export const AGENT_MEMORY_DIRECTORY = 'memory'
export const AGENT_MEMORY_INDEX_FILE = 'MEMORY.md'
export const MAX_AGENT_MEMORY_FILE_BYTES = 256 * 1024
export const MAX_AGENT_MEMORY_TOTAL_BYTES = 2 * 1024 * 1024
export const MAX_AGENT_MEMORY_FILES = 128

export interface AgentMemoryFileEntry {
  relativePath: string
  size: number
  updatedAt: number
}

export interface AgentMemorySummary {
  projectId: string
  indexExists: boolean
  totalBytes: number
  files: AgentMemoryFileEntry[]
}

export interface AgentMemoryFile {
  projectId: string
  relativePath: string
  content: string
  size: number
  updatedAt: number
}

/** memory/ 变化只携带定位提示；renderer 会重新读取权威文件列表。 */
export interface AgentMemoryChangedEvent {
  projectId: string
  changedAt: number
  relativePath?: string
}

/** Agent 项目记忆的四层 IPC 通道；Chat 不暴露对应入口。 */
export const AGENT_MEMORY_IPC_CHANNELS = {
  LIST: 'axon:agent:memory:list',
  READ: 'axon:agent:memory:read',
  WRITE: 'axon:agent:memory:write',
  WATCH: 'axon:agent:memory:watch',
  UNWATCH: 'axon:agent:memory:unwatch',
  CHANGED: 'axon:agent:memory:changed',
} as const
