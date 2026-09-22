/** Agent 子任务生命周期与关联持久化；不启动 runtime，也不保存子会话正文。 */

import { randomUUID } from 'node:crypto'
import {
  MAX_AGENT_DELEGATION_CONCURRENCY,
  MAX_AGENT_DELEGATION_DEPTH,
  MAX_AGENT_DELEGATION_OBJECTIVE_LENGTH,
  MAX_AGENT_DELEGATION_PROGRESS_LENGTH,
  MAX_AGENT_DELEGATION_RESULT_LENGTH,
  MAX_AGENT_DELEGATION_TITLE_LENGTH,
  MAX_AGENT_DELEGATIONS_PER_ROOT,
  isAgentDelegationTerminal,
} from '@axon/shared'
import type {
  AgentDelegation,
  AgentDelegationBlockReason,
  AgentDelegationCreateInput,
  AgentDelegationStatus,
  AgentDelegationTransitionInput,
  AgentErrorCategory,
  AgentTypedError,
  AgentTaskChangedEvent,
} from '@axon/shared'
import { AgentRootStateStore } from '../agent/agent-root-state-store'

const MAX_STORED_DELEGATIONS = 10_000
const ID_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/
const STATUSES: readonly AgentDelegationStatus[] = [
  'queued', 'running', 'blocked', 'completed', 'failed', 'canceled', 'interrupted',
]
const BLOCK_REASONS: readonly AgentDelegationBlockReason[] = ['permission', 'ask_user', 'plan_approval']
const SUBAGENT_TYPES = ['coder', 'explore', 'plan'] as const
const ERROR_CATEGORIES: readonly AgentErrorCategory[] = [
  'network', 'provider', 'protocol', 'context', 'runtime', 'configuration',
  'workspace', 'permission', 'persistence', 'canceled', 'unknown',
]
const ALLOWED_TRANSITIONS: Readonly<Record<AgentDelegationStatus, readonly AgentDelegationStatus[]>> = {
  queued: ['running', 'failed', 'canceled', 'interrupted'],
  running: ['blocked', 'completed', 'failed', 'canceled', 'interrupted'],
  blocked: ['running', 'failed', 'canceled', 'interrupted'],
  completed: [],
  failed: [],
  canceled: [],
  interrupted: [],
}

export class AgentDelegationManagerError extends Error {
  constructor(
    readonly code: 'invalid_input' | 'not_found' | 'duplicate' | 'limit_reached' | 'invalid_transition' | 'storage_error',
    message: string,
  ) {
    super(message)
    this.name = 'AgentDelegationManagerError'
  }
}

export interface AgentDelegationManagerOptions {
  sessionsDir?: string
  stateStore?: AgentRootStateStore
  createId?: () => string
  now?: () => number
}

function cloneJson<T>(value: T): T {
  return JSON.parse(JSON.stringify(value)) as T
}

function normalizeId(value: unknown, label: string): string {
  if (typeof value !== 'string' || !ID_PATTERN.test(value)) {
    throw new AgentDelegationManagerError('invalid_input', `${label}格式无效`)
  }
  return value
}

function normalizeText(value: unknown, label: string, maxLength: number): string {
  if (typeof value !== 'string' || !value.trim() || value.length > maxLength) {
    throw new AgentDelegationManagerError('invalid_input', `${label}格式无效`)
  }
  return value.trim()
}

function normalizeOptionalText(value: unknown, label: string, maxLength: number): string | undefined {
  if (value === undefined || value === null) return undefined
  return normalizeText(value, label, maxLength)
}

function normalizeTimestamp(value: unknown, label: string): number {
  if (typeof value !== 'number' || !Number.isFinite(value) || value < 0) {
    throw new AgentDelegationManagerError('invalid_input', `${label}无效`)
  }
  return value
}

function normalizeBoolean(value: unknown, label: string): boolean {
  if (typeof value !== 'boolean') {
    throw new AgentDelegationManagerError('invalid_input', `${label}无效`)
  }
  return value
}

function normalizeSubagentType(value: unknown): AgentDelegation['subagentType'] {
  if (typeof value !== 'string' || !SUBAGENT_TYPES.includes(value as AgentDelegation['subagentType'])) {
    throw new AgentDelegationManagerError('invalid_input', '子 Agent 类型无效')
  }
  return value as AgentDelegation['subagentType']
}

function normalizeTypedError(value: unknown): AgentTypedError {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    throw new AgentDelegationManagerError('invalid_input', '子任务错误无效')
  }
  const error = value as Record<string, unknown>
  if (
    typeof error.code !== 'string' || !error.code || error.code.length > 128
    || typeof error.category !== 'string' || !ERROR_CATEGORIES.includes(error.category as AgentErrorCategory)
    || typeof error.message !== 'string' || !error.message || error.message.length > 4_000
    || typeof error.retryable !== 'boolean'
  ) throw new AgentDelegationManagerError('invalid_input', '子任务错误无效')
  return {
    code: error.code,
    category: error.category as AgentErrorCategory,
    message: error.message,
    retryable: error.retryable,
  }
}

/** 从磁盘恢复时重新校验状态相关字段，坏记录不会污染其余委派。 */
function normalizeDelegation(value: unknown): AgentDelegation {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    throw new AgentDelegationManagerError('invalid_input', '子任务记录无效')
  }
  const raw = value as Record<string, unknown>
  const status = raw.status
  if (typeof status !== 'string' || !STATUSES.includes(status as AgentDelegationStatus)) {
    throw new AgentDelegationManagerError('invalid_input', '子任务状态无效')
  }
  const depth = raw.depth
  if (!Number.isSafeInteger(depth) || (depth as number) < 1 || (depth as number) > MAX_AGENT_DELEGATION_DEPTH) {
    throw new AgentDelegationManagerError('invalid_input', '子任务深度无效')
  }
  const createdAt = normalizeTimestamp(raw.createdAt, '子任务创建时间')
  const updatedAt = normalizeTimestamp(raw.updatedAt, '子任务更新时间')
  const startedAt = raw.startedAt === undefined ? undefined : normalizeTimestamp(raw.startedAt, '子任务开始时间')
  const finishedAt = raw.finishedAt === undefined ? undefined : normalizeTimestamp(raw.finishedAt, '子任务结束时间')
  const blockedReason = raw.blockedReason
  if (
    blockedReason !== undefined
    && (typeof blockedReason !== 'string' || !BLOCK_REASONS.includes(blockedReason as AgentDelegationBlockReason))
  ) throw new AgentDelegationManagerError('invalid_input', '子任务阻塞原因无效')
  const normalizedStatus = status as AgentDelegationStatus
  const resultSummary = normalizeOptionalText(raw.resultSummary, '子任务结果', MAX_AGENT_DELEGATION_RESULT_LENGTH)
  const error = raw.error === undefined ? undefined : normalizeTypedError(raw.error)
  const rootSessionId = normalizeId(raw.rootSessionId, '根会话 ID')
  const parentSessionId = normalizeId(raw.parentSessionId, '父会话 ID')
  const childSessionId = normalizeId(raw.childSessionId, '子会话 ID')
  if (
    updatedAt < createdAt
    || (startedAt !== undefined && (startedAt < createdAt || startedAt > updatedAt))
    || (finishedAt !== undefined && (finishedAt < createdAt || finishedAt > updatedAt))
    || ((normalizedStatus === 'running' || normalizedStatus === 'blocked') && startedAt === undefined)
    || (normalizedStatus === 'blocked' && blockedReason === undefined)
    || (normalizedStatus === 'completed' && (!resultSummary || finishedAt === undefined))
    || (normalizedStatus === 'failed' && (!error || finishedAt === undefined))
    || ((normalizedStatus === 'canceled' || normalizedStatus === 'interrupted') && finishedAt === undefined)
    || (!isAgentDelegationTerminal(normalizedStatus) && finishedAt !== undefined)
    || (normalizedStatus !== 'blocked' && blockedReason !== undefined)
    || (normalizedStatus !== 'completed' && resultSummary !== undefined)
    || (normalizedStatus !== 'failed' && error !== undefined)
    || rootSessionId === childSessionId
    || parentSessionId === childSessionId
  ) throw new AgentDelegationManagerError('invalid_input', '子任务状态字段不完整')
  return {
    id: normalizeId(raw.id, '子任务 ID'),
    rootSessionId,
    parentSessionId,
    childSessionId,
    parentToolUseId: normalizeText(raw.parentToolUseId, '父工具调用 ID', 512),
    title: normalizeText(raw.title, '子任务标题', MAX_AGENT_DELEGATION_TITLE_LENGTH),
    objective: normalizeText(raw.objective, '子任务目标', MAX_AGENT_DELEGATION_OBJECTIVE_LENGTH),
    subagentType: normalizeSubagentType(raw.subagentType),
    runInBackground: normalizeBoolean(raw.runInBackground, '子任务运行模式'),
    depth: depth as number,
    status: normalizedStatus,
    ...(raw.latestProgress === undefined ? {} : {
      latestProgress: normalizeText(raw.latestProgress, '子任务进度', MAX_AGENT_DELEGATION_PROGRESS_LENGTH),
    }),
    ...(blockedReason === undefined ? {} : { blockedReason: blockedReason as AgentDelegationBlockReason }),
    ...(resultSummary === undefined ? {} : { resultSummary }),
    ...(error === undefined ? {} : { error }),
    createdAt,
    updatedAt,
    ...(startedAt === undefined ? {} : { startedAt }),
    ...(finishedAt === undefined ? {} : { finishedAt }),
  }
}

/** state.json 以内含目录作为根作用域，只持久化会话内不可推导字段。 */
function normalizeStoredTask(rootSessionId: string, value: unknown): AgentDelegation {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    throw new AgentDelegationManagerError('invalid_input', '子任务记录无效')
  }
  const raw = value as Record<string, unknown>
  return normalizeDelegation({
    ...raw,
    rootSessionId,
    parentSessionId: rootSessionId,
    childSessionId: raw.agentId,
    depth: 1,
  })
}

function toStoredTask(delegation: AgentDelegation): Record<string, unknown> {
  const stored = { ...delegation, agentId: delegation.childSessionId } as Record<string, unknown>
  delete stored.rootSessionId
  delete stored.parentSessionId
  delete stored.childSessionId
  delete stored.depth
  return stored
}

export class AgentDelegationManager {
  private readonly stateStore: AgentRootStateStore
  private readonly createId: () => string
  private readonly now: () => number
  private readonly listeners = new Set<(event: AgentTaskChangedEvent) => void>()

  constructor(options: AgentDelegationManagerOptions) {
    if (!options.sessionsDir && !options.stateStore) throw new Error('缺少 Agent 会话目录')
    this.stateStore = options.stateStore ?? new AgentRootStateStore(options.sessionsDir!)
    this.createId = options.createId ?? randomUUID
    this.now = options.now ?? Date.now
  }

  subscribe(listener: (event: AgentTaskChangedEvent) => void): () => void {
    this.listeners.add(listener)
    return () => this.listeners.delete(listener)
  }

  list(rootSessionId?: string): AgentDelegation[] {
    const normalizedRootId = rootSessionId === undefined ? undefined : normalizeId(rootSessionId, '根会话 ID')
    const roots = normalizedRootId ? [normalizedRootId] : this.stateStore.listRootIds()
    return roots.flatMap((rootId) => this.readRoot(rootId))
      .map((item) => cloneJson(item))
      .sort((left, right) => left.createdAt - right.createdAt)
  }

  get(id: string): AgentDelegation | undefined {
    const normalizedId = normalizeId(id, '子任务 ID')
    const item = this.list().find((delegation) => delegation.id === normalizedId)
    return item ? cloneJson(item) : undefined
  }

  /**
   * 建立父工具调用、子会话与根任务的唯一关联，初态固定为 queued。
   * 编排层应先创建子会话，再调用本函数；失败时由编排层回收子会话。
   */
  create(input: AgentDelegationCreateInput): AgentDelegation {
    const all = this.list()
    if (all.length >= MAX_STORED_DELEGATIONS) {
      throw new AgentDelegationManagerError('limit_reached', '子任务历史数量已达上限')
    }
    const rootSessionId = normalizeId(input.rootSessionId, '根会话 ID')
    const parentSessionId = normalizeId(input.parentSessionId, '父会话 ID')
    const childSessionId = normalizeId(input.childSessionId, '子会话 ID')
    const parentToolUseId = normalizeText(input.parentToolUseId, '父工具调用 ID', 512)
    if (rootSessionId === childSessionId || parentSessionId === childSessionId) {
      throw new AgentDelegationManagerError('invalid_input', '子会话不能引用自身')
    }
    if (
      !Number.isSafeInteger(input.depth)
      || input.depth < 1
      || input.depth > MAX_AGENT_DELEGATION_DEPTH
    ) throw new AgentDelegationManagerError('limit_reached', '子任务委派深度已达上限')
    if (
      all.some((item) => item.childSessionId === childSessionId)
      || all.some((item) => (
        item.parentSessionId === parentSessionId && item.parentToolUseId === parentToolUseId
      ))
    ) throw new AgentDelegationManagerError('duplicate', '子任务关联已存在')
    const rootTasks = this.readRoot(rootSessionId)
    const activeCount = rootTasks.filter((item) => (
      item.rootSessionId === rootSessionId && !isAgentDelegationTerminal(item.status)
    )).length
    if (activeCount >= MAX_AGENT_DELEGATIONS_PER_ROOT) {
      throw new AgentDelegationManagerError('limit_reached', '根任务的未结束子任务数量已达上限')
    }
    const timestamp = this.currentTimestamp()
    const delegation: AgentDelegation = {
      id: this.createUniqueId(all),
      rootSessionId,
      parentSessionId,
      childSessionId,
      parentToolUseId,
      title: normalizeText(input.title, '子任务标题', MAX_AGENT_DELEGATION_TITLE_LENGTH),
      objective: normalizeText(input.objective, '子任务目标', MAX_AGENT_DELEGATION_OBJECTIVE_LENGTH),
      subagentType: normalizeSubagentType(input.subagentType),
      runInBackground: normalizeBoolean(input.runInBackground, '子任务运行模式'),
      depth: input.depth,
      status: 'queued',
      createdAt: timestamp,
      updatedAt: timestamp,
    }
    this.writeRoot(rootSessionId, [...rootTasks, delegation])
    this.emitChanged(delegation)
    return cloneJson(delegation)
  }

  /** 状态机只接受显式合法转换；终态不可复活，running 受根任务并发上限约束。 */
  transition(id: string, input: AgentDelegationTransitionInput): AgentDelegation {
    const normalizedId = normalizeId(id, '子任务 ID')
    const existing = this.get(normalizedId)
    if (!existing) throw new AgentDelegationManagerError('not_found', '子任务不存在')
    const tasks = this.readRoot(existing.rootSessionId)
    const position = tasks.findIndex((item) => item.id === normalizedId)
    if (!ALLOWED_TRANSITIONS[existing.status].includes(input.status)) {
      throw new AgentDelegationManagerError('invalid_transition', `不能从 ${existing.status} 转换到 ${input.status}`)
    }
    if (input.status === 'running') {
      const runningCount = tasks.filter((item) => (
        item.id !== existing.id
        && item.rootSessionId === existing.rootSessionId
        && (item.status === 'running' || item.status === 'blocked')
      )).length
      if (runningCount >= MAX_AGENT_DELEGATION_CONCURRENCY) {
        throw new AgentDelegationManagerError('limit_reached', '根任务的子 Agent 并发已达上限')
      }
    }

    // 先统一清理旧状态的专属字段，再按目标状态补齐，避免 blocked 信息泄漏到终态。
    const timestamp = Math.max(existing.updatedAt, this.currentTimestamp())
    const latestProgress = input.latestProgress === undefined
      ? existing.latestProgress
      : normalizeText(input.latestProgress, '子任务进度', MAX_AGENT_DELEGATION_PROGRESS_LENGTH)
    const updated: AgentDelegation = {
      ...existing,
      status: input.status,
      ...(latestProgress === undefined ? {} : { latestProgress }),
      updatedAt: timestamp,
      ...(existing.startedAt === undefined && input.status === 'running' ? { startedAt: timestamp } : {}),
      ...(isAgentDelegationTerminal(input.status) ? { finishedAt: timestamp } : {}),
    }
    delete updated.blockedReason
    delete updated.resultSummary
    delete updated.error
    if (input.status === 'blocked') updated.blockedReason = input.blockedReason
    if (input.status === 'completed') {
      updated.resultSummary = normalizeText(input.resultSummary, '子任务结果', MAX_AGENT_DELEGATION_RESULT_LENGTH)
    }
    if (input.status === 'failed') updated.error = normalizeTypedError(input.error)
    tasks[position] = updated
    this.writeRoot(existing.rootSessionId, tasks)
    this.emitChanged(updated)
    return cloneJson(updated)
  }

  /** 流式进度仅更新摘要，不改变生命周期；完整消息仍进入子会话 JSONL。 */
  updateProgress(id: string, latestProgress: string): AgentDelegation {
    const normalizedId = normalizeId(id, '子任务 ID')
    const existing = this.get(normalizedId)
    if (!existing) throw new AgentDelegationManagerError('not_found', '子任务不存在')
    const tasks = this.readRoot(existing.rootSessionId)
    const position = tasks.findIndex((item) => item.id === normalizedId)
    if (existing.status !== 'running' && existing.status !== 'blocked') {
      throw new AgentDelegationManagerError('invalid_transition', '只有运行中或阻塞中的子任务可以更新进度')
    }
    const updated = {
      ...existing,
      latestProgress: normalizeText(latestProgress, '子任务进度', MAX_AGENT_DELEGATION_PROGRESS_LENGTH),
      updatedAt: Math.max(existing.updatedAt, this.currentTimestamp()),
    }
    tasks[position] = updated
    this.writeRoot(existing.rootSessionId, tasks)
    this.emitChanged(updated)
    return cloneJson(updated)
  }

  /**
   * 应用启动时一次性收敛无法继续的遗留任务。
   * queued/running/blocked 都依赖已经丢失的进程内编排，因此统一标为 interrupted。
   */
  markRunningDelegationsAsInterrupted(): AgentDelegation[] {
    const interrupted: AgentDelegation[] = []
    for (const rootSessionId of this.stateStore.listRootIds()) {
      const tasks = this.readRoot(rootSessionId)
      let changed = false
      for (let position = 0; position < tasks.length; position += 1) {
        const existing = tasks[position]!
        if (isAgentDelegationTerminal(existing.status)) continue
        const timestamp = Math.max(existing.updatedAt, this.currentTimestamp())
        const updated: AgentDelegation = {
          ...existing,
          status: 'interrupted',
          updatedAt: timestamp,
          finishedAt: timestamp,
        }
        delete updated.blockedReason
        tasks[position] = updated
        interrupted.push(cloneJson(updated))
        changed = true
      }
      if (changed) {
        this.writeRoot(rootSessionId, tasks)
        for (const task of tasks) {
          if (interrupted.some((item) => item.id === task.id)) this.emitChanged(task)
        }
      }
    }
    return interrupted
  }

  private currentTimestamp(): number {
    const timestamp = this.now()
    return Number.isFinite(timestamp) && timestamp >= 0 ? timestamp : 0
  }

  private createUniqueId(delegations: readonly AgentDelegation[]): string {
    for (let attempt = 0; attempt < 10; attempt += 1) {
      const candidate = normalizeId(this.createId(), '子任务 ID')
      if (!delegations.some((item) => item.id === candidate)) return candidate
    }
    throw new AgentDelegationManagerError('storage_error', '无法生成唯一子任务 ID')
  }

  /** 读取一个根会话内的任务；坏记录单条隔离，不影响同会话其他任务。 */
  private readRoot(rootSessionId: string): AgentDelegation[] {
    const source = this.stateStore.read(rootSessionId)
    const delegations: AgentDelegation[] = []
    const ids = new Set<string>()
    const childIds = new Set<string>()
    const parentToolKeys = new Set<string>()
    for (const item of source.tasks) {
      try {
        const delegation = normalizeStoredTask(rootSessionId, item)
        const parentToolKey = delegation.parentToolUseId
        if (
          ids.has(delegation.id)
          || childIds.has(delegation.childSessionId)
          || parentToolKeys.has(parentToolKey)
        ) continue
        ids.add(delegation.id)
        childIds.add(delegation.childSessionId)
        parentToolKeys.add(parentToolKey)
        delegations.push(delegation)
      } catch {
        // 单条损坏记录隔离，其余父子关系仍可加载。
      }
    }
    if (delegations.length !== source.tasks.length) {
      this.writeRoot(rootSessionId, delegations)
      console.warn('[Agent 协作] 已清理无效子任务记录')
    }
    return delegations
  }

  /** 仅替换 state.json 的 tasks，必须保留会话管理器维护的 agents。 */
  private writeRoot(rootSessionId: string, delegations: readonly AgentDelegation[]): void {
    try {
      this.stateStore.update(rootSessionId, (state) => ({
        ...state,
        agents: Object.fromEntries(Object.entries(state.agents).map(([agentId, value]) => {
          if (!value || typeof value !== 'object' || Array.isArray(value)) return [agentId, value]
          const normalized = { ...(value as Record<string, unknown>) }
          if (delegations.some((item) => item.childSessionId === agentId)) delete normalized.parentToolUseId
          return [agentId, normalized]
        })),
        tasks: delegations.map(toStoredTask),
      }))
    } catch (error) {
      if (error instanceof AgentDelegationManagerError) throw error
      throw new AgentDelegationManagerError('storage_error', '写入根会话任务状态失败')
    }
  }

  private emitChanged(task: AgentDelegation): void {
    const event: AgentTaskChangedEvent = {
      type: 'changed',
      rootSessionId: task.rootSessionId,
      task: cloneJson(task),
    }
    for (const listener of this.listeners) {
      try { listener(event) } catch { /* 单个 UI 监听器不能打断任务状态落盘。 */ }
    }
  }
}
