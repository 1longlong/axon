/** 子任务只读协调；校验根作用域后读取 state 与子 Agent 消息。 */

import type { AgentDelegation, AgentGenerationEvent, AgentTaskEvent, BackendClientId, SDKMessage } from '@axon/shared'
import type { BackendClientRegistry } from '../backend-client-registry'
import type { AgentDelegationManager } from './agent-delegation-manager'
import type { AgentEventBus } from '../agent/agent-event-bus'
import type { AgentSessionManager } from '../agent/agent-session-manager'

export interface AgentTaskControllerOptions {
  clients: Pick<BackendClientRegistry, 'has' | 'subscribeDetached'>
  sessions: Pick<AgentSessionManager, 'get' | 'getMessages'>
  tasks: Pick<AgentDelegationManager, 'list' | 'get' | 'subscribe'>
  events: Pick<AgentEventBus, 'subscribe'>
}

/** 仅描述可识别的查询/订阅边界；未知存储与资源错误由协议层脱敏。 */
export class AgentTaskControllerError extends Error {
  constructor(readonly code: 'invalid_input' | 'not_found' | 'unavailable', message: string) {
    super(message)
    this.name = 'AgentTaskControllerError'
  }
}

function parseId(value: unknown, label: string): string {
  if (typeof value !== 'string' || !/^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/.test(value.trim())) {
    throw new AgentTaskControllerError('invalid_input', `${label}无效或为空`)
  }
  return value.trim()
}

export class AgentTaskController {
  private readonly subscriptions = new Map<BackendClientId, Set<() => void>>()
  private readonly unsubscribeClients: () => void
  private disposed = false

  /** 只读投影不接管运行 owner；客户端断开仅释放它的状态和运行事件订阅。 */
  constructor(private readonly options: AgentTaskControllerOptions) {
    this.unsubscribeClients = options.clients.subscribeDetached((client) => this.clearClient(client))
  }

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
    if (!task) throw new AgentTaskControllerError('not_found', '子任务不存在')
    return this.options.sessions.getMessages(task.childSessionId)
  }

  /**
   * 先建立 agentId → task 快照，再订阅状态和运行事件。
   * 每个订阅有独立映射，释放不影响其他订阅；文本 delta 到达时不触碰 state.json。
   */
  subscribe(client: BackendClientId, listener: (event: AgentTaskEvent) => void): () => void {
    if (this.disposed || !this.options.clients.has(client)) {
      throw new AgentTaskControllerError('unavailable', '子任务订阅客户端未登记或已断开')
    }
    const taskByAgentId = new Map(this.options.tasks.list().map((task) => [task.childSessionId, task]))
    let released = false
    const deliver = (event: AgentTaskEvent): void => {
      if (released || this.disposed || !this.options.clients.has(client)) return
      try { listener(event) } catch { console.warn('[子任务订阅] 变化投递失败') }
    }
    const releaseTasks = this.options.tasks.subscribe((event) => {
      if (released) return
      taskByAgentId.set(event.task.childSessionId, event.task)
      deliver(event)
    })
    let releaseRuns: () => void
    // 第二条上游订阅失败时撤销第一条，不能留下没有客户端持有的监听器。
    try {
      releaseRuns = this.options.events.subscribe((event: AgentGenerationEvent, run) => {
        if (released) return
        const task = taskByAgentId.get(event.sessionId)
        if (!task) return
        deliver({
          type: 'agent_event', rootSessionId: task.rootSessionId,
          taskId: task.id, agentId: task.childSessionId, event,
          ...(run ? { run: { ...run } } : {}),
        })
      })
    } catch (error) {
      released = true
      taskByAgentId.clear()
      try { releaseTasks() } catch (cleanupError) { throw new AggregateError([error, cleanupError], '子任务订阅装配失败') }
      throw error
    }
    const release = (): void => {
      if (released) return
      released = true
      // 先失效与移除归属，再清理上游；清理失败或迟到回调也不能重新投递。
      this.subscriptions.get(client)?.delete(release)
      if (this.subscriptions.get(client)?.size === 0) this.subscriptions.delete(client)
      taskByAgentId.clear()
      const errors: unknown[] = []
      for (const cleanup of [releaseRuns, releaseTasks]) {
        try { cleanup() } catch (error) { errors.push(error) }
      }
      if (errors.length) throw new AggregateError(errors, '子任务订阅清理失败')
    }
    const owned = this.subscriptions.get(client) ?? new Set<() => void>()
    owned.add(release)
    this.subscriptions.set(client, owned)
    return release
  }

  /** 逐项释放客户端订阅，失败不跳过同一客户端的其他订阅。 */
  clearClient(client: BackendClientId): void {
    const errors: unknown[] = []
    for (const release of [...(this.subscriptions.get(client) ?? [])]) {
      try { release() } catch (error) { errors.push(error) }
    }
    if (errors.length) throw new AggregateError(errors, '子任务客户端清理失败')
  }

  /** 退出先停止新订阅与投递，再解除断开监听和全部上游订阅。 */
  dispose(): void {
    if (this.disposed) return
    this.disposed = true
    this.unsubscribeClients()
    const errors: unknown[] = []
    for (const client of [...this.subscriptions.keys()]) {
      try { this.clearClient(client) } catch (error) { errors.push(error) }
    }
    if (errors.length) throw new AggregateError(errors, '子任务投影清理失败')
  }

  private requireRoot(value: unknown): string {
    const rootId = parseId(value, '根会话 ID')
    const session = this.options.sessions.get(rootId)
    if (!session || session.parentSessionId) throw new AgentTaskControllerError('not_found', '根会话不存在')
    return rootId
  }
}
