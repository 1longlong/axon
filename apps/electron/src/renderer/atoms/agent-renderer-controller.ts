/** Agent renderer 控制器：协调 preload API、实时事件与权威持久化快照。 */

import type { Store } from 'jotai/vanilla/store'
import type {
  AgentAskUserResponse,
  BackendOwnedRun,
  AgentEnvironmentCheckInput,
  AgentEnvironmentCheckResult,
  AgentMemoryChangedEvent,
  AgentMemoryFile,
  AgentMemorySummary,
  AgentMoveQueuedMessageInput,
  AgentPermissionResponse,
  AgentProject,
  AgentProjectCreateInput,
  AgentProjectUpdateInput,
  AgentProjectWatchSubscription,
  AgentProjectWatchTarget,
  AgentProjectWatchClosedEvent,
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
import { mergeAgentHistory, recordAgentHistoryChange } from './agent-history-merge'
import type { AgentHistoryChanges } from './agent-history-merge'
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
  private projectNotificationVersion = 0
  private readonly messageLoadVersions = new Map<string, number>()
  private readonly historyReads = new Map<string, AgentHistoryChanges>()
  private readonly observedRunTokens = new Map<string, number>()
  private readonly runIdentityVersions = new Map<string, number>()
  private readonly pauseLoadVersions = new Map<string, number>()
  private lifecycleVersion = 0

  constructor(
    private readonly api: AgentRendererApi,
    private readonly store: Store,
  ) {}

  /** 先订阅事件再加载索引，避免启动期间漏掉 run_started。 */
  start(): () => void {
    if (this.unsubscribe) return this.unsubscribe
    const lifecycle = ++this.lifecycleVersion
    const unsubscribeProjects = this.api.onProjectsChanged((projects) => {
      if (lifecycle !== this.lifecycleVersion) return
      this.projectNotificationVersion++; this.projectsLoadVersion++
      this.store.set(agentStateAtom, (state) => ({ ...state, projects: sortAgentProjects(projects), projectsStatus: 'ready',
        lastError: state.lastError?.scope === 'projects' ? null : state.lastError }))
    })
    const unsubscribeRuns = this.api.onRunChanged(({ phase, run }) => {
      if (lifecycle !== this.lifecycleVersion) return
      this.runIdentityVersions.set(run.sessionId, (this.runIdentityVersions.get(run.sessionId) ?? 0) + 1)
      const current = this.store.get(agentStateAtom).ownedRunsBySession[run.sessionId]
      if (phase === 'started') {
        if (!current || run.runStartedAt >= current.runStartedAt) this.setOwnedRun(run.sessionId, run)
        // 继续 RPC 要等整轮结束；真实新轮已开始便解除提交锁，允许用户再次暂停它。
        this.setPauseOperation(run.sessionId, undefined, 'continuing')
      } else if (current?.runId === run.runId) this.setOwnedRun(run.sessionId)
    })
    const unsubscribeEvents = this.api.onEvent((event) => {
      if (lifecycle !== this.lifecycleVersion) return
      if (event.type === 'session_title') {
        this.store.set(agentStateAtom, (state) => reduceAgentGenerationEvent(state, event))
        return
      }
      this.observedRunTokens.set(
        event.sessionId,
        Math.max(this.observedRunTokens.get(event.sessionId) ?? 0, event.runStartedAt),
      )
      // 正文流不废弃完整历史读取；只记录本次读取期间真正被 reducer 接纳的消息变化。
      this.store.set(agentStateAtom, (state) => {
        const next = reduceAgentGenerationEvent(state, event)
        const changes = this.historyReads.get(event.sessionId)
        if (changes && next.messagesBySession[event.sessionId] !== state.messagesBySession[event.sessionId]) {
          recordAgentHistoryChange(changes, event)
        }
        return next
      })
      if (event.type === 'run_finished') void this.loadMessages(event.sessionId)
    })
    const unsubscribeQueue = this.api.onQueueChanged((snapshot) => {
      if (lifecycle !== this.lifecycleVersion) return
      this.store.set(agentStateAtom, (state) => ({
        ...state,
        queuedMessagesBySession: {
          ...state.queuedMessagesBySession,
          [snapshot.sessionId]: snapshot.messages,
        },
      }))
    })
    const unsubscribePauses = this.api.onPauseChanged(({ sessionId }) => {
      if (lifecycle === this.lifecycleVersion) {
        const previous = this.store.get(agentStateAtom).activeRunsBySession[sessionId]
        const observedOnly = previous !== undefined && this.observedRunTokens.get(sessionId) !== previous
        void this.loadPause(sessionId, true).then(() => {
          if (lifecycle !== this.lifecycleVersion) return
          const state = this.store.get(agentStateAtom)
          // 原入口已有逐消息流和命令完成校准；变化通知不重复抢占分页快照租额。
          if (state.pauseStatusBySession[sessionId] === 'ready' && !state.pauseOperationsBySession[sessionId]
            && (state.pausesBySession[sessionId]?.state === 'paused'
              || (observedOnly && state.activeRunsBySession[sessionId] === undefined))) void this.loadMessages(sessionId, false)
        })
      }
    })
    const cleanup = (): void => {
      unsubscribeEvents()
      unsubscribeQueue()
      unsubscribeRuns()
      unsubscribeProjects()
      unsubscribePauses()
      if (this.unsubscribe === cleanup) {
        this.unsubscribe = null
        this.lifecycleVersion += 1
        this.store.set(agentStateAtom, (state) => ({ ...state, ownedRunsBySession: {}, pausesBySession: {}, pauseStatusBySession: {}, pauseOperationsBySession: {} }))
        this.historyReads.clear()
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
    void this.restoreActiveRuns(lifecycle)
    return cleanup
  }

  /** 用主进程快照补齐订阅前已启动的任务；订阅后观测到的更新始终优先。 */
  private async restoreActiveRuns(lifecycle: number): Promise<void> {
    try {
      const runs = await this.api.listActiveRuns()
      if (lifecycle !== this.lifecycleVersion) return
      for (const run of runs) {
        if ((this.observedRunTokens.get(run.sessionId) ?? 0) >= run.runStartedAt) {
          // 同一控制器重启时展示状态可复用，但真实控制缓存已释放，仍需查询原入口身份。
          if (!this.store.get(agentStateAtom).ownedRunsBySession[run.sessionId] && this.store.get(agentStateAtom).activeRunsBySession[run.sessionId] === run.runStartedAt) {
            void this.restoreOwnedRun(run.sessionId, run.runStartedAt, lifecycle)
          }
          continue
        }
        this.store.set(agentStateAtom, (state) => reduceAgentGenerationEvent(state, {
          type: 'run_started',
          sessionId: run.sessionId,
          runStartedAt: run.runStartedAt,
          source: run.source,
        }))
        void this.restoreOwnedRun(run.sessionId, run.runStartedAt, lifecycle)
      }
    } catch {
      // 运行快照只是 UI 恢复辅助，失败不能阻断会话和项目索引加载。
    }
  }

  /** 只补订阅前遗漏的所属身份；新事件、结束或页面释放后，迟到查询不能覆盖控制目标。 */
  private async restoreOwnedRun(sessionId: string, runStartedAt: number, lifecycle: number): Promise<void> {
    const version = this.runIdentityVersions.get(sessionId) ?? 0
    try {
      const run = await this.api.getOwnedRun(sessionId)
      if (lifecycle !== this.lifecycleVersion || version !== (this.runIdentityVersions.get(sessionId) ?? 0)
        || !run || run.sessionId !== sessionId || run.runStartedAt !== runStartedAt
        || this.store.get(agentStateAtom).activeRunsBySession[sessionId] !== runStartedAt) return
      this.setOwnedRun(sessionId, run)
    } catch { /* 观察入口或已结束运行没有控制目标，不在点击停止时重新查询。 */ }
  }

  /** 真实控制身份进入可观察状态；普通运行快照不能调用这里授予 owner。 */
  private setOwnedRun(sessionId: string, run?: BackendOwnedRun): void {
    this.store.set(agentStateAtom, (state) => {
      const ownedRunsBySession = { ...state.ownedRunsBySession }
      if (run) ownedRunsBySession[sessionId] = { ...run }
      else delete ownedRunsBySession[sessionId]
      return { ...state, ownedRunsBySession }
    })
  }

  /** 通知只令快照失效；按会话版本/页面代次复读后端，慢响应不能复活旧继续凭据。 */
  async loadPause(sessionId: string, refreshActivity = false): Promise<void> {
    const lifecycle = this.lifecycleVersion
    const observed = this.observedRunTokens.get(sessionId)
    const version = (this.pauseLoadVersions.get(sessionId) ?? 0) + 1
    this.pauseLoadVersions.set(sessionId, version)
    this.store.set(agentStateAtom, (state) => ({ ...state,
      pauseStatusBySession: { ...state.pauseStatusBySession, [sessionId]: 'loading' },
    }))
    try {
      const snapshot = await this.api.getPause(sessionId)
      // 另一入口的继续只广播状态失效，不转投它的正文流；公开运行快照补齐观察状态。
      const runs = refreshActivity ? await this.api.listActiveRuns() : undefined
      if (lifecycle !== this.lifecycleVersion || this.pauseLoadVersions.get(sessionId) !== version) return
      this.store.set(agentStateAtom, (state) => {
        const pausesBySession = { ...state.pausesBySession }
        const newerRun = snapshot && Math.max(state.activeRunsBySession[sessionId] ?? 0,
          this.observedRunTokens.get(sessionId) ?? 0) > snapshot.runStartedAt
        if (snapshot?.sessionId === sessionId && !newerRun) pausesBySession[sessionId] = snapshot
        else delete pausesBySession[sessionId]
        const activeRunsBySession = { ...state.activeRunsBySession }, activeRunSourcesBySession = { ...state.activeRunSourcesBySession }
        if (runs && observed === this.observedRunTokens.get(sessionId)) {
          const run = runs.find((item) => item.sessionId === sessionId)
          if (run) { activeRunsBySession[sessionId] = run.runStartedAt; activeRunSourcesBySession[sessionId] = run.source }
          else { delete activeRunsBySession[sessionId]; delete activeRunSourcesBySession[sessionId] }
        }
        return { ...state, pausesBySession, activeRunsBySession, activeRunSourcesBySession,
          pauseStatusBySession: { ...state.pauseStatusBySession, [sessionId]: 'ready' } }
      })
    } catch {
      if (lifecycle !== this.lifecycleVersion || this.pauseLoadVersions.get(sessionId) !== version) return
      this.store.set(agentStateAtom, (state) => ({ ...state,
        pauseStatusBySession: { ...state.pauseStatusBySession, [sessionId]: 'error' },
      }))
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

  /** JSONL 作基线，保留当前流式草稿并合并读取期间的新消息；版本令牌拒绝迟到快照。 */
  async loadMessages(sessionId: string, refreshPause = true): Promise<void> {
    if (refreshPause) void this.loadPause(sessionId)
    const version = (this.messageLoadVersions.get(sessionId) ?? 0) + 1
    this.messageLoadVersions.set(sessionId, version)
    const changes: AgentHistoryChanges = { byUuid: new Map(), unkeyed: [] }
    const beforeRead = this.store.get(agentStateAtom)
    const runStartedAt = beforeRead.activeRunsBySession[sessionId]
    const draftUuid = runStartedAt !== undefined ? beforeRead.streamingAssistantUuidBySession[sessionId] : undefined
    // 读取前的在途内容尚未落盘，不能依赖读取期间恰好有新 delta 才保住它。
    if (draftUuid) changes.byUuid.set(draftUuid, 'draft')
    this.historyReads.set(sessionId, changes)
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
      this.store.set(agentStateAtom, (state) => {
        // 预置草稿只属于原活跃轮；撤回/完整消息由实时事件覆盖，不续接已结束的旧草稿。
        if (draftUuid && changes.byUuid.get(draftUuid) === 'draft'
          && (state.activeRunsBySession[sessionId] !== runStartedAt || state.streamingAssistantUuidBySession[sessionId] !== draftUuid)) {
          changes.byUuid.delete(draftUuid)
        }
        return {
          ...state,
          messagesBySession: { ...state.messagesBySession, [sessionId]: mergeAgentHistory(messages, state.messagesBySession[sessionId] ?? [], changes) },
          messageStatusBySession: { ...state.messageStatusBySession, [sessionId]: 'ready' },
          lastError: state.lastError?.scope === 'messages'
            && state.lastError.sessionId === sessionId ? null : state.lastError,
        }
      })
    } catch {
      if (this.messageLoadVersions.get(sessionId) !== version) return
      this.store.set(agentStateAtom, (state) => ({
        ...state,
        messageStatusBySession: { ...state.messageStatusBySession, [sessionId]: 'error' },
        lastError: { scope: 'messages', sessionId, message: '加载 Agent 消息失败' },
      }))
    } finally {
      if (this.historyReads.get(sessionId) === changes) this.historyReads.delete(sessionId)
    }
  }

  /** 主动读取权威队列，用于补偿 IPC 广播与命令响应之间的时序差异。 */
  async loadQueuedMessages(sessionId: string): Promise<void> {
    const lifecycle = this.lifecycleVersion
    try {
      const messages = await this.api.listQueuedMessages(sessionId)
      if (lifecycle !== this.lifecycleVersion) return
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
    this.setOwnedRun(sessionId)
    this.pauseLoadVersions.set(sessionId, (this.pauseLoadVersions.get(sessionId) ?? 0) + 1)
    this.historyReads.delete(sessionId)
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
      const queuedMessages = { ...state.queuedMessagesBySession }
      const pauses = { ...state.pausesBySession }, pauseStatus = { ...state.pauseStatusBySession }, pauseOperations = { ...state.pauseOperationsBySession }
      delete pauses[sessionId]; delete pauseStatus[sessionId]; delete pauseOperations[sessionId]
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
        queuedMessagesBySession: queuedMessages,
        pausesBySession: pauses, pauseStatusBySession: pauseStatus, pauseOperationsBySession: pauseOperations,
        lastError: state.lastError?.sessionId === sessionId ? null : state.lastError,
      }
    })
    return session
  }

  /** 创建结果只补未收到通知的本地列表；权威快照和新页面优先于旧响应。 */
  async createProject(input: AgentProjectCreateInput): Promise<AgentProject> {
    const lifecycle = this.lifecycleVersion, notification = this.projectNotificationVersion
    const project = await this.api.createProject(input)
    if (lifecycle !== this.lifecycleVersion || notification !== this.projectNotificationVersion) return project
    this.projectsLoadVersion += 1
    this.store.set(agentStateAtom, (state) => ({
      ...state,
      projects: upsertAgentProject(state.projects, project),
      projectsStatus: 'ready',
    }))
    return project
  }

  /** 项目更新仍由后端保存；收到更近快照后不再合并迟到的单项目响应。 */
  async updateProject(id: string, input: AgentProjectUpdateInput): Promise<AgentProject> {
    const lifecycle = this.lifecycleVersion, notification = this.projectNotificationVersion
    const project = await this.api.updateProject(id, input)
    if (lifecycle !== this.lifecycleVersion || notification !== this.projectNotificationVersion) return project
    this.projectsLoadVersion += 1
    this.store.set(agentStateAtom, (state) => ({
      ...state,
      projects: upsertAgentProject(state.projects, project),
    }))
    return project
  }

  /** 删除只清理本页未更新列表；释放后旧响应不能重新修改项目投影。 */
  async deleteProject(id: string): Promise<AgentProject> {
    const lifecycle = this.lifecycleVersion, notification = this.projectNotificationVersion
    const project = await this.api.deleteProject(id)
    if (lifecycle !== this.lifecycleVersion || notification !== this.projectNotificationVersion) return project
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

  watchProjectMemory(projectId: string): Promise<AgentProjectWatchSubscription> {
    return this.api.watchProjectMemory(projectId)
  }

  unwatchProjectMemory(target: AgentProjectWatchTarget): Promise<boolean> {
    return this.api.unwatchProjectMemory(target)
  }

  onProjectMemoryChanged(callback: (event: AgentMemoryChangedEvent) => void): () => void {
    return this.api.onProjectMemoryChanged(callback)
  }

  /** 打开主进程原生目录选择器；取消是正常结果，传输失败才写入错误状态。 */
  async pickLocalWorkspace(): Promise<AgentWorkspaceDirectorySelection | null> {
    const lifecycle = this.lifecycleVersion
    try {
      const selected = await this.api.pickLocalWorkspace()
      return lifecycle === this.lifecycleVersion ? selected : null
    } catch {
      if (lifecycle !== this.lifecycleVersion) return null
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

  async watchProjectDirectory(projectId: string): Promise<AgentProjectWatchSubscription> {
    return this.api.watchProjectDirectory(projectId)
  }

  async unwatchProjectDirectory(target: AgentProjectWatchTarget): Promise<boolean> {
    return this.api.unwatchProjectDirectory(target)
  }

  onProjectWatchClosed(callback: (event: AgentProjectWatchClosedEvent) => void): () => void {
    return this.api.onProjectWatchClosed(callback)
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

  /** 点击时同步捕获 UI 已观察的真实轮次；传输迟到也只能尝试停止这一个目标。 */
  async stop(sessionId: string): Promise<boolean> {
    const target = this.store.get(agentStateAtom).ownedRunsBySession[sessionId]
    if (!target || this.store.get(agentStateAtom).activeRunsBySession[sessionId] !== target.runStartedAt) return false
    try { return await this.api.stop({ sessionId: target.sessionId, runId: target.runId }) } catch {
      this.store.set(agentStateAtom, (state) => ({
        ...state,
        lastError: { scope: 'run', sessionId, message: '停止 Agent 运行失败' },
      }))
      return false
    }
  }

  /** 同步提交锁驱动输入区；旧继续应答不能清掉新暂停操作的锁。 */
  private setPauseOperation(sessionId: string, operation?: 'pausing' | 'continuing', expected?: 'pausing' | 'continuing'): void {
    this.store.set(agentStateAtom, (state) => {
      if (expected && state.pauseOperationsBySession[sessionId] !== expected) return state
      const pauseOperationsBySession = { ...state.pauseOperationsBySession }
      if (operation) pauseOperationsBySession[sessionId] = operation
      else delete pauseOperationsBySession[sessionId]
      return { ...state, pauseOperationsBySession }
    })
  }

  /** 捕获原入口的确切运行目标；立即防重复，但只信后端收束后重读的 paused 凭据。 */
  async pause(sessionId: string): Promise<boolean> {
    const state = this.store.get(agentStateAtom), target = state.ownedRunsBySession[sessionId]
    if (!target || state.activeRunsBySession[sessionId] !== target.runStartedAt || state.pauseOperationsBySession[sessionId]) return false
    const lifecycle = this.lifecycleVersion
    this.setPauseOperation(sessionId, 'pausing')
    try {
      await this.api.pause({ sessionId: target.sessionId, runId: target.runId })
      return true
    } catch {
      if (lifecycle === this.lifecycleVersion) this.store.set(agentStateAtom, (current) => ({ ...current,
        lastError: { scope: 'run', sessionId, message: '暂停未能确认完成，请检查会话状态；不会自动重发。' },
      }))
      return false
    } finally {
      if (lifecycle === this.lifecycleVersion) {
        await Promise.allSettled([this.loadPause(sessionId, true), this.loadMessages(sessionId, false), this.loadQueuedMessages(sessionId)])
        if (lifecycle === this.lifecycleVersion) this.setPauseOperation(sessionId, undefined, 'pausing')
      }
    }
  }

  /** 继续使用已读取的确切 pauseId；提交不重发，通知/应答均通过后端快照校准。 */
  async continue(sessionId: string): Promise<AgentSendResult> {
    const state = this.store.get(agentStateAtom), pause = state.pausesBySession[sessionId]
    if (!pause || pause.state !== 'paused' || state.pauseStatusBySession[sessionId] !== 'ready'
      || state.ownedRunsBySession[sessionId] || state.activeRunsBySession[sessionId] !== undefined || state.pauseOperationsBySession[sessionId]) {
      return { success: false, code: 'invalid_input', message: '暂停状态尚未确认或已失效' }
    }
    const lifecycle = this.lifecycleVersion
    this.setPauseOperation(sessionId, 'continuing')
    let result: AgentSendResult
    try { result = await this.api.continue({ sessionId, pauseId: pause.pauseId }) }
    catch { result = { success: false, code: 'internal_error', message: '继续请求未能确认，请检查会话状态；不会自动重发。' } }
    if (lifecycle === this.lifecycleVersion) {
      await Promise.allSettled([this.loadPause(sessionId, true), this.loadMessages(sessionId, false), this.refreshSessions()])
      if (lifecycle !== this.lifecycleVersion) return result
      this.setPauseOperation(sessionId, undefined, 'continuing')
      if (!result.success) this.store.set(agentStateAtom, (current) => ({ ...current,
        lastError: { scope: 'run', sessionId, code: result.code, message: result.message },
      }))
    }
    return result
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
