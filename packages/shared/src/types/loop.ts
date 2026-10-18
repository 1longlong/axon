/** Loop 对外协议只描述本地任务与结果，不携带 Runtime 或控制通道凭据。 */
import type { AgentSandboxMode } from './agent-sandbox'
import type { AgentThinkingLevel } from './agent-session'
import type { SDKMessageUsage } from './agent-message'
import type { McpProjectConfig, McpServerConfig } from './mcp'

export type LoopNotifyPolicy = 'auto' | 'always' | 'never'
export type LoopRunRole = 'exec' | 'evolve' | 'edit' | 'setup'
export type LoopRunPhase = 'pending' | 'running' | 'done' | 'error' | 'canceled' | 'interrupted'
export type LoopRunStatus = 'new' | 'resolved' | 'nothing-new'
export type LoopRunTrigger = 'scheduled' | 'manual' | 'rescheduled' | 'catchup' | 'auto_evolve' | 'manual_evolve' | 'user_edit' | 'initial_setup'
export type LoopPreparationState = 'pending' | 'ready' | 'failed'
export interface LoopMetricField { key: string; label: string; unit?: string }

export interface LoopCreateInput {
  name: string
  workspacePath: string
  channelId: string
  modelId: string
  task: string
  cron: string
  timezone?: string
  goal?: string | null
  enabled?: boolean
  allowControl?: boolean
  notify?: LoopNotifyPolicy
  sandboxMode?: AgentSandboxMode
  thinkingLevel?: AgentThinkingLevel
  workflow?: string | null
  ui?: string | null
  stateSchema?: LoopMetricField[]
  /** 仅用户设置可授予预检网络及确切 MCP 工具，模型结构命令不能修改。 */
  precheckNetworkAccess?: boolean
  allowedMcpTools?: string[]
}
export type LoopUpdateInput = Partial<Omit<LoopCreateInput, 'workspacePath'>>
/** 桌面只提交意图与授权，技术配置由独立准备轮生成。 */
export interface LoopComposeInput extends Omit<LoopCreateInput, 'workflow' | 'ui' | 'stateSchema'> {
  runImmediately?: boolean
  /** 创建时的独立 MCP 草稿；加密另存，不进入定义或执行日志。 */
  mcpConfig?: McpProjectConfig
}
export type LoopMcpTarget = { loopId: string } | { workspacePath: string }
export interface LoopMcpConnectionTestInput {
  requestId: string
  target: LoopMcpTarget
  serverName: string
  server: McpServerConfig
}
export interface LoopDefinition extends LoopCreateInput {
  id: string
  revision: number
  /** 仅任务/目标/执行能力变化时推进；调度暂停和展示设置不使当前结果失效。 */
  executionRevision: number
  runtimeId: 'pi'
  workspacePath: string
  taskFile: string
  timezone: string
  goal: string | null
  enabled: boolean
  allowControl: boolean
  notify: LoopNotifyPolicy
  sandboxMode: AgentSandboxMode
  workflow: string | null
  ui: string | null
  stateSchema: LoopMetricField[]
  createdAt: number
  updatedAt: number
}
export interface LoopProgress { step: number; label: string; at: number }
export interface LoopRunSummary {
  id: string
  loopId: string
  definitionRevision: number
  role: LoopRunRole
  trigger: LoopRunTrigger
  phase: LoopRunPhase
  outcome?: 'exec' | 'evolve' | 'edit' | 'setup' | 'silent' | 'direct' | 'error' | 'skipped'
  status?: LoopRunStatus
  ts: string
  queuedAt: number
  startedAt: number | null
  finishedAt: number | null
  durationMs: number | null
  running: boolean
  queued: boolean
  message?: string
  state?: Record<string, number | string>
  error?: string
  sessionId?: string
  workflowId?: string
  finalText?: string
  progress?: LoopProgress
  activity?: LoopProgress[]
  costUsd?: number
  usage?: SDKMessageUsage
  query?: string
  instruction?: string
  controls?: Array<{ verb: string; at: number; detail: string }>
}
export interface LoopSummary extends LoopDefinition {
  preparation: LoopPreparationState
  recentRuns: LoopRunSummary[]
  runCount: number
  completedAt: number | null
  completionReason: string | null
  nextRunAt: number | null
  nextFire: number | null
  running: boolean
  queued: boolean
  latestRun?: LoopRunSummary
  totalCostUsd: number
  storageError?: string
}
export interface LoopDetail {
  job: LoopSummary; runs: LoopRunSummary[]; taskFileContent: string; taskFileError?: string; editRequest: string | null
  pendingMaintenance: Array<{ role: 'edit' | 'evolve'; trigger: LoopRunTrigger; instruction?: string }>
}
export interface LoopArtifact {
  path: string
  hash: string
  size: number
  modifiedAt: number
  mediaType: string
  meta?: { type?: string; title?: string; date?: string }
}
export interface LoopArtifactContent extends LoopArtifact { content: string; encoding: 'utf8' | 'base64' }
export interface LoopArtifactDiff {
  path: string
  status: 'added' | 'modified' | 'deleted'
  before: string | null
  after: string | null
}
export interface LoopRunDetail {
  job: LoopSummary
  run: LoopRunSummary
  artifacts: LoopArtifact[]
  changes: LoopArtifactDiff[]
  query: string
  controls: Array<{ verb: string; at: number; detail: string }>
}
export interface LoopCommandInput { loopId: string; runId?: string; instruction?: string }
export interface LoopReadArtifactInput { loopId: string; runId?: string; path: string }

export const LOOP_IPC_CHANNELS = {
  LIST: 'axon:loop:list', GET: 'axon:loop:get', CREATE: 'axon:loop:create', UPDATE: 'axon:loop:update',
  DELETE: 'axon:loop:delete', RUN: 'axon:loop:run', STOP: 'axon:loop:stop', EVOLVE: 'axon:loop:evolve',
  EDIT: 'axon:loop:edit', RUN_DETAIL: 'axon:loop:run-detail', ARTIFACTS: 'axon:loop:artifacts',
  READ_ARTIFACT: 'axon:loop:artifact:read', EVENT: 'axon:loop:event',
  RUNS: 'axon:loop:runs',
  MCP_TOOLS: 'axon:loop:mcp-tools',
  MCP_GET_CONFIG: 'axon:loop:mcp:get-config', MCP_SAVE_CONFIG: 'axon:loop:mcp:save-config',
  MCP_TEST_CONNECTION: 'axon:loop:mcp:test-connection', MCP_CANCEL_TEST: 'axon:loop:mcp:cancel-test',
  PREPARE: 'axon:loop:prepare',
} as const
export interface LoopMcpToolOption { name: string; description: string }
export interface LoopChangedEvent { loopId: string; runId?: string }
export interface LoopDispatchResult { runId: string | null; queued: boolean }
