/**
 * Agent 根会话聚合持久化（state.json + 各 Agent 自有 JSONL）
 *
 * 双轨设计（设计文档 §8）：根会话索引 + state + JSONL 是**唯一展示源**，
 * 编排层从 SDKMessage 流直接落盘；runtime 自己写的 session artifact 是
 * **唯一 resume 凭据**，本层只在索引里保存它的引用（sdkSessionId/runtimeSessionFile）。
 *
 * 校验纪律与 Chat 的 ConversationManager 一致：索引与消息都做规范化，
 * 未知消息类型透传保留（向前兼容），缺失 uuid 的消息在落盘前回填稳定 id
 * （已知陷阱 #7），损坏行隔离到 .corrupt 副本后修复主文件。
 */

import { randomUUID } from 'node:crypto'
import { chmodSync, copyFileSync, existsSync, mkdirSync, readFileSync, statSync, unlinkSync } from 'node:fs'
import { dirname, join } from 'node:path'
import {
  DEFAULT_AGENT_SESSION_TITLE,
  AGENT_RUNTIME_CAPABILITIES,
  MAX_AGENT_MEMORY_FILE_BYTES,
  MAX_AGENT_MEMORY_FILES,
  MAX_AGENT_SESSION_TITLE_LENGTH,
} from '@axon/shared'
import type {
  AgentMemoryFileStates,
  AgentPermissionMode,
  AgentRuntimeId,
  AgentSessionCreateInput,
  AgentSessionMeta,
  AgentSubagentType,
  AgentSessionUpdateInput,
  AgentThinkingLevel,
  SDKMessage,
} from '@axon/shared'
import { readJsonFileSafe, writeJsonFileAtomic, writeTextFileAtomic } from '../core/safe-file'
import { AgentRootStateStore } from './agent-root-state-store'

const INDEX_VERSION = 5
const MAX_SESSION_MESSAGES = 100_000
const MAX_SESSIONS_FILE_BYTES = 128 * 1024 * 1024
const MAX_MESSAGE_LINE_BYTES = 8 * 1024 * 1024
const PERMISSION_MODES: readonly AgentPermissionMode[] = ['default', 'acceptEdits', 'bypassPermissions', 'plan']
const THINKING_LEVELS: readonly AgentThinkingLevel[] = ['off', 'minimal', 'low', 'medium', 'high', 'xhigh', 'max']
const SUBAGENT_TYPES: readonly AgentSubagentType[] = ['coder', 'explore', 'plan']
const RUNTIME_IDS: readonly AgentRuntimeId[] = ['pi', 'zima']

export class AgentSessionManagerError extends Error {
  constructor(
    readonly code: 'invalid_input' | 'not_found' | 'duplicate' | 'too_large' | 'storage_error',
    message: string,
  ) {
    super(message)
    this.name = 'AgentSessionManagerError'
  }
}

interface AgentSessionsIndex {
  version: number
  sessions: AgentSessionMeta[]
}

function cloneJson<T>(value: T): T {
  return JSON.parse(JSON.stringify(value)) as T
}

/** 会话/消息 ID 同时是文件名与关联键，必须排除路径成分。 */
const ID_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/

function normalizeId(value: unknown, label: string): string {
  if (typeof value !== 'string' || !ID_PATTERN.test(value)) {
    throw new AgentSessionManagerError('invalid_input', `${label}格式无效`)
  }
  return value
}

function normalizeOptionalId(value: unknown, label: string, maxLength: number): string | undefined {
  if (value === undefined || value === null) return undefined
  if (typeof value !== 'string' || !value.trim() || value.length > maxLength) {
    throw new AgentSessionManagerError('invalid_input', `${label}格式无效`)
  }
  return value.trim()
}

function normalizeOptionalSessionId(value: unknown, label: string): string | undefined {
  if (value === undefined || value === null) return undefined
  return normalizeId(value, label)
}

/** 父会话、根会话与父工具调用必须成组存在，避免产生无法导航的半条关系。 */
function normalizeLineage(value: Record<string, unknown>, sessionId?: string): {
  parentSessionId?: string
  rootSessionId?: string
  parentToolUseId?: string
} {
  const parentSessionId = normalizeOptionalSessionId(value.parentSessionId, '父会话 ID')
  const rootSessionId = normalizeOptionalSessionId(value.rootSessionId, '根会话 ID')
  const parentToolUseId = normalizeOptionalId(value.parentToolUseId, '父工具调用 ID', 512)
  const count = [parentSessionId, rootSessionId, parentToolUseId].filter(Boolean).length
  if (count !== 0 && count !== 3) {
    throw new AgentSessionManagerError('invalid_input', '子会话关联字段必须完整')
  }
  if (sessionId && (parentSessionId === sessionId || rootSessionId === sessionId)) {
    throw new AgentSessionManagerError('invalid_input', '子会话不能引用自身')
  }
  return { parentSessionId, rootSessionId, parentToolUseId }
}

function normalizeTitle(value: unknown): string {
  if (value === undefined) return DEFAULT_AGENT_SESSION_TITLE
  if (typeof value !== 'string' || !value.trim()) {
    throw new AgentSessionManagerError('invalid_input', '会话标题不能为空')
  }
  return value.trim().slice(0, MAX_AGENT_SESSION_TITLE_LENGTH)
}

function normalizePermissionMode(value: unknown): AgentPermissionMode | undefined {
  if (value === undefined || value === null) return undefined
  if (typeof value !== 'string' || !PERMISSION_MODES.includes(value as AgentPermissionMode)) {
    throw new AgentSessionManagerError('invalid_input', '权限模式无效')
  }
  return value as AgentPermissionMode
}

function normalizeThinkingLevel(value: unknown): AgentThinkingLevel | undefined {
  if (value === undefined || value === null) return undefined
  if (typeof value !== 'string' || !THINKING_LEVELS.includes(value as AgentThinkingLevel)) {
    throw new AgentSessionManagerError('invalid_input', '思考等级无效')
  }
  return value as AgentThinkingLevel
}

function normalizeRuntimeId(value: unknown): AgentRuntimeId {
  if (typeof value !== 'string' || !RUNTIME_IDS.includes(value as AgentRuntimeId)) {
    throw new AgentSessionManagerError('invalid_input', 'Agent Runtime 无效')
  }
  return value as AgentRuntimeId
}

function normalizeSubagentType(value: unknown): AgentSubagentType | undefined {
  if (value === undefined || value === null) return undefined
  if (typeof value !== 'string' || !SUBAGENT_TYPES.includes(value as AgentSubagentType)) {
    throw new AgentSessionManagerError('invalid_input', '子 Agent 类型无效')
  }
  return value as AgentSubagentType
}

/** 校验会话私有的 memory/ 元信息表；这里只保存 stat 结果，不接受正文或绝对路径。 */
function normalizeMemoryFileStates(value: unknown, allowNull = false): AgentMemoryFileStates | undefined {
  if (value === undefined || (allowNull && value === null)) return undefined
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    throw new AgentSessionManagerError('invalid_input', '记忆文件元信息无效')
  }
  const entries = Object.entries(value)
  if (entries.length > MAX_AGENT_MEMORY_FILES) {
    throw new AgentSessionManagerError('invalid_input', '记忆文件元信息数量过多')
  }
  const normalized: AgentMemoryFileStates = {}
  for (const [path, rawState] of entries) {
    if (
      !path || path.length > 512 || path.startsWith('/') || path.includes('\\')
      || path.includes('\0') || !path.endsWith('.md')
      || path.split('/').some((part) => !part || part === '.' || part === '..')
      || !rawState || typeof rawState !== 'object' || Array.isArray(rawState)
    ) throw new AgentSessionManagerError('invalid_input', '记忆文件元信息无效')
    const state = rawState as Record<string, unknown>
    if (
      Object.keys(state).some((key) => key !== 'updatedAt' && key !== 'size')
      || typeof state.updatedAt !== 'number' || !Number.isFinite(state.updatedAt) || state.updatedAt < 0
      || typeof state.size !== 'number' || !Number.isSafeInteger(state.size)
      || state.size < 0 || state.size > MAX_AGENT_MEMORY_FILE_BYTES
    ) throw new AgentSessionManagerError('invalid_input', '记忆文件元信息无效')
    normalized[path] = { updatedAt: state.updatedAt, size: state.size }
  }
  return normalized
}

function normalizeMeta(value: unknown): AgentSessionMeta {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    throw new AgentSessionManagerError('invalid_input', '会话索引项无效')
  }
  const meta = value as Record<string, unknown>
  const id = normalizeId(meta.id, '会话 ID')
  if (
    typeof meta.createdAt !== 'number'
    || !Number.isFinite(meta.createdAt)
    || meta.createdAt < 0
    || typeof meta.updatedAt !== 'number'
    || !Number.isFinite(meta.updatedAt)
    || meta.updatedAt < meta.createdAt
  ) {
    throw new AgentSessionManagerError('invalid_input', '会话时间无效')
  }
  const channelId = normalizeOptionalId(meta.channelId, '渠道 ID', 100)
  const modelId = normalizeOptionalId(meta.modelId, '模型 ID', 512)
  const projectId = normalizeOptionalId(meta.projectId, '项目 ID', 128)
  const sdkSessionId = normalizeOptionalId(meta.sdkSessionId, 'runtime 会话 ID', 512)
  const runtimeSessionFile = normalizeOptionalId(meta.runtimeSessionFile, 'runtime 会话文件', 1024)
  const permissionMode = normalizePermissionMode(meta.permissionMode)
  const thinkingLevel = normalizeThinkingLevel(meta.thinkingLevel)
  const memoryFileStates = normalizeMemoryFileStates(meta.memoryFileStates)
  const lineage = normalizeLineage(meta, id)
  const subagentType = normalizeSubagentType(meta.subagentType)
  if (Boolean(lineage.parentSessionId) !== Boolean(subagentType)) {
    throw new AgentSessionManagerError('invalid_input', '子 Agent 类型与父子关系不一致')
  }
  return {
    id,
    runtimeId: normalizeRuntimeId(meta.runtimeId),
    title: normalizeTitle(meta.title),
    ...(channelId === undefined ? {} : { channelId }),
    ...(modelId === undefined ? {} : { modelId }),
    ...(projectId === undefined ? {} : { projectId }),
    ...(sdkSessionId === undefined ? {} : { sdkSessionId }),
    ...(runtimeSessionFile === undefined ? {} : { runtimeSessionFile }),
    ...(permissionMode === undefined ? {} : { permissionMode }),
    ...(thinkingLevel === undefined ? {} : { thinkingLevel }),
    ...(memoryFileStates === undefined ? {} : { memoryFileStates }),
    ...(lineage.parentSessionId === undefined ? {} : { parentSessionId: lineage.parentSessionId }),
    ...(lineage.rootSessionId === undefined ? {} : { rootSessionId: lineage.rootSessionId }),
    ...(lineage.parentToolUseId === undefined ? {} : { parentToolUseId: lineage.parentToolUseId }),
    ...(subagentType === undefined ? {} : { subagentType }),
    createdAt: meta.createdAt,
    updatedAt: meta.updatedAt,
  }
}

/** 子 Agent 的根目录已经表达所属关系，state.json 只保存不可推导的元数据。 */
function stripChildLineage(meta: AgentSessionMeta, keepPendingParentToolUseId = false): Record<string, unknown> {
  const persisted = { ...meta } as Record<string, unknown>
  delete persisted.id
  delete persisted.parentSessionId
  delete persisted.rootSessionId
  if (!keepPendingParentToolUseId) delete persisted.parentToolUseId
  // 创建 task 前短暂保留该字段，委派写入同一 state 后会移除；用于关联失败时回收子 Agent。
  return persisted
}

/** 全局索引只保留发现和分组根会话所需的轻量摘要。 */
function toRootCatalog(meta: AgentSessionMeta): AgentSessionMeta {
  return {
    id: meta.id,
    runtimeId: meta.runtimeId,
    title: meta.title,
    ...(meta.projectId === undefined ? {} : { projectId: meta.projectId }),
    createdAt: meta.createdAt,
    updatedAt: meta.updatedAt,
  }
}

/** 根 Agent 的完整元数据归入 state.json；ID 已由所属目录表达。 */
function toStoredRootMeta(meta: AgentSessionMeta): Record<string, unknown> {
  const persisted = { ...meta } as Record<string, unknown>
  delete persisted.id
  return persisted
}

/**
 * 规范化待落盘的 SDK 消息。协议校验刻意宽松：只要求 type 为字符串，
 * 其余字段（含未知类型与未知字段）透传保留——这是渲染与持久化的唯一消息模型，
 * 掐掉字段等于掐掉功能。缺失 uuid 的消息回填稳定 id（已知陷阱 #7）。
 */
function normalizeMessage(value: unknown): { message: SDKMessage; uuid: string } {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    throw new AgentSessionManagerError('invalid_input', 'SDK 消息必须是对象')
  }
  const raw = value as Record<string, unknown>
  if (typeof raw.type !== 'string' || !raw.type) {
    throw new AgentSessionManagerError('invalid_input', 'SDK 消息缺少类型')
  }
  const uuid = typeof raw.uuid === 'string' && raw.uuid.trim()
    ? raw.uuid
    : `backfill-${randomUUID()}`
  return { message: { ...raw, uuid } as SDKMessage, uuid }
}

/** 读取消息 uuid；result/system 等类型允许缺失，返回 undefined。 */
function getUuid(message: SDKMessage): string | undefined {
  const value = (message as { uuid?: unknown }).uuid
  return typeof value === 'string' ? value : undefined
}

export interface AgentSessionManagerOptions {
  indexPath: string
  sessionsDir: string
  stateStore?: AgentRootStateStore
  createId?: () => string
  now?: () => number
}

export class AgentSessionManager {
  private readonly indexPath: string
  private readonly sessionsDir: string
  private readonly createId: () => string
  private readonly now: () => number
  private readonly stateStore: AgentRootStateStore

  constructor(options: AgentSessionManagerOptions) {
    this.indexPath = options.indexPath
    this.sessionsDir = options.sessionsDir
    this.createId = options.createId ?? randomUUID
    this.now = options.now ?? Date.now
    this.stateStore = options.stateStore ?? new AgentRootStateStore(options.sessionsDir)
    mkdirSync(dirname(this.indexPath), { recursive: true })
    mkdirSync(this.sessionsDir, { recursive: true })
    if (process.platform !== 'win32') chmodSync(this.sessionsDir, 0o700)
  }

  list(): AgentSessionMeta[] {
    const roots = this.readIndex().sessions.flatMap((catalog) => {
      const root = this.readRootSession(catalog)
      return root ? [root] : []
    })
    const children = roots.flatMap((root) => this.readChildSessions(root.id))
    return [...roots, ...children]
      .map((session) => cloneJson(session))
      .sort((left, right) => right.updatedAt - left.updatedAt)
  }

  get(id: string): AgentSessionMeta | undefined {
    const normalizedId = normalizeId(id, '会话 ID')
    const catalogs = this.readIndex().sessions
    const roots = catalogs.flatMap((catalog) => {
      const root = this.readRootSession(catalog)
      return root ? [root] : []
    })
    const meta = roots.find((item) => item.id === normalizedId)
      ?? roots.flatMap((root) => this.readChildSessions(root.id)).find((item) => item.id === normalizedId)
    return meta ? cloneJson(meta) : undefined
  }

  create(input: AgentSessionCreateInput = {}): AgentSessionMeta {
    const index = this.readIndex()
    const timestamp = this.currentTimestamp()
    const channelId = normalizeOptionalId(input.channelId, '渠道 ID', 100)
    const modelId = normalizeOptionalId(input.modelId, '模型 ID', 512)
    const projectId = normalizeOptionalId(input.projectId, '项目 ID', 128)
    const permissionMode = normalizePermissionMode(input.permissionMode)
    const requestedThinkingLevel = normalizeThinkingLevel(input.thinkingLevel)
    const id = this.createUniqueId(this.list())
    const lineage = normalizeLineage(input as Record<string, unknown>, id)
    const subagentType = normalizeSubagentType(input.subagentType)
    if (Boolean(lineage.parentSessionId) !== Boolean(subagentType)) {
      throw new AgentSessionManagerError('invalid_input', '子 Agent 类型与父子关系不一致')
    }
    const runtimeId = input.runtimeId === undefined ? 'pi' : normalizeRuntimeId(input.runtimeId)
    if (!AGENT_RUNTIME_CAPABILITIES[runtimeId].thinkingLevel && requestedThinkingLevel !== undefined) {
      throw new AgentSessionManagerError('invalid_input', 'Zima Runtime 不支持思考等级设置')
    }
    const thinkingLevel = AGENT_RUNTIME_CAPABILITIES[runtimeId].thinkingLevel
      ? requestedThinkingLevel ?? 'medium' : undefined
    if (lineage.parentSessionId) {
      const parent = this.get(lineage.parentSessionId)
      if (!parent || parent.rootSessionId !== lineage.rootSessionId && parent.id !== lineage.rootSessionId) {
        throw new AgentSessionManagerError('not_found', '父会话不存在或不属于根会话')
      }
      if (parent.runtimeId !== runtimeId) {
        throw new AgentSessionManagerError('invalid_input', '子 Agent 必须继承父会话 Runtime')
      }
    }
    const meta: AgentSessionMeta = {
      id,
      runtimeId,
      title: normalizeTitle(input.title),
      ...(channelId === undefined ? {} : { channelId }),
      ...(modelId === undefined ? {} : { modelId }),
      ...(projectId === undefined ? {} : { projectId }),
      ...(permissionMode === undefined ? {} : { permissionMode }),
      ...(thinkingLevel === undefined ? {} : { thinkingLevel }),
      ...(lineage.parentSessionId === undefined ? {} : { parentSessionId: lineage.parentSessionId }),
      ...(lineage.rootSessionId === undefined ? {} : { rootSessionId: lineage.rootSessionId }),
      ...(lineage.parentToolUseId === undefined ? {} : { parentToolUseId: lineage.parentToolUseId }),
      ...(subagentType === undefined ? {} : { subagentType }),
      createdAt: timestamp,
      updatedAt: timestamp,
    }
    if (lineage.rootSessionId) {
      if (!index.sessions.some((item) => item.id === lineage.rootSessionId)) {
        throw new AgentSessionManagerError('not_found', '根会话不存在')
      }
      this.stateStore.update(lineage.rootSessionId, (state) => ({
        ...state,
        agents: { ...state.agents, [id]: stripChildLineage(meta, true) },
      }))
    } else {
      // state 先落盘；目录摘要写失败时最多留下一个可清理的孤立根目录。
      this.stateStore.update(id, (state) => ({
        ...state,
        agents: { ...state.agents, main: toStoredRootMeta(meta) },
      }))
      index.sessions.push(toRootCatalog(meta))
      this.writeIndex(index)
    }
    console.log(`[Agent 会话] 已创建会话: ${meta.title} (${meta.id})`)
    return cloneJson(meta)
  }

  update(id: string, input: AgentSessionUpdateInput): AgentSessionMeta {
    const normalizedId = normalizeId(id, '会话 ID')
    const index = this.readIndex()
    const position = index.sessions.findIndex((item) => item.id === normalizedId)
    const existing = this.get(normalizedId)
    if (!existing) throw new AgentSessionManagerError('not_found', '会话不存在')
    if (!AGENT_RUNTIME_CAPABILITIES[existing.runtimeId].thinkingLevel && input.thinkingLevel !== undefined) {
      throw new AgentSessionManagerError('invalid_input', 'Zima Runtime 不支持思考等级设置')
    }
    const channelId = input.channelId === undefined
      ? existing.channelId
      : normalizeOptionalId(input.channelId, '渠道 ID', 100)
    const modelId = input.modelId === undefined
      ? existing.modelId
      : normalizeOptionalId(input.modelId, '模型 ID', 512)
    const projectId = input.projectId === undefined
      ? existing.projectId
      : normalizeOptionalId(input.projectId, '项目 ID', 128)
    const permissionMode = input.permissionMode === undefined
      ? existing.permissionMode
      : normalizePermissionMode(input.permissionMode)
    const thinkingLevel = input.thinkingLevel === undefined
      ? existing.thinkingLevel
      : normalizeThinkingLevel(input.thinkingLevel)
    // resume 凭据只在 runtime 真实给出时写入；空串视为无效值拒绝而不是清空。
    const sdkSessionId = input.sdkSessionId === undefined
      ? existing.sdkSessionId
      : normalizeOptionalId(input.sdkSessionId, 'runtime 会话 ID', 512)
    const runtimeSessionFile = input.runtimeSessionFile === undefined
      ? existing.runtimeSessionFile
      : normalizeOptionalId(input.runtimeSessionFile, 'runtime 会话文件', 1024)
    const memoryFileStates = input.memoryFileStates === undefined
      ? existing.memoryFileStates
      : normalizeMemoryFileStates(input.memoryFileStates, true)
    const updated: AgentSessionMeta = {
      id: existing.id,
      runtimeId: existing.runtimeId,
      title: input.title === undefined ? existing.title : normalizeTitle(input.title),
      ...(channelId === undefined ? {} : { channelId }),
      ...(modelId === undefined ? {} : { modelId }),
      ...(projectId === undefined ? {} : { projectId }),
      ...(sdkSessionId === undefined ? {} : { sdkSessionId }),
      ...(runtimeSessionFile === undefined ? {} : { runtimeSessionFile }),
      ...(permissionMode === undefined ? {} : { permissionMode }),
      ...(thinkingLevel === undefined ? {} : { thinkingLevel }),
      ...(memoryFileStates === undefined ? {} : { memoryFileStates }),
      ...(existing.parentSessionId === undefined ? {} : { parentSessionId: existing.parentSessionId }),
      ...(existing.rootSessionId === undefined ? {} : { rootSessionId: existing.rootSessionId }),
      ...(existing.parentToolUseId === undefined ? {} : { parentToolUseId: existing.parentToolUseId }),
      ...(existing.subagentType === undefined ? {} : { subagentType: existing.subagentType }),
      createdAt: existing.createdAt,
      updatedAt: Math.max(existing.updatedAt, this.currentTimestamp()),
    }
    if (position >= 0) {
      this.stateStore.update(updated.id, (state) => ({
        ...state,
        agents: { ...state.agents, main: toStoredRootMeta(updated) },
      }))
      index.sessions[position] = toRootCatalog(updated)
      this.writeIndex(index)
    } else {
      const rootSessionId = existing.rootSessionId!
      this.stateStore.update(rootSessionId, (state) => ({
        ...state,
        agents: { ...state.agents, [updated.id]: stripChildLineage(updated) },
      }))
      this.touchRoot(rootSessionId)
    }
    console.log(`[Agent 会话] 已更新会话: ${updated.title} (${updated.id})`)
    return cloneJson(updated)
  }

  delete(id: string): AgentSessionMeta {
    const normalizedId = normalizeId(id, '会话 ID')
    const index = this.readIndex()
    const position = index.sessions.findIndex((item) => item.id === normalizedId)
    const removed = this.get(normalizedId)
    if (!removed) throw new AgentSessionManagerError('not_found', '会话不存在')
    const sessionPath = this.sessionPath(normalizedId)
    if (position >= 0) {
      index.sessions.splice(position, 1)
      this.writeIndex(index)
      this.stateStore.deleteRoot(normalizedId)
      console.log(`[Agent 会话] 已删除会话: ${removed.title} (${removed.id})`)
      return cloneJson(removed)
    }

    const rootSessionId = removed.rootSessionId!
    this.stateStore.update(rootSessionId, (state) => {
      const agents = { ...state.agents }
      delete agents[normalizedId]
      return {
        ...state,
        agents,
        tasks: state.tasks.filter((task) => {
          if (!task || typeof task !== 'object' || Array.isArray(task)) return true
          const record = task as Record<string, unknown>
          return record.agentId !== normalizedId && record.childSessionId !== normalizedId
        }),
      }
    })

    // 子 Agent 索引先落盘；消息清理失败只留下不可达孤儿文件。
    for (const path of [sessionPath, `${sessionPath}.tmp`, `${sessionPath}.corrupt`]) {
      if (!existsSync(path)) continue
      try { unlinkSync(path) } catch { console.warn(`[Agent 会话] 清理消息文件失败: ${normalizedId}`) }
    }
    this.touchRoot(rootSessionId)
    console.log(`[Agent 会话] 已删除会话: ${removed.title} (${removed.id})`)
    return cloneJson(removed)
  }

  getMessages(id: string): SDKMessage[] {
    const normalizedId = this.requireSession(id)
    return this.readMessages(normalizedId).map((message) => cloneJson(message))
  }

  /**
   * 把一条完整 SDKMessage 追加落盘（编排层从 adapter 流直接写入）。
   * 与 Chat 一致采用“读取校验后原子整文件替换”，优先保证 MVP 正确性；
   * 超长会话的增量追加优化留待出现真实性能压力后处理。
   */
  appendMessage(id: string, value: SDKMessage): SDKMessage {
    const normalizedId = this.requireSession(id)
    const { message, uuid } = normalizeMessage(value)
    const messages = this.readMessages(normalizedId)
    if (messages.some((item) => getUuid(item) === uuid)) {
      throw new AgentSessionManagerError('duplicate', '消息 uuid 已存在')
    }
    if (messages.length >= MAX_SESSION_MESSAGES) {
      throw new AgentSessionManagerError('too_large', '会话消息数量已达上限')
    }
    // runtime 不保证携带时间；以应用首次落盘时刻补齐，恢复后仍保持同一时间。
    const persisted = typeof message.createdAt === 'number'
      && Number.isFinite(message.createdAt)
      && message.createdAt >= 0
      ? message
      : { ...message, createdAt: this.currentTimestamp() }
    this.writeMessages(normalizedId, [...messages, persisted])
    this.touch(normalizedId)
    return cloneJson(persisted)
  }

  private sessionPath(id: string): string {
    const session = this.get(normalizeId(id, '会话 ID'))
    if (!session) throw new AgentSessionManagerError('not_found', '会话不存在')
    const rootSessionId = session.rootSessionId ?? session.id
    return this.stateStore.agentMessagesPath(rootSessionId, session.rootSessionId ? session.id : 'main')
  }

  private requireSession(id: string): string {
    const normalizedId = normalizeId(id, '会话 ID')
    if (!this.get(normalizedId)) {
      throw new AgentSessionManagerError('not_found', '会话不存在')
    }
    return normalizedId
  }

  /** 逐行隔离损坏记录；修复前保留原文件副本，避免静默销毁证据。 */
  private readMessages(id: string): SDKMessage[] {
    const path = this.sessionPath(id)
    if (!existsSync(path)) return []
    try {
      if (statSync(path).size > MAX_SESSIONS_FILE_BYTES) {
        throw new AgentSessionManagerError('too_large', '会话消息文件过大')
      }
    } catch (error) {
      if (error instanceof AgentSessionManagerError) throw error
      throw new AgentSessionManagerError('storage_error', '读取会话消息失败')
    }

    let raw: string
    try {
      raw = readFileSync(path, 'utf-8')
    } catch {
      throw new AgentSessionManagerError('storage_error', '读取会话消息失败')
    }
    const messages: SDKMessage[] = []
    const uuids = new Set<string>()
    let damaged = false
    for (const line of raw.split('\n')) {
      if (!line.trim()) continue
      try {
        const { message, uuid } = normalizeMessage(JSON.parse(line) as unknown)
        if (uuids.has(uuid)) {
          damaged = true
          continue
        }
        uuids.add(uuid)
        messages.push(message)
      } catch {
        damaged = true
      }
    }
    if (damaged) this.recoverMessages(path, messages)
    return messages
  }

  private recoverMessages(path: string, messages: readonly SDKMessage[]): void {
    try {
      copyFileSync(path, `${path}.corrupt`)
      if (process.platform !== 'win32') chmodSync(`${path}.corrupt`, 0o600)
      this.writeMessagesFile(path, messages)
      console.warn(`[Agent 会话] 已隔离损坏消息文件: ${path}`)
    } catch {
      console.error(`[Agent 会话] 消息文件自动恢复失败: ${path}`)
    }
  }

  private writeMessages(id: string, messages: readonly SDKMessage[]): void {
    try {
      this.writeMessagesFile(this.sessionPath(id), messages)
    } catch (error) {
      if (error instanceof AgentSessionManagerError) throw error
      throw new AgentSessionManagerError('storage_error', '写入会话消息失败')
    }
  }

  private writeMessagesFile(path: string, messages: readonly SDKMessage[]): void {
    const content = messages.length === 0
      ? ''
      : `${messages.map((message) => JSON.stringify(message)).join('\n')}\n`
    if (new TextEncoder().encode(content).byteLength > MAX_SESSIONS_FILE_BYTES) {
      throw new AgentSessionManagerError('too_large', '会话消息文件过大')
    }
    mkdirSync(dirname(path), { recursive: true })
    if (process.platform !== 'win32') chmodSync(dirname(path), 0o700)
    writeTextFileAtomic(path, content, 0o600)
  }

  private touch(id: string): void {
    const normalizedId = normalizeId(id, '会话 ID')
    const index = this.readIndex()
    const position = index.sessions.findIndex((item) => item.id === normalizedId)
    if (position >= 0) {
      this.touchRoot(normalizedId)
      return
    }
    const child = this.get(normalizedId)
    if (!child?.rootSessionId) throw new AgentSessionManagerError('not_found', '会话不存在')
    const updated = { ...child, updatedAt: Math.max(child.updatedAt, this.currentTimestamp()) }
    this.stateStore.update(child.rootSessionId, (state) => ({
      ...state,
      agents: { ...state.agents, [child.id]: stripChildLineage(updated) },
    }))
    this.touchRoot(child.rootSessionId)
  }

  private touchRoot(rootSessionId: string): void {
    const index = this.readIndex()
    const position = index.sessions.findIndex((item) => item.id === rootSessionId)
    if (position < 0) throw new AgentSessionManagerError('not_found', '根会话不存在')
    const root = this.readRootSession(index.sessions[position]!)
    if (!root) throw new AgentSessionManagerError('not_found', '根会话状态不存在')
    const updated = { ...root, updatedAt: Math.max(root.updatedAt, this.currentTimestamp()) }
    this.stateStore.update(rootSessionId, (state) => ({
      ...state,
      agents: { ...state.agents, main: toStoredRootMeta(updated) },
    }))
    index.sessions[position] = toRootCatalog(updated)
    this.writeIndex(index)
  }

  /** 全局目录项只负责发现；完整根 Agent 元数据以 state.json 的 main 为准。 */
  private readRootSession(catalog: AgentSessionMeta): AgentSessionMeta | undefined {
    const stored = this.stateStore.read(catalog.id).agents.main
    if (!stored || typeof stored !== 'object' || Array.isArray(stored)) return undefined
    try { return normalizeMeta({ ...stored, id: catalog.id }) }
    catch { return undefined }
  }

  /** state.json 不重复保存可由目录和任务记录推导的父子外键。 */
  private readChildSessions(rootSessionId: string): AgentSessionMeta[] {
    const state = this.stateStore.read(rootSessionId)
    return Object.entries(state.agents).flatMap(([agentId, value]) => {
      if (agentId === 'main') return []
      try {
        const task = state.tasks.find((candidate) => {
          if (!candidate || typeof candidate !== 'object' || Array.isArray(candidate)) return false
          const record = candidate as Record<string, unknown>
          return record.agentId === agentId || record.childSessionId === agentId
        }) as Record<string, unknown> | undefined
        const storedAgent = value as Record<string, unknown>
        const parentToolUseId = task?.parentToolUseId ?? storedAgent.parentToolUseId
        if (typeof parentToolUseId !== 'string') return []
        return [normalizeMeta({
          ...(value as object),
          id: agentId,
          parentSessionId: rootSessionId,
          rootSessionId,
          parentToolUseId,
        })]
      } catch {
        return []
      }
    })
  }

  private currentTimestamp(): number {
    const timestamp = this.now()
    if (!Number.isFinite(timestamp) || timestamp < 0) return 0
    return timestamp
  }

  private createUniqueId(sessions: readonly AgentSessionMeta[]): string {
    for (let attempt = 0; attempt < 10; attempt += 1) {
      const candidate = this.createId()
      const normalized = normalizeId(candidate, '会话 ID')
      if (!sessions.some((item) => item.id === normalized)) return normalized
    }
    throw new AgentSessionManagerError('storage_error', '无法生成唯一会话 ID')
  }

  private readIndex(): AgentSessionsIndex {
    if (!existsSync(this.indexPath)) return { version: INDEX_VERSION, sessions: [] }
    const value = readJsonFileSafe<unknown>(this.indexPath)
    if (!value || typeof value !== 'object' || Array.isArray(value)) {
      return { version: INDEX_VERSION, sessions: [] }
    }
    const source = value as Record<string, unknown>
    if (source.version !== INDEX_VERSION || !Array.isArray(source.sessions)) {
      // 开发期不迁移旧 DTO；先保留原索引，避免重置时失去定位原会话目录的线索。
      const backupPath = `${this.indexPath}.before-runtime-v5`
      if (!existsSync(backupPath)) copyFileSync(this.indexPath, backupPath)
      const reset = { version: INDEX_VERSION, sessions: [] }
      this.writeIndex(reset)
      console.warn(`[Agent 会话] 已备份并重置旧版会话索引: ${backupPath}`)
      return reset
    }
    const items = Array.isArray(source.sessions) ? source.sessions : []
    const sessions: AgentSessionMeta[] = []
    const ids = new Set<string>()
    for (const item of items) {
      try {
        const meta = toRootCatalog(normalizeMeta(item))
        // 全局索引只服务左侧栏的根会话；子 Agent 必须归入根目录 state.json。
        if (meta.parentSessionId || ids.has(meta.id)) continue
        ids.add(meta.id)
        sessions.push(meta)
      } catch {
        // 单个坏索引项被隔离，其余会话仍可加载。
      }
    }
    const normalized = { version: INDEX_VERSION, sessions }
    if (
      sessions.length !== items.length
    ) {
      this.writeIndex(normalized)
      console.warn('[Agent 会话] 已清理无效或旧版会话索引')
    }
    return normalized
  }

  private writeIndex(index: AgentSessionsIndex): void {
    writeJsonFileAtomic(this.indexPath, index)
  }
}
