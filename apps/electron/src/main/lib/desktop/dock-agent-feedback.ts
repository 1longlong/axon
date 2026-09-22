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
  type: 'permission_request' | 'ask_user_request' | 'exit_plan_mode_request'
}>

type InteractionResolvedEvent = Extract<AgentGenerationEvent, {
  type: 'permission_resolved' | 'ask_user_resolved' | 'exit_plan_mode_resolved'
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
  private attentionId: number | null = null

  constructor(private readonly options: DockAgentFeedbackOptions) {}

  /** 启动时用 AgentService 的权威快照校准角标，避免窗口重载影响运行计数。 */
  initialize(activeRuns: readonly AgentActiveRun[]): void {
    this.activeRuns.clear()
    for (const run of activeRuns) this.activeRuns.add(runKey(run.sessionId, run.runStartedAt))
    this.renderBadge()
  }

  /** 消费运行和交互事件；只有应用不在前台时才请求系统注意力。 */
  handleEvent(event: AgentGenerationEvent): void {
    if (event.type === 'run_started') {
      this.activeRuns.add(runKey(event.sessionId, event.runStartedAt))
      this.renderBadge()
      return
    }

    if (event.type === 'run_finished') {
      this.activeRuns.delete(runKey(event.sessionId, event.runStartedAt))
      this.renderBadge()
      if (!event.completion.stoppedByUser) this.requestAttentionWhenBackground()
      return
    }

    if (
      event.type === 'permission_request'
      || event.type === 'ask_user_request'
      || event.type === 'exit_plan_mode_request'
    ) {
      this.pendingInteractions.add(requestId(event))
      this.renderBadge()
      this.requestAttentionWhenBackground()
      return
    }

    if (
      event.type === 'permission_resolved'
      || event.type === 'ask_user_resolved'
      || event.type === 'exit_plan_mode_resolved'
    ) {
      this.pendingInteractions.delete(requestId(event))
      this.renderBadge()
    }
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
