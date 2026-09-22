export interface ProviderChatTextBlock {
  type: 'text'
  text: string
}

export interface ProviderChatReasoningBlock {
  type: 'reasoning'
  text: string
  /** 供应商返回的不透明完整签名；不得解析或修改。 */
  signature?: string
}

export interface ProviderChatToolCallBlock {
  type: 'tool_call'
  callId: string
  name: string
  /** 已完整累计、尚待请求编码器校验的 JSON 对象字符串。 */
  arguments: string
}

export interface ProviderChatToolResultBlock {
  type: 'tool_result'
  callId: string
  name: string
  output: string
  isError?: boolean
}

/** 随用户消息进入请求的图片内容；数据由编排层从本地附件读取，core 不接触文件系统。 */
export interface ProviderChatImageBlock {
  type: 'image'
  /** 只允许四种供应商与本地白名单一致的类型：image/png、image/jpeg、image/gif、image/webp。 */
  mediaType: string
  /** 完整 base64 内容，不含 data: 前缀。 */
  data: string
}

export type ProviderChatContentBlock =
  | ProviderChatTextBlock
  | ProviderChatReasoningBlock
  | ProviderChatToolCallBlock
  | ProviderChatToolResultBlock
  | ProviderChatImageBlock

export interface ProviderChatMessage {
  role: 'user' | 'assistant'
  content: readonly ProviderChatContentBlock[]
}

export interface ProviderFunctionTool {
  name: string
  description: string
  inputSchema: Readonly<Record<string, unknown>>
  strict?: boolean
}

export interface ProviderEffortThinking {
  mode: 'effort'
  effort: 'minimal' | 'low' | 'medium' | 'high'
  includeSummary?: boolean
}

export interface ProviderBudgetThinking {
  mode: 'budget'
  budgetTokens: number
}

/** 请求层显式选择编码模式；不根据模型名称猜测能力。 */
export type ProviderThinkingOptions = ProviderEffortThinking | ProviderBudgetThinking

export interface ProviderChatRequest {
  modelId: string
  systemPrompt?: string
  messages: readonly ProviderChatMessage[]
  tools?: readonly ProviderFunctionTool[]
  maxOutputTokens: number
  temperature?: number
  thinking?: ProviderThinkingOptions
}
