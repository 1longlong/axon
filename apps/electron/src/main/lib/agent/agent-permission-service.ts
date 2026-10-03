/** Agent 工具权限判定、异步等待、窗口所有权与取消生命周期。 */

import { randomUUID } from 'node:crypto'
import type {
  AgentCanUseTool,
  AgentGenerationEvent,
  AgentPermissionDangerLevel,
  AgentPermissionRequest,
  AgentPermissionResponse,
  AgentSandboxEscalation,
  AgentSandboxGrant,
  AgentToolPermissionResult,
  AgentToolExecution,
  AgentSubagentType,
} from '@axon/shared'
import { AGENT_SKILL_READ_TOOL_NAME } from '../project/agent-skill-read-tool'
import { evaluateAgentCommandRule } from './agent-command-rules'

const DEFAULT_PERMISSION_TIMEOUT_MS = 5 * 60 * 1_000
const READ_TOOLS = new Set(['Read', 'Glob', 'Grep', 'LS'])
const SUBAGENT_READ_TOOLS = new Set([
  'Read', 'Glob', 'Grep', 'LS', 'MemoryList', 'MemoryRead', AGENT_SKILL_READ_TOOL_NAME,
])
const SANDBOX_ATTEMPT_TOOLS = new Set(['Write', 'Edit', 'MultiEdit'])

type PermissionEvent = Extract<
  AgentGenerationEvent,
  { type: 'permission_request' | 'permission_resolved' }
>

interface PendingPermission {
  owner: number
  request: AgentPermissionRequest
  input: Record<string, unknown>
  toolExecution?: AgentToolExecution
  resolve: (result: AgentToolPermissionResult) => void
  timeout: ReturnType<typeof setTimeout>
  cleanupSignals: () => void
}

export interface AgentPermissionServiceOptions {
  createId?: () => string
  now?: () => number
  timeoutMs?: number
}

function cloneRecord(value: Record<string, unknown>): Record<string, unknown> {
  return JSON.parse(JSON.stringify(value)) as Record<string, unknown>
}

function commandFrom(input: Record<string, unknown>): string {
  return typeof input.command === 'string' ? input.command.trim() : ''
}

function hasShellRisk(command: string): boolean {
  return /(?:^|\s)(?:rm|rmdir|sudo|su|chmod|chown|dd|kill|pkill)\b/i.test(command)
    || /(?:^|\s)git\s+(?:push|reset|clean|rebase|checkout)\b/i.test(command)
    || /[|;&>`]/.test(command)
    || command.includes('$(')
}

function assessDanger(toolName: string, input: Record<string, unknown>): AgentPermissionDangerLevel {
  if (toolName === 'Bash' && hasShellRisk(commandFrom(input))) return 'dangerous'
  return 'normal'
}

function describe(toolName: string, input: Record<string, unknown>): string {
  if (toolName === 'Bash') return commandFrom(input) ? `执行命令：${commandFrom(input).slice(0, 300)}` : '执行命令'
  const path = typeof input.file_path === 'string' ? input.file_path : undefined
  const memoryPath = typeof input.path === 'string' ? input.path : undefined
  if (toolName === 'MemoryList') return '列出项目记忆文件'
  if (toolName === 'MemoryRead') return memoryPath ? `读取项目记忆：${memoryPath}` : '读取项目记忆'
  if (toolName === 'MemoryWrite') return memoryPath ? `写入项目记忆：${memoryPath}` : '写入项目记忆'
  if (toolName === 'TaskStop') return '停止后台 Agent 任务'
  if (toolName === 'Write') return path ? `写入文件：${path}` : '写入文件'
  if (toolName === 'Edit' || toolName === 'MultiEdit') return path ? `编辑文件：${path}` : '编辑文件'
  return `使用工具：${toolName}`
}

function describeEscalation(escalation: AgentSandboxEscalation): string {
  if (escalation.reason === 'protectedPathWrite') return `写入受保护路径：${escalation.target ?? '未知路径'}`
  if (escalation.reason === 'filesystemWriteOutsideWorkspace') {
    return `写入工作区外路径：${escalation.target ?? '未知路径'}`
  }
  return '允许命令访问网络'
}

function permissionKey(
  toolName: string,
  input: Record<string, unknown>,
  escalation: AgentSandboxEscalation,
): string {
  const permission = escalation.permission
  return permission.type === 'network'
    ? `network:${whitelistKey(toolName, input)}`
    : `filesystemWrite:${[...permission.roots].sort().join('\0')}`
}

function cloneEscalation(escalation: AgentSandboxEscalation): AgentSandboxEscalation {
  return {
    ...escalation,
    permission: escalation.permission.type === 'network'
      ? { type: 'network' }
      : { type: 'filesystemWrite', roots: [...escalation.permission.roots] },
  }
}

/** 会话白名单绑定执行边界与排序后的输入，避免同名工具跨来源复用批准。 */
function whitelistKey(toolName: string, input: Record<string, unknown>, toolExecution?: AgentToolExecution): string {
  const normalized = Object.fromEntries(Object.entries(input).sort(([left], [right]) => left.localeCompare(right)))
  return `${JSON.stringify(toolExecution ?? null)}:${toolName}:${JSON.stringify(normalized)}`
}

export class AgentPermissionService {
  private readonly pending = new Map<string, PendingPermission>()
  private readonly owners = new Map<string, number>()
  private readonly sessionWhitelists = new Map<string, Set<string>>()
  private readonly sessionSandboxGrants = new Map<string, Map<string, AgentSandboxGrant>>()
  private readonly listeners = new Set<(event: PermissionEvent) => void>()
  private readonly createId: () => string
  private readonly now: () => number
  private readonly timeoutMs: number

  constructor(options: AgentPermissionServiceOptions = {}) {
    this.createId = options.createId ?? randomUUID
    this.now = options.now ?? Date.now
    this.timeoutMs = options.timeoutMs ?? DEFAULT_PERMISSION_TIMEOUT_MS
  }

  subscribe(listener: (event: PermissionEvent) => void): () => void {
    this.listeners.add(listener)
    return () => this.listeners.delete(listener)
  }

  /** IPC 在运行前绑定 owner；已被其他窗口占用的会话不能静默改绑。 */
  bindOwner(sessionId: string, owner: number): boolean {
    const existing = this.owners.get(sessionId)
    if (existing !== undefined && existing !== owner) return false
    this.owners.set(sessionId, owner)
    return true
  }

  /** 协作编排只读取父会话 owner 并传给子会话，不向 renderer 暴露该映射。 */
  getOwner(sessionId: string): number | undefined {
    return this.owners.get(sessionId)
  }

  /** 只允许当前 owner 解绑，并拒绝该会话尚未答复的全部请求。 */
  unbindOwner(sessionId: string, owner: number): void {
    if (this.owners.get(sessionId) !== owner) return
    this.owners.delete(sessionId)
    this.cancelSession(sessionId, 'owner_gone', '权限请求所属窗口已关闭')
  }

  /** 为一轮 Agent 创建权限回调；角色硬边界先于沙箱升级和普通用户审批。 */
  createCanUseTool(
    sessionId: string,
    runStartedAt: number,
    runSignal: AbortSignal,
    subagentType?: AgentSubagentType,
  ): AgentCanUseTool {
    return async (toolName, rawInput, options) => {
      const input = cloneRecord(rawInput)
      const allow = (): AgentToolPermissionResult => ({ behavior: 'allow', updatedInput: input })
      const commandRule = toolName === 'Bash'
        ? evaluateAgentCommandRule(commandFrom(input))
        : undefined
      const execution = options.toolExecution
      const sandboxed = execution?.kind === 'sandbox' && execution.mode === options.executionPolicy.sandboxMode
      const nativeRead = READ_TOOLS.has(toolName) && (sandboxed || execution?.kind === 'runtime')
      const managedHost = execution?.kind === 'host' && execution.permissionMode === 'managed'
      if (runSignal.aborted || options.signal?.aborted) {
        return { behavior: 'deny', message: 'Agent 运行已停止' }
      }
      // 角色边界是硬限制；用户授权不能把 explore/plan 变成 coder。
      if (subagentType === 'explore' || subagentType === 'plan') {
        if (!options.sandboxEscalation && (nativeRead || managedHost && SUBAGENT_READ_TOOLS.has(toolName))) return allow()
        if (subagentType === 'explore' && sandboxed && execution.mode === 'readOnly'
          && commandRule?.decision === 'allow' && !options.sandboxEscalation) {
          return allow()
        }
        return {
          behavior: 'deny',
          message: subagentType === 'plan'
            ? 'plan 子 Agent 只允许读取和分析，不能使用 Shell 或修改资源'
            : 'explore 子 Agent 只允许读取、搜索和受只读沙箱保护的命令',
        }
      }
      // forbidden 是不可由历史白名单或用户审批覆盖的硬规则，必须先于二者判断。
      if (commandRule?.decision === 'forbidden') {
        return { behavior: 'deny', message: `命令规则禁止执行：${commandRule.reason}` }
      }
      if (options.sandboxEscalation) {
        if (!sandboxed) return { behavior: 'deny', message: '该工具没有宿主沙箱，不能申请沙箱升级权限' }
        const existingGrant = this.sessionSandboxGrants.get(sessionId)
          ?.get(permissionKey(toolName, input, options.sandboxEscalation))
        if (existingGrant) return { ...allow(), sandboxGrants: [existingGrant] }
        const owner = this.owners.get(sessionId)
        if (owner === undefined || runSignal.aborted || options.signal?.aborted) {
          return { behavior: 'deny', message: '沙箱升级确认不可用或运行已停止' }
        }
        return this.waitForDecision(
          owner,
          sessionId,
          runStartedAt,
          toolName,
          input,
          options.toolUseId,
          runSignal,
          execution,
          options.signal,
          options.sandboxEscalation,
        )
      }
      if (this.isWhitelisted(sessionId, toolName, input, execution)) return allow()
      if (nativeRead || managedHost) return allow()
      if (sandboxed && commandRule?.decision === 'allow') return allow()
      // 只有真实宿主文件工具可直接尝试；同名自定义工具或 runtime 原生写入必须普通审批。
      if (sandboxed && SANDBOX_ATTEMPT_TOOLS.has(toolName)) {
        const grants = [...(this.sessionSandboxGrants.get(sessionId)?.values() ?? [])]
          .filter((grant) => grant.permission.type === 'filesystemWrite')
        return { ...allow(), ...(grants.length > 0 ? { sandboxGrants: grants } : {}) }
      }
      const owner = this.owners.get(sessionId)
      if (owner === undefined || runSignal.aborted || options.signal?.aborted) {
        return { behavior: 'deny', message: '权限确认不可用或运行已停止' }
      }
      return this.waitForDecision(
        owner,
        sessionId,
        runStartedAt,
        toolName,
        input,
        options.toolUseId,
        runSignal,
        execution,
        options.signal,
      )
    }
  }

  /** 仅当前运行窗口能答复；重复、过期或跨窗口响应返回 false。 */
  respond(owner: number, response: AgentPermissionResponse): boolean {
    const pending = this.pending.get(response.requestId)
    if (!pending || pending.owner !== owner) return false
    const updatedInput = response.updatedInput
      ? cloneRecord(response.updatedInput)
      : cloneRecord(pending.input)
    const updatedCommandRule = pending.request.toolName === 'Bash'
      ? evaluateAgentCommandRule(commandFrom(updatedInput))
      : undefined
    // renderer 可修正输入，但最终输入仍要重新过硬规则，不能借审批响应绕过 forbidden。
    if (response.behavior === 'allow' && updatedCommandRule?.decision === 'forbidden') {
      this.settle(
        pending,
        { behavior: 'deny', message: `命令规则禁止执行：${updatedCommandRule.reason}` },
        'response',
        'deny',
      )
      return true
    }
    const escalation = pending.request.sandboxEscalation
    let sandboxGrants: AgentSandboxGrant[] | undefined
    if (response.behavior === 'allow' && escalation) {
      const grant: AgentSandboxGrant = {
        scope: response.alwaysAllow && pending.request.allowAlways ? 'session' : 'once',
        permission: escalation.permission,
      }
      sandboxGrants = [grant]
      if (grant.scope === 'session') {
        const grants = this.sessionSandboxGrants.get(pending.request.sessionId) ?? new Map<string, AgentSandboxGrant>()
        grants.set(permissionKey(pending.request.toolName, updatedInput, escalation), grant)
        this.sessionSandboxGrants.set(pending.request.sessionId, grants)
      }
    }
    if (response.behavior === 'allow' && response.alwaysAllow && pending.request.allowAlways && !escalation) {
      const whitelist = this.sessionWhitelists.get(pending.request.sessionId) ?? new Set<string>()
      whitelist.add(whitelistKey(pending.request.toolName, updatedInput, pending.toolExecution))
      this.sessionWhitelists.set(pending.request.sessionId, whitelist)
    }
    this.settle(
      pending,
      response.behavior === 'allow'
        ? { behavior: 'allow', updatedInput, ...(sandboxGrants ? { sandboxGrants } : {}) }
        : { behavior: 'deny', message: '用户拒绝了此操作' },
      'response',
      response.behavior,
    )
    return true
  }

  clearSessionWhitelist(sessionId: string): void {
    this.sessionWhitelists.delete(sessionId)
    this.sessionSandboxGrants.delete(sessionId)
  }

  /** 停止、结束或 owner 消失时统一清理，防止 runtime 永久等待。 */
  cancelSession(
    sessionId: string,
    reason: 'aborted' | 'owner_gone' = 'aborted',
    message = 'Agent 运行已停止',
  ): number {
    const matches = [...this.pending.values()].filter((item) => item.request.sessionId === sessionId)
    for (const item of matches) this.settle(item, { behavior: 'deny', message }, reason, 'deny')
    return matches.length
  }

  private isWhitelisted(sessionId: string, toolName: string, input: Record<string, unknown>, toolExecution?: AgentToolExecution): boolean {
    return this.sessionWhitelists.get(sessionId)?.has(whitelistKey(toolName, input, toolExecution)) ?? false
  }

  /** 先登记 pending 再广播请求，避免极快响应早于 Map 写入。 */
  private waitForDecision(
    owner: number,
    sessionId: string,
    runStartedAt: number,
    toolName: string,
    input: Record<string, unknown>,
    toolUseId: string,
    runSignal: AbortSignal,
    toolExecution?: AgentToolExecution,
    toolSignal?: AbortSignal,
    sandboxEscalation?: AgentSandboxEscalation,
  ): Promise<AgentToolPermissionResult> {
    const createdAt = this.now()
    const request: AgentPermissionRequest = {
      requestId: this.createId(), sessionId, runStartedAt, toolUseId, toolName,
      toolInput: cloneRecord(input),
      description: sandboxEscalation ? describeEscalation(sandboxEscalation) : describe(toolName, input),
      dangerLevel: assessDanger(toolName, input),
      allowAlways: assessDanger(toolName, input) !== 'dangerous',
      ...(sandboxEscalation ? { sandboxEscalation: cloneEscalation(sandboxEscalation) } : {}),
      createdAt, expiresAt: createdAt + this.timeoutMs,
    }
    return new Promise((resolve) => {
      const abort = (): void => {
        const item = this.pending.get(request.requestId)
        if (item) this.settle(item, { behavior: 'deny', message: 'Agent 运行已停止' }, 'aborted', 'deny')
      }
      runSignal.addEventListener('abort', abort, { once: true })
      toolSignal?.addEventListener('abort', abort, { once: true })
      const cleanupSignals = (): void => {
        runSignal.removeEventListener('abort', abort)
        toolSignal?.removeEventListener('abort', abort)
      }
      const pending: PendingPermission = {
        owner,
        request,
        input,
        toolExecution,
        resolve,
        cleanupSignals,
        timeout: setTimeout(() => {
          const item = this.pending.get(request.requestId)
          if (item) this.settle(item, { behavior: 'deny', message: '权限确认已超时' }, 'timeout', 'deny')
        }, this.timeoutMs),
      }
      this.pending.set(request.requestId, pending)
      this.emit({ type: 'permission_request', sessionId, runStartedAt, request })
    })
  }

  private settle(
    pending: PendingPermission,
    result: AgentToolPermissionResult,
    reason: 'response' | 'aborted' | 'timeout' | 'owner_gone',
    behavior: 'allow' | 'deny',
  ): void {
    if (!this.pending.delete(pending.request.requestId)) return
    clearTimeout(pending.timeout)
    pending.cleanupSignals()
    pending.resolve(result)
    this.emit({
      type: 'permission_resolved',
      sessionId: pending.request.sessionId,
      runStartedAt: pending.request.runStartedAt,
      requestId: pending.request.requestId,
      behavior,
      reason,
    })
  }

  /** 监听器故障不能阻断权限 Promise 的收束。 */
  private emit(event: PermissionEvent): void {
    for (const listener of this.listeners) {
      try { listener(event) } catch { console.warn('[Agent 权限] 监听器处理失败') }
    }
  }
}

let permissionService: AgentPermissionService | null = null

export function getAgentPermissionService(): AgentPermissionService {
  permissionService ??= new AgentPermissionService()
  return permissionService
}
