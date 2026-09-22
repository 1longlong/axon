/** Agent renderer 控制器：协调 preload API、实时事件与权威持久化快照。 */

import type { Store } from 'jotai/vanilla/store'
import type {
  AgentAskUserResponse,
  AgentEnvironmentCheckInput,
  AgentEnvironmentCheckResult,
  AgentExitPlanResponse,
  AgentMemoryChangedEvent,
  AgentMemoryFile,
  AgentMemorySummary,
  AgentMoveQueuedMessageInput,
  AgentPermissionResponse,
  AgentProject,
  AgentProjectCreateInput,
  AgentProjectUpdateInput,
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
} from '@axon/shared'
import type { AgentRendererApi } from './agent-renderer-api'
import { reduceAgentGenerationEvent } from './agent-event-reducer'
import {
  agentStateAtom,
  sortAgentProjects,
  sortAgentSessions,
  upsertAgentProject,
  upsertAgentSession,
} from './agent-state-model'

/** preload Agent API 的状态控制器；事件负责即时展示，JSONL 负责最终校准。 */
export class AgentRendererController {
  private unsubscribe: (() => void) | null = null
  private sessionsLoadVersion = 0
  private projectsLoadVersion = 0
  private readonly messageLoadVersions = new Map<string, number>()
  private readonly observedRunTokens = new Map<string, number>()

  constructor(
    private readonly api: AgentRendererApi,
    private readonly store: Store,
  ) {}

  /** 先订阅事件再加载索引，避免启动期间漏掉 run_started。 */
  start(): () => void {
    if (this.unsubscribe) return this.unsubscribe
    const unsubscribeEvents = this.api.onEvent((event) => {
      if (event.type === 'session_title') {
        this.store.set(agentStateAtom, (state) => reduceAgentGenerationEvent(state, event))
        return
      }
      this.observedRunTokens.set(
        event.sessionId,
        Math.max(this.observedRunTokens.get(event.sessionId) ?? 0, event.runStartedAt),
      )
      // 任意流事件都让旧磁盘读取失效；run_finished 再拉取权威 JSONL 终态。
      this.messageLoadVersions.set(
        event.sessionId,
        (this.messageLoadVersions.get(event.sessionId) ?? 0) + 1,
      )
      this.store.set(agentStateAtom, (state) => reduceAgentGenerationEvent(state, event))
      if (event.type === 'run_finished') void this.loadMessages(event.sessionId)
    })
    const unsubscribeQueue = this.api.onQueueChanged((snapshot) => {
      this.store.set(agentStateAtom, (state) => ({
        ...state,
        queuedMessagesBySession: {
          ...state.queuedMessagesBySession,
          [snapshot.sessionId]: snapshot.messages,
        },
      }))
    })
    const cleanup = (): void => {
      unsubscribeEvents()
      unsubscribeQueue()
      if (this.unsubscribe === cleanup) {
        this.unsubscribe = null
        this.sessionsLoadVersion += 1
        this.projectsLoadVersion += 1
        for (const [sessionId, version] of this.messageLoadVersions) {
          this.messageLoadVersions.set(sessionId, version + 1)
        }
      }
    }
    this.unsubscribe = cleanup
    void this.refreshSessions()
    void this.refreshProjects()
    void this.restoreActiveRuns()
    return cleanup
  }

  /** 用主进程快照补齐订阅前已启动的任务；订阅后观测到的更新始终优先。 */
  private async restoreActiveRuns(): Promise<void> {
    try {
      const runs = await this.api.listActiveRuns()
      for (const run of runs) {
        if ((this.observedRunTokens.get(run.sessionId) ?? 0) >= run.runStartedAt) continue
        this.store.set(agentStateAtom, (state) => reduceAgentGenerationEvent(state, {
          type: 'run_started',
          sessionId: run.sessionId,
          runStartedAt: run.runStartedAt,
          source: run.source,
        }))
      }
    } catch {
      // 运行快照只是 UI 恢复辅助，失败不能阻断会话和项目索引加载。
    }
  }

  /** 读取项目即时状态；版本令牌防止慢列表覆盖刚完成的 CRUD。 */
  async refreshProjects(): Promise<void> {
    const version = ++this.projectsLoadVersion
    this.store.set(agentStateAtom, (state) => ({ ...state, projectsStatus: 'loading' }))
    try {
      const projects = await this.api.listProjects()
      if (this.projectsLoadVersion !== version) return
      this.store.set(agentStateAtom, (state) => ({
        ...state,
        projects: sortAgentProjects(projects),
        projectsStatus: 'ready',
        lastError: state.lastError?.scope === 'projects' ? null : state.lastError,
      }))
    } catch {
      if (this.projectsLoadVersion !== version) return
      this.store.set(agentStateAtom, (state) => ({
        ...state,
        projectsStatus: 'error',
        lastError: { scope: 'projects', message: '加载 Agent 项目失败' },
      }))
    }
  }

  /** 使用版本令牌丢弃旧列表响应，防止慢请求覆盖较新的 CRUD 结果。 */
  async refreshSessions(): Promise<void> {
    const version = ++this.sessionsLoadVersion
    this.store.set(agentStateAtom, (state) => ({ ...state, sessionsStatus: 'loading' }))
    try {
      const sessions = await this.api.listSessions()
      if (this.sessionsLoadVersion !== version) return
      this.store.set(agentStateAtom, (state) => ({
        ...state,
        sessions: sortAgentSessions(sessions.map((session) => {
          const local = state.sessions.find((item) => item.id === session.id)
          return local && local.updatedAt > session.updatedAt ? local : session
        })),
        sessionsStatus: 'ready',
        lastError: state.lastError?.scope === 'sessions' ? null : state.lastError,
      }))
    } catch {
      if (this.sessionsLoadVersion !== version) return
      this.store.set(agentStateAtom, (state) => ({
        ...state,
        sessionsStatus: 'error',
        lastError: { scope: 'sessions', message: '加载 Agent 会话失败' },
      }))
    }
  }

  /** 每个会话独立防乱序，并以主进程 JSONL 返回值替换本地快照。 */
  async loadMessages(sessionId: string): Promise<void> {
    const version = (this.messageLoadVersions.get(sessionId) ?? 0) + 1
    this.messageLoadVersions.set(sessionId, version)
    this.store.set(agentStateAtom, (state) => ({
      ...state,
      messageStatusBySession: {
        ...state.messageStatusBySession,
        [sessionId]: 'loading',
      },
    }))
    try {
      const messages = await this.api.getMessages(sessionId)
      if (this.messageLoadVersions.get(sessionId) !== version) return
      this.store.set(agentStateAtom, (state) => ({
        ...state,
        messagesBySession: { ...state.messagesBySession, [sessionId]: messages },
        messageStatusBySession: { ...state.messageStatusBySession, [sessionId]: 'ready' },
        lastError: state.lastError?.scope === 'messages'
          && state.lastError.sessionId === sessionId ? null : state.lastError,
      }))
    } catch {
      if (this.messageLoadVersions.get(sessionId) !== version) return
      this.store.set(agentStateAtom, (state) => ({
        ...state,
        messageStatusBySession: { ...state.messageStatusBySession, [sessionId]: 'error' },
        lastError: { scope: 'messages', sessionId, message: '加载 Agent 消息失败' },
      }))
    }
  }

  /** 主动读取权威队列，用于补偿 IPC 广播与命令响应之间的时序差异。 */
  async loadQueuedMessages(sessionId: string): Promise<void> {
    try {
      const messages = await this.api.listQueuedMessages(sessionId)
      this.store.set(agentStateAtom, (state) => ({
        ...state,
        queuedMessagesBySession: { ...state.queuedMessagesBySession, [sessionId]: messages },
      }))
    } catch {
      // 队列读取失败不影响已持久化消息和当前 Agent 运行。
    }
  }

  async createSession(input: AgentSessionCreateInput = {}): Promise<AgentSessionMeta> {
    const session = await this.api.createSession(input)
    this.sessionsLoadVersion += 1
    this.store.set(agentStateAtom, (state) => ({
      ...state,
      sessions: upsertAgentSession(state.sessions, session),
      messagesBySession: { ...state.messagesBySession, [session.id]: [] },
      messageStatusBySession: { ...state.messageStatusBySession, [session.id]: 'ready' },
    }))
    return session
  }

  async updateSession(id: string, input: AgentSessionUpdateInput): Promise<AgentSessionMeta> {
    const session = await this.api.updateSession(id, input)
    this.sessionsLoadVersion += 1
    this.store.set(agentStateAtom, (state) => ({
      ...state,
      sessions: upsertAgentSession(state.sessions, session),
    }))
    return session
  }

  async deleteSession(sessionId: string): Promise<AgentSessionMeta> {
    const session = await this.api.deleteSession(sessionId)
    this.sessionsLoadVersion += 1
    this.messageLoadVersions.set(sessionId, (this.messageLoadVersions.get(sessionId) ?? 0) + 1)
    this.store.set(agentStateAtom, (state) => {
      const messages = { ...state.messagesBySession }
      const statuses = { ...state.messageStatusBySession }
      const activeRuns = { ...state.activeRunsBySession }
      const activeRunSources = { ...state.activeRunSourcesBySession }
      const retryStatuses = { ...state.retryStatusBySession }
      const compactionStatuses = { ...state.compactionStatusBySession }
      const activeToolUseIds = { ...state.activeToolUseIdsBySession }
      const streamingAssistantUuids = { ...state.streamingAssistantUuidBySession }
      const permissions = { ...state.pendingPermissionsBySession }
      const askUsers = { ...state.pendingAskUsersBySession }
      const exitPlans = { ...state.pendingExitPlansBySession }
      const queuedMessages = { ...state.queuedMessagesBySession }
      delete messages[sessionId]
      delete statuses[sessionId]
      delete activeRuns[sessionId]
      delete activeRunSources[sessionId]
      delete retryStatuses[sessionId]
      delete compactionStatuses[sessionId]
      delete activeToolUseIds[sessionId]
      delete streamingAssistantUuids[sessionId]
      delete permissions[sessionId]
      delete askUsers[sessionId]
      delete exitPlans[sessionId]
      delete queuedMessages[sessionId]
      return {
        ...state,
        sessions: state.sessions.filter((item) => item.id !== sessionId),
        messagesBySession: messages,
        messageStatusBySession: statuses,
        activeRunsBySession: activeRuns,
        activeRunSourcesBySession: activeRunSources,
        retryStatusBySession: retryStatuses,
        compactionStatusBySession: compactionStatuses,
        activeToolUseIdsBySession: activeToolUseIds,
        streamingAssistantUuidBySession: streamingAssistantUuids,
        pendingPermissionsBySession: permissions,
        pendingAskUsersBySession: askUsers,
        pendingExitPlansBySession: exitPlans,
        queuedMessagesBySession: queuedMessages,
        lastError: state.lastError?.sessionId === sessionId ? null : state.lastError,
      }
    })
    return session
  }

  async createProject(input: AgentProjectCreateInput): Promise<AgentProject> {
    const project = await this.api.createProject(input)
    this.projectsLoadVersion += 1
    this.store.set(agentStateAtom, (state) => ({
      ...state,
      projects: upsertAgentProject(state.projects, project),
      projectsStatus: 'ready',
    }))
    return project
  }

  async updateProject(id: string, input: AgentProjectUpdateInput): Promise<AgentProject> {
    const project = await this.api.updateProject(id, input)
    this.projectsLoadVersion += 1
    this.store.set(agentStateAtom, (state) => ({
      ...state,
      projects: upsertAgentProject(state.projects, project),
    }))
    return project
  }

  async deleteProject(id: string): Promise<AgentProject> {
    const project = await this.api.deleteProject(id)
    this.projectsLoadVersion += 1
    this.store.set(agentStateAtom, (state) => ({
      ...state,
      projects: state.projects.filter((item) => item.id !== id),
    }))
    return project
  }

  listProjectMemory(projectId: string): Promise<AgentMemorySummary> {
    return this.api.listProjectMemory(projectId)
  }

  readProjectMemory(projectId: string, relativePath: string): Promise<AgentMemoryFile> {
    return this.api.readProjectMemory(projectId, relativePath)
  }

  writeProjectMemory(projectId: string, relativePath: string, content: string): Promise<AgentMemoryFile> {
    return this.api.writeProjectMemory(projectId, relativePath, content)
  }

  watchProjectMemory(projectId: string): Promise<void> {
    return this.api.watchProjectMemory(projectId)
  }

  unwatchProjectMemory(projectId: string): Promise<void> {
    return this.api.unwatchProjectMemory(projectId)
  }

  onProjectMemoryChanged(callback: (event: AgentMemoryChangedEvent) => void): () => void {
    return this.api.onProjectMemoryChanged(callback)
  }

  /** 打开主进程原生目录选择器；取消是正常结果，传输失败才写入错误状态。 */
  async pickLocalWorkspace(): Promise<AgentWorkspaceDirectorySelection | null> {
    try {
      return await this.api.pickLocalWorkspace()
    } catch {
      this.store.set(agentStateAtom, (state) => ({
        ...state,
        lastError: { scope: 'projects', message: '打开本地项目目录失败' },
      }))
      return null
    }
  }

  /** 请求主进程按工作区边界枚举文件；错误交给当前文件面板就地展示。 */
  async listProjectDirectory(projectId: string): Promise<AgentWorkspaceDirectoryListing> {
    return this.api.listProjectDirectory(projectId)
  }

  async readProjectFile(projectId: string, relativePath: string): Promise<AgentWorkspaceFilePreview> {
    return this.api.readProjectFile(projectId, relativePath)
  }

  async readProjectDiff(projectId: string, relativePath: string): Promise<AgentWorkspaceFileDiff> {
    if (!this.api.readProjectDiff) throw new Error('Diff 功能不可用')
    return this.api.readProjectDiff(projectId, relativePath)
  }

  async watchProjectDirectory(projectId: string): Promise<void> {
    return this.api.watchProjectDirectory(projectId)
  }

  async unwatchProjectDirectory(projectId: string): Promise<void> {
    return this.api.unwatchProjectDirectory(projectId)
  }

  onProjectDirectoryChanged(callback: (event: AgentWorkspaceDirectoryChangedEvent) => void): () => void {
    return this.api.onProjectDirectoryChanged(callback)
  }

  /**
   * started 命令收束后重读 JSONL；queued 命令只刷新等待列表，避免覆盖当前流。
   * success 仅表示主进程已接管消息，模型成败仍由 result 错误卡展示。
   */
  async send(input: AgentSendInput): Promise<AgentSendResult> {
    let result: AgentSendResult
    try {
      result = await this.api.send(input)
    } catch {
      result = { success: false, code: 'internal_error', message: '无法连接主进程 Agent 服务' }
    }
    if (result.success && result.disposition === 'queued') {
      // 等待消息尚未落盘；此时重读 JSONL 会反向覆盖当前轮的流式草稿。
      await this.loadQueuedMessages(input.sessionId)
    } else {
      await Promise.allSettled([this.loadMessages(input.sessionId), this.refreshSessions()])
    }
    this.store.set(agentStateAtom, (state) => ({
      ...state,
      lastError: !result.success
        ? { scope: 'run', sessionId: input.sessionId, code: result.code, message: result.message }
        : state.lastError,
    }))
    return result
  }

  async cancelQueuedMessage(input: AgentQueuedMessageControlInput): Promise<boolean> {
    try {
      const changed = await this.api.cancelQueuedMessage(input)
      await this.loadQueuedMessages(input.sessionId)
      return changed
    } catch { return false }
  }

  async moveQueuedMessage(input: AgentMoveQueuedMessageInput): Promise<boolean> {
    try {
      const changed = await this.api.moveQueuedMessage(input)
      await this.loadQueuedMessages(input.sessionId)
      return changed
    } catch { return false }
  }

  async stop(sessionId: string): Promise<boolean> {
    try { return await this.api.stop(sessionId) } catch {
      this.store.set(agentStateAtom, (state) => ({
        ...state,
        lastError: { scope: 'run', sessionId, message: '停止 Agent 运行失败' },
      }))
      return false
    }
  }

  async respondPermission(response: AgentPermissionResponse): Promise<boolean> {
    try {
      if (!this.api.respondPermission) return false
      return await this.api.respondPermission(response)
    } catch {
      this.store.set(agentStateAtom, (state) => ({
        ...state,
        lastError: { scope: 'run', message: '提交权限选择失败' },
      }))
      return false
    }
  }

  async respondAskUser(response: AgentAskUserResponse): Promise<boolean> {
    try { return await this.api.respondAskUser(response) } catch {
      this.store.set(agentStateAtom, (state) => ({
        ...state,
        lastError: { scope: 'run', message: '提交 Agent 问题回答失败' },
      }))
      return false
    }
  }

  async respondExitPlan(response: AgentExitPlanResponse): Promise<boolean> {
    try {
      const accepted = await this.api.respondExitPlan(response)
      if (!accepted) {
        this.store.set(agentStateAtom, (state) => ({
          ...state,
          lastError: { scope: 'run', message: '计划审批已失效或模式切换失败' },
        }))
      }
      return accepted
    } catch {
      this.store.set(agentStateAtom, (state) => ({
        ...state,
        lastError: { scope: 'run', message: '提交计划审批失败' },
      }))
      return false
    }
  }

  /** 检查会话工作目录和本机命令；页面用结果展示可修复的启动前提示。 */
  async checkEnvironment(input: AgentEnvironmentCheckInput = {}): Promise<AgentEnvironmentCheckResult | null> {
    try {
      if (!this.api.checkEnvironment) return null
      return await this.api.checkEnvironment(input)
    } catch {
      this.store.set(agentStateAtom, (state) => ({
        ...state,
        lastError: { scope: 'environment', message: '检查 Agent 运行环境失败' },
      }))
      return null
    }
  }
}
