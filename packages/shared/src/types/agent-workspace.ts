/** Agent 工作区的跨进程中立契约。 */

/** 系统目录选择器的安全结果；取消不视为错误。 */
export type AgentWorkspaceDirectorySelection =
  | { canceled: true }
  | { canceled: false; path: string; suggestedName: string }

export type AgentWorkspaceEntryKind = 'directory' | 'file' | 'symlink'

/** 文件树只暴露工作区内相对路径，不把主进程绝对路径带到 renderer。 */
export interface AgentWorkspaceTreeEntry {
  name: string
  relativePath: string
  kind: AgentWorkspaceEntryKind
  children?: AgentWorkspaceTreeEntry[]
}

export interface AgentWorkspaceDirectoryListing {
  projectId: string
  entries: AgentWorkspaceTreeEntry[]
  /** 达到深度或条目上限时为 true，UI 应明确提示列表并不完整。 */
  truncated: boolean
}

/** 文件系统变化只作为重新读取信号，不跨 IPC 发送真实路径。 */
export interface AgentWorkspaceDirectoryChangedEvent {
  projectId: string
  changedAt: number
}

interface AgentWorkspaceFilePreviewBase {
  projectId: string
  relativePath: string
  name: string
  size: number
}

/** 二进制与超大文件只返回元数据，文本内容才允许跨 IPC。 */
export type AgentWorkspaceFilePreview =
  | (AgentWorkspaceFilePreviewBase & { kind: 'text'; content: string })
  | (AgentWorkspaceFilePreviewBase & { kind: 'binary' | 'too_large' })

/** 只读 Diff 结果；不可比较时返回稳定状态，不把 git 原始错误跨 IPC 暴露。 */
export type AgentWorkspaceFileDiff =
  | { projectId: string; relativePath: string; status: 'changed'; patch: string }
  | { projectId: string; relativePath: string; status: 'clean' | 'unavailable'; message: string }
