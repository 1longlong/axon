/** AskUserQuestion 工具的请求解析、owner 校验与异步等待生命周期。 */

import { randomUUID } from 'node:crypto'
import type {
  AgentAskUserQuestion,
  AgentAskUserRequest,
  AgentAskUserResponse,
  AgentCustomToolDefinition,
  AgentCustomToolResult,
  AgentGenerationEvent,
} from '@axon/shared'

type AskUserEvent = Extract<AgentGenerationEvent, { type: 'ask_user_request' | 'ask_user_resolved' }>

interface PendingAskUser {
  owner: number
  request: AgentAskUserRequest
  resolve: (result: AgentCustomToolResult) => void
  cleanupSignals: () => void
}

function asRecord(value: unknown): Record<string, unknown> | null {
  return value && typeof value === 'object' && !Array.isArray(value)
    ? value as Record<string, unknown>
    : null
}

/** 严格收口模型生成的工具参数，避免空问题或超大选项进入 renderer。 */
function parseQuestions(input: Record<string, unknown>): AgentAskUserQuestion[] | null {
  if (!Array.isArray(input.questions) || input.questions.length < 1 || input.questions.length > 4) return null
  const questions: AgentAskUserQuestion[] = []
  for (const candidate of input.questions) {
    const raw = asRecord(candidate)
    const question = typeof raw?.question === 'string' ? raw.question.trim().slice(0, 1_000) : ''
    if (!question || questions.some((item) => item.question === question)) return null
    const rawOptions = Array.isArray(raw?.options) ? raw.options.slice(0, 8) : []
    const options = rawOptions.map((option) => {
      const value = asRecord(option)
      return {
        label: typeof value?.label === 'string' ? value.label.trim().slice(0, 100) : '',
        ...(typeof value?.description === 'string' && value.description.trim()
          ? { description: value.description.trim().slice(0, 500) }
          : {}),
      }
    }).filter((option) => option.label)
    questions.push({
      question,
      ...(typeof raw?.header === 'string' && raw.header.trim()
        ? { header: raw.header.trim().slice(0, 40) }
        : {}),
      options,
      multiSelect: raw?.multiSelect === true,
    })
  }
  return questions
}

export class AgentAskUserService {
  private readonly owners = new Map<string, number>()
  private readonly pending = new Map<string, PendingAskUser>()
  private readonly listeners = new Set<(event: AskUserEvent) => void>()
  private readonly createId: () => string

  constructor(createId: () => string = randomUUID) {
    this.createId = createId
  }

  subscribe(listener: (event: AskUserEvent) => void): () => void {
    this.listeners.add(listener)
    return () => this.listeners.delete(listener)
  }

  bindOwner(sessionId: string, owner: number): boolean {
    const current = this.owners.get(sessionId)
    if (current !== undefined && current !== owner) return false
    this.owners.set(sessionId, owner)
    return true
  }

  /** owner 消失时拒绝尚未回答的问题，确保 runtime 工具 Promise 一定收束。 */
  unbindOwner(sessionId: string, owner: number): void {
    if (this.owners.get(sessionId) !== owner) return
    this.owners.delete(sessionId)
    this.cancelSession(sessionId, 'owner_gone', '问题所属窗口已关闭')
  }

  /** 为本轮创建中立自定义工具；真正调用时才登记问题并暂停工具执行。 */
  createTool(sessionId: string, runStartedAt: number, runSignal: AbortSignal): AgentCustomToolDefinition {
    return {
      name: 'AskUserQuestion',
      description: '当继续任务所需的关键事实、选择或授权缺失，且无法从上下文可靠推断时，向用户提出 1 到 4 个最少且具体的问题并等待回答；先完成不依赖该信息的已授权工作，能安全采用合理默认值时继续执行。',
      inputSchema: {
        type: 'object',
        additionalProperties: false,
        required: ['questions'],
        properties: {
          questions: {
            type: 'array', minItems: 1, maxItems: 4,
            items: {
              type: 'object', additionalProperties: false, required: ['question', 'options'],
              properties: {
                question: { type: 'string' },
                header: { type: 'string' },
                multiSelect: { type: 'boolean' },
                options: {
                  type: 'array', maxItems: 8,
                  items: {
                    type: 'object', additionalProperties: false, required: ['label'],
                    properties: { label: { type: 'string' }, description: { type: 'string' } },
                  },
                },
              },
            },
          },
        },
      },
      execute: (input, options) => this.waitForAnswer(
        sessionId, runStartedAt, input, runSignal, options.signal,
      ),
    }
  }

  /** 仅当前 owner 可回答；答案必须覆盖每个问题且限制为简短文本。 */
  respond(owner: number, response: AgentAskUserResponse): boolean {
    const pending = this.pending.get(response.requestId)
    if (!pending || pending.owner !== owner) return false
    if (response.behavior === 'cancel') {
      this.settle(pending, { content: '用户取消了本次问题', isError: true }, 'canceled')
      return true
    }
    const answers: Record<string, string> = {}
    for (const question of pending.request.questions) {
      const answer = response.answers[question.question]?.trim()
      if (!answer || answer.length > 10_000) return false
      answers[question.question] = answer
    }
    this.settle(pending, { content: { answers } }, 'answered')
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

  /** 先登记 pending 再发事件，避免 renderer 的即时回答早于等待记录。 */
  private waitForAnswer(
    sessionId: string,
    runStartedAt: number,
    input: Record<string, unknown>,
    runSignal: AbortSignal,
    toolSignal?: AbortSignal,
  ): Promise<AgentCustomToolResult> {
    const questions = parseQuestions(input)
    const owner = this.owners.get(sessionId)
    if (!questions) return Promise.resolve({ content: 'AskUserQuestion 参数无效', isError: true })
    if (owner === undefined || runSignal.aborted || toolSignal?.aborted) {
      return Promise.resolve({ content: '当前没有可接收问题的交互窗口', isError: true })
    }
    const request: AgentAskUserRequest = {
      requestId: this.createId(), sessionId, runStartedAt, questions,
    }
    return new Promise((resolve) => {
      const abort = (): void => {
        const pending = this.pending.get(request.requestId)
        if (pending) this.settle(pending, { content: 'Agent 运行已停止', isError: true }, 'aborted')
      }
      runSignal.addEventListener('abort', abort, { once: true })
      toolSignal?.addEventListener('abort', abort, { once: true })
      const pending: PendingAskUser = {
        owner, request, resolve,
        cleanupSignals: () => {
          runSignal.removeEventListener('abort', abort)
          toolSignal?.removeEventListener('abort', abort)
        },
      }
      this.pending.set(request.requestId, pending)
      this.emit({ type: 'ask_user_request', sessionId, runStartedAt, request })
    })
  }

  private settle(
    pending: PendingAskUser,
    result: AgentCustomToolResult,
    reason: 'answered' | 'canceled' | 'aborted' | 'owner_gone',
  ): void {
    if (!this.pending.delete(pending.request.requestId)) return
    pending.cleanupSignals()
    pending.resolve(result)
    this.emit({
      type: 'ask_user_resolved',
      sessionId: pending.request.sessionId,
      runStartedAt: pending.request.runStartedAt,
      requestId: pending.request.requestId,
      reason,
    })
  }

  private emit(event: AskUserEvent): void {
    for (const listener of this.listeners) {
      try { listener(event) } catch { console.warn('[Agent 追问] 监听器处理失败') }
    }
  }
}

let askUserService: AgentAskUserService | null = null

export function getAgentAskUserService(): AgentAskUserService {
  askUserService ??= new AgentAskUserService()
  return askUserService
}
