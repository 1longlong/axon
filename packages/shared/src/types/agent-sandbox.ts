/** Agent 本地工具沙箱的 Runtime 中立契约；具体 Seatbelt profile 只由主进程实现。 */

export type AgentSandboxPlatform = 'macos'
export type AgentSandboxMode = 'readOnly' | 'workspaceWrite'
export type AgentApprovalPolicy = 'onRequest'
export type AgentApprovalReviewer = 'user' | 'autoReview'

export type AgentSandboxCapabilityLimitation =
  | 'hostExecutorUnavailable'
  | 'partialToolDelegation'
  | 'runtimeToolDelegationUnavailable'
  | 'platformUnsupported'

export type AgentSandboxedToolName = 'bash' | 'read' | 'write' | 'edit' | 'grep' | 'glob' | 'ls'

/** adapter 对宿主 OS 沙箱的能力声明；未明确支持时，编排层不得假定命令已受隔离。 */
export interface AgentSandboxCapability {
  /** 只有所有本地副作用工具都被覆盖时才为 true。 */
  supported: boolean
  modes: AgentSandboxMode[]
  sandboxedTools: AgentSandboxedToolName[]
  limitation?: AgentSandboxCapabilityLimitation
}

export interface AgentSandboxCapabilityInput {
  platform: AgentSandboxPlatform
}

export interface AgentSandboxFullReadAccess {
  type: 'fullAccess'
}

/** 一轮查询的基础能力边界；protectedReadOnlyRoots 优先于更宽的 writableRoots。 */
export interface AgentSandboxPolicy {
  platform: AgentSandboxPlatform
  mode: AgentSandboxMode
  /** 项目管理器解析出的可信项目根；命令 cwd 只能位于其中。 */
  workingDirectory: string
  readAccess: AgentSandboxFullReadAccess
  writableRoots: string[]
  protectedReadOnlyRoots: string[]
  networkAccess: boolean
}

/** 越过基础策略时可申请的最小权限单元。 */
export type AgentSandboxPermission =
  | { type: 'filesystemWrite'; roots: string[] }
  | { type: 'network' }

export type AgentSandboxEscalationReason =
  | 'filesystemWriteOutsideWorkspace'
  | 'protectedPathWrite'
  | 'networkAccess'

/** 宿主发现基础策略不足时返回的最小升级请求；审批层只能授予这里声明的权限。 */
export interface AgentSandboxEscalation {
  reason: AgentSandboxEscalationReason
  permission: AgentSandboxPermission
  target?: string
  message: string
}

/** 穿过 adapter 的中立控制流错误，不代表工具自身执行失败。 */
export class AgentSandboxEscalationError extends Error {
  constructor(readonly escalation: AgentSandboxEscalation) {
    super(escalation.message)
    this.name = 'AgentSandboxEscalationError'
  }
}

export type AgentSandboxGrantScope = 'once' | 'session'

export interface AgentSandboxGrant {
  scope: AgentSandboxGrantScope
  permission: AgentSandboxPermission
}

/** 宿主命令执行输入始终使用 argv，禁止 adapter 拼接 Seatbelt profile 或 shell 包装串。 */
export interface AgentSandboxCommandRequest {
  argv: string[]
  cwd: string
  policy: AgentSandboxPolicy
  grants: AgentSandboxGrant[]
  environment?: Record<string, string | undefined>
  timeoutMs?: number
  abortSignal?: AbortSignal
}

/** 原始 Shell 请求由宿主选择解释器；adapter 不生成启动 argv 或快照包装脚本。 */
export interface AgentSandboxShellCommandRequest extends Omit<AgentSandboxCommandRequest, 'argv'> {
  command: string
  /** 默认采用登录启动语义；非登录请求不应套用登录环境快照。 */
  login?: boolean
  /** 与完整初始环境分开；只让明确覆盖项在快照恢复后胜出，undefined 表示删除。 */
  environmentOverrides?: Record<string, string | undefined>
  /** 宿主或 runtime 管理的程序目录，在恢复 PATH 后重新前置。 */
  pathPrepend?: string[]
}

export interface AgentSandboxCommandOutputHandlers {
  onStdout?: (chunk: string) => void
  onStderr?: (chunk: string) => void
}

export interface AgentSandboxFileContext {
  policy: AgentSandboxPolicy
  grants: AgentSandboxGrant[]
  abortSignal?: AbortSignal
}

export interface AgentSandboxPathStat {
  isDirectory: boolean
  size: number
}

export interface AgentSandboxGlobOptions {
  ignore: string[]
  limit: number
}

export interface AgentSandboxTextSearchOptions {
  pattern: string
  glob?: string
  ignoreCase?: boolean
  literal?: boolean
  context?: number
  limit: number
}

export interface AgentSandboxTextSearchMatch {
  path: string
  line: number
  text: string
  before: string[]
  after: string[]
}

export interface AgentSandboxTextSearchResult {
  matches: AgentSandboxTextSearchMatch[]
  limitReached: boolean
}

/** adapter 只能通过这个中立端口请求宿主执行命令或文件操作，不能直接接触 Seatbelt 实现。 */
export interface AgentHostToolExecutionPort {
  /** 报告实际宿主保护能力；端口存在不等于 OS 沙箱可用。 */
  getSandboxCapability(): AgentSandboxCapability
  initializeShellEnvironment(input: { sessionId: string; cwd: string }): AgentHostShellEnvironment
  executeShellCommand(
    request: AgentSandboxShellCommandRequest,
    handlers?: AgentSandboxCommandOutputHandlers,
  ): Promise<AgentSandboxCommandResult>
  executeCommand(
    request: AgentSandboxCommandRequest,
    handlers?: AgentSandboxCommandOutputHandlers,
  ): Promise<AgentSandboxCommandResult>
  readFile(path: string, context: AgentSandboxFileContext): Promise<Buffer>
  assertFileAccess(path: string, access: 'read' | 'write', context: AgentSandboxFileContext): Promise<void>
  writeFile(path: string, content: string, context: AgentSandboxFileContext): Promise<void>
  createDirectory(path: string, context: AgentSandboxFileContext): Promise<void>
  pathExists(path: string, context: AgentSandboxFileContext): Promise<boolean>
  statPath(path: string, context: AgentSandboxFileContext): Promise<AgentSandboxPathStat>
  readDirectory(path: string, context: AgentSandboxFileContext): Promise<string[]>
  glob(pattern: string, cwd: string, options: AgentSandboxGlobOptions, context: AgentSandboxFileContext): Promise<string[]>
  searchText(
    path: string,
    options: AgentSandboxTextSearchOptions,
    context: AgentSandboxFileContext,
  ): Promise<AgentSandboxTextSearchResult>
  detectImageMimeType(path: string, context: AgentSandboxFileContext): Promise<string | undefined>
}

/** 会话持有宿主环境的引用；不暴露 Shell 类型、快照内容或内部文件路径。 */
export interface AgentHostShellEnvironment {
  executeShellCommand(
    request: AgentSandboxShellCommandRequest,
    handlers?: AgentSandboxCommandOutputHandlers,
  ): Promise<AgentSandboxCommandResult>
  dispose(): void
}

export interface AgentSandboxCommandResult {
  exitCode: number | null
  terminationSignal?: string
  timedOut: boolean
  aborted: boolean
  stdout: string
  stderr: string
  stdoutTruncated: boolean
  stderrTruncated: boolean
}
