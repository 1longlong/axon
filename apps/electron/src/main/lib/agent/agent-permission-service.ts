/** Agent 工具权限判定、异步等待、窗口所有权与取消生命周期。 */

import { randomUUID } from 'node:crypto'
import type {
  AgentCanUseTool,
  AgentGenerationEvent,
  AgentPermissionDangerLevel,
  AgentPermissionRequest,
  AgentPermissionResponse,
  AgentToolPermissionResult,
  AgentSubagentType,
} from '@axon/shared'
import { AGENT_MEMORY_EDIT_TOOL_NAMES, AGENT_MEMORY_SAFE_TOOL_NAMES } from '../memory/agent-memory-tools'
import { AGENT_COLLABORATION_SAFE_TOOL_NAMES } from '../collaboration/agent-collaboration-tools'
import { AGENT_TOOL_SEARCH_NAME } from './agent-tool-search'
import { AGENT_SKILL_READ_TOOL_NAME } from '../project/agent-skill-read-tool'

const DEFAULT_PERMISSION_TIMEOUT_MS = 5 * 60 * 1_000
const SAFE_TOOLS = new Set([
  'Read', 'Glob', 'Grep', 'LS', 'AskUserQuestion', AGENT_TOOL_SEARCH_NAME, AGENT_SKILL_READ_TOOL_NAME,
  ...AGENT_MEMORY_SAFE_TOOL_NAMES,
  ...AGENT_COLLABORATION_SAFE_TOOL_NAMES,
])
const EDIT_TOOLS = new Set(['Write', 'Edit', 'MultiEdit', ...AGENT_MEMORY_EDIT_TOOL_NAMES])
const PLAN_MODE_DENIAL = '计划模式只允许读取和分析；请先提交计划并等待用户批准'
const SUBAGENT_READ_TOOLS = new Set([
  'Read', 'Glob', 'Grep', 'LS', 'MemoryList', 'MemoryRead', AGENT_SKILL_READ_TOOL_NAME,
])

type PermissionEvent = Extract<
  AgentGenerationEvent,
  { type: 'permission_request' | 'permission_resolved' }
>

interface PendingPermission {
  owner: number
  request: AgentPermissionRequest
  input: Record<string, unknown>
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

function isSafeReadOnlyCommand(command: string): boolean {
  if (!command || hasShellRisk(command)) return false
  if (/^find(?:\s|$)/.test(command) && /(?:^|\s)-(?:delete|exec|execdir|ok|okdir)(?:\s|$)/.test(command)) return false
  return /^(?:pwd|whoami|uname|ls|head|tail|cat|grep|rg|wc|file|stat|du|df|find|which)(?:\s|$)/.test(command)
    || /^git\s+(?:status|log|diff|show|rev-parse|ls-files|grep)(?:\s|$)/.test(command)
    || /^git\s+(?:branch|tag)(?:\s+(?:--list|-a|-r|-v|-vv|--show-current))*\s*$/.test(command)
    || /^git\s+remote(?:\s+(?:-v|show|get-url)(?:\s+[^\s]+)?)?\s*$/.test(command)
}

function assessDanger(toolName: string, input: Record<string, unknown>): AgentPermissionDangerLevel {
  if (SAFE_TOOLS.has(toolName)) return 'safe'
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

/** 顶层键排序后生成本轮白名单键；Bash 因参数含具体命令，只会复用完全相同的输入。 */
function whitelistKey(toolName: string, input: Record<string, unknown>): string {
  const normalized = Object.fromEntries(Object.entries(input).sort(([left], [right]) => left.localeCompare(right)))
  return `${toolName}:${JSON.stringify(normalized)}`
}

export class AgentPermissionService {
  private readonly pending = new Map<string, PendingPermission>()
  private readonly owners = new Map<string, number>()
  private readonly sessionWhitelists = new Map<string, Set<string>>()
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

  /**
   * 为一轮 Agent 创建权限回调：plan 只允许静态判定的只读操作，安全读取自动通过，
   * acceptEdits 额外允许文件编辑，bypassPermissions 全放行；其余操作进入确认队列。
   */
  createCanUseTool(
    sessionId: string,
    runStartedAt: number,
    runSignal: AbortSignal,
    subagentType?: AgentSubagentType,
  ): AgentCanUseTool {
    return async (toolName, rawInput, options) => {
      const input = cloneRecord(rawInput)
      const allow = (): AgentToolPermissionResult => ({ behavior: 'allow', updatedInput: input })
      // 角色边界是硬限制，必须先于 bypassPermissions；用户授权不能把 explore/plan 变成 coder。
      if (subagentType === 'explore' || subagentType === 'plan') {
        if (SUBAGENT_READ_TOOLS.has(toolName)) return allow()
        if (subagentType === 'explore' && toolName === 'Bash' && isSafeReadOnlyCommand(commandFrom(input))) {
          return allow()
        }
        return {
          behavior: 'deny',
          message: subagentType === 'plan'
            ? 'plan 子 Agent 只允许读取和分析，不能使用 Shell 或修改资源'
            : 'explore 子 Agent 只允许读取、搜索和无副作用命令',
        }
      }
      // plan 必须先于历史白名单和普通确认判断，避免切换模式后沿用旧授权产生写操作。
      if (options.permissionMode === 'plan') {
        if (toolName === 'ExitPlanMode') return allow()
        if (SAFE_TOOLS.has(toolName)) return allow()
        if (toolName === 'Bash' && isSafeReadOnlyCommand(commandFrom(input))) return allow()
        return { behavior: 'deny', message: PLAN_MODE_DENIAL }
      }
      if (toolName === 'ExitPlanMode') {
        return { behavior: 'deny', message: '当前不在计划模式中' }
      }
      if (options.permissionMode === 'bypassPermissions') return allow()
      if (this.isWhitelisted(sessionId, toolName, input)) return allow()
      if (SAFE_TOOLS.has(toolName)) return allow()
      if (toolName === 'Bash' && isSafeReadOnlyCommand(commandFrom(input))) return allow()
      if (options.permissionMode === 'acceptEdits' && EDIT_TOOLS.has(toolName)) return allow()

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
    if (response.behavior === 'allow' && response.alwaysAllow && pending.request.allowAlways) {
      const whitelist = this.sessionWhitelists.get(pending.request.sessionId) ?? new Set<string>()
      whitelist.add(whitelistKey(pending.request.toolName, pending.input))
      this.sessionWhitelists.set(pending.request.sessionId, whitelist)
    }
    this.settle(
      pending,
      response.behavior === 'allow'
        ? { behavior: 'allow', updatedInput }
        : { behavior: 'deny', message: '用户拒绝了此操作' },
      'response',
      response.behavior,
    )
    return true
  }

  clearSessionWhitelist(sessionId: string): void {
    this.sessionWhitelists.delete(sessionId)
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

  private isWhitelisted(sessionId: string, toolName: string, input: Record<string, unknown>): boolean {
    return this.sessionWhitelists.get(sessionId)?.has(whitelistKey(toolName, input)) ?? false
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
    toolSignal?: AbortSignal,
  ): Promise<AgentToolPermissionResult> {
    const createdAt = this.now()
    const request: AgentPermissionRequest = {
      requestId: this.createId(), sessionId, runStartedAt, toolUseId, toolName,
      toolInput: cloneRecord(input), description: describe(toolName, input),
      dangerLevel: assessDanger(toolName, input),
      allowAlways: assessDanger(toolName, input) !== 'dangerous',
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
