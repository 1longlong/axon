/**
 * Agent Provider 适配器接口（可插拔边界的中立面）
 *
 * 编排层只依赖本接口与 SDKMessage 协议；runtime 专属代码（SDK import、
 * session artifact 查找、工具定义 shape 转换）全部封在各 adapter 实现文件里。
 * 可选方法 = 能力协商：编排层必须探测后调用，未实现时降级。
 */

import type {
  AgentPermissionMode,
  AgentReasoningCapability,
  AgentThinkingLevel,
} from './agent-session'
import type { AgentStreamPayload } from './agent-message'
import type { ProviderType } from './channel'

export interface AgentToolPermissionOptions {
  signal?: AbortSignal
  toolUseId: string
  permissionMode: AgentPermissionMode
}

export interface AgentToolPermissionResult {
  behavior: 'allow' | 'deny'
  /** 权限界面允许用户修正路径等参数后，再交给 runtime 执行。 */
  updatedInput?: Record<string, unknown>
  message?: string
}

export type AgentCanUseTool = (
  toolName: string,
  input: Record<string, unknown>,
  options: AgentToolPermissionOptions,
) => Promise<AgentToolPermissionResult>

export interface AgentCustomToolTextContent {
  type: 'text'
  text: string
}

export interface AgentCustomToolImageContent {
  type: 'image'
  data: string
  mimeType: string
}

export type AgentCustomToolContent =
  | string
  | Record<string, unknown>
  | Array<AgentCustomToolTextContent | AgentCustomToolImageContent>

export interface AgentCustomToolResult {
  /** 中立文本/图片结果；其他协议块应由桥接层转为文本后再进入 adapter。 */
  content: AgentCustomToolContent
  isError?: boolean
  details?: unknown
  /** 本次结果返回了这些 deferred 工具的完整定义；adapter 从下一次模型请求起加载它们。 */
  addedToolNames?: string[]
}

/** 编排层使用的中立工具定义；adapter 在边缘转换成 runtime 专属 shape。 */
export interface AgentCustomToolDefinition {
  name: string
  description: string
  inputSchema: Record<string, unknown>
  /** 是否只向模型暴露轻量目录信息，并通过 tool_search 按需返回完整 schema。 */
  isDeferred?: boolean
  execute: (
    input: Record<string, unknown>,
    options: { signal?: AbortSignal; toolUseId: string },
  ) => Promise<AgentCustomToolResult>
}

/** 主进程解析后交给 adapter 的项目指令来源，不包含 runtime 专属类型。 */
export interface AgentProjectInstructionSource {
  path: string
  relativePath: string
  scopeRoot: string
  content: string
  contentHash: string
}

export interface AgentProjectInstructionScope {
  projectRoot: string
  /** 当前 system prompt 已经包含的来源，用于动态激活时去重。 */
  initialSources: AgentProjectInstructionSource[]
}

/** 主进程发现的轻量 Skill 元数据；正文仍留在 SKILL.md 中按需读取。 */
export interface AgentSkillSource {
  name: string
  description: string
  /** 项目专用、项目共享、Axon 管理安装、用户全局四类来源。 */
  directoryKind: 'axon' | 'agents' | 'builtin' | 'user'
  directoryPath: string
  instructionPath: string
  relativeInstructionPath: string
  contentHash: string
  compatibility?: string
  metadata?: Record<string, string>
  /** 仅描述 Skill 期望使用的工具，不会绕过应用权限。 */
  allowedTools?: string[]
  disableModelInvocation?: boolean
  userInvocable?: boolean
  argumentHint?: string
}

/** SDK 用户消息（队列消息注入用）。 */
export interface SDKUserMessageInput {
  type: 'user'
  message: { role: 'user'; content: string }
  parent_tool_use_id: null
  priority?: 'now' | 'next' | 'later'
  uuid?: string
  session_id: string
}

export interface SendQueuedMessageOptions {
  /** 先取消当前 turn，再把消息作为新一轮用户输入发送。 */
  interrupt?: boolean
  /** runtime/adapter 已接收消息后回调；调用方据此区分失败时是否可回滚本地历史。 */
  onAccepted?: () => void
}

/** Agent 查询输入（Provider 无关的通用字段）。 */
export interface AgentQueryInput {
  /** 应用侧会话 ID（自有概念，不是 runtime 的） */
  sessionId: string
  /** 用户 prompt（编排层已完成上下文注入） */
  prompt: string
  model?: string
  /** Agent 工作目录 */
  cwd?: string
  abortSignal?: AbortSignal
  /** 编排层解析后的主进程私有连接信息，禁止越过主进程边界。 */
  connection?: {
    provider: ProviderType
    baseUrl: string
    apiKey: string
  }
  systemPrompt?: string
  permissionMode?: AgentPermissionMode
  /** runtime 无关的思考强度；adapter 负责映射到具体 SDK。 */
  thinkingLevel?: AgentThinkingLevel
  /** runtime 私有目录与恢复凭据；具体 artifact 格式仍由 adapter 解释。 */
  runtimeConfigDir?: string
  runtimeSessionDir?: string
  resumeSessionId?: string
  runtimeSessionFile?: string
  /** runtime artifact 不可恢复时，由编排层从中立历史生成的语义恢复上下文。 */
  recoveryPrompt?: string
  /** 路径工具可据此按需激活更深目录的项目指令。 */
  projectInstructionScope?: AgentProjectInstructionScope
  /** 子 Agent 可见的中立内置工具名；缺失表示使用完整默认集合。 */
  allowedBuiltinTools?: string[]
  customTools?: AgentCustomToolDefinition[]
  canUseTool?: AgentCanUseTool
  onRuntimeSession?: (sessionId: string, sessionFile?: string) => void
}

/** adapter 用于判断当前 Provider/模型能否原生承载会话内动态工具定义。 */
export interface AgentDeferredToolCapabilityInput {
  provider: ProviderType
  model: string
}

/** adapter 查询当前 runtime 如何解释指定 Provider/模型的思考等级。 */
export interface AgentReasoningCapabilityInput {
  provider: ProviderType
  model: string
}

/**
 * 语义要点（设计文档 §3）：
 * - `query()` 是"一轮"不是"一个会话"；同一 sessionId 可多次 query，adapter 内部
 *   维护 runtime 侧会话状态，同一会话同时只允许一个活跃 query。
 * - systemPrompt、权限、工具与 resume 是核心闭环的中立字段；只有具体 runtime
 *   独有的调优项才放进 adapter 扩展输入，上层不得依赖其 SDK 类型。
 */
export interface AgentProviderAdapter {
  /** 未实现或返回 undefined 时，UI 不展示未经 runtime 确认的思考等级。 */
  getReasoningCapability?(
    input: AgentReasoningCapabilityInput,
  ): AgentReasoningCapability | undefined | Promise<AgentReasoningCapability | undefined>
  /** 未实现或返回 false 时，编排层必须把 deferred 工具降级为普通 eager 工具。 */
  supportsDeferredTools?(input: AgentDeferredToolCapabilityInput): boolean | Promise<boolean>
  /** 发起查询，返回完整消息与仅供渲染的增量事件流。 */
  query(input: AgentQueryInput): AsyncIterable<AgentStreamPayload>
  /** 中止指定会话的执行（硬停止）。 */
  abort(sessionId: string): void
  /** 软中断当前 turn 但保留活跃 Query，允许立即续跑新消息（可选能力）。 */
  interruptQuery?(sessionId: string): Promise<void>
  /** 释放资源。 */
  dispose(): void
  /** 向活跃查询注入队列消息（可选，仅支持队列的 Provider 实现）。 */
  sendQueuedMessage?(sessionId: string, message: SDKUserMessageInput, options?: SendQueuedMessageOptions): Promise<void>
  /** 取消队列中的待发送消息（可选）。 */
  cancelQueuedMessage?(sessionId: string, messageUuid: string): Promise<void>
  /** 动态切换活跃查询的权限模式（可选）。 */
  setPermissionMode?(sessionId: string, mode: string): Promise<void>
}
