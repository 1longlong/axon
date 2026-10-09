/** Axon 宿主能力入口；不装配业务后端，不导入 Electron 或具体 Runtime。 */
export { checkAgentEnvironment } from './agent-environment-service'
export { resolveAgentShell } from './agent-shell'
export type { AgentShell, AgentShellType, AgentShellResolutionOptions } from './agent-shell'
export { AgentShellSnapshotEnvironment, prepareAgentShellSnapshotCommand, pruneAgentShellSnapshots } from './agent-shell-snapshot'
export type {
  AgentShellSnapshot, AgentShellSnapshotOptions, AgentShellSnapshotCleanupOptions,
  AgentShellSnapshotCommandInput, AgentPreparedShellCommand, AgentShellSnapshotFailure,
} from './agent-shell-snapshot'
export { compileSeatbeltProfile, detectSeatbeltCapability } from './agent-seatbelt-profile'
export type {
  SeatbeltCapability, SeatbeltUnavailableReason, SeatbeltProfileOverrides, DetectSeatbeltCapabilityOptions,
} from './agent-seatbelt-profile'
export { AgentSandboxCommandService, AgentSandboxExecutionError } from './agent-sandbox-command-service'
export type { AgentSandboxCommandServiceOptions, AgentSandboxExecutionErrorCode } from './agent-sandbox-command-service'
