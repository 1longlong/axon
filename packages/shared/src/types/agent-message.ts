/**
 * Agent 中立消息协议（SDKMessage）
 *
 * 这是渲染层、持久化层与编排层之间唯一的 Agent 消息模型：adapter 把具体
 * runtime 的输出转换为本协议，协议本身不依赖任何 runtime SDK。
 * 形状沿用 Claude Agent SDK 风格；未知消息类型必须透传不丢弃（联合类型兜底分支）。
 *
 * 关键规则（设计文档 §4/§5）：
 * - `uuid` 是消息唯一标识：持久化、UI 定位、流式 delta 归属都靠它。
 * - `session_id` 是 runtime 侧会话 ID，与应用侧 sessionId 是两个概念。
 * - `parent_tool_use_id` 为 null 表示顶层消息；非 null 表示挂在某个工具调用
 *   （如子 Agent）之下，UI 据此做树状折叠。
 * - Delta 只存在于运行时事件流，绝不写入 JSONL；JSONL 只存完整消息。
 */

// ===== 内容块 =====

export interface SDKTextBlock {
  type: 'text'
  text: string
}

export interface SDKToolUseBlock {
  type: 'tool_use'
  id: string
  name: string
  input: Record<string, unknown>
}

export interface SDKThinkingBlock {
  type: 'thinking'
  thinking: string
}

/** assistant 内容块联合；未知块类型透传保留，向前兼容。 */
export type SDKContentBlock =
  | SDKTextBlock
  | SDKToolUseBlock
  | SDKThinkingBlock
  | { type: string; [key: string]: unknown }

export interface SDKToolResultBlock {
  type: 'tool_result'
  tool_use_id: string
  content?: unknown
  is_error?: boolean
}

/** user 内容块联合：工具结果回传与文本。 */
export type SDKUserContentBlock =
  | SDKToolResultBlock
  | SDKTextBlock
  | { type: string; [key: string]: unknown }

// ===== 消息类型 =====

export interface SDKMessageUsage {
  input_tokens: number
  output_tokens?: number
  cache_read_input_tokens?: number
  cache_creation_input_tokens?: number
}

export type AgentErrorCategory =
  | 'network'
  | 'provider'
  | 'protocol'
  | 'context'
  | 'runtime'
  | 'configuration'
  | 'workspace'
  | 'permission'
  | 'persistence'
  | 'canceled'
  | 'unknown'

/** 可跨 adapter、JSONL 和 renderer 传递的稳定错误，不携带上游原始异常。 */
export interface AgentTypedError {
  code: string
  category: AgentErrorCategory
  message: string
  retryable: boolean
}

export interface SDKAssistantMessage {
  type: 'assistant'
  /** Axon 首次持久化该完整消息的时间；供 UI 展示，不参与 runtime 恢复语义。 */
  createdAt?: number
  message: {
    content: SDKContentBlock[]
    usage?: SDKMessageUsage
    model?: string
    stop_reason?: string
  }
  parent_tool_use_id: string | null
  session_id?: string
  uuid?: string
  /** assistant 级错误说明；adapter 已将 runtime 原始异常转换为中立安全错误。 */
  error?: AgentTypedError
}

export interface SDKUserMessage {
  type: 'user'
  /** 快捷浮窗用户输入来源；仅用于应用 JSONL 和 UI，不改变 runtime 消息。 */
  inputOrigin?: 'quick'
  /** Axon 首次持久化该完整消息的时间。 */
  createdAt?: number
  message?: {
    content?: SDKUserContentBlock[]
  }
  parent_tool_use_id: string | null
  session_id?: string
  uuid?: string
  /** runtime 合成的消息（如内置能力展开的 prompt），非人类用户输入。 */
  isSynthetic?: boolean
}

export type AgentSkillDirectoryKind = 'axon' | 'agents' | 'builtin' | 'user'
export type AgentSkillActivationSource = 'skill_read' | 'explicit'

/** 一轮 Agent 中真正加载过的 Skill；用于 JSONL 恢复和后续 UI 汇总。 */
export interface AgentSkillActivation {
  name: string
  directoryKind: AgentSkillDirectoryKind
  relativeInstructionPath: string
  sources: AgentSkillActivationSource[]
}

/**
 * result 是一轮查询的收束信号：渲染层的"运行中"状态必须以它（或查询错误）为准。
 * subtype 的字符串兜底允许 runtime 引入新的终态类型。
 */
export interface SDKResultMessage {
  type: 'result'
  createdAt?: number
  subtype: 'success' | 'error' | 'error_max_turns' | 'error_max_budget_usd' | 'error_during_execution' | (string & {})
  usage: SDKMessageUsage
  total_cost_usd?: number
  errors?: string[]
  /** 一轮失败的结构化原因；errors[] 暂留作旧消息兼容字段。 */
  error?: AgentTypedError
  terminal_reason?: string
  /** 明确标识由用户主动停止；不能用 aborted/错误文案反推。 */
  stopped_by_user?: boolean
  /** runtime 手动压缩等场景的内部收束，不代表真实模型 usage，不得计入用量统计。 */
  isSyntheticCompactionResult?: boolean
  /** 本轮成功加载的 Skills；发现但未读取的 Skill 不会进入记录。 */
  skill_activations?: AgentSkillActivation[]
  session_id?: string
  uuid?: string
}

/**
 * system 消息承载系统事件：init（模型确认）、compact_boundary（压缩边界，必须落盘）、
 * permission_denied 等。字段集开放，未知事件靠 subtype + 透传字段表达。
 */
export interface SDKSystemMessage {
  type: 'system'
  createdAt?: number
  subtype?: string
  session_id?: string
  /** init：确认的模型 */
  model?: string
  /** init：Runtime 实际采用的上下文窗口上限，供中立 UI 计算占用比例。 */
  context_window_tokens?: number
  /** compact_boundary：压缩结果 */
  compact_result?: 'success' | 'failed' | 'noop'
  compact_reason?: 'manual' | 'threshold' | 'overflow'
  compact_error?: string
  summary?: string
  /** compact_boundary：runtime 对压缩前后上下文的估算，优先于 UI 文本估算。 */
  context_tokens_before?: number
  context_tokens_after?: number
  /** permission_denied：被拒绝的工具与原因 */
  tool_name?: string
  tool_use_id?: string
  message?: string
  decision_reason_type?: string
  decision_reason?: string
  [key: string]: unknown
}

/** tool_progress 是工具执行心跳，仅存在于运行时，不写入 JSONL。 */
export interface SDKToolProgressMessage {
  type: 'tool_progress'
  createdAt?: number
  tool_use_id: string
  tool_name: string
  parent_tool_use_id: string | null
  elapsed_time_seconds?: number
  session_id?: string
}

export type SDKMessage =
  | SDKAssistantMessage
  | SDKUserMessage
  | SDKResultMessage
  | SDKSystemMessage
  | SDKToolProgressMessage
  | { type: string; createdAt?: number; session_id?: string; parent_tool_use_id?: string | null; [key: string]: unknown }

// ===== 流式增量（仅运行时，绝不写入 JSONL） =====

/** assistant 输出的增量片段；contentIndex 定位它在 content 数组中的位置。 */
export type AgentAssistantDelta =
  | { type: 'start' }
  | { type: 'text_start'; contentIndex: number }
  | { type: 'text_delta'; contentIndex: number; delta: string }
  | { type: 'text_end'; contentIndex: number; content: string }
  | { type: 'thinking_start'; contentIndex: number }
  | { type: 'thinking_delta'; contentIndex: number; delta: string }
  | { type: 'thinking_end'; contentIndex: number; content: string }
  | { type: 'toolcall_start'; contentIndex: number; toolCall?: AgentToolCallDelta }
  | { type: 'toolcall_delta'; contentIndex: number; delta: string; toolCall?: AgentToolCallDelta }
  | { type: 'toolcall_end'; contentIndex: number; toolCall: AgentToolCallDelta }

export interface AgentToolCallDelta {
  id: string
  name: string
  arguments?: Record<string, unknown>
}

export interface AgentAssistantDeltaPayload {
  /** 归属到哪条 assistant 消息 */
  uuid: string
  deltas: AgentAssistantDelta[]
  session_id?: string
  /**
   * 产生该 Delta 的 Agent run 起始时间。停止后立即发起新一轮时，旧一轮的尾部
   * delta 可能混进新流，渲染层必须丢弃早于当前轮起始时间的事件（已知陷阱 #1）。
   */
  runStartedAt?: number
}

/** 模型调用级自动重试状态；只供当前 UI 展示，不进入会话 JSONL。 */
export type AgentRetryStatus =
  | {
      phase: 'scheduled'
      attempt: number
      maxAttempts: number
      delayMs: number
      /** renderer 删除这条已流式展示、但即将被 runtime 丢弃的草稿。 */
      discardedAssistantUuid?: string
    }
  | { phase: 'finished'; attempt: number; success: boolean }

/** runtime 上下文压缩状态；只驱动当前运行 UI，不写入会话 JSONL。 */
export type AgentCompactionStatus =
  | { phase: 'started'; reason: 'manual' | 'threshold' | 'overflow' }
  | {
      phase: 'finished'
      reason: 'manual' | 'threshold' | 'overflow'
      result: 'success' | 'failed' | 'noop'
    }

/** adapter 事件流：完整消息可落盘，其余载荷只投影到当前 UI。 */
export type AgentStreamPayload =
  | { kind: 'sdk_message'; message: SDKMessage }
  | { kind: 'sdk_delta'; delta: AgentAssistantDeltaPayload }
  | { kind: 'retry_status'; status: AgentRetryStatus }
  | { kind: 'compaction_status'; status: AgentCompactionStatus }
  | {
      /** runtime 放弃某条流式 assistant（如上下文压缩恢复），仅清理 UI 草稿。 */
      kind: 'discard_assistant'
      uuid: string
    }
