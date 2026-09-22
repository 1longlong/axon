/** Agent renderer 状态公共入口；实现按模型、事件归并、API 与控制器分层。 */

export type { AgentRendererApi, AgentWorkspaceDirectoryListing } from './agent-renderer-api'
export { AgentRendererController } from './agent-renderer-controller'
export { reduceAgentGenerationEvent } from './agent-event-reducer'
export {
  agentActiveRunsAtom,
  agentMessagesBySessionAtom,
  agentPendingPermissionsAtom,
  agentSessionsAtom,
  agentStateAtom,
  createInitialAgentRendererState,
} from './agent-state-model'
export type {
  AgentLoadStatus,
  AgentRendererError,
  AgentRendererState,
} from './agent-state-model'

