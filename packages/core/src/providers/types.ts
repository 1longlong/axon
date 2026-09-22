/** Provider 结束生成的统一原因。 */
export type ProviderFinishReason =
  | 'stop'
  | 'length'
  | 'tool_use'
  | 'content_filter'
  | 'error'
  | 'other'

/** Provider 线协议或 SSE 结构错误的共同基类，供网络层与具体适配器解耦。 */
export class ProviderStreamProtocolError extends Error {}

export interface ProviderTextDeltaEvent {
  type: 'text_delta'
  delta: string
}

export interface ProviderReasoningStartEvent {
  type: 'reasoning_start'
  blockId: string
}

export interface ProviderReasoningDeltaEvent {
  type: 'reasoning_delta'
  blockId: string
  delta: string
}

export interface ProviderReasoningSignatureEvent {
  type: 'reasoning_signature'
  blockId: string
  signatureDelta: string
}

export interface ProviderReasoningEndEvent {
  type: 'reasoning_end'
  blockId: string
}

export interface ProviderToolCallStartEvent {
  type: 'tool_call_start'
  /** 单次流中稳定的关联键；供应商未提供 id 时由适配器生成。 */
  callKey: string
  /** 后续提交工具结果时使用的调用 id。 */
  callId: string
  name: string
}

export interface ProviderToolCallDeltaEvent {
  type: 'tool_call_delta'
  callKey: string
  /** 尚未解析的 JSON 参数文本增量。 */
  argumentsDelta: string
}

export interface ProviderToolCallEndEvent {
  type: 'tool_call_end'
  callKey: string
}

export interface ProviderUsage {
  inputTokens?: number
  outputTokens?: number
  reasoningTokens?: number
  cacheReadTokens?: number
  cacheWriteTokens?: number
  totalTokens?: number
}

export interface ProviderUsageEvent {
  type: 'usage'
  /** 截至当前事件的累计用量快照，而非增量。 */
  usage: ProviderUsage
}

export interface ProviderFinishEvent {
  type: 'finish'
  reason: ProviderFinishReason
  /** 仅用于诊断，不应参与上层业务分支。 */
  providerReason?: string
}

/** 所有供应商适配器向 Chat 编排层输出的统一流式协议。 */
export type ProviderStreamEvent =
  | ProviderTextDeltaEvent
  | ProviderReasoningStartEvent
  | ProviderReasoningDeltaEvent
  | ProviderReasoningSignatureEvent
  | ProviderReasoningEndEvent
  | ProviderToolCallStartEvent
  | ProviderToolCallDeltaEvent
  | ProviderToolCallEndEvent
  | ProviderUsageEvent
  | ProviderFinishEvent

/** 已完成 SSE 字段折叠、尚未做供应商语义转换的事件。 */
export interface ServerSentEvent {
  event: string
  data: string
  id?: string
  retry?: number
}

/** 将单个 SSE 事件转换为零个或多个中立事件。 */
export interface ProviderStreamAdapter {
  parseEvent(event: ServerSentEvent): readonly ProviderStreamEvent[]
  /** 底层流自然结束后调用；未收到供应商终态时必须抛错。 */
  assertComplete(): void
}

export function isProviderFinishEvent(
  event: ProviderStreamEvent,
): event is ProviderFinishEvent {
  return event.type === 'finish'
}
