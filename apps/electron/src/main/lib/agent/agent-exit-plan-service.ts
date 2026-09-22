/** ExitPlanMode 的参数校验、owner 路由与计划审批等待生命周期。 */

import { randomUUID } from 'node:crypto'
import type {
  AgentCustomToolDefinition,
  AgentCustomToolResult,
  AgentExecutionPermissionMode,
  AgentExitPlanRequest,
  AgentExitPlanResponse,
  AgentGenerationEvent,
} from '@axon/shared'

type ExitPlanEvent = Extract<
  AgentGenerationEvent,
  { type: 'exit_plan_mode_request' | 'exit_plan_mode_resolved' | 'plan_mode_changed' }
>

interface PendingExitPlan {
  owner: number
  request: AgentExitPlanRequest
  resolve: (result: AgentCustomToolResult) => void
  cleanupSignals: () => void
}

function parsePlan(input: Record<string, unknown>): Pick<AgentExitPlanRequest, 'plan' | 'allowedOperations'> | null {
  const plan = typeof input.plan === 'string' ? input.plan.trim() : ''
  if (!plan || plan.length > 40_000) return null
  const rawOperations = input.allowedOperations === undefined ? [] : input.allowedOperations
  if (!Array.isArray(rawOperations) || rawOperations.length > 20) return null
  const allowedOperations = rawOperations.map((item) => (
    typeof item === 'string' ? item.trim().slice(0, 300) : ''
  )).filter(Boolean)
  if (allowedOperations.length !== rawOperations.length) return null
  return { plan, allowedOperations }
}

export class AgentExitPlanService {
  private readonly owners = new Map<string, number>()
  private readonly pending = new Map<string, PendingExitPlan>()
  private readonly listeners = new Set<(event: ExitPlanEvent) => void>()

  constructor(private readonly createId: () => string = randomUUID) {}

  subscribe(listener: (event: ExitPlanEvent) => void): () => void {
    this.listeners.add(listener)
    return () => this.listeners.delete(listener)
  }

  bindOwner(sessionId: string, owner: number): boolean {
    const current = this.owners.get(sessionId)
    if (current !== undefined && current !== owner) return false
    this.owners.set(sessionId, owner)
    return true
  }

  /** owner 消失时收束计划工具，防止窗口关闭后 runtime 永久等待。 */
  unbindOwner(sessionId: string, owner: number): void {
    if (this.owners.get(sessionId) !== owner) return
    this.owners.delete(sessionId)
    this.cancelSession(sessionId, 'owner_gone', '计划审批所属窗口已关闭')
  }

  /** 将模型提交计划转换成中立工具，并在调用处暂停等待 renderer 审批。 */
  createTool(sessionId: string, runStartedAt: number, runSignal: AbortSignal): AgentCustomToolDefinition {
    return {
      name: 'ExitPlanMode',
      description: '完成只读调研后提交完整实施计划，并等待用户批准、反馈或拒绝。批准前不要执行计划。',
      inputSchema: {
        type: 'object',
        additionalProperties: false,
        required: ['plan'],
        properties: {
          plan: { type: 'string', description: '完整、简洁、可执行的实施计划。' },
          allowedOperations: {
            type: 'array', maxItems: 20,
            description: '执行计划预计需要的写入、命令或其他有副作用操作。',
            items: { type: 'string' },
          },
        },
      },
      execute: (input, options) => this.waitForApproval(
        sessionId, runStartedAt, input, runSignal, options.signal,
      ),
    }
  }

  /** 审批先切换并持久化模式，再唤醒工具；反馈和拒绝保持 plan 继续只读。 */
  async respond(
    owner: number,
    response: AgentExitPlanResponse,
    changeMode: (sessionId: string, mode: AgentExecutionPermissionMode) => Promise<void>,
  ): Promise<boolean> {
    const pending = this.pending.get(response.requestId)
    if (!pending || pending.owner !== owner) return false
    if (response.action === 'approve') {
      await changeMode(pending.request.sessionId, response.targetMode)
      if (this.pending.get(response.requestId) !== pending) return false
      this.settle(pending, {
        content: { approved: true, permissionMode: response.targetMode },
      }, 'approved')
      this.emit({
        type: 'plan_mode_changed',
        sessionId: pending.request.sessionId,
        runStartedAt: pending.request.runStartedAt,
        active: false,
        mode: response.targetMode,
        source: 'approval',
      })
      return true
    }
    if (response.action === 'feedback') {
      const feedback = response.feedback.trim()
      if (!feedback || feedback.length > 10_000) return false
      this.settle(pending, {
        content: { approved: false, feedback, instruction: '请继续只读调研并修改计划，然后重新提交审批。' },
      }, 'feedback')
      return true
    }
    this.settle(pending, {
      content: { approved: false, rejected: true, instruction: '用户拒绝当前计划，不要执行任何改动。' },
    }, 'rejected')
    return true
  }

  cancelSession(
    sessionId: string,
    reason: 'aborted' | 'owner_gone' = 'aborted',
    message = 'Agent 运行已停止',
  ): number {
    const matches = [...this.pending.values()].filter((item) => item.request.sessionId === sessionId)
    for (const pending of matches) this.settle(pending, { content: message, isError: true }, reason)
    return matches.length
  }

  /** 先登记 pending 再广播，避免 renderer 即时响应早于等待记录。 */
  private waitForApproval(
    sessionId: string,
    runStartedAt: number,
    input: Record<string, unknown>,
    runSignal: AbortSignal,
    toolSignal?: AbortSignal,
  ): Promise<AgentCustomToolResult> {
    const parsed = parsePlan(input)
    const owner = this.owners.get(sessionId)
    if (!parsed) return Promise.resolve({ content: 'ExitPlanMode 参数无效', isError: true })
    if (owner === undefined || runSignal.aborted || toolSignal?.aborted) {
      return Promise.resolve({ content: '当前没有可接收计划审批的交互窗口', isError: true })
    }
    const request: AgentExitPlanRequest = {
      requestId: this.createId(), sessionId, runStartedAt, ...parsed,
    }
    return new Promise((resolve) => {
      const abort = (): void => {
        const pending = this.pending.get(request.requestId)
        if (pending) this.settle(pending, { content: 'Agent 运行已停止', isError: true }, 'aborted')
      }
      runSignal.addEventListener('abort', abort, { once: true })
      toolSignal?.addEventListener('abort', abort, { once: true })
      const pending: PendingExitPlan = {
        owner, request, resolve,
        cleanupSignals: () => {
          runSignal.removeEventListener('abort', abort)
          toolSignal?.removeEventListener('abort', abort)
        },
      }
      this.pending.set(request.requestId, pending)
      this.emit({ type: 'exit_plan_mode_request', sessionId, runStartedAt, request })
    })
  }

  private settle(
    pending: PendingExitPlan,
    result: AgentCustomToolResult,
    reason: 'approved' | 'feedback' | 'rejected' | 'aborted' | 'owner_gone',
  ): void {
    if (!this.pending.delete(pending.request.requestId)) return
    pending.cleanupSignals()
    pending.resolve(result)
    this.emit({
      type: 'exit_plan_mode_resolved',
      sessionId: pending.request.sessionId,
      runStartedAt: pending.request.runStartedAt,
      requestId: pending.request.requestId,
      reason,
    })
  }

  private emit(event: ExitPlanEvent): void {
    for (const listener of this.listeners) {
      try { listener(event) } catch { console.warn('[Agent 计划审批] 监听器处理失败') }
    }
  }
}

let exitPlanService: AgentExitPlanService | null = null

export function getAgentExitPlanService(): AgentExitPlanService {
  exitPlanService ??= new AgentExitPlanService()
  return exitPlanService
}
