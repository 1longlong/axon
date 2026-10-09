/** 子任务 renderer 状态：state.json 快照负责恢复，变化事件负责运行中更新。 */

import { atom } from 'jotai'
import type { Store } from 'jotai/vanilla/store'
import type { AgentCompactionStatus, AgentDelegation, AgentRetryStatus, SDKMessage } from '@axon/shared'
import {
  createInitialAgentRendererState,
  reduceAgentGenerationEvent,
} from './agent-state'
import type { AgentLoadStatus, AgentRendererState } from './agent-state'
import { mergeAgentHistory, recordAgentHistoryChange } from './agent-history-merge'
import type { AgentHistoryChanges } from './agent-history-merge'
import { observeTasks } from '../lib/task-subscription'
import type { TaskObservation, TaskSubscriptionApi } from '../lib/task-subscription'

export interface AgentTaskRendererApi extends TaskSubscriptionApi {
  list(rootSessionId: string): Promise<AgentDelegation[]>
  get(rootSessionId: string, taskId: string): Promise<AgentDelegation | null>
  getMessages(rootSessionId: string, taskId: string): Promise<SDKMessage[]>
}

export interface AgentTaskRendererState {
  tasksByRootSession: Record<string, AgentDelegation[]>
  taskStatusByRootSession: Record<string, AgentLoadStatus>
  messagesByTask: Record<string, SDKMessage[]>
  messageStatusByTask: Record<string, AgentLoadStatus>
  runningByTask: Record<string, boolean>
  retryStatusByTask: Record<string, AgentRetryStatus>
  compactionStatusByTask: Record<string, AgentCompactionStatus>
  activeToolUseIdsByTask: Record<string, string[]>
  streamingAssistantUuidByTask: Record<string, string>
  lastError: { rootSessionId: string; taskId?: string; message: string } | null
}

export const agentTaskStateAtom = atom<AgentTaskRendererState>({
  tasksByRootSession: {},
  taskStatusByRootSession: {},
  messagesByTask: {},
  messageStatusByTask: {},
  runningByTask: {},
  retryStatusByTask: {},
  compactionStatusByTask: {},
  activeToolUseIdsByTask: {},
  streamingAssistantUuidByTask: {},
  lastError: null,
})

function sortTasks(tasks: readonly AgentDelegation[]): AgentDelegation[] {
  return [...tasks].sort((left, right) => left.createdAt - right.createdAt)
}

function upsertTask(tasks: readonly AgentDelegation[], task: AgentDelegation): AgentDelegation[] {
  const position = tasks.findIndex((item) => item.id === task.id)
  if (position < 0) return sortTasks([...tasks, task])
  const next = [...tasks]
  next[position] = task
  return sortTasks(next)
}

/** 完整快照替换旧缓存，只叠加本次读取期间的事件，不依赖毫秒时间戳判定先后。 */
function mergeTaskSnapshot(
  snapshot: readonly AgentDelegation[],
  current: readonly AgentDelegation[],
  changed: ReadonlySet<string>,
): AgentDelegation[] {
  const merged = new Map(snapshot.map((task) => [task.id, task]))
  for (const task of current) {
    if (changed.has(task.id)) merged.set(task.id, task)
  }
  return sortTasks([...merged.values()])
}

/** preload Task API 的协调器；慢快照用版本令牌隔离，实时事件始终优先。 */
export class AgentTaskRendererController {
  private unsubscribe: (() => void) | null = null
  private readonly rootLoadVersions = new Map<string, number>()
  private readonly messageLoadVersions = new Map<string, number>()
  private readonly liveStates = new Map<string, AgentRendererState>()
  private observation: TaskObservation | null = null
  private readonly rootReads = new Map<string, Set<string>>()
  private readonly historyReads = new Map<string, AgentHistoryChanges>()
  private readonly taskGetVersions = new Map<string, number>()
  private readonly taskGetChanged = new Set<string>()
  private readonly runs = new Map<string, { runId: string; startedAt: number; finished: boolean }>()

  constructor(
    private readonly api: AgentTaskRendererApi,
    private readonly store: Store,
  ) {}

  /** 全局任务投影先建立精确订阅；快照调用等待登记成功，不把观察者变成运行 owner。 */
  start(): () => void {
    if (this.unsubscribe) return this.unsubscribe
    const observation = observeTasks(this.api, (event) => {
      if (event.type === 'agent_event') {
        if (event.event.sessionId !== event.agentId || event.run && (event.run.sessionId !== event.agentId || event.run.runStartedAt !== event.event.runStartedAt)) return
        // 审批/追问仍由原入口承接；Task 只读投影不建立第二份交互等待。
        if (['permission_request', 'permission_resolved', 'ask_user_request', 'ask_user_resolved'].includes(event.event.type)) return
        let base = this.liveStates.get(event.taskId) ?? {
          ...createInitialAgentRendererState(), messagesBySession: { [event.agentId]: this.store.get(agentTaskStateAtom).messagesByTask[event.taskId] ?? [] },
        }
        if (event.run) {
          const known = this.runs.get(event.taskId)
          if (event.event.type === 'run_started') {
            if (known && (event.run.runStartedAt < known.startedAt || event.run.runId === known.runId && known.finished)) return
            this.runs.set(event.taskId, { runId: event.run.runId, startedAt: event.run.runStartedAt, finished: false })
          } else if (event.event.type !== 'session_title') {
            if (known && (known.runId !== event.run.runId || known.finished)) return
            if (!known && (event.event.type === 'stream' || event.event.type === 'run_finished')) {
              this.runs.set(event.taskId, { runId: event.run.runId, startedAt: event.run.runStartedAt, finished: false })
              // 重载时未收到 run_started，可信实际轮次允许初始化只读流，不获取控制权。
              base = reduceAgentGenerationEvent(base, { type: 'run_started', sessionId: event.agentId, runStartedAt: event.run.runStartedAt, source: event.event.source })
            }
            if (event.event.type === 'run_finished') this.runs.get(event.taskId)!.finished = true
          }
        }
        const liveState = reduceAgentGenerationEvent(base, event.event)
        if (liveState === base) return
        const history = this.historyReads.get(event.taskId)
        if (history && liveState.messagesBySession[event.agentId] !== base.messagesBySession[event.agentId]) recordAgentHistoryChange(history, event.event)
        this.liveStates.set(event.taskId, liveState)
        this.store.set(agentTaskStateAtom, (state) => {
          const running = liveState.activeRunsBySession[event.agentId] !== undefined
          const retry = liveState.retryStatusBySession[event.agentId]
          const retryStatusByTask = { ...state.retryStatusByTask }
          const compaction = liveState.compactionStatusBySession[event.agentId]
          const compactionStatusByTask = { ...state.compactionStatusByTask }
          if (retry) retryStatusByTask[event.taskId] = retry
          else delete retryStatusByTask[event.taskId]
          if (compaction) compactionStatusByTask[event.taskId] = compaction
          else delete compactionStatusByTask[event.taskId]
          return {
            ...state,
            messagesByTask: { ...state.messagesByTask, [event.taskId]: liveState.messagesBySession[event.agentId] ?? [] },
            runningByTask: { ...state.runningByTask, [event.taskId]: running },
            retryStatusByTask,
            compactionStatusByTask,
            activeToolUseIdsByTask: {
              ...state.activeToolUseIdsByTask,
              [event.taskId]: liveState.activeToolUseIdsBySession[event.agentId] ?? [],
            },
            streamingAssistantUuidByTask: {
              ...state.streamingAssistantUuidByTask,
              [event.taskId]: liveState.streamingAssistantUuidBySession[event.agentId] ?? '',
            },
          }
        })
        if (event.event.type === 'run_finished' && !this.historyReads.has(event.taskId)) void this.loadMessages(event.rootSessionId, event.taskId)
        return
      }
      if (event.task.rootSessionId !== event.rootSessionId) return
      this.rootReads.get(event.rootSessionId)?.add(event.task.id)
      if (this.taskGetVersions.has(event.task.id)) this.taskGetChanged.add(event.task.id)
      this.store.set(agentTaskStateAtom, (state) => ({
        ...state,
        tasksByRootSession: {
          ...state.tasksByRootSession,
          [event.rootSessionId]: upsertTask(
            state.tasksByRootSession[event.rootSessionId] ?? [],
            event.task,
          ),
        },
        taskStatusByRootSession: {
          ...state.taskStatusByRootSession,
          [event.rootSessionId]: 'ready',
        },
      }))
      if (this.store.get(agentTaskStateAtom).messageStatusByTask[event.task.id] === 'ready' && !this.historyReads.has(event.task.id)) {
        void this.loadMessages(event.rootSessionId, event.task.id)
      }
    })
    this.observation = observation
    const cleanup = (): void => {
      observation.dispose()
      if (this.unsubscribe === cleanup) {
        this.unsubscribe = null
        this.observation = null
        for (const [rootId, version] of this.rootLoadVersions) this.rootLoadVersions.set(rootId, version + 1)
        for (const [taskId, version] of this.messageLoadVersions) this.messageLoadVersions.set(taskId, version + 1)
        this.liveStates.clear()
        this.runs.clear()
        this.rootReads.clear(); this.historyReads.clear(); this.taskGetChanged.clear()
        for (const [id, version] of this.taskGetVersions) this.taskGetVersions.set(id, version + 1)
      }
    }
    this.unsubscribe = cleanup
    return cleanup
  }

  /** 子面板可能先于 Provider effect 读取，懒启动同一订阅并等待登记，不另建投影。 */
  private async ready(): Promise<void> {
    if (!this.observation) this.start()
    await this.observation!.ready
  }

  /** 加载根会话 task 快照；订阅先启动，避免快照响应覆盖期间到达的新状态。 */
  async loadTasks(rootSessionId: string): Promise<void> {
    const version = (this.rootLoadVersions.get(rootSessionId) ?? 0) + 1
    this.rootLoadVersions.set(rootSessionId, version)
    const changed = new Set<string>()
    this.rootReads.set(rootSessionId, changed)
    this.store.set(agentTaskStateAtom, (state) => ({
      ...state,
      taskStatusByRootSession: { ...state.taskStatusByRootSession, [rootSessionId]: 'loading' },
    }))
    try {
      await this.ready()
      if (this.rootLoadVersions.get(rootSessionId) !== version) return
      const tasks = await this.api.list(rootSessionId)
      if (this.rootLoadVersions.get(rootSessionId) !== version) return
      this.store.set(agentTaskStateAtom, (state) => ({
        ...state,
        tasksByRootSession: {
          ...state.tasksByRootSession,
          [rootSessionId]: mergeTaskSnapshot(
            tasks,
            state.tasksByRootSession[rootSessionId] ?? [],
            changed,
          ),
        },
        taskStatusByRootSession: { ...state.taskStatusByRootSession, [rootSessionId]: 'ready' },
        lastError: state.lastError?.rootSessionId === rootSessionId ? null : state.lastError,
      }))
    } catch {
      if (this.rootLoadVersions.get(rootSessionId) !== version) return
      this.store.set(agentTaskStateAtom, (state) => ({
        ...state,
        taskStatusByRootSession: { ...state.taskStatusByRootSession, [rootSessionId]: 'error' },
        lastError: { rootSessionId, message: '加载子任务失败' },
      }))
    } finally {
      if (this.rootReads.get(rootSessionId) === changed) this.rootReads.delete(rootSessionId)
    }
  }

  /** 单项慢读取不覆盖期间到达的 Task 事件；卸载/较新请求使返回无效。 */
  async loadTask(rootSessionId: string, taskId: string): Promise<AgentDelegation | null> {
    const version = (this.taskGetVersions.get(taskId) ?? 0) + 1
    this.taskGetVersions.set(taskId, version); this.taskGetChanged.delete(taskId)
    await this.ready()
    if (this.taskGetVersions.get(taskId) !== version) return null
    const task = await this.api.get(rootSessionId, taskId)
    if (this.taskGetVersions.get(taskId) !== version) return null
    const current = this.store.get(agentTaskStateAtom).tasksByRootSession[rootSessionId]?.find((item) => item.id === taskId)
    if (this.taskGetChanged.has(taskId)) return current ?? null
    if (!task) return null
    this.store.set(agentTaskStateAtom, (state) => ({
      ...state,
      tasksByRootSession: {
        ...state.tasksByRootSession,
        [rootSessionId]: upsertTask(state.tasksByRootSession[rootSessionId] ?? [], task),
      },
    }))
    return task
  }

  /** 子 Agent 详情只读取完整 SDKMessage；delta 与 tool_progress 不进入历史快照。 */
  async loadMessages(rootSessionId: string, taskId: string): Promise<void> {
    const version = (this.messageLoadVersions.get(taskId) ?? 0) + 1
    this.messageLoadVersions.set(taskId, version)
    const changes: AgentHistoryChanges = { byUuid: new Map(), unkeyed: [] }
    this.historyReads.set(taskId, changes)
    this.store.set(agentTaskStateAtom, (state) => ({
      ...state,
      messageStatusByTask: { ...state.messageStatusByTask, [taskId]: 'loading' },
    }))
    try {
      await this.ready()
      if (this.messageLoadVersions.get(taskId) !== version) return
      const messages = await this.api.getMessages(rootSessionId, taskId)
      if (this.messageLoadVersions.get(taskId) !== version) return
      const merged = mergeAgentHistory(messages, this.store.get(agentTaskStateAtom).messagesByTask[taskId] ?? [], changes)
      const task = this.store.get(agentTaskStateAtom).tasksByRootSession[rootSessionId]?.find((item) => item.id === taskId)
      // 将完整历史回灌同一 reducer 基线，后续 delta 不再从空数组覆盖旧历史。
      if (task) {
        const base = this.liveStates.get(taskId) ?? createInitialAgentRendererState()
        this.liveStates.set(taskId, { ...base, messagesBySession: { ...base.messagesBySession, [task.childSessionId]: merged } })
      }
      this.store.set(agentTaskStateAtom, (state) => ({
        ...state,
        messagesByTask: { ...state.messagesByTask, [taskId]: merged },
        messageStatusByTask: { ...state.messageStatusByTask, [taskId]: 'ready' },
        lastError: state.lastError?.taskId === taskId ? null : state.lastError,
      }))
    } catch {
      if (this.messageLoadVersions.get(taskId) !== version) return
      this.store.set(agentTaskStateAtom, (state) => ({
        ...state,
        messageStatusByTask: { ...state.messageStatusByTask, [taskId]: 'error' },
        lastError: { rootSessionId, taskId, message: '加载子 Agent 消息失败' },
      }))
    } finally {
      if (this.historyReads.get(taskId) === changes) this.historyReads.delete(taskId)
    }
  }
}
