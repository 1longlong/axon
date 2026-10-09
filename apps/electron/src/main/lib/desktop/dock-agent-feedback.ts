import type { AgentActiveRun, AgentGenerationEvent } from '@axon/shared'

export interface DockFeedbackPort {
  setBadge(text: string): void
  requestAttention(): number
  cancelAttention(id: number): void
}

export interface DockAgentFeedbackOptions {
  dock: DockFeedbackPort | null
  isForeground(): boolean
}

type InteractionRequestEvent = Extract<AgentGenerationEvent, {
  type: 'permission_request' | 'ask_user_request'
}>

type InteractionResolvedEvent = Extract<AgentGenerationEvent, {
  type: 'permission_resolved' | 'ask_user_resolved'
}>

function runKey(sessionId: string, runStartedAt: number): string {
  return `${sessionId}:${runStartedAt}`
}

function requestId(event: InteractionRequestEvent | InteractionResolvedEvent): string {
  return 'request' in event ? event.request.requestId : event.requestId
}

/**
 * 把中立 Agent 生命周期折叠成 Dock 状态：运行数显示数字，待交互显示感叹号。
 * 本类不依赖 Electron，主进程只需提供一个可选 Dock 端口即可安全跨平台降级。
 */
export class DockAgentFeedbackController {
  private readonly activeRuns = new Set<string>()
  private readonly pendingInteractions = new Set<string>()
  private readonly runOwners = new Map<string, string>()
  private readonly interactionOwners = new Map<string, string>()
  private attentionId: number | null = null

  constructor(private readonly options: DockAgentFeedbackOptions) {}

  /** 在开放 UI 请求前用后端权威快照校准角标，后续按实际入口事件更新。 */
  initialize(activeRuns: readonly AgentActiveRun[]): void {
    this.activeRuns.clear()
    this.runOwners.clear()
    for (const run of activeRuns) this.activeRuns.add(runKey(run.sessionId, run.runStartedAt))
    this.renderBadge()
  }

  /** 消费运行和交互事件；只有应用不在前台时才请求系统注意力。 */
  handleEvent(event: AgentGenerationEvent, clientId?: string): void {
    if (event.type === 'run_started') {
      this.activeRuns.add(runKey(event.sessionId, event.runStartedAt))
      if (clientId) this.runOwners.set(runKey(event.sessionId, event.runStartedAt), clientId)
      this.renderBadge()
      return
    }

    if (event.type === 'run_finished') {
      this.activeRuns.delete(runKey(event.sessionId, event.runStartedAt))
      this.runOwners.delete(runKey(event.sessionId, event.runStartedAt))
      this.renderBadge()
      if (!event.completion.stoppedByUser) this.requestAttentionWhenBackground()
      return
    }

    if (
      event.type === 'permission_request'
      || event.type === 'ask_user_request'
    ) {
      this.pendingInteractions.add(requestId(event))
      if (clientId) this.interactionOwners.set(requestId(event), clientId)
      this.renderBadge()
      this.requestAttentionWhenBackground()
      return
    }

    if (
      event.type === 'permission_resolved'
      || event.type === 'ask_user_resolved'
    ) {
      this.pendingInteractions.delete(requestId(event))
      this.interactionOwners.delete(requestId(event))
      this.renderBadge()
    }
  }

  /** 入口失效后的终态不再投递；立即移除该入口角标，不清除其他窗口运行或请求注意力。 */
  detachClient(clientId: string): void {
    for (const [key, owner] of this.runOwners) if (owner === clientId) { this.runOwners.delete(key); this.activeRuns.delete(key) }
    for (const [key, owner] of this.interactionOwners) if (owner === clientId) { this.interactionOwners.delete(key); this.pendingInteractions.delete(key) }
    this.renderBadge()
  }

  /** 窗口重新获得焦点后停止动画；未解决交互仍由感叹号角标持续表达。 */
  acknowledgeAttention(): void {
    if (this.attentionId === null || !this.options.dock) return
    this.options.dock.cancelAttention(this.attentionId)
    this.attentionId = null
  }

  dispose(): void {
    this.acknowledgeAttention()
    this.activeRuns.clear()
    this.pendingInteractions.clear()
    this.runOwners.clear()
    this.interactionOwners.clear()
    this.options.dock?.setBadge('')
  }

  private renderBadge(): void {
    if (!this.options.dock) return
    const badge = this.pendingInteractions.size > 0
      ? '!'
      : this.activeRuns.size > 0
        ? String(this.activeRuns.size)
        : ''
    this.options.dock.setBadge(badge)
  }

  private requestAttentionWhenBackground(): void {
    if (!this.options.dock || this.options.isForeground() || this.attentionId !== null) return
    this.attentionId = this.options.dock.requestAttention()
  }
}
