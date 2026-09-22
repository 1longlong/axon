/** 子任务只读 IPC 编排；校验根作用域后读取 state 与子 Agent 消息。 */

import type { AgentDelegation, AgentGenerationEvent, AgentTaskEvent, SDKMessage } from '@axon/shared'
import type { AgentDelegationManager } from './agent-delegation-manager'
import type { AgentEventBus } from '../agent/agent-event-bus'
import type { AgentSessionManager } from '../agent/agent-session-manager'

export interface AgentTaskIpcControllerOptions {
  sessions: Pick<AgentSessionManager, 'get' | 'getMessages'>
  tasks: Pick<AgentDelegationManager, 'list' | 'get' | 'subscribe'>
  events: Pick<AgentEventBus, 'subscribe'>
}

function parseId(value: unknown, label: string): string {
  if (typeof value !== 'string' || !value.trim()) throw new Error(`${label}不能为空`)
  return value.trim()
}

export class AgentTaskIpcController {
  private readonly taskByAgentId = new Map<string, AgentDelegation>()

  constructor(private readonly options: AgentTaskIpcControllerOptions) {}

  /** 返回根会话内全部前台与后台任务，UI 再按状态分组。 */
  list(rootSessionId: unknown): AgentDelegation[] {
    const rootId = this.requireRoot(rootSessionId)
    return this.options.tasks.list(rootId)
  }

  get(rootSessionId: unknown, taskId: unknown): AgentDelegation | null {
    const rootId = this.requireRoot(rootSessionId)
    const task = this.options.tasks.get(parseId(taskId, '子任务 ID'))
    return task?.rootSessionId === rootId ? task : null
  }

  /** 先校验 task 属于当前根会话，再通过 childSessionId 读取对应 Agent JSONL。 */
  getMessages(rootSessionId: unknown, taskId: unknown): SDKMessage[] {
    const task = this.get(rootSessionId, taskId)
    if (!task) throw new Error('子任务不存在')
    return this.options.sessions.getMessages(task.childSessionId)
  }

  /**
   * 先建立 agentId → task 快照，再订阅状态和运行事件。
   * 映射驻留内存，文本 delta 到达时不触碰 state.json。
   */
  subscribe(listener: (event: AgentTaskEvent) => void): () => void {
    for (const task of this.options.tasks.list()) this.taskByAgentId.set(task.childSessionId, task)
    const releaseTasks = this.options.tasks.subscribe((event) => {
      this.taskByAgentId.set(event.task.childSessionId, event.task)
      listener(event)
    })
    const releaseRuns = this.options.events.subscribe((event: AgentGenerationEvent) => {
      const task = this.taskByAgentId.get(event.sessionId)
      if (!task) return
      listener({
        type: 'agent_event',
        rootSessionId: task.rootSessionId,
        taskId: task.id,
        agentId: task.childSessionId,
        event,
      })
    })
    return () => {
      releaseRuns()
      releaseTasks()
      this.taskByAgentId.clear()
    }
  }

  private requireRoot(value: unknown): string {
    const rootId = parseId(value, '根会话 ID')
    const session = this.options.sessions.get(rootId)
    if (!session || session.parentSessionId) throw new Error('根会话不存在')
    return rootId
  }
}
