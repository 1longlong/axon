/** preload 暴露给 Agent renderer 控制器的中立 API 契约。 */

import type {
  AgentActiveRun,
  AgentAskUserResponse,
  AgentEnvironmentCheckInput,
  AgentEnvironmentCheckResult,
  AgentExitPlanResponse,
  AgentGenerationEvent,
  AgentMemoryChangedEvent,
  AgentMemoryFile,
  AgentMemorySummary,
  AgentMoveQueuedMessageInput,
  AgentPermissionResponse,
  AgentProject,
  AgentProjectCreateInput,
  AgentProjectUpdateInput,
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
  createSession(input?: AgentSessionCreateInput): Promise<AgentSessionMeta>
  updateSession(id: string, input: AgentSessionUpdateInput): Promise<AgentSessionMeta>
  deleteSession(id: string): Promise<AgentSessionMeta>
  getMessages(id: string): Promise<SDKMessage[]>
  send(input: AgentSendInput): Promise<AgentSendResult>
  stop(sessionId: string): Promise<boolean>
  respondPermission?(response: AgentPermissionResponse): Promise<boolean>
  respondAskUser(response: AgentAskUserResponse): Promise<boolean>
  respondExitPlan(response: AgentExitPlanResponse): Promise<boolean>
  listQueuedMessages(sessionId: string): Promise<AgentQueuedMessage[]>
  cancelQueuedMessage(input: AgentQueuedMessageControlInput): Promise<boolean>
  moveQueuedMessage(input: AgentMoveQueuedMessageInput): Promise<boolean>
  onEvent(callback: (event: AgentGenerationEvent) => void): () => void
  onQueueChanged(callback: (snapshot: AgentQueueSnapshot) => void): () => void
  listProjects(): Promise<AgentProject[]>
  createProject(input: AgentProjectCreateInput): Promise<AgentProject>
  updateProject(id: string, input: AgentProjectUpdateInput): Promise<AgentProject>
  deleteProject(id: string): Promise<AgentProject>
  pickLocalWorkspace(): Promise<AgentWorkspaceDirectorySelection>
  listProjectDirectory(projectId: string): Promise<AgentWorkspaceDirectoryListing>
  readProjectFile(projectId: string, relativePath: string): Promise<AgentWorkspaceFilePreview>
  readProjectDiff?(projectId: string, relativePath: string): Promise<AgentWorkspaceFileDiff>
  watchProjectDirectory(projectId: string): Promise<void>
  unwatchProjectDirectory(projectId: string): Promise<void>
  onProjectDirectoryChanged(callback: (event: AgentWorkspaceDirectoryChangedEvent) => void): () => void
  listProjectMemory(projectId: string): Promise<AgentMemorySummary>
  readProjectMemory(projectId: string, relativePath: string): Promise<AgentMemoryFile>
  writeProjectMemory(projectId: string, relativePath: string, content: string): Promise<AgentMemoryFile>
  watchProjectMemory(projectId: string): Promise<void>
  unwatchProjectMemory(projectId: string): Promise<void>
  onProjectMemoryChanged(callback: (event: AgentMemoryChangedEvent) => void): () => void
}

export type { AgentWorkspaceDirectoryListing }
