/** exec 收集整个工作流的中立事件；通知与 RPC 终态一致才确认最终主回复。 */
import { APP_SERVER_CLIENT_METHODS, APP_SERVER_NOTIFICATIONS } from '@axon/shared'
import type { AgentCompletionPayload, AgentTypedError, AgentWorkflowResult, BackendAgentRunEvent,
  BackendAgentWorkflow, ExecEvent, ExecExecutionCompletion, RpcParams } from '@axon/shared'
import type { JsonRpcPeer } from '@axon/app-server'

export class ExecStreamError extends Error {
  constructor() { super('CLI 运行事件身份、顺序或结果无效'); this.name = 'ExecStreamError' }
}
interface RunState {
  envelope: BackendAgentRunEvent
  texts: Map<string, string>
  result?: { subtype: string; stopped: boolean }
  completion?: AgentCompletionPayload
}
export interface ExecRunSnapshot {
  runId: string
  sessionId: string
  finalText: string
  completion: AgentCompletionPayload
  success: boolean
}
export interface ExecWorkflowSnapshot {
  result: AgentWorkflowResult
  /** 失败或取消不把局部回复作为普通 stdout 的最终正文。 */
  finalText: string
  success: boolean
}
export interface ExecRunStreamOptions {
  executionId: string
  /** 同步交给有界输出队列，不能在通知回调中无限累积异步写入。 */
  emit: (event: ExecEvent) => void
  now?: () => number
}
function object(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
}
function id(value: unknown): value is string { return typeof value === 'string' && value.trim().length > 0 }
function finite(value: unknown): value is number { return typeof value === 'number' && Number.isFinite(value) && value >= 0 }

/** 工作流及 RPC 校验使用显式中立字段，不把私有/额外传输属性复制到公开 JSONL。 */
function workflow(value: unknown): BackendAgentWorkflow {
  if (!object(value) || !id(value.sessionId) || !id(value.workflowId) || !finite(value.startedAt)) throw new ExecStreamError()
  return { sessionId: value.sessionId, workflowId: value.workflowId, startedAt: value.startedAt }
}
function typedError(value: unknown): AgentTypedError {
  if (!object(value) || !id(value.code) || typeof value.message !== 'string' || typeof value.retryable !== 'boolean'
    || !['network', 'provider', 'protocol', 'context', 'runtime', 'configuration', 'workspace', 'permission', 'persistence', 'canceled', 'unknown'].includes(String(value.category))) throw new ExecStreamError()
  return { code: value.code, category: value.category as AgentTypedError['category'], message: value.message, retryable: value.retryable }
}
/** 校验真实用量/终态并固定字段顺序，供事件和应答相互核对；不补造缺失用量。 */
function completion(value: unknown): AgentCompletionPayload {
  if (!object(value) || !id(value.resultSubtype) || !id(value.terminalReason)
    || typeof value.persisted !== 'boolean' || typeof value.stoppedByUser !== 'boolean'
    || !finite(value.completedAt) || !finite(value.durationMs) || !object(value.usage) || !finite(value.usage.input_tokens)
    || value.totalCostUsd !== undefined && !finite(value.totalCostUsd)) throw new ExecStreamError()
  const parsed: AgentCompletionPayload = { terminalReason: value.terminalReason, resultSubtype: value.resultSubtype,
    stoppedByUser: value.stoppedByUser, persisted: value.persisted, usage: { input_tokens: value.usage.input_tokens },
    completedAt: value.completedAt, durationMs: value.durationMs }
  for (const key of ['output_tokens', 'cache_read_input_tokens', 'cache_creation_input_tokens'] as const) {
    if (value.usage[key] === undefined) continue
    if (!finite(value.usage[key])) throw new ExecStreamError()
    parsed.usage[key] = value.usage[key]
  }
  if (value.totalCostUsd !== undefined) parsed.totalCostUsd = value.totalCostUsd as number
  if (value.error !== undefined) parsed.error = typedError(value.error)
  return parsed
}
/** 按终态检查字段组合；completed 必须有正常落盘主轮，失败必须携带中立错误。 */
function workflowResult(value: unknown): AgentWorkflowResult {
  if (!object(value) || !['completed', 'failed', 'canceled'].includes(String(value.status))) throw new ExecStreamError()
  const parsed: AgentWorkflowResult = { workflow: workflow(value.workflow), status: value.status as AgentWorkflowResult['status'] }
  if (value.lastRun !== undefined) {
    if (!object(value.lastRun) || !id(value.lastRun.sessionId) || !id(value.lastRun.runId) || !finite(value.lastRun.runStartedAt)) throw new ExecStreamError()
    parsed.lastRun = { sessionId: value.lastRun.sessionId, runId: value.lastRun.runId, runStartedAt: value.lastRun.runStartedAt }
  }
  if (value.completion !== undefined) parsed.completion = completion(value.completion)
  if (value.error !== undefined) parsed.error = typedError(value.error)
  if (Boolean(parsed.lastRun) !== Boolean(parsed.completion) || parsed.lastRun && parsed.lastRun.sessionId !== parsed.workflow.sessionId
    || parsed.status === 'failed' && !parsed.error || parsed.status !== 'failed' && parsed.error
    || parsed.status === 'completed' && (!parsed.completion || parsed.completion.resultSubtype !== 'success'
      || !parsed.completion.persisted || parsed.completion.stoppedByUser || parsed.completion.error)) throw new ExecStreamError()
  return parsed
}

/** 仅解析可信后端的领域数据；路由与输出实际使用的字段必须通过跨进程校验。 */
function envelope(value: unknown): BackendAgentRunEvent {
  if (!object(value) || !object(value.run) || !object(value.event) || !id(value.visibleSessionId)
    || !id(value.run.sessionId) || !id(value.run.runId) || !finite(value.run.runStartedAt)
    || value.event.sessionId !== value.run.sessionId || value.event.runStartedAt !== value.run.runStartedAt
    || !['run_started', 'stream', 'run_finished', 'permission_resolved', 'ask_user_resolved'].includes(String(value.event.type))) {
    throw new ExecStreamError()
  }
  return value as unknown as BackendAgentRunEvent
}

export class ExecRunStream {
  private target?: { clientId: string; sessionId: string }
  private readonly runs = new Map<string, RunState>()
  private readonly failure = new AbortController()
  private sequence = 0
  private bytes = 0
  private latestRootRun?: string
  private startedWorkflow?: BackendAgentWorkflow
  private finishedWorkflow?: AgentWorkflowResult
  private confirmed = false
  private executionStarted = false
  private executionFinished = false
  private disposed = false
  private attached = false

  constructor(private readonly options: ExecRunStreamOptions) {
    if (!id(options.executionId)) throw new ExecStreamError()
  }
  get signal(): AbortSignal { return this.failure.signal }

  /** 参数解析后登记 CLI 范围；帮助/版本不登记，不在输出中携带凭据或用户任务。 */
  beginExecution(): void {
    this.signal.throwIfAborted()
    if (this.disposed || this.executionStarted) throw new ExecStreamError()
    this.executionStarted = true
    this.options.emit({ ...this.identity(), type: 'exec_started' })
  }

  /** 清理和正文交付后输出唯一 CLI 终态；协议失败也可报告失败，但不能报成功。 */
  finishExecution(value: ExecExecutionCompletion): void {
    if (this.disposed || !this.executionStarted || this.executionFinished
      || ![0, 1, 2, 3, 124, 130, 143].includes(value.exitCode)
      || !['completed', 'failed', 'not_started'].includes(value.cleanup)
      || value.exitCode === 0 && (this.signal.aborted || !this.confirmed || this.finishedWorkflow?.status !== 'completed'
        || value.cleanup !== 'completed' || value.error)) throw new ExecStreamError()
    const parsed: ExecExecutionCompletion = { exitCode: value.exitCode, cleanup: value.cleanup,
      ...(value.error ? { error: typedError(value.error) } : {}) }
    this.executionFinished = true
    this.options.emit({ ...this.identity(), type: 'exec_finished', completion: parsed })
  }

  /** 握手前安装订阅；会话创建后、执行工作流前绑定原 external 身份和根会话。 */
  attach(peer: JsonRpcPeer): void {
    if (this.attached || this.disposed) throw new ExecStreamError()
    this.attached = true
    peer.handleNotification(APP_SERVER_NOTIFICATIONS.AGENT_RUN, (params) => this.receive(params))
    peer.handleNotification(APP_SERVER_NOTIFICATIONS.AGENT_WORKFLOW, (params) => this.receiveWorkflow(params))
    // never/reject 的实际拒绝由 core 完成；意外交互不能转为自动批准或伪造回答。
    for (const [method, behavior] of [[APP_SERVER_CLIENT_METHODS.AGENT_PERMISSION, 'deny'], [APP_SERVER_CLIENT_METHODS.AGENT_ASK_USER, 'cancel']] as const) {
      peer.handle(method, (params) => {
        this.fail()
        const request = object(params) && object(params.event) && object(params.event.event) && object(params.event.event.request)
          ? params.event.event.request : undefined
        return { requestId: request && id(request.requestId) ? request.requestId : '', behavior }
      })
    }
  }

  /** 取消使用真实后端范围；没收到开始事件时由请求取消/连接退出处理交付未知。 */
  activeWorkflow(): BackendAgentWorkflow | undefined {
    return this.startedWorkflow && !this.finishedWorkflow ? { ...this.startedWorkflow } : undefined
  }

  /** 工作流开始先于模型轮次，完成晚于全部主/子 finally；唯一终态与流快照相互核对。 */
  receiveWorkflow(params: RpcParams): void {
    if (this.disposed || this.signal.aborted) return
    try {
      if (!object(params) || !id(params.clientId)) throw new ExecStreamError()
      if (!this.target || params.clientId !== this.target.clientId) return
      if (!object(params.event)) throw new ExecStreamError()
      if (params.event.type === 'workflow_started') {
        const started = workflow(params.event.workflow)
        if (started.sessionId !== this.target.sessionId) return
        if (this.startedWorkflow || this.finishedWorkflow || this.runs.size) throw new ExecStreamError()
        this.startedWorkflow = started
        this.options.emit({ ...this.identity(), type: 'workflow_started', workflow: started })
      } else if (params.event.type === 'workflow_finished') {
        const result = workflowResult(params.event.result)
        if (result.workflow.sessionId !== this.target.sessionId) return
        if (!this.startedWorkflow || this.finishedWorkflow
          || JSON.stringify(result.workflow) !== JSON.stringify(this.startedWorkflow)) throw new ExecStreamError()
        this.validateFinal(result)
        this.finishedWorkflow = result
        this.options.emit({ ...this.identity(), type: 'workflow_finished', result })
      } else throw new ExecStreamError()
    } catch { this.fail() }
  }
  bind(clientId: string, sessionId: string): void {
    if (this.target || this.disposed || !id(clientId) || !id(sessionId)) throw new ExecStreamError()
    this.signal.throwIfAborted()
    this.target = { clientId, sessionId }
  }

  /** 通知同步按到达顺序投影；任何协议/输出故障封口，交付未知不会靠重新发送补救。 */
  receive(params: RpcParams): void {
    if (this.disposed || this.signal.aborted) return
    try {
      if (!object(params) || !id(params.clientId)) throw new ExecStreamError()
      if (!this.target || params.clientId !== this.target.clientId) return
      const packet = envelope(params.event)
      if (packet.visibleSessionId !== this.target.sessionId) return
      if (!this.startedWorkflow || this.finishedWorkflow) throw new ExecStreamError()
      const { run, event } = packet
      let state = this.runs.get(run.runId)
      // 用户消息首次落盘就失败时没有 run_started；仅允许带明确未落盘终态的实际身份。
      const failedBeforeStart = !state && event.type === 'run_finished' && event.completion?.persisted === false
      if (event.type === 'run_started' || event.type === 'run_finished' && failedBeforeStart) {
        if (state || this.runs.size >= 4096 || (run.sessionId === this.target.sessionId
          ? event.source !== (this.latestRootRun ? 'background_notification' : 'external') : event.source !== 'delegation' || !this.latestRootRun)) throw new ExecStreamError()
        if (run.sessionId === this.target.sessionId) {
          const prior = this.latestRootRun && this.runs.get(this.latestRootRun)
          if (prior && !prior.completion) throw new ExecStreamError()
          if (prior) { for (const uuid of prior.texts.keys()) this.removeText(prior, uuid) }
          this.latestRootRun = run.runId
        }
        state = { envelope: packet, texts: new Map() }
        this.runs.set(run.runId, state)
      }
      if (event.type !== 'run_started') {
        if (!state || state.completion || state.envelope.run.sessionId !== run.sessionId
          || state.envelope.run.runStartedAt !== run.runStartedAt) throw new ExecStreamError()
        if ((event.type === 'stream' || event.type === 'run_finished')
          && state.envelope.event.type === 'run_started' && event.source !== state.envelope.event.source) throw new ExecStreamError()
        if (event.type === 'stream') this.stream(state, packet)
        else if (event.type === 'run_finished') {
          const parsed = completion(event.completion)
          if (parsed.completedAt < run.runStartedAt
            || state.result && (state.result.subtype !== parsed.resultSubtype || state.result.stopped !== parsed.stoppedByUser)
            || parsed.persisted && !state.result) throw new ExecStreamError()
          state.completion = parsed
        }
      }
      // clientId 和原始私有 RPC 外壳不进入公开输出；unknown usage 不补造为零。
      this.options.emit({ ...this.identity(), type: 'agent_event', run, visibleSessionId: packet.visibleSessionId, event })
    } catch { this.fail() }
  }

  /** delta 只输出、不作为最终正文；完整消息按 uuid 更新，丢弃/重试可撤销候选。 */
  private stream(state: RunState, packet: BackendAgentRunEvent): void {
    if (packet.event.type !== 'stream' || !object(packet.event.payload)) throw new ExecStreamError()
    const payload = packet.event.payload
    if (state.result) throw new ExecStreamError()
    if (payload.kind === 'discard_assistant') this.removeText(state, payload.uuid)
    else if (payload.kind === 'retry_status' && payload.status.phase === 'scheduled' && payload.status.discardedAssistantUuid) {
      this.removeText(state, payload.status.discardedAssistantUuid)
    } else if (payload.kind === 'sdk_message') {
      const message = payload.message
      if (!object(message) || !id(message.type)) throw new ExecStreamError()
      if (message.type === 'result') {
        if (typeof message.subtype !== 'string' || message.stopped_by_user !== undefined && typeof message.stopped_by_user !== 'boolean') throw new ExecStreamError()
        state.result = { subtype: message.subtype, stopped: message.stopped_by_user === true }
      } else if (message.type === 'assistant' && packet.run.sessionId === this.target!.sessionId && message.parent_tool_use_id == null) {
        if (!object(message.message) || !Array.isArray(message.message.content) || !id(message.uuid)) throw new ExecStreamError()
        const texts: string[] = []
        for (const block of message.message.content) {
          if (!object(block)) throw new ExecStreamError()
          if (block.type === 'text') {
            if (typeof block.text !== 'string') throw new ExecStreamError()
            texts.push(block.text)
          }
        }
        this.removeText(state, message.uuid)
        const text = texts.join('\n')
        if (text.trim()) {
          this.bytes += Buffer.byteLength(text)
          if (this.bytes > 16 * 1024 * 1024 || state.texts.size >= 4096) throw new ExecStreamError()
          state.texts.set(message.uuid, text)
        }
      }
    } else if (!['sdk_delta', 'retry_status', 'compaction_status', 'discard_assistant'].includes(payload.kind)) throw new ExecStreamError()
  }
  private removeText(state: RunState, uuid: string): void {
    const text = state.texts.get(uuid)
    if (text !== undefined) { this.bytes -= Buffer.byteLength(text); state.texts.delete(uuid) }
  }
  private fail(): void { if (!this.signal.aborted) this.failure.abort(new ExecStreamError()) }

  private identity() {
    return { version: 1 as const, executionId: this.options.executionId, sequence: ++this.sequence,
      timestamp: (this.options.now ?? Date.now)() }
  }

  /** 完成必须对应流里的最新主轮；任何未结束子轮都不能被后端终态掩盖。 */
  private validateFinal(result: AgentWorkflowResult): void {
    for (const state of this.runs.values()) if (!state.completion) throw new ExecStreamError()
    const state = this.latestRootRun ? this.runs.get(this.latestRootRun)! : undefined
    if (state) {
      if (!result.lastRun || result.lastRun.runId !== state.envelope.run.runId
        || result.lastRun.sessionId !== state.envelope.run.sessionId || result.lastRun.runStartedAt !== state.envelope.run.runStartedAt
        || JSON.stringify(result.completion) !== JSON.stringify(state.completion)) throw new ExecStreamError()
    } else if (result.lastRun || result.completion) throw new ExecStreamError()
    if (result.status === 'completed' && (!this.latest()?.success
      || [...this.runs.values()].some((item) => !item.completion?.persisted))) throw new ExecStreamError()
  }

  /** 通知并不替代执行 RPC 返回；调用方收到应答后确认一次，再消费最终正文和状态。 */
  confirm(value: unknown): ExecWorkflowSnapshot {
    try {
      this.signal.throwIfAborted()
      const result = workflowResult(value)
      if (this.disposed || this.confirmed || !this.finishedWorkflow
        || JSON.stringify(result) !== JSON.stringify(this.finishedWorkflow)) throw new ExecStreamError()
      this.validateFinal(result)
      this.confirmed = true
      return { result, success: result.status === 'completed', finalText: result.status === 'completed' ? this.latest()!.finalText : '' }
    } catch { this.fail(); throw new ExecStreamError() }
  }

  /** 只返回已收束的最新主轮；调用方仍必须等待 core 的工作流完成和实际 send/退出。 */
  latest(): ExecRunSnapshot | undefined {
    this.signal.throwIfAborted()
    const state = this.latestRootRun ? this.runs.get(this.latestRootRun) : undefined
    if (!state?.completion) return undefined
    const { completion, result } = state
    return { runId: state.envelope.run.runId, sessionId: state.envelope.run.sessionId,
      finalText: [...state.texts.values()].at(-1) ?? '', completion,
      success: Boolean(result?.subtype === 'success' && completion.resultSubtype === 'success'
        && completion.persisted && !completion.stoppedByUser && !completion.error) }
  }
  dispose(): void { this.disposed = true; this.runs.clear(); this.bytes = 0; this.startedWorkflow = undefined; this.finishedWorkflow = undefined }
}
