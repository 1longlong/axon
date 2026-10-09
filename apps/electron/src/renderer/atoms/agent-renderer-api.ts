/** preload 暴露给 Agent renderer 控制器的中立 API 契约。 */

import type {
  AgentActiveRun,
  AgentRunIdentityEvent,
  BackendOwnedRun,
  BackendRunControlInput,
  AgentAskUserResponse,
  AgentEnvironmentCheckInput,
  AgentEnvironmentCheckResult,
  AgentGenerationEvent,
  AgentMemoryChangedEvent,
  AgentMemoryFile,
  AgentMemorySummary,
  AgentMoveQueuedMessageInput,
  AgentPermissionResponse,
  AgentProject,
  AgentProjectCreateInput,
  AgentProjectUpdateInput,
  AgentProjectWatchSubscription,
  AgentProjectWatchTarget,
  AgentProjectWatchClosedEvent,
  AgentQueueSnapshot,
  AgentQueuedMessage,
  AgentQueuedMessageControlInput,
  AgentSendInput,
  AgentSendResult,
  AgentSessionCreateInput,
  AgentSessionMeta,
  AgentSessionUpdateInput,
  AgentWorkspaceDirectoryChangedEvent,
  AgentWorkspaceDirectoryListing,
  AgentWorkspaceDirectorySelection,
  AgentWorkspaceFileDiff,
  AgentWorkspaceFilePreview,
  SDKMessage,
} from '@axon/shared'

export interface AgentRendererApi {
  checkEnvironment?(input?: AgentEnvironmentCheckInput): Promise<AgentEnvironmentCheckResult>
  listSessions(): Promise<AgentSessionMeta[]>
  listActiveRuns(): Promise<AgentActiveRun[]>
  getOwnedRun(sessionId: string): Promise<BackendOwnedRun | null>
  createSession(input?: AgentSessionCreateInput): Promise<AgentSessionMeta>
  updateSession(id: string, input: AgentSessionUpdateInput): Promise<AgentSessionMeta>
  deleteSession(id: string): Promise<AgentSessionMeta>
  getMessages(id: string): Promise<SDKMessage[]>
  send(input: AgentSendInput): Promise<AgentSendResult>
  stop(target: BackendRunControlInput): Promise<boolean>
  respondPermission?(response: AgentPermissionResponse): Promise<boolean>
  respondAskUser(response: AgentAskUserResponse): Promise<boolean>
  listQueuedMessages(sessionId: string): Promise<AgentQueuedMessage[]>
  cancelQueuedMessage(input: AgentQueuedMessageControlInput): Promise<boolean>
  moveQueuedMessage(input: AgentMoveQueuedMessageInput): Promise<boolean>
  onEvent(callback: (event: AgentGenerationEvent) => void): () => void
  onRunChanged(callback: (event: AgentRunIdentityEvent) => void): () => void
  onQueueChanged(callback: (snapshot: AgentQueueSnapshot) => void): () => void
  listProjects(): Promise<AgentProject[]>
  onProjectsChanged(callback: (projects: AgentProject[]) => void): () => void
  createProject(input: AgentProjectCreateInput): Promise<AgentProject>
  updateProject(id: string, input: AgentProjectUpdateInput): Promise<AgentProject>
  deleteProject(id: string): Promise<AgentProject>
  pickLocalWorkspace(): Promise<AgentWorkspaceDirectorySelection>
  listProjectDirectory(projectId: string): Promise<AgentWorkspaceDirectoryListing>
  readProjectFile(projectId: string, relativePath: string): Promise<AgentWorkspaceFilePreview>
  readProjectDiff?(projectId: string, relativePath: string): Promise<AgentWorkspaceFileDiff>
  watchProjectDirectory(projectId: string): Promise<AgentProjectWatchSubscription>
  unwatchProjectDirectory(target: AgentProjectWatchTarget): Promise<boolean>
  onProjectWatchClosed(callback: (event: AgentProjectWatchClosedEvent) => void): () => void
  onProjectDirectoryChanged(callback: (event: AgentWorkspaceDirectoryChangedEvent) => void): () => void
  listProjectMemory(projectId: string): Promise<AgentMemorySummary>
  readProjectMemory(projectId: string, relativePath: string): Promise<AgentMemoryFile>
  writeProjectMemory(projectId: string, relativePath: string, content: string): Promise<AgentMemoryFile>
  watchProjectMemory(projectId: string): Promise<AgentProjectWatchSubscription>
  unwatchProjectMemory(target: AgentProjectWatchTarget): Promise<boolean>
  onProjectMemoryChanged(callback: (event: AgentMemoryChangedEvent) => void): () => void
}

export type { AgentWorkspaceDirectoryListing }
