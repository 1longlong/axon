/** 子任务 renderer 状态：state.json 快照负责恢复，变化事件负责运行中更新。 */

import { atom } from 'jotai'
import type { Store } from 'jotai/vanilla/store'
import type { AgentCompactionStatus, AgentDelegation, AgentRetryStatus, AgentTaskEvent, SDKMessage } from '@axon/shared'
import {
  createInitialAgentRendererState,
  reduceAgentGenerationEvent,
} from './agent-state'
import type { AgentLoadStatus, AgentRendererState } from './agent-state'

export interface AgentTaskRendererApi {
  list(rootSessionId: string): Promise<AgentDelegation[]>
  get(rootSessionId: string, taskId: string): Promise<AgentDelegation | null>
  getMessages(rootSessionId: string, taskId: string): Promise<SDKMessage[]>
  onEvent(callback: (event: AgentTaskEvent) => void): () => void
}

export interface AgentTaskRendererState {
  tasksByRootSession: Record<string, AgentDelegation[]>
  taskStatusByRootSession: Record<string, AgentLoadStatus>
  messagesByTask: Record<string, SDKMessage[]>
  messageStatusByTask: Record<string, AgentLoadStatus>
  /** 用主 Agent 同款 reducer 折叠出的当前子 Agent 消息；不落盘。 */
  liveMessagesByTask: Record<string, SDKMessage[]>
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
  liveMessagesByTask: {},
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

/** 快照补齐缺失任务，同 ID 时保留 renderer 已收到的更新版本。 */
function mergeTaskSnapshot(
  snapshot: readonly AgentDelegation[],
  current: readonly AgentDelegation[],
): AgentDelegation[] {
  const merged = new Map(snapshot.map((task) => [task.id, task]))
  for (const task of current) {
    const fromSnapshot = merged.get(task.id)
    if (!fromSnapshot || task.updatedAt > fromSnapshot.updatedAt) merged.set(task.id, task)
  }
  return sortTasks([...merged.values()])
}

/** preload Task API 的协调器；慢快照用版本令牌隔离，实时事件始终优先。 */
export class AgentTaskRendererController {
  private unsubscribe: (() => void) | null = null
  private readonly rootLoadVersions = new Map<string, number>()
  private readonly messageLoadVersions = new Map<string, number>()
  private readonly liveStates = new Map<string, AgentRendererState>()

  constructor(
    private readonly api: AgentTaskRendererApi,
    private readonly store: Store,
  ) {}

  start(): () => void {
    if (this.unsubscribe) return this.unsubscribe
    const unsubscribe = this.api.onEvent((event) => {
      if (event.type === 'agent_event') {
        const base = event.event.type === 'run_started'
          ? createInitialAgentRendererState()
          : this.liveStates.get(event.taskId) ?? createInitialAgentRendererState()
        const liveState = reduceAgentGenerationEvent(base, event.event)
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
            liveMessagesByTask: {
              ...state.liveMessagesByTask,
              [event.taskId]: liveState.messagesBySession[event.agentId] ?? [],
            },
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
        return
      }
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
      if (this.store.get(agentTaskStateAtom).messagesByTask[event.task.id]) {
        void this.loadMessages(event.rootSessionId, event.task.id)
      }
    })
    const cleanup = (): void => {
      unsubscribe()
      if (this.unsubscribe === cleanup) {
        this.unsubscribe = null
        for (const [rootId, version] of this.rootLoadVersions) this.rootLoadVersions.set(rootId, version + 1)
        for (const [taskId, version] of this.messageLoadVersions) this.messageLoadVersions.set(taskId, version + 1)
        this.liveStates.clear()
      }
    }
    this.unsubscribe = cleanup
    return cleanup
  }

  /** 加载根会话 task 快照；订阅先启动，避免快照响应覆盖期间到达的新状态。 */
  async loadTasks(rootSessionId: string): Promise<void> {
    const version = (this.rootLoadVersions.get(rootSessionId) ?? 0) + 1
    this.rootLoadVersions.set(rootSessionId, version)
    this.store.set(agentTaskStateAtom, (state) => ({
      ...state,
      taskStatusByRootSession: { ...state.taskStatusByRootSession, [rootSessionId]: 'loading' },
    }))
    try {
      const tasks = await this.api.list(rootSessionId)
      if (this.rootLoadVersions.get(rootSessionId) !== version) return
      this.store.set(agentTaskStateAtom, (state) => ({
        ...state,
        tasksByRootSession: {
          ...state.tasksByRootSession,
          [rootSessionId]: mergeTaskSnapshot(
            tasks,
            state.tasksByRootSession[rootSessionId] ?? [],
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
    }
  }

  async loadTask(rootSessionId: string, taskId: string): Promise<AgentDelegation | null> {
    const task = await this.api.get(rootSessionId, taskId)
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
    this.store.set(agentTaskStateAtom, (state) => ({
      ...state,
      messageStatusByTask: { ...state.messageStatusByTask, [taskId]: 'loading' },
    }))
    try {
      const messages = await this.api.getMessages(rootSessionId, taskId)
      if (this.messageLoadVersions.get(taskId) !== version) return
      this.store.set(agentTaskStateAtom, (state) => ({
        ...state,
        messagesByTask: { ...state.messagesByTask, [taskId]: messages },
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
    }
  }
}
