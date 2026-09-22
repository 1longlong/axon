/**
 * PiAgentAdapter——可插拔边界的 Pi runtime 实现。
 *
 * 纪律（AGENTS.md 可插拔边界）：所有 runtime 专属代码（Pi SDK import、工具名/参数
 * 形状、session artifact 语义、Pi 错误文案模式）只允许出现在本文件内；编排层、
 * 渲染层与持久化层只依赖 SDKMessage 协议和 AgentProviderAdapter 接口。
 *
 * 本文件同时包含消息转换与查询生命周期，确保 runtime SDK 不越过 adapter 边界。
 */

import { randomUUID } from 'node:crypto'
import { existsSync, mkdirSync, readdirSync } from 'node:fs'
import { isAbsolute, join, relative, resolve } from 'node:path'
import type { AgentMessage } from '@earendil-works/pi-agent-core'
import type { AssistantMessage, AssistantMessageEvent, ToolResultMessage, UserMessage } from '@earendil-works/pi-ai/compat'
import type {
  AgentSession,
  AgentSessionEvent,
  ExtensionAPI,
  ToolDefinition,
} from '@earendil-works/pi-coding-agent'
import type {
  AgentAssistantDelta,
  AgentCanUseTool,
  AgentCustomToolDefinition,
  AgentCustomToolResult,
  AgentDeferredToolCapabilityInput,
  AgentPermissionMode,
  AgentProviderAdapter,
  AgentQueryInput,
  AgentReasoningCapability,
  AgentReasoningCapabilityInput,
  AgentStreamPayload,
  AgentThinkingLevel,
  AgentTypedError,
  SDKAssistantMessage,
  SDKMessage,
  SDKMessageUsage,
  SDKSystemMessage,
} from '@axon/shared'
import { createUserStoppedResult } from '../agent/agent-stop-policy'
import { PiProjectInstructionScope } from './pi-project-instruction-scope'

type PiSdk = typeof import('@earendil-works/pi-coding-agent')
type PiCompat = Pick<typeof import('@earendil-works/pi-ai/compat'),
  'isContextOverflow' | 'isRetryableAssistantError' | 'getModels' | 'getProviders' | 'getSupportedThinkingLevels' | 'clampThinkingLevel'>
type PiCatalogModel = ReturnType<PiCompat['getModels']>[number]

// 主进程以 CJS 运行，而 pi-ai/compat 只声明了 ESM export；用原生 dynamic import
// 保留 ESM 加载语义，避免 Electron 启动阶段 require 子路径时报 ERR_PACKAGE_PATH_NOT_EXPORTED。
const loadPiCompat = (): Promise<PiCompat> => {
  const dynamicImport = new Function('specifier', 'return import(specifier)') as (specifier: string) => Promise<PiCompat>
  return dynamicImport('@earendil-works/pi-ai/compat')
}

let piCompat: PiCompat | undefined

const THINKING_LEVELS: readonly AgentThinkingLevel[] = ['off', 'minimal', 'low', 'medium', 'high', 'xhigh', 'max']

interface PiReasoningModel {
  reasoning: boolean
  thinkingLevelMap?: Partial<Record<AgentThinkingLevel, string | null>>
  compat?: Record<string, boolean | string>
  capability?: AgentReasoningCapability
}

interface PiReasoningProfile {
  levels: readonly AgentThinkingLevel[]
  defaultLevel: AgentThinkingLevel
  effortMap: Partial<Record<AgentThinkingLevel, string | null>>
  compat?: Record<string, boolean | string>
}

interface PiDeferredToolCapability {
  enabled: boolean
  compat?: Record<string, boolean>
}

/** 已验证的模型族须同时匹配实际 API 协议，避免向兼容端点发送错误的思考字段。 */
function reasoningProfile(provider: PiAgentQueryOptions['provider'], modelId: string): PiReasoningProfile | undefined {
  const id = modelId.toLowerCase()
  const openai = provider === 'openai' || provider === 'openai-responses' || provider === 'custom'
  const anthropic = provider === 'anthropic' || provider === 'anthropic-compatible'
  if (openai && !id.endsWith('-chat-latest') && (/^gpt-5(?:\.|-|$)/.test(id) || /^(?:o1|o3|o4)(?:-|$)/.test(id))) {
    const max = /^gpt-5\.6(?:-|$)/.test(id)
    return {
      levels: max ? ['off', 'low', 'medium', 'high', 'xhigh', 'max'] : ['off', 'low', 'medium', 'high', 'xhigh'],
      defaultLevel: 'high',
      effortMap: { off: 'none', minimal: 'low', xhigh: 'xhigh', ...(max ? { max: 'max' } : {}) },
      compat: { supportsReasoningEffort: true },
    }
  }
  if (anthropic && /^deepseek-v4-(?:flash|pro)(?:-|$)/.test(id)) {
    const pro = /^deepseek-v4-pro(?:-|$)/.test(id)
    return {
      levels: ['off', 'low', 'high', 'xhigh', 'max'], defaultLevel: 'high',
      effortMap: { minimal: null, medium: null, low: pro ? 'high' : 'low', high: 'high', xhigh: pro ? 'max' : 'high', max: 'max' },
    }
  }
  if ((openai && provider !== 'openai-responses' || anthropic) && /^(?:k3(?:-256k)?|kimi-k3)$/.test(id)) {
    return {
      levels: ['off', 'low', 'high', 'max'], defaultLevel: 'high',
      effortMap: { minimal: 'low', low: 'low', medium: 'high', high: 'high', xhigh: 'max', max: 'max' },
      compat: anthropic ? { forceAdaptiveThinking: true } : { supportsReasoningEffort: true },
    }
  }
  if ((openai && provider !== 'openai-responses' || anthropic) && (id === 'glm-5.2' || id === 'glm-5.3')) {
    const next = id === 'glm-5.3'
    return {
      levels: next ? ['low', 'high', 'max'] : ['off', 'high', 'max'], defaultLevel: next ? 'max' : 'high',
      effortMap: next
        ? { low: 'low', high: 'high', max: 'max' }
        : { minimal: anthropic ? 'high' : null, low: 'high', medium: 'high', high: 'high', xhigh: 'max', max: 'max' },
      compat: anthropic
        ? { forceAdaptiveThinking: true }
        : { supportsReasoningEffort: true, thinkingFormat: 'zai', zaiToolStream: true },
    }
  }
  return undefined
}

/** 优先读取同供应商目录；自定义 OpenAI 端点只接受协议相符的精确模型匹配。 */
function findPiCatalogModel(compat: PiCompat, provider: PiAgentQueryOptions['provider'], modelId: string): PiCatalogModel | undefined {
  const preferred = provider === 'anthropic' || provider === 'anthropic-compatible'
    ? ['anthropic'] : provider === 'google' ? ['google'] : provider === 'custom' ? [] : ['openai']
  const candidates = provider === 'custom' ? compat.getProviders() : preferred
  for (const name of candidates) {
    try {
      const model = compat.getModels(name as Parameters<PiCompat['getModels']>[0])
        .find((item) => item.id.toLowerCase() === modelId.toLowerCase())
      if (model && model.api === runtimeApi(provider)) return model
    } catch { /* 动态/不可用目录不应阻断其他供应商的精确匹配。 */ }
  }
  return undefined
}

/** 同一能力解析服务 UI 与 runtime 注册；未知模型不伪装为已确认支持思考。 */
async function resolvePiReasoningModel(provider: PiAgentQueryOptions['provider'], modelId: string): Promise<PiReasoningModel> {
  const compat = piCompat ?? (piCompat = await loadPiCompat())
  const catalog = findPiCatalogModel(compat, provider, modelId)
  const profile = reasoningProfile(provider, modelId)
  if (profile) return {
    reasoning: true,
    thinkingLevelMap: profile.effortMap,
    ...(profile.compat ? { compat: profile.compat } : {}),
    capability: { levels: [...profile.levels], defaultLevel: profile.defaultLevel },
  }
  if (catalog) {
    const levels = compat.getSupportedThinkingLevels(catalog) as AgentThinkingLevel[]
    const catalogCompat = catalog.compat as { forceAdaptiveThinking?: unknown } | undefined
    return {
      reasoning: catalog.reasoning,
      ...(catalog.thinkingLevelMap ? { thinkingLevelMap: catalog.thinkingLevelMap } : {}),
      ...(catalog.api === 'anthropic-messages' && catalogCompat?.forceAdaptiveThinking === true
        ? { compat: { forceAdaptiveThinking: true } } : {}),
      ...(levels.some((level) => level !== 'off')
        ? { capability: { levels, defaultLevel: compat.clampThinkingLevel(catalog, 'high') } }
        : {}),
    }
  }
  return { reasoning: true }
}

/** 只向 renderer 公开中立等级清单，不暴露 Pi 模型目录或协议编码。 */
export async function getPiReasoningCapability(
  provider: PiAgentQueryOptions['provider'], modelId: string,
): Promise<AgentReasoningCapability | undefined> {
  return (await resolvePiReasoningModel(provider, modelId)).capability
}

function supportsAnthropicToolReferences(modelId: string): boolean {
  const id = modelId.toLowerCase()
  if (id.includes('haiku')) return false
  const version = id.match(/^claude-(?:opus|sonnet|fable)-(\d+)(?:-(\d+))?(?:-|$)/)
  if (!version) return false
  const major = Number(version[1])
  const minor = version[2] && version[2].length < 8 ? Number(version[2]) : 0
  return major > 4 || (major === 4 && minor >= 5)
}

/** 只认可官方协议目录中明确支持动态工具块的模型，兼容端点不做能力猜测。 */
async function resolvePiDeferredToolCapability(
  provider: PiAgentQueryOptions['provider'], modelId: string,
): Promise<PiDeferredToolCapability> {
  if (provider !== 'anthropic' && provider !== 'openai-responses') return { enabled: false }
  const compat = piCompat ?? (piCompat = await loadPiCompat())
  const catalog = findPiCatalogModel(compat, provider, modelId)
  if (!catalog) return { enabled: false }
  if (provider === 'anthropic') {
    const enabled = supportsAnthropicToolReferences(catalog.id)
    return enabled ? { enabled, compat: { supportsToolReferences: true } } : { enabled }
  }
  const catalogCompat = catalog.compat as {
    supportsAdditionalTools?: unknown
    supportsToolSearch?: unknown
  } | undefined
  const supportsAdditionalTools = catalogCompat?.supportsAdditionalTools === true
  const supportsToolSearch = catalogCompat?.supportsToolSearch === true
  const enabled = supportsAdditionalTools || supportsToolSearch
  return enabled ? { enabled, compat: { supportsAdditionalTools, supportsToolSearch } } : { enabled }
}

export async function supportsPiDeferredTools(
  provider: PiAgentQueryOptions['provider'], modelId: string,
): Promise<boolean> {
  return (await resolvePiDeferredToolCapability(provider, modelId)).enabled
}

/** 遵循 Pi 的收窄方向：当前档位不可用时优先向更高档靠拢。 */
function clampAgentThinkingLevel(level: AgentThinkingLevel, available: readonly AgentThinkingLevel[]): AgentThinkingLevel {
  if (available.includes(level)) return level
  const index = THINKING_LEVELS.indexOf(level)
  for (let i = index + 1; i < THINKING_LEVELS.length; i += 1) {
    if (available.includes(THINKING_LEVELS[i]!)) return THINKING_LEVELS[i]!
  }
  for (let i = index - 1; i >= 0; i -= 1) {
    if (available.includes(THINKING_LEVELS[i]!)) return THINKING_LEVELS[i]!
  }
  return available[0] ?? 'off'
}

/** DeepSeek 兼容端点用 output_config.effort，不识别 Pi 通用的 thinking budget。 */
function deepSeekReasoningExtension(
  level: AgentThinkingLevel, effortMap: Partial<Record<AgentThinkingLevel, string | null>>,
): (pi: ExtensionAPI) => void {
  return (pi) => {
    pi.on('before_provider_request', (event) => {
      const payload = event.payload
      if (!payload || typeof payload !== 'object' || Array.isArray(payload)) return undefined
      const body = payload as Record<string, unknown>
      const { thinking: _thinking, output_config: _outputConfig, ...rest } = body
      if (level === 'off') return { ...rest, thinking: { type: 'disabled' } }
      const effort = effortMap[level]
      return typeof effort === 'string'
        ? { ...rest, thinking: { type: 'enabled' }, output_config: { effort } }
        : undefined
    })
  }
}

export interface PiAgentQueryOptions extends AgentQueryInput {
  apiKey: string
  baseUrl: string
  provider: 'openai' | 'openai-responses' | 'anthropic' | 'anthropic-compatible' | 'google' | 'custom'
  systemPrompt: string
  permissionMode: AgentPermissionMode
  runtimeAgentDir: string
  runtimeSessionDir: string
  resumeSessionId?: string
  runtimeSessionFile?: string
  customTools?: AgentCustomToolDefinition[]
  canUseTool?: AgentCanUseTool
  onSessionId?: (sdkSessionId: string, sessionFile?: string) => void
}

interface ActivePiSession {
  session?: AgentSession
  abortRequested: boolean
  permissionMode: AgentPermissionMode
}

/** 将中立查询字段收口成当前 runtime 的必需输入，并在触碰文件或网络前校验。 */
function resolvePiQueryInput(input: AgentQueryInput): PiAgentQueryOptions {
  const legacy = input as Partial<PiAgentQueryOptions>
  const apiKey = input.connection?.apiKey ?? legacy.apiKey
  const baseUrl = input.connection?.baseUrl ?? legacy.baseUrl
  const provider = input.connection?.provider ?? legacy.provider
  const runtimeAgentDir = input.runtimeConfigDir ?? legacy.runtimeAgentDir
  const runtimeSessionDir = input.runtimeSessionDir ?? legacy.runtimeSessionDir
  const systemPrompt = input.systemPrompt ?? legacy.systemPrompt
  const permissionMode = input.permissionMode ?? legacy.permissionMode
  const thinkingLevel = input.thinkingLevel ?? legacy.thinkingLevel ?? 'medium'
  if (apiKey === undefined || !baseUrl || !provider || !runtimeAgentDir || !runtimeSessionDir || systemPrompt === undefined || !permissionMode) {
    throw new Error('Agent runtime 查询配置不完整')
  }
  return {
    ...input,
    apiKey,
    baseUrl,
    provider,
    runtimeAgentDir,
    runtimeSessionDir,
    systemPrompt,
    permissionMode,
    thinkingLevel,
    customTools: input.customTools ?? legacy.customTools,
    canUseTool: input.canUseTool ?? legacy.canUseTool,
    onSessionId: input.onRuntimeSession ?? legacy.onSessionId,
  }
}

// ===== Pi 错误文案分类（Pi 专属知识，不得泄漏到 adapter 之外） =====

/**
 * 瞬时网络错误模式：上游 API 偶发断流/抖动（SSE 中途 terminated、TCP 重置、
 * fetch 超时、对端提前关闭、CDN 切断 chunked 响应等）。这些错误无 HTTP 状态码，
 * runtime 内置重试无法完全消化时穿透到应用层，走「保留 resume 的自动重试」。
 */
const TRANSIENT_NETWORK_PATTERN =
  /\b408\b|terminated|socket hang up|ECONNRESET|ETIMEDOUT|ECONNABORTED|EPIPE|ENOTFOUND|EAI_AGAIN|ECONNREFUSED|fetch failed|failed to fetch|network error|peer closed connection|connection (?:error|closed|reset)|other side closed|incomplete chunked read|AbortError|(?:operation|request) was aborted|(?:request )?timed out|stream (?:closed|ended|disconnected) prematurely|premature close|stream ended before (?:a )?(?:terminal(?: response)? event|message_stop)/i

/**
 * 上游响应体解析失败模式：网关返回 HTML 错误页、SSE 流被截断、代理注入脏数据等，
 * 与瞬时网络错误同属上游抖动，重试通常即可恢复。
 */
const MALFORMED_RESPONSE_PATTERN =
  /JSON Parse error|Unable to parse JSON|Unexpected end of JSON input|Unexpected token.*JSON|Unexpected non-whitespace character after JSON|is not valid JSON/i

export function isTransientNetworkError(message?: string): boolean {
  return !!message && TRANSIENT_NETWORK_PATTERN.test(message)
}

export function isMalformedResponseError(message?: string): boolean {
  return !!message && MALFORMED_RESPONSE_PATTERN.test(message)
}

/**
 * SDK resume 指向的会话不存在。不同版本错误文案不一致（甚至缺失空格），
 * 不能依赖逐字匹配，去掉所有空白后做模式匹配。
 */
export function isSessionNotFoundError(...messages: Array<string | undefined>): boolean {
  return messages.some((message) => {
    if (!message) return false
    const compact = message.replace(/\s+/g, '').toLowerCase()
    return /noconversationfound(?:with)?session(?:id)?/.test(compact)
  })
}

// ===== Pi 内置工具名的显示与参数归一 =====

function getPiEditItems(input: Record<string, unknown>): Array<Record<string, unknown>> {
  return Array.isArray(input.edits)
    ? input.edits.filter((item): item is Record<string, unknown> => Boolean(item) && typeof item === 'object')
    : []
}

function isMultiEditInput(piName: string, input: Record<string, unknown>): boolean {
  return piName === 'edit' && getPiEditItems(input).length > 1
}

/** Pi 的小写工具名映射为 Claude 风格显示名；未知工具原样返回。 */
export function displayToolName(piName: string, input?: Record<string, unknown>): string {
  switch (piName) {
    case 'read':
      return 'Read'
    case 'write':
      return 'Write'
    case 'edit':
      return input && isMultiEditInput(piName, input) ? 'MultiEdit' : 'Edit'
    case 'bash':
      return 'Bash'
    case 'grep':
      return 'Grep'
    case 'find':
      return 'Glob'
    case 'ls':
      return 'LS'
    default:
      return piName
  }
}

/**
 * 权限确认时给用户看到的输入形状：把 Pi 的 path 等字段归一为 Claude 风格的
 * file_path/old_string/new_string，渲染层与权限规则不需要认识 Pi 字段名。
 */
export function normalizePermissionInput(piName: string, input: Record<string, unknown>): Record<string, unknown> {
  switch (piName) {
    case 'read':
    case 'write':
      return { ...input, file_path: input.path }
    case 'edit': {
      const editItems = getPiEditItems(input)
      const firstEdit = editItems[0]
      return {
        ...input,
        file_path: input.path,
        edits: editItems.map((edit) => ({
          ...edit,
          old_string: edit.old_string ?? edit.oldText,
          new_string: edit.new_string ?? edit.newText,
        })),
        old_string: firstEdit?.old_string ?? firstEdit?.oldText,
        new_string: firstEdit?.new_string ?? firstEdit?.newText,
      }
    }
    case 'find':
      return { ...input, pattern: input.pattern }
    case 'ls':
      return { ...input, file_path: input.path ?? '.' }
    default:
      return input
  }
}

/** 持久化/回传给模型时的工具输入归一：兼容 Pi 新旧两种字段名。 */
function normalizeToolUseInput(piName: string, input: Record<string, unknown>): Record<string, unknown> {
  switch (piName) {
    case 'read':
    case 'write':
      return { ...input, file_path: input.file_path ?? input.path }
    case 'edit': {
      const editItems = getPiEditItems(input)
      const firstEdit = editItems[0]
      const normalizedEdits = editItems.map((edit) => ({
        ...edit,
        old_string: edit.old_string ?? edit.oldText,
        new_string: edit.new_string ?? edit.newText,
      }))
      const joinedOld = normalizedEdits
        .map((edit, index) => `--- Edit ${index + 1} ---\n${String(edit.old_string ?? '')}`)
        .join('\n')
      const joinedNew = normalizedEdits
        .map((edit, index) => `--- Edit ${index + 1} ---\n${String(edit.new_string ?? '')}`)
        .join('\n')
      return {
        ...input,
        file_path: input.file_path ?? input.path,
        edits: normalizedEdits,
        old_string: input.old_string ?? (normalizedEdits.length > 1 ? joinedOld : firstEdit?.old_string ?? firstEdit?.oldText),
        new_string: input.new_string ?? (normalizedEdits.length > 1 ? joinedNew : firstEdit?.new_string ?? firstEdit?.newText),
      }
    }
    case 'find':
      return { ...input, pattern: input.pattern }
    case 'ls':
      return { ...input, file_path: input.file_path ?? input.path ?? '.' }
    default:
      return input
  }
}

/** 用户在权限确认里修改过输入时，把 Claude 风格字段还原回 Pi 字段名再交给 runtime。 */
export function restorePiInput(
  piName: string,
  original: Record<string, unknown>,
  updated?: Record<string, unknown>,
): Record<string, unknown> {
  if (!updated) return original
  switch (piName) {
    case 'read':
    case 'write':
    case 'edit':
      return { ...original, ...updated, path: updated.file_path ?? updated.path ?? original.path }
    default:
      return { ...original, ...updated }
  }
}

function contentToText(content: unknown): string {
  if (typeof content === 'string') return content
  if (Array.isArray(content)) {
    return content.map((block) => {
      if (block && typeof block === 'object' && 'type' in block && block.type === 'text' && 'text' in block) {
        return typeof block.text === 'string' ? block.text : ''
      }
      return ''
    }).join('')
  }
  return ''
}

/** 提取 runtime 消息原始时间；无合法时间时由会话仓储在首次落盘时补齐。 */
function messageCreatedAt(message: AgentMessage): number | undefined {
  const timestamp = (message as { timestamp?: unknown }).timestamp
  return typeof timestamp === 'number' && Number.isFinite(timestamp) && timestamp >= 0
    ? timestamp
    : undefined
}

function usageFromAssistant(message: AssistantMessage): SDKMessageUsage {
  return {
    input_tokens: message.usage?.input ?? 0,
    output_tokens: message.usage?.output ?? 0,
    cache_read_input_tokens: message.usage?.cacheRead ?? 0,
    cache_creation_input_tokens: message.usage?.cacheWrite ?? 0,
  }
}

// ===== abort 半截 assistant 处理（已知陷阱 #2） =====

export function isAssistantPiMessage(message: AgentMessage): message is AssistantMessage {
  return !!message && typeof message === 'object' && 'role' in message && message.role === 'assistant'
}

function isAbortedAssistantMessage(message: AgentMessage): message is AssistantMessage {
  return isAssistantPiMessage(message) && message.stopReason === 'aborted'
}

/**
 * 中断时最后一条 assistant 可能不完整（有流式输出但无完整 content）。
 * 持久化/resume 前丢弃尾部 aborted assistant，否则下次 resume 会撞坏消息序列。
 */
export function dropTrailingAbortedAssistant(messages: AgentMessage[]): AgentMessage[] {
  const lastMessage = messages[messages.length - 1]
  return lastMessage && isAbortedAssistantMessage(lastMessage) ? messages.slice(0, -1) : messages
}

// ===== assistant 终态错误与已生成内容的分离 =====

/** 读取已脱敏的终态错误；原始 runtime 文本不会进入中立协议。 */
export function getPiAssistantErrorDetails(message: SDKAssistantMessage): {
  detailedMessage: string
  originalError: string
} {
  const errorMessage = message.error?.message?.trim() || 'Unknown error'
  return { detailedMessage: errorMessage, originalError: errorMessage }
}

/** Pi 在流失败前可能已生成正文；这些正文按正常 assistant 输出保留。 */
export function hasPiAssistantTextContent(message: SDKAssistantMessage): boolean {
  return message.message.content.some(
    (block) => block.type === 'text' && 'text' in block && typeof block.text === 'string' && block.text.trim().length > 0,
  )
}

/** 复制 Pi 已生成的输出，剥掉终态传输/供应商失败标记。 */
export function stripPiAssistantError(message: SDKAssistantMessage): SDKAssistantMessage {
  const contentMessage = { ...message }
  delete contentMessage.error
  return contentMessage
}

const PROVIDER_QUOTA_PATTERN =
  /GoUsageLimitError|FreeUsageLimitError|monthly usage limit|available balance|insufficient[_ ]quota|out of budget|quota exceeded|billing|payment required|credit balance/i
const PROVIDER_AUTH_PATTERN =
  /\b(?:401|403)\b|unauthori[sz]ed|forbidden|invalid api key|invalid_api_key|authentication|permission denied|access denied/i
const PROVIDER_MODEL_PATTERN =
  /model(?:s)? (?:was |were )?not found|unknown model|model[^\n]*does not exist|no such model|model_not_found|(?:404[^\n]*model|model[^\n]*404)/i
const PROVIDER_ENDPOINT_PATTERN =
  /\b404\b|endpoint[^\n]*not found|route[^\n]*not found|page not found/i
const PROVIDER_POLICY_PATTERN =
  /content[_ -]?filter|content policy|safety (?:filter|policy)|blocked due to|responsible ai policy|prohibited content/i
const PROVIDER_RATE_LIMIT_PATTERN =
  /\b429\b|rate.?limit|too many requests|ResourceExhausted|throttl/i
const PROVIDER_SERVER_PATTERN =
  /\b(?:500|502|503|504|524|529)\b|overloaded|service.?unavailable|server.?error|internal.?error|provider.?returned.?error/i
const PROVIDER_REQUEST_PATTERN =
  /\b(?:400|405|409|413|415|422)\b|bad request|invalid (?:request|parameter|argument)|unsupported (?:parameter|media|operation)|malformed request/i
const PROVIDER_ENDPOINT_UNREACHABLE_PATTERN =
  /(?:^|\b)(?:ENOTFOUND|EAI_AGAIN|ERR_NAME_NOT_RESOLVED|getaddrinfo|fetch failed|connection refused|could not resolve host)(?:\b|$)|^connection error(?:\.|\s).*/i

/**
 * 将最终 AssistantMessage 分类成中立错误：先匹配不可恢复的
 * 上下文/账户/请求错误，再使用 runtime 同源规则标识瞬时失败。
 */
function createPiTypedError(assistant: AssistantMessage): AgentTypedError {
  const message = assistant.errorMessage ?? ''
  const contextOverflow = piCompat?.isContextOverflow(assistant) ?? /context length|context window|too many tokens|maximum context/i.test(message)
  if (contextOverflow) return {
    code: 'context_overflow',
    category: 'context',
    message: '上下文超出模型上限，自动压缩后仍无法继续',
    retryable: false,
  }
  if (PROVIDER_QUOTA_PATTERN.test(message)) return {
    code: 'provider_quota_exhausted',
    category: 'configuration',
    message: '模型服务额度或账户余额不足，请检查账户状态',
    retryable: false,
  }
  if (PROVIDER_MODEL_PATTERN.test(message)) return {
    code: 'provider_model_not_found',
    category: 'configuration',
    message: '模型不存在或当前账户无权访问，请检查模型 ID',
    retryable: false,
  }
  if (PROVIDER_POLICY_PATTERN.test(message)) return {
    code: 'provider_content_rejected',
    category: 'provider',
    message: '请求被模型服务的内容或安全策略拒绝',
    retryable: false,
  }
  if (PROVIDER_AUTH_PATTERN.test(message)) return {
    code: 'provider_authentication_error',
    category: 'configuration',
    message: '模型服务认证或访问权限无效，请检查渠道配置',
    retryable: false,
  }
  if (PROVIDER_ENDPOINT_PATTERN.test(message)) return {
    code: 'provider_endpoint_not_found',
    category: 'configuration',
    message: '模型服务地址或请求路径不存在，请检查 Base URL',
    retryable: false,
  }
  if (PROVIDER_ENDPOINT_UNREACHABLE_PATTERN.test(message)) return {
    code: 'provider_endpoint_not_found',
    category: 'configuration',
    message: '模型服务地址无法连接，请检查 Base URL、域名和端口配置',
    retryable: false,
  }
  if (isMalformedResponseError(message)) return {
    code: 'protocol_error',
    category: 'protocol',
    message: '模型服务返回了无法解析的响应，请检查渠道兼容性',
    retryable: false,
  }
  if (isTransientNetworkError(message)) return {
    code: 'network_error',
    category: 'network',
    message: '网络连接中断，请检查网络或渠道地址后重试',
    retryable: true,
  }
  if (PROVIDER_RATE_LIMIT_PATTERN.test(message)) return {
    code: 'provider_rate_limited',
    category: 'provider',
    message: '模型服务请求过于频繁，自动重试后仍未恢复',
    retryable: true,
  }
  if (PROVIDER_SERVER_PATTERN.test(message) || piCompat?.isRetryableAssistantError(assistant)) return {
    code: 'provider_unavailable',
    category: 'provider',
    message: '模型服务暂时不可用，自动重试后仍未恢复',
    retryable: true,
  }
  if (PROVIDER_REQUEST_PATTERN.test(message)) return {
    code: 'provider_request_invalid',
    category: 'protocol',
    message: '模型服务不接受当前请求，请检查模型与渠道协议兼容性',
    retryable: false,
  }
  return {
    code: 'provider_error',
    category: 'provider',
    message: '模型服务返回了无法自动恢复的错误',
    retryable: false,
  }
}

// ===== AgentMessage → SDKMessage =====

/**
 * 转换单条 Pi AgentMessage；无法识别的角色返回 null（调用方跳过，不猜测）。
 * 说明：产出的消息 parent_tool_use_id 恒为 null——Pi 的事件模型没有子代理
 * sidechain 概念；历史 JSONL 里非空 parent_tool_use_id 来自旧 runtime 的会话，
 * 渲染层的树状折叠逻辑为兼容旧数据保留。
 */
export function convertPiMessage(
  message: AgentMessage,
  sessionId: string,
  options: { uuid?: string } = {},
): SDKMessage | null {
  if (!message || typeof message !== 'object' || !('role' in message)) return null
  const createdAt = messageCreatedAt(message)

  if (message.role === 'user') {
    const user = message as UserMessage
    return {
      type: 'user',
      ...(createdAt === undefined ? {} : { createdAt }),
      message: {
        content: [{ type: 'text', text: contentToText(user.content) }],
      },
      parent_tool_use_id: null,
      session_id: sessionId,
      uuid: options.uuid ?? randomUUID(),
    } as unknown as SDKMessage
  }

  if (message.role === 'assistant') {
    const assistant = message as AssistantMessage
    // 只有 stopReason === 'error' 才把 errorMessage 提升为终态 error 字段；
    // 其它终态即使带 errorMessage 也只记录日志，避免把可恢复抖动误报为失败。
    const isTerminalError = assistant.stopReason === 'error'
    if (assistant.errorMessage && !isTerminalError) {
      console.warn(
        `[pi-adapter] 忽略非终态 errorMessage（stopReason=${assistant.stopReason}）`,
      )
    }
    return {
      type: 'assistant',
      ...(createdAt === undefined ? {} : { createdAt }),
      message: {
        content: assistant.content.map((block) => {
          if (block.type === 'text') return { type: 'text', text: block.text }
          if (block.type === 'thinking') return { type: 'thinking', thinking: block.thinking }
          if (block.type === 'toolCall') {
            return {
              type: 'tool_use',
              id: block.id,
              name: displayToolName(block.name, block.arguments as Record<string, unknown>),
              input: normalizeToolUseInput(block.name, block.arguments as Record<string, unknown>),
            }
          }
          return block as unknown as Record<string, unknown>
        }),
        usage: usageFromAssistant(assistant),
        model: assistant.model,
        stop_reason: assistant.stopReason,
      },
      parent_tool_use_id: null,
      session_id: sessionId,
      uuid: options.uuid ?? randomUUID(),
      ...(assistant.errorMessage && isTerminalError && {
        error: createPiTypedError(assistant),
      }),
    } as unknown as SDKMessage
  }

  if (message.role === 'toolResult') {
    const toolResult = message as ToolResultMessage
    return {
      type: 'user',
      ...(createdAt === undefined ? {} : { createdAt }),
      message: {
        content: [{
          type: 'tool_result',
          tool_use_id: toolResult.toolCallId,
          content: toolResult.content,
          is_error: toolResult.isError,
        }],
      },
      tool_use_result: toolResult.details,
      parent_tool_use_id: null,
      session_id: sessionId,
      uuid: options.uuid ?? randomUUID(),
    } as unknown as SDKMessage
  }

  return null
}

export function hasToolResult(message: SDKMessage): boolean {
  if (message.type !== 'user') return false
  const content = (message as { message?: { content?: Array<{ type?: string }> } }).message?.content
  return Array.isArray(content) && content.some((block) => block.type === 'tool_result')
}

/** 把 runtime 压缩终态转换为可落盘边界；成功边界携带压缩后估算供 UI 立即换基线。 */
export function convertPiCompactionEnd(
  event: Extract<AgentSessionEvent, { type: 'compaction_end' }>,
  sessionId: string,
): SDKSystemMessage {
  const compactResult = event.aborted ? 'noop' : event.result ? 'success' : 'failed'
  return {
    type: 'system',
    subtype: 'compact_boundary',
    session_id: sessionId,
    compact_result: compactResult,
    compact_reason: event.reason,
    ...(event.result?.summary ? { summary: event.result.summary } : {}),
    ...(typeof event.result?.tokensBefore === 'number'
      ? { context_tokens_before: event.result.tokensBefore }
      : {}),
    ...(typeof event.result?.estimatedTokensAfter === 'number'
      ? { context_tokens_after: event.result.estimatedTokensAfter }
      : {}),
    ...(event.errorMessage ? { compact_error: event.errorMessage } : {}),
  }
}

/**
 * 把一轮 Pi 运行的全部消息收束为 result 终态消息：累计 usage、汇总成本，
 * 并只在最后一个 assistant 终态失败时报告 error_during_execution——
 * 非终态 errorMessage 是可恢复抖动，不伪装成整轮失败。
 */
export function convertResultMessage(messages: AgentMessage[], sessionId: string): SDKMessage {
  const assistants = messages.filter((m): m is AssistantMessage =>
    !!m && typeof m === 'object' && 'role' in m && m.role === 'assistant')
  const costValues = assistants
    .map((msg) => msg.usage?.cost?.total)
    .filter((value): value is number => typeof value === 'number' && Number.isFinite(value))
  const usage = assistants.reduce(
    (acc, msg) => ({
      input_tokens: acc.input_tokens + (msg.usage?.input ?? 0),
      output_tokens: acc.output_tokens + (msg.usage?.output ?? 0),
      cache_read_input_tokens: acc.cache_read_input_tokens + (msg.usage?.cacheRead ?? 0),
      cache_creation_input_tokens: acc.cache_creation_input_tokens + (msg.usage?.cacheWrite ?? 0),
    }),
    { input_tokens: 0, output_tokens: 0, cache_read_input_tokens: 0, cache_creation_input_tokens: 0 },
  )
  const lastAssistant = assistants[assistants.length - 1]
  if (!lastAssistant) return {
    type: 'result',
    subtype: 'error_during_execution',
    usage,
    terminal_reason: 'failed',
    errors: ['Agent runtime 未返回模型终态'],
    error: {
      code: 'runtime_missing_assistant',
      category: 'runtime',
      message: 'Agent runtime 未返回模型终态',
      retryable: false,
    },
    session_id: sessionId,
  }
  const assistantError = lastAssistant?.stopReason === 'error' ? lastAssistant.errorMessage : undefined
  const typedError = assistantError && lastAssistant ? createPiTypedError(lastAssistant) : undefined
  const terminalReason = assistantError
    ? 'failed'
    : lastAssistant?.stopReason === 'length'
      ? 'max_tokens'
      : lastAssistant?.stopReason === 'aborted'
        ? 'stopped'
        : 'completed'
  return {
    type: 'result',
    subtype: assistantError ? 'error_during_execution' : terminalReason === 'max_tokens' ? 'max_tokens' : 'success',
    usage,
    total_cost_usd: costValues.length > 0 ? costValues.reduce((sum, cost) => sum + cost, 0) : undefined,
    terminal_reason: terminalReason,
    errors: typedError ? [typedError.message] : undefined,
    error: typedError,
    session_id: sessionId,
  } as unknown as SDKMessage
}

/** 用户在自动重试等待中停止时，强制把旧的 Provider 失败收束为已停止。 */
function convertStoppedResult(messages: AgentMessage[], sessionId: string): SDKMessage {
  const result = convertResultMessage(messages, sessionId) as Extract<SDKMessage, { type: 'result' }>
  return createUserStoppedResult({
    sessionId,
    usage: result.usage,
    totalCostUsd: result.total_cost_usd,
  })
}

// ===== Pi 运行事件 → 中立流事件 =====

function toolCallDeltaFromPartial(
  event: Extract<AssistantMessageEvent, { type: 'toolcall_start' | 'toolcall_delta' }>,
) {
  const block = event.partial.content[event.contentIndex]
  if (!block || block.type !== 'toolCall') return undefined
  return {
    id: block.id,
    name: displayToolName(block.name, block.arguments as Record<string, unknown>),
    ...(event.type === 'toolcall_start' ? { arguments: {} } : {}),
  }
}

/** 从 runtime 的累计更新中只提取小型 delta，避免重复传输完整 assistant。 */
export function serializePiAssistantDelta(event: AssistantMessageEvent): AgentAssistantDelta | undefined {
  switch (event.type) {
    case 'start': return { type: 'start' }
    case 'text_start': return { type: 'text_start', contentIndex: event.contentIndex }
    case 'text_delta': return { type: 'text_delta', contentIndex: event.contentIndex, delta: event.delta }
    case 'text_end': return { type: 'text_end', contentIndex: event.contentIndex, content: event.content }
    case 'thinking_start': return { type: 'thinking_start', contentIndex: event.contentIndex }
    case 'thinking_delta': return { type: 'thinking_delta', contentIndex: event.contentIndex, delta: event.delta }
    case 'thinking_end': return { type: 'thinking_end', contentIndex: event.contentIndex, content: event.content }
    case 'toolcall_start': {
      const toolCall = toolCallDeltaFromPartial(event)
      return { type: 'toolcall_start', contentIndex: event.contentIndex, ...(toolCall ? { toolCall } : {}) }
    }
    case 'toolcall_delta': {
      const toolCall = toolCallDeltaFromPartial(event)
      return { type: 'toolcall_delta', contentIndex: event.contentIndex, delta: event.delta, ...(toolCall ? { toolCall } : {}) }
    }
    case 'toolcall_end':
      return {
        type: 'toolcall_end',
        contentIndex: event.contentIndex,
        toolCall: {
          id: event.toolCall.id,
          name: displayToolName(event.toolCall.name, event.toolCall.arguments as Record<string, unknown>),
          arguments: event.toolCall.arguments as Record<string, unknown>,
        },
      }
    default:
      return undefined
  }
}

interface AsyncQueue<T> extends AsyncIterable<T> {
  push(value: T): void
  close(): void
  fail(error: unknown): void
}

function createAsyncQueue<T>(): AsyncQueue<T> {
  const values: T[] = []
  const waiters: Array<{
    resolve: (result: IteratorResult<T>) => void
    reject: (error: unknown) => void
  }> = []
  let closed = false
  let failure: unknown

  const flush = (): void => {
    while (waiters.length > 0 && values.length > 0) {
      waiters.shift()?.resolve({ value: values.shift() as T, done: false })
    }
    if (values.length > 0 || waiters.length === 0 || !closed) return
    const pending = waiters.splice(0)
    if (failure) {
      for (const waiter of pending) waiter.reject(failure)
      failure = undefined
    } else {
      for (const waiter of pending) waiter.resolve({ value: undefined, done: true })
    }
  }

  return {
    push(value) {
      if (!closed) values.push(value)
      flush()
    },
    close() {
      closed = true
      flush()
    },
    fail(error) {
      if (closed) return
      failure = error
      closed = true
      flush()
    },
    [Symbol.asyncIterator]() {
      return {
        next: () => {
          if (values.length > 0) return Promise.resolve({ value: values.shift() as T, done: false })
          if (closed) {
            if (failure) {
              const error = failure
              failure = undefined
              return Promise.reject(error)
            }
            return Promise.resolve({ value: undefined, done: true })
          }
          return new Promise<IteratorResult<T>>((resolveResult, reject) => {
            waiters.push({ resolve: resolveResult, reject })
          })
        },
      }
    },
  }
}

function runtimeApi(provider: PiAgentQueryOptions['provider']) {
  switch (provider) {
    case 'openai':
    case 'custom':
      return 'openai-completions' as const
    case 'openai-responses':
      return 'openai-responses' as const
    case 'google':
      return 'google-generative-ai' as const
    default:
      return 'anthropic-messages' as const
  }
}

/** 注册会话独占的临时 Provider，避免 API Key 写进 runtime 的全局配置。 */
async function buildRuntimeModel(sdk: PiSdk, input: PiAgentQueryOptions) {
  const modelRuntime = await sdk.ModelRuntime.create({ allowModelNetwork: false })
  const providerId = `axon-${input.provider}-${input.sessionId}`
  const api = runtimeApi(input.provider)
  const modelId = input.model?.trim() || 'default'
  const reasoningModel = await resolvePiReasoningModel(input.provider, modelId)
  const deferredToolCapability = await resolvePiDeferredToolCapability(input.provider, modelId)
  const baseUrl = input.baseUrl.trim().replace(/\/$/, '')
  if (!baseUrl) throw new Error('Agent 渠道缺少 Base URL')
  // Keyless 本地端点仍需让 runtime 认为 Provider 已配置；关闭 authHeader 后占位值不会发往服务端。
  const runtimeApiKey = input.apiKey || `axon-keyless-${input.sessionId}`
  modelRuntime.registerProvider(providerId, {
    name: providerId,
    apiKey: runtimeApiKey,
    ...(input.apiKey ? {} : { authHeader: false }),
    api,
    baseUrl,
    models: [{
      id: modelId,
      name: modelId,
      api,
      baseUrl,
      reasoning: reasoningModel.reasoning,
      ...(reasoningModel.thinkingLevelMap ? { thinkingLevelMap: reasoningModel.thinkingLevelMap } : {}),
      input: ['text', 'image'],
      cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
      contextWindow: 200_000,
      maxTokens: 64_000,
      compat: {
        supportsDeveloperRole: false,
        ...(reasoningModel.compat ?? {}),
        ...(deferredToolCapability.compat ?? {}),
      },
    }],
  })
  const model = modelRuntime.getModel(providerId, modelId)
  if (!model) throw new Error(`Agent 模型注册失败：${modelId}`)
  return { modelRuntime, model, reasoningCapability: reasoningModel.capability, supportsReasoning: reasoningModel.reasoning }
}

function isWithinDirectory(path: string, directory: string): boolean {
  const relation = relative(resolve(directory), resolve(path))
  return relation === '' || (!relation.startsWith('..') && !isAbsolute(relation))
}

/** 精确路径优先；兼容只有 runtime session id 的旧元数据时才扫描目录。 */
function resolveSessionFile(input: PiAgentQueryOptions): string | undefined {
  if (input.runtimeSessionFile) {
    if (!isWithinDirectory(input.runtimeSessionFile, input.runtimeSessionDir)) {
      throw new Error('Agent runtime 会话文件越出允许目录')
    }
    if (existsSync(input.runtimeSessionFile)) return input.runtimeSessionFile
  }
  if (!input.resumeSessionId || !existsSync(input.runtimeSessionDir)) return undefined
  const match = readdirSync(input.runtimeSessionDir)
    .find((entry) => entry.endsWith('.jsonl') && entry.includes(input.resumeSessionId as string))
  return match ? join(input.runtimeSessionDir, match) : undefined
}

function normalizeToolResult(result: AgentCustomToolResult) {
  const content = typeof result.content === 'string'
    ? [{ type: 'text' as const, text: result.content }]
    : Array.isArray(result.content)
      ? result.content
      : [{ type: 'text' as const, text: JSON.stringify(result.content) }]
  return {
    content,
    details: result.details,
    ...(result.isError ? { isError: true } : {}),
    ...(result.addedToolNames?.length ? { addedToolNames: result.addedToolNames } : {}),
  }
}

function restoredDeferredToolNames(messages: readonly AgentMessage[], deferredNames: ReadonlySet<string>): Set<string> {
  const restored = new Set<string>()
  for (const message of messages) {
    if (message.role !== 'toolResult') continue
    for (const name of message.addedToolNames ?? []) {
      if (deferredNames.has(name)) restored.add(name)
    }
  }
  return restored
}

function wrapToolWithPermission(
  definition: ToolDefinition,
  input: PiAgentQueryOptions,
  active: ActivePiSession,
  emit: (payload: AgentStreamPayload) => void,
  projectInstructionScope?: PiProjectInstructionScope,
): ToolDefinition {
  if (!input.canUseTool && !projectInstructionScope) return definition
  return {
    ...definition,
    async execute(toolUseId, rawInput, signal, onUpdate, context) {
      const original = rawInput as Record<string, unknown>
      let updatedInput: Record<string, unknown> | undefined
      if (input.canUseTool) {
        const permission = await input.canUseTool(
          displayToolName(definition.name, original),
          normalizePermissionInput(definition.name, original),
          { signal, toolUseId, permissionMode: active.permissionMode },
        )
        if (permission.behavior === 'deny') {
          emit({
            kind: 'sdk_message',
            message: {
              type: 'system',
              subtype: 'permission_denied',
              tool_name: displayToolName(definition.name, original),
              tool_use_id: toolUseId,
              message: permission.message ?? '用户拒绝了工具执行',
            },
          })
          return {
            content: [{ type: 'text', text: permission.message ?? '用户拒绝了工具执行' }],
            details: undefined,
            isError: true,
          }
        }
        updatedInput = permission.updatedInput
      }
      const restored = restorePiInput(definition.name, original, updatedInput)
      projectInstructionScope?.observeRead(definition.name, restored)
      const result = await definition.execute(toolUseId, restored, signal, onUpdate, context)
      return result
    },
  } as ToolDefinition
}

function convertCustomTool(tool: AgentCustomToolDefinition): ToolDefinition {
  const execute: ToolDefinition['execute'] = async (toolUseId, rawInput, signal) =>
    normalizeToolResult(await tool.execute(rawInput as Record<string, unknown>, { signal, toolUseId }))
  return {
    name: tool.name,
    label: tool.name,
    description: tool.description,
    parameters: tool.inputSchema,
    execute,
  } as unknown as ToolDefinition
}

/**
 * 进程内 Agent Runtime 适配器：接收编排层的中立输入，创建/恢复 runtime 会话，
 * 再把运行事件转换成下游唯一认识的 AgentStreamPayload。
 */
export class PiAgentAdapter implements AgentProviderAdapter {
  private readonly activeSessions = new Map<string, ActivePiSession>()

  constructor(
    private readonly loadRuntime: () => Promise<PiSdk> = () => import('@earendil-works/pi-coding-agent'),
  ) {}

  getReasoningCapability(input: AgentReasoningCapabilityInput): Promise<AgentReasoningCapability | undefined> {
    return getPiReasoningCapability(input.provider, input.model)
  }

  supportsDeferredTools(input: AgentDeferredToolCapabilityInput): Promise<boolean> {
    return supportsPiDeferredTools(input.provider, input.model)
  }

  async *query(baseInput: AgentQueryInput): AsyncIterable<AgentStreamPayload> {
    const input = resolvePiQueryInput(baseInput)
    if (this.activeSessions.has(input.sessionId)) throw new Error('该 Agent 会话已有任务正在执行')

    const active: ActivePiSession = {
      abortRequested: false,
      permissionMode: input.permissionMode,
    }
    const queue = createAsyncQueue<AgentStreamPayload>()
    const runStartedAt = Date.now()
    this.activeSessions.set(input.sessionId, active)
    let unsubscribe: (() => void) | undefined
    let abortListener: (() => void) | undefined
    let promptStarted = false
    let promptSettled = false

    try {
      // 初始化顺序不能调换：先固定 artifact 与模型，再订阅事件，最后发送 prompt，
      // 否则会丢失 init 或首个流式事件。
      mkdirSync(input.runtimeAgentDir, { recursive: true })
      mkdirSync(input.runtimeSessionDir, { recursive: true })
      const sdk = await this.loadRuntime()
      // 运行时模块必须在进入事件转换前就绪，后续错误分类才能复用同源规则。
      piCompat = await loadPiCompat()
      const cwd = input.cwd ?? process.cwd()
      const sessionFile = resolveSessionFile(input)
      const resumeRequested = Boolean(input.resumeSessionId || input.runtimeSessionFile)
      let recoveredRuntimeSession = false
      let sessionManager: ReturnType<typeof sdk.SessionManager.create>
      if (sessionFile) {
        try {
          sessionManager = sdk.SessionManager.open(sessionFile, input.runtimeSessionDir, cwd)
        } catch (error) {
          if (input.recoveryPrompt === undefined) throw error
          // artifact 存在但无法解析时也只能创建新 runtime session 做语义恢复。
          sessionManager = sdk.SessionManager.create(cwd, input.runtimeSessionDir)
          recoveredRuntimeSession = true
        }
      } else if (resumeRequested) {
        if (input.recoveryPrompt === undefined) {
          throw new Error(`No conversation found with session ID ${input.resumeSessionId ?? 'unknown'}`)
        }
        sessionManager = sdk.SessionManager.create(cwd, input.runtimeSessionDir)
        recoveredRuntimeSession = true
      } else {
        sessionManager = sdk.SessionManager.create(cwd, input.runtimeSessionDir)
      }
      const { modelRuntime, model, reasoningCapability, supportsReasoning } = await buildRuntimeModel(sdk, input)
      const thinkingLevel = reasoningCapability
        ? clampAgentThinkingLevel(input.thinkingLevel ?? 'medium', reasoningCapability.levels)
        : supportsReasoning ? input.thinkingLevel ?? 'medium' : 'off'
      const deepSeekProfile = input.provider === 'anthropic-compatible'
        ? reasoningProfile(input.provider, input.model?.trim() || '') : undefined
      const settingsManager = sdk.SettingsManager.inMemory()
      const resourceLoader = new sdk.DefaultResourceLoader({
        cwd,
        agentDir: input.runtimeAgentDir,
        settingsManager,
        noExtensions: true,
        noSkills: true,
        noPromptTemplates: true,
        noThemes: true,
        noContextFiles: true,
        systemPrompt: input.systemPrompt,
        ...(deepSeekProfile && /^deepseek-v4-(?:flash|pro)(?:-|$)/i.test(input.model?.trim() || '')
          ? { extensionFactories: [deepSeekReasoningExtension(thinkingLevel, deepSeekProfile.effortMap)] }
          : {}),
      })
      await resourceLoader.reload()

      const emit = (payload: AgentStreamPayload): void => queue.push(payload)
      const projectInstructionScope = input.projectInstructionScope
        ? new PiProjectInstructionScope(input.projectInstructionScope)
        : undefined
      const allowedBuiltinTools = input.allowedBuiltinTools
        ? new Set(input.allowedBuiltinTools)
        : undefined
      const tools = [
        ...sdk.createCodingTools(cwd)
          .filter((tool) => !allowedBuiltinTools || allowedBuiltinTools.has(displayToolName(tool.name)))
          .map((tool) => tool as unknown as ToolDefinition),
        ...(input.customTools ?? []).map(convertCustomTool),
      ].map((tool) => wrapToolWithPermission(
        tool, input, active, emit, projectInstructionScope,
      ))
      const supportsDeferredTools = await supportsPiDeferredTools(input.provider, input.model?.trim() || 'default')
      const deferredToolNames = new Set(supportsDeferredTools
        ? (input.customTools ?? []).filter((tool) => tool.isDeferred === true).map((tool) => tool.name)
        : [])
      const activeTools = (loaded: ReadonlySet<string>): ToolDefinition[] => tools.filter((tool) => (
        !deferredToolNames.has(tool.name) || loaded.has(tool.name)
      ))
      const activeAgentTools = (loaded: ReadonlySet<string>): AgentSession['agent']['state']['tools'] => (
        activeTools(loaded) as unknown as AgentSession['agent']['state']['tools']
      )
      const createSession = () => sdk.createAgentSession({
        cwd, agentDir: input.runtimeAgentDir, modelRuntime, model, settingsManager,
        resourceLoader, sessionManager, thinkingLevel,
        noTools: 'builtin', customTools: tools,
      })
      let created: Awaited<ReturnType<typeof sdk.createAgentSession>>
      try {
        created = await createSession()
      } catch (error) {
        const message = error instanceof Error ? error.message : undefined
        if (!resumeRequested || input.recoveryPrompt === undefined || !isSessionNotFoundError(message)) throw error
        // 某些 runtime 延迟到创建 AgentSession 才读取 artifact；此处覆盖该恢复时机。
        sessionManager = sdk.SessionManager.create(cwd, input.runtimeSessionDir)
        recoveredRuntimeSession = true
        created = await createSession()
      }
      const session = created.session
      session.agent.toolExecution = 'sequential'
      const loadedDeferredToolNames = restoredDeferredToolNames(
        session.agent.state.messages,
        deferredToolNames,
      )
      // runtime 先注册完整执行定义，再在首个模型请求前收窄可见集合。
      if (deferredToolNames.size > 0) session.agent.state.tools = activeAgentTools(loadedDeferredToolNames)
      if (projectInstructionScope || deferredToolNames.size > 0) {
        const previousPrepareNextTurnWithContext = session.agent.prepareNextTurnWithContext
        session.agent.prepareNextTurnWithContext = async (context, signal) => {
          const previousSnapshot = await previousPrepareNextTurnWithContext?.(context, signal)
          let nextContext = previousSnapshot?.context ?? context.context
          let changed = false
          if (projectInstructionScope) {
            const systemPrompt = projectInstructionScope.appendPending(nextContext.systemPrompt)
            if (systemPrompt !== nextContext.systemPrompt) {
              nextContext = { ...nextContext, systemPrompt }
              changed = true
            }
          }
          for (const result of context.toolResults) {
            for (const name of result.addedToolNames ?? []) {
              if (!deferredToolNames.has(name) || loadedDeferredToolNames.has(name)) continue
              loadedDeferredToolNames.add(name)
              changed = true
            }
          }
          if (changed && deferredToolNames.size > 0) {
            const nextTools = activeAgentTools(loadedDeferredToolNames)
            session.agent.state.tools = nextTools
            nextContext = { ...nextContext, tools: nextTools }
          }
          if (!changed) return previousSnapshot
          return {
            ...previousSnapshot,
            context: nextContext,
          }
        }
      }
      active.session = session
      input.onSessionId?.(session.sessionId, session.sessionFile)
      emit({
        kind: 'sdk_message',
        message: {
          type: 'system',
          subtype: 'init',
          session_id: session.sessionId,
          model: session.model?.id,
          context_window_tokens: session.model?.contextWindow,
        },
      })
      if (recoveredRuntimeSession) {
        emit({
          kind: 'sdk_message',
          message: {
            type: 'system',
            subtype: 'runtime_session_recovered',
            session_id: session.sessionId,
            message: '原运行会话记录不可用，已从应用消息历史创建新的运行会话',
          },
        })
      }

      let assistantUuid = randomUUID()
      let pendingFailedAssistant: SDKMessage | undefined
      let discardedAssistantUuid: string | undefined
      const settledAgentMessages: AgentMessage[] = []
      unsubscribe = session.subscribe((event: AgentSessionEvent) => {
        // 每个回调都校验 active 引用，隔离停止后迟到或已被新一轮替换的事件。
        if (this.activeSessions.get(input.sessionId) !== active) return
        // 停止后只保留用量汇总和 settled 收束；其它迟到事件不得再进入 Axon 事件流。
        if (active.abortRequested && event.type !== 'agent_end' && event.type !== 'agent_settled') return
        if (event.type === 'message_update' && isAssistantPiMessage(event.message)) {
          const delta = serializePiAssistantDelta(event.assistantMessageEvent)
          if (delta) emit({
            kind: 'sdk_delta',
            delta: { uuid: assistantUuid, deltas: [delta], session_id: session.sessionId, runStartedAt },
          })
          return
        }
        if (event.type === 'message_end') {
          const assistant = isAssistantPiMessage(event.message) ? event.message : undefined
          // 地址解析/连接失败属于确定性配置问题；在 runtime 决定重试前关闭自动重试。
          // 不能调用 session.setAutoRetryEnabled：runtime 该方法只更新 globalSettings，
          // 而当前判断读取的是 settings 快照；applyOverrides 才会更新实际读取对象。
          // 超时、连接重置等未命中该模式的瞬时故障仍保留 runtime 重试能力。
          if (assistant?.stopReason === 'error' && PROVIDER_ENDPOINT_UNREACHABLE_PATTERN.test(assistant.errorMessage ?? '')) {
            settingsManager.applyOverrides({ retry: { enabled: false } })
          }
          if (assistant?.stopReason === 'aborted') {
            assistantUuid = randomUUID()
            return
          }
          const converted = convertPiMessage(event.message, session.sessionId, assistant ? { uuid: assistantUuid } : {})
          if (converted && (converted.type !== 'user' || hasToolResult(converted))) {
            // 失败 assistant 先等 agent_end.willRetry：可恢复失败不能进入 Axon JSONL。
            if (assistant?.stopReason === 'error') pendingFailedAssistant = converted
            else emit({ kind: 'sdk_message', message: converted })
          }
          if (assistant) assistantUuid = randomUUID()
          return
        }
        if (event.type === 'tool_execution_update') {
          emit({
            kind: 'sdk_message',
            message: {
              type: 'tool_progress',
              tool_use_id: event.toolCallId,
              tool_name: displayToolName(event.toolName, event.args as Record<string, unknown>),
              parent_tool_use_id: null,
              session_id: session.sessionId,
            },
          })
          return
        }
        if (event.type === 'agent_end') {
          // continue/retry 每次只返回本段新消息，累计后 result 才能覆盖整轮用量。
          settledAgentMessages.push(...event.messages)
          // 某些 runtime 版本可能在 message_end 后异步汇总错误；在 agent_end
          // 再兜底更新同一个 settings 快照，确保 _prepareRetry() 前不会启动重试。
          const lastAssistant = [...event.messages].reverse().find(isAssistantPiMessage)
          if (lastAssistant?.stopReason === 'error' && PROVIDER_ENDPOINT_UNREACHABLE_PATTERN.test(lastAssistant.errorMessage ?? '')) {
            settingsManager.applyOverrides({ retry: { enabled: false } })
          }
          if (event.willRetry) {
            discardedAssistantUuid = pendingFailedAssistant && 'uuid' in pendingFailedAssistant
              ? typeof pendingFailedAssistant.uuid === 'string' ? pendingFailedAssistant.uuid : undefined
              : undefined
            pendingFailedAssistant = undefined
            return
          }
          // willRetry 只覆盖普通重试；上下文压缩可能紧随其后，继续等 settled。
          return
        }
        if (event.type === 'auto_retry_start') {
          emit({
            kind: 'retry_status',
            status: {
              phase: 'scheduled',
              attempt: event.attempt,
              maxAttempts: event.maxAttempts,
              delayMs: event.delayMs,
              ...(discardedAssistantUuid ? { discardedAssistantUuid } : {}),
            },
          })
          discardedAssistantUuid = undefined
          return
        }
        if (event.type === 'compaction_start') {
          emit({ kind: 'compaction_status', status: { phase: 'started', reason: event.reason } })
          if (event.reason === 'overflow') {
            if (pendingFailedAssistant && 'uuid' in pendingFailedAssistant && typeof pendingFailedAssistant.uuid === 'string') {
              emit({ kind: 'discard_assistant', uuid: pendingFailedAssistant.uuid })
            }
            // overflow assistant 已由 runtime 放弃；压缩失败时最终 result 仍从累计原始消息归类。
            pendingFailedAssistant = undefined
          }
          return
        }
        if (event.type === 'compaction_end') {
          // 必须先广播边界再允许 overflow 续跑，使 UI/JSONL 在下一条 assistant 前切换基线。
          emit({ kind: 'sdk_message', message: convertPiCompactionEnd(event, session.sessionId) })
          emit({
            kind: 'compaction_status',
            status: {
              phase: 'finished',
              reason: event.reason,
              result: event.aborted ? 'noop' : event.result ? 'success' : 'failed',
            },
          })
          return
        }
        if (event.type === 'auto_retry_end') {
          emit({
            kind: 'retry_status',
            status: { phase: 'finished', attempt: event.attempt, success: event.success },
          })
          return
        }
        if (event.type === 'agent_settled') {
          // agent_end 可因自动重试/压缩续跑多次；只在 settled 产生本轮唯一 result。
          if (pendingFailedAssistant?.type === 'assistant') {
            // 失败前已生成的正文保留供用户查看；空失败消息不制造空白气泡。
            const failedAssistant = pendingFailedAssistant as SDKAssistantMessage
            if (hasPiAssistantTextContent(failedAssistant)) {
              emit({ kind: 'sdk_message', message: stripPiAssistantError(failedAssistant) })
            }
          }
          pendingFailedAssistant = undefined
          const result = active.abortRequested
            ? convertStoppedResult(settledAgentMessages, session.sessionId)
            : convertResultMessage(settledAgentMessages, session.sessionId)
          emit({
            kind: 'sdk_message',
            message: result,
          })
        }
      })

      if (input.abortSignal) {
        const onAbort = (): void => this.abort(input.sessionId)
        input.abortSignal.addEventListener('abort', onAbort, { once: true })
        abortListener = () => input.abortSignal?.removeEventListener('abort', onAbort)
      }
      if (active.abortRequested || input.abortSignal?.aborted) {
        // 初始化期间已停止：不允许随后的 prompt 真正发起模型请求。
        await session.abort()
        emit({ kind: 'sdk_message', message: convertStoppedResult([], session.sessionId) })
        queue.close()
      } else {
        promptStarted = true
        const prompt = recoveredRuntimeSession && input.recoveryPrompt
          ? `${input.recoveryPrompt}\n\n[当前用户消息]\n${input.prompt}`
          : input.prompt
        void session.prompt(prompt)
          .then(() => {
            promptSettled = true
            queue.close()
          })
          .catch((error: unknown) => {
            promptSettled = true
            queue.fail(error)
          })
      }

      for await (const payload of queue) yield payload
    } finally {
      abortListener?.()
      // 下游写盘/广播失败会提前关闭生成器；先中止 runtime，防止工具在 UI 结束后继续修改工作区。
      if (promptStarted && !promptSettled && active.session) {
        active.abortRequested = true
        try { await active.session.abort() }
        catch { console.warn('[pi-adapter] 提前退出时中止 runtime 失败') }
      }
      unsubscribe?.()
      active.session?.dispose()
      if (this.activeSessions.get(input.sessionId) === active) this.activeSessions.delete(input.sessionId)
    }
  }

  /** 硬停止当前会话；初始化未完成时先记标志，创建完成后立即中止。 */
  abort(sessionId: string): void {
    const active = this.activeSessions.get(sessionId)
    if (!active) return
    active.abortRequested = true
    void active.session?.abort().catch(() => {
      console.warn('[pi-adapter] 中止 runtime 失败，将由查询 finally 继续清理')
    })
  }

  async setPermissionMode(sessionId: string, mode: string): Promise<void> {
    const active = this.activeSessions.get(sessionId)
    if (!active) throw new Error('Agent 会话当前未运行')
    if (mode !== 'default' && mode !== 'acceptEdits' && mode !== 'bypassPermissions' && mode !== 'plan') {
      throw new Error(`未知权限模式：${mode}`)
    }
    active.permissionMode = mode
  }

  /** 释放所有活跃 runtime；用于应用退出或 adapter 替换。 */
  dispose(): void {
    for (const sessionId of this.activeSessions.keys()) this.abort(sessionId)
    this.activeSessions.clear()
  }
}
