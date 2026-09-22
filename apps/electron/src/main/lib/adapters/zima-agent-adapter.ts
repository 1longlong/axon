/** Zima runtime 的私有 stdio JSON-RPC 传输边界；上层只接触中立 Agent 契约。 */

import { spawn, type ChildProcessWithoutNullStreams } from 'node:child_process'
import { createHash, randomUUID } from 'node:crypto'
import { existsSync, readFileSync, realpathSync, statSync } from 'node:fs'
import { basename, dirname, join, isAbsolute, relative, resolve } from 'node:path'
import type {
  AgentProviderAdapter,
  AgentCustomToolDefinition,
  AgentErrorCategory,
  AgentPermissionMode,
  AgentQueryInput,
  AgentReasoningCapability,
  AgentReasoningCapabilityInput,
  AgentStreamPayload,
  AgentTypedError,
  SDKContentBlock,
  SDKMessageUsage,
  SDKResultMessage,
  SDKSystemMessage,
  SDKToolUseBlock,
} from '@axon/shared'

const PROTOCOL_VERSION = 2
const MAX_LINE_BYTES = 8_000_000
const MAX_QUEUED_EVENTS = 2_048
const ZIMA_BUILTIN_TOOLS = ['Read', 'Write', 'Edit', 'Glob', 'Grep', 'Bash'] as const
const HANDSHAKE_TIMEOUT_MS = 10_000
const SHUTDOWN_TIMEOUT_MS = 2_000
const ZIMA_CONTEXT_WINDOW_TOKENS = 128_000

type JsonObject = Record<string, unknown>

interface PendingRequest {
  resolve: (value: JsonObject) => void
  reject: (error: Error) => void
  timer: ReturnType<typeof setTimeout>
}

export interface ZimaRuntimeProcessOptions {
  /** 必须指向受控虚拟环境中的 Python，不能依赖 PATH 上碰巧存在的命令。 */
  pythonExecutable: string
  clientVersion: string
  onEvent?: (event: JsonObject) => void
  onFailure?: (error: Error) => void
}

export interface ZimaRuntimeHandshake {
  bootId: string
  runtimeVersion: string
}

function asObject(value: unknown): JsonObject | undefined {
  return value && typeof value === 'object' && !Array.isArray(value)
    ? value as JsonObject
    : undefined
}

/** 比较真实路径；macOS 的 /var 与 /private/var 等别名不能被误判为越界。 */
function canonicalArtifactPath(path: string): string {
  const absolute = resolve(path)
  return existsSync(absolute)
    ? realpathSync(absolute)
    : join(realpathSync(dirname(absolute)), basename(absolute))
}

/** 每个活动 Zima 会话持有一个进程；请求响应按 ID 关联，事件单独上送。 */
export class ZimaRuntimeTransport {
  private readonly pending = new Map<string, PendingRequest>()
  private stdoutBuffer = Buffer.alloc(0)
  private failed: Error | undefined
  private closing = false
  private handshake: ZimaRuntimeHandshake | undefined

  private constructor(
    private readonly child: ChildProcessWithoutNullStreams,
    private readonly onEvent?: (event: JsonObject) => void,
    private readonly onFailure?: (error: Error) => void,
  ) {
    child.stdout.on('data', (chunk: Buffer) => this.receive(chunk))
    child.stdout.on('error', () => this.fail(new Error('Zima Runtime 输出管道失败')))
    child.stdin.on('error', () => this.fail(new Error('Zima Runtime 输入管道失败')))
    // stderr 不写入会话或日志；其中可能包含渠道密钥和模型输入。
    child.stderr.on('data', () => { })
    child.on('error', () => this.fail(new Error('Zima Runtime 进程启动失败')))
    child.on('exit', () => this.fail(new Error('Zima Runtime 进程已退出')))
  }

  /** 启动受控 Python 并完成版本握手；不合格进程立即关闭，不交给查询层。 */
  static async connect(options: ZimaRuntimeProcessOptions): Promise<ZimaRuntimeTransport> {
    if (!isAbsolute(options.pythonExecutable) || !options.clientVersion.trim()) {
      throw new Error('Zima Runtime 启动配置无效')
    }
    const child = spawn(options.pythonExecutable, ['-m', 'zima_agent.runtime', '--stdio'], {
      stdio: ['pipe', 'pipe', 'pipe'],
      windowsHide: true,
    })
    const transport = new ZimaRuntimeTransport(child, options.onEvent, options.onFailure)
    try {
      const response = await transport.request('runtime.handshake', {
        protocol_version: PROTOCOL_VERSION,
        client: { name: 'axon', version: options.clientVersion },
      }, HANDSHAKE_TIMEOUT_MS)
      const runtime = asObject(response.runtime)
      if (
        response.protocol_version !== PROTOCOL_VERSION
        || runtime?.name !== 'zima-agent-runtime'
        || typeof runtime.version !== 'string' || !runtime.version
        || typeof runtime.boot_id !== 'string' || !runtime.boot_id
      ) throw new Error('Zima Runtime 握手版本或身份无效')
      transport.handshake = { bootId: runtime.boot_id, runtimeVersion: runtime.version }
      return transport
    } catch (error) {
      transport.fail(error instanceof Error ? error : new Error('Zima Runtime 握手失败'))
      throw error
    }
  }

  get identity(): ZimaRuntimeHandshake {
    if (!this.handshake) throw new Error('Zima Runtime 尚未完成握手')
    return this.handshake
  }

  /** 发送一条有界 JSON-RPC 请求；超时仅拒绝等待者，不隐式重投可能已执行的请求。 */
  request(method: string, params: JsonObject, timeoutMs = 30_000): Promise<JsonObject> {
    if (this.failed || this.closing) return Promise.reject(this.failed ?? new Error('Zima Runtime 已关闭'))
    const id = randomUUID()
    const line = `${JSON.stringify({ jsonrpc: '2.0', id, method, params })}\n`
    if (Buffer.byteLength(line) > MAX_LINE_BYTES) {
      return Promise.reject(new Error('Zima Runtime 请求超过协议大小限制'))
    }
    return new Promise<JsonObject>((resolve, reject) => {
      const timer = setTimeout(() => {
        // 请求可能已在子进程执行；进程状态不确定时整体关闭，绝不自动重发。
        this.fail(new Error(`Zima Runtime 请求超时: ${method}`))
      }, timeoutMs)
      this.pending.set(id, { resolve, reject, timer })
      this.child.stdin.write(line, (error) => {
        if (!error) return
        const pending = this.pending.get(id)
        if (!pending) return
        this.pending.delete(id)
        clearTimeout(pending.timer)
        pending.reject(new Error(`Zima Runtime 请求发送失败: ${method}`))
      })
    })
  }

  /** 先请求优雅停机；失败或超时后强制结束，确保子进程不遗留。 */
  async close(): Promise<void> {
    if (this.closing) return
    if (!this.failed) {
      try { await this.request('runtime.shutdown', {}, SHUTDOWN_TIMEOUT_MS) }
      catch { /* 退出时的协议失败不妨碍资源回收。 */ }
    }
    this.closing = true
    this.fail(new Error('Zima Runtime 已关闭'))
  }

  /** 应用退出时同步结束子进程；不等待可能已经失联的 JSON-RPC 回包。 */
  terminate(): void {
    this.closing = true
    this.fail(new Error('Zima Runtime 已终止'))
  }

  /** stdout 按字节限制和换行切包，避免恶意或损坏进程无限堆积内存。 */
  private receive(chunk: Buffer): void {
    if (this.failed) return
    this.stdoutBuffer = Buffer.concat([this.stdoutBuffer, chunk])
    if (this.stdoutBuffer.length > MAX_LINE_BYTES && this.stdoutBuffer.indexOf(10) < 0) {
      this.fail(new Error('Zima Runtime 输出行超过协议大小限制'))
      return
    }
    while (true) {
      const end = this.stdoutBuffer.indexOf(10)
      if (end < 0) break
      if (end > MAX_LINE_BYTES) {
        this.fail(new Error('Zima Runtime 输出行超过协议大小限制'))
        return
      }
      const line = this.stdoutBuffer.subarray(0, end).toString('utf8')
      this.stdoutBuffer = this.stdoutBuffer.subarray(end + 1)
      try { this.dispatch(JSON.parse(line) as unknown) }
      catch {
        this.fail(new Error('Zima Runtime 返回无效 JSON-RPC 数据'))
        return
      }
    }
    if (this.stdoutBuffer.length > MAX_LINE_BYTES) {
      this.fail(new Error('Zima Runtime 输出行超过协议大小限制'))
    }
  }

  /** 响应只完成对应 ID；事件须匹配本次握手 boot ID，过期进程事件直接丢弃。 */
  private dispatch(value: unknown): void {
    const envelope = asObject(value)
    if (!envelope || envelope.jsonrpc !== '2.0') throw new Error('无效 JSON-RPC')
    if (envelope.method === 'runtime.event') {
      const event = asObject(envelope.params)
      if (event && this.handshake && event.boot_id === this.handshake.bootId) this.onEvent?.(event)
      return
    }
    if (typeof envelope.id !== 'string') throw new Error('响应缺少请求 ID')
    const pending = this.pending.get(envelope.id)
    if (!pending) return // 已超时的迟到响应不能影响后续请求。
    this.pending.delete(envelope.id)
    clearTimeout(pending.timer)
    const error = asObject(envelope.error)
    const result = asObject(envelope.result)
    if (error) pending.reject(new Error('Zima Runtime 拒绝请求'))
    else if (result) pending.resolve(result)
    else pending.reject(new Error('Zima Runtime 响应缺少结果'))
  }

  /** 将任何致命传输故障收束成一次关闭，并拒绝全部悬挂请求。 */
  private fail(error: Error): void {
    if (this.failed) return
    this.failed = error
    for (const pending of this.pending.values()) {
      clearTimeout(pending.timer)
      pending.reject(error)
    }
    this.pending.clear()
    this.onFailure?.(error)
    this.child.kill()
  }
}

interface ActiveZimaRun {
  transport: ZimaRuntimeTransport
  runId: string
  runtimeSessionId: string
  abortRequested: boolean
  permissionMode: AgentPermissionMode
}

function zimaProvider(provider: NonNullable<AgentQueryInput['connection']>['provider']): string {
  if (provider === 'openai') return 'openai'
  if (provider === 'custom') return 'openai-compatible'
  if (provider === 'anthropic' || provider === 'anthropic-compatible') return 'anthropic'
  if (provider === 'google') return 'google'
  throw new Error('此渠道协议尚不受 Zima Runtime 支持')
}

/** 创建与发送共用约束，防止持久化一个 Zima 无法请求的渠道。 */
export function assertZimaConnection(connection: NonNullable<AgentQueryInput['connection']>): void {
  zimaProvider(connection.provider)
  if (!connection.apiKey.trim()) throw new Error('Zima Runtime 要求非空 API Key')
  let url: URL
  try { url = new URL(connection.baseUrl) }
  catch { throw new Error('Zima Runtime 的 Base URL 无效') }
  if (!['http:', 'https:'].includes(url.protocol) || !url.hostname) {
    throw new Error('Zima Runtime 的 Base URL 必须是 HTTP(S) 地址')
  }
}

/** 当前协议不能在 Read 后热更新系统提示；明确提示模型主动检查子目录规则。 */
function zimaSystemPrompt(input: AgentQueryInput): string | null {
  const base = input.systemPrompt?.trim() ?? ''
  if (!input.projectInstructionScope) return base || null
  return [
    base,
    'Zima Runtime 当前不会自动把子目录 AGENTS.md 加入后续模型请求。进入子目录读取或修改文件前，先用 Read 检查沿途适用的 AGENTS.md；项目根规则已由宿主提供。',
  ].filter(Boolean).join('\n\n')
}

/** 只在 adapter 内把连接信息和恢复凭据翻译成 Zima 的 session.run 参数。 */
function buildRunParams(input: AgentQueryInput, runId: string): JsonObject {
  const connection = input.connection
  if (!connection || !input.model || !input.cwd || !input.runtimeSessionDir) {
    throw new Error('Zima Runtime 缺少模型、工作区或会话目录')
  }
  assertZimaConnection(connection)
  const sessionDirectory = resolve(input.runtimeSessionDir, 'zima')
  let resumeFile: string | undefined
  if (input.runtimeSessionFile) {
    resumeFile = canonicalArtifactPath(input.runtimeSessionFile)
    const descendant = relative(canonicalArtifactPath(sessionDirectory), resumeFile)
    if (descendant.startsWith('..') || isAbsolute(descendant) || basename(descendant) !== 'state.json') {
      throw new Error('Zima Runtime 恢复文件不属于本 runtime 目录')
    }
  }
  return {
    session_id: input.sessionId,
    run_id: runId,
    prompt: input.prompt,
    working_directory: input.cwd,
    system_prompt: zimaSystemPrompt(input),
    model: {
      provider: zimaProvider(connection.provider),
      name: input.model,
      base_url: connection.baseUrl,
      api_key: connection.apiKey,
      thinking_level: input.thinkingLevel ?? 'medium',
    },
    runtime: {
      session_directory: sessionDirectory,
      context_window_tokens: ZIMA_CONTEXT_WINDOW_TOKENS,
      ...(resumeFile
        ? { resume_file: resumeFile }
        : input.resumeSessionId ? { resume_session_id: input.resumeSessionId } : {}),
      ...(input.recoveryPrompt ? { recovery_prompt: input.recoveryPrompt } : {}),
    },
    tools: {
      allowed_builtin_tools: input.allowedBuiltinTools
        ? ZIMA_BUILTIN_TOOLS.filter((name) => input.allowedBuiltinTools?.includes(name))
        : [...ZIMA_BUILTIN_TOOLS],
      host_tools: (input.customTools ?? [])
        .map((tool) => ({ name: tool.name, description: tool.description, input_schema: tool.inputSchema })),
      approval_mode: 'host',
    },
    features: { skills: false, mcp: false, subagents: false },
  }
}

function permissionInput(name: string, input: JsonObject): JsonObject {
  return ['Read', 'Write', 'Edit'].includes(name) ? { ...input, file_path: input.path } : input
}

function restoredArguments(original: JsonObject, updated: JsonObject | undefined): JsonObject {
  if (!updated) return original
  const restored = { ...original, ...updated }
  if (typeof updated.file_path === 'string') restored.path = updated.file_path
  delete restored.file_path
  return restored
}

function callbackFields(event: JsonObject): { requestId: string; toolCallId: string; name: string; args: JsonObject } {
  const data = asObject(event.data)
  if (
    typeof data?.request_id !== 'string' || !data.request_id
    || typeof data.tool_call_id !== 'string' || !data.tool_call_id
    || typeof data.name !== 'string' || !data.name
  ) throw new Error('Zima Runtime 回调缺少身份字段')
  const args = asObject(data.arguments)
  if (!args) throw new Error('Zima Runtime 回调参数不是对象')
  return { requestId: data.request_id, toolCallId: data.tool_call_id, name: data.name, args }
}

function toolCallsFromMessage(value: unknown): SDKContentBlock[] {
  if (!Array.isArray(value)) return []
  return value.map((raw) => {
    const call = asObject(raw)
    const func = asObject(call?.function)
    if (typeof call?.id !== 'string' || typeof func?.name !== 'string') {
      throw new Error('Zima 完整回复包含无效工具调用')
    }
    const args = asObject(func.arguments)
    if (!args) throw new Error('Zima 工具调用参数不是对象')
    return { type: 'tool_use', id: call.id, name: func.name, input: args }
  })
}

function isToolUse(block: SDKContentBlock): block is SDKToolUseBlock {
  return block.type === 'tool_use' && typeof (block as { id?: unknown }).id === 'string'
}

interface ZimaAssistantOrder {
  blocks: SDKContentBlock[]
  toolIndices: Map<string, number>
}

/** 每次通道切换都开启新块，避免后续思考被并入较早的思考块。 */
function appendOrderedDelta(order: ZimaAssistantOrder, channel: 'text' | 'thinking', delta: string): number {
  const last = order.blocks.at(-1)
  if (last?.type !== channel) order.blocks.push(channel === 'text' ? { type: 'text', text: '' } : { type: 'thinking', thinking: '' })
  const index = order.blocks.length - 1
  const block = order.blocks[index]!
  if (channel === 'text' && block.type === 'text') block.text = `${block.text}${delta}`
  if (channel === 'thinking' && block.type === 'thinking') block.thinking = `${block.thinking}${delta}`
  return index
}

function appendOrderedTool(order: ZimaAssistantOrder, id: string, name: string): number {
  const existing = order.toolIndices.get(id)
  if (existing !== undefined) return existing
  const index = order.blocks.length
  order.blocks.push({ type: 'tool_use', id, name, input: {} })
  order.toolIndices.set(id, index)
  return index
}

function usageFrom(value: unknown): SDKMessageUsage {
  const raw = asObject(value)
  const input = raw?.prompt_tokens
  const output = raw?.completion_tokens
  return {
    input_tokens: typeof input === 'number' && Number.isFinite(input) ? input : 0,
    output_tokens: typeof output === 'number' && Number.isFinite(output) ? output : 0,
  }
}

/** Zima 决定是否重试；这里仅把稳定错误码翻译成 Axon 可展示的类别与文案。 */
function typedRunError(value: unknown): AgentTypedError {
  const raw = asObject(value)
  const code = typeof raw?.code === 'string' ? raw.code : 'zima_runtime_error'
  const known: Record<string, { category: AgentErrorCategory; message: string }> = {
    authentication_error: { category: 'configuration', message: '模型服务认证失败，请检查渠道 API Key' },
    permission_error: { category: 'configuration', message: '模型服务拒绝访问，请检查账户权限' },
    invalid_model: { category: 'configuration', message: '模型不存在或不可用，请检查模型 ID' },
    dns_failed: { category: 'configuration', message: '模型服务域名无法解析，请检查 Base URL' },
    connection_failed: { category: 'configuration', message: '模型服务地址无法连接，请检查 Base URL、域名和端口' },
    tls_failed: { category: 'configuration', message: '模型服务 TLS 连接失败，请检查地址和证书' },
    invalid_request: { category: 'protocol', message: '模型服务不接受当前请求，请检查渠道与模型兼容性' },
    malformed_response: { category: 'protocol', message: '模型服务返回无法解析的响应' },
    rate_limit: { category: 'provider', message: '模型服务请求过于频繁，自动重试后仍未恢复' },
    server_overloaded: { category: 'provider', message: '模型服务暂时不可用，自动重试后仍未恢复' },
    request_timeout: { category: 'network', message: '模型服务请求超时，自动重试后仍未恢复' },
    stream_interrupted: { category: 'network', message: '模型服务连接中断，自动重试后仍未恢复' },
    context_overflow: { category: 'context', message: '上下文超出模型上限，自动压缩后仍无法继续' },
  }
  const mapped = known[code]
  return {
    code,
    category: mapped?.category ?? 'runtime',
    message: mapped?.message ?? (typeof raw?.message === 'string' ? raw.message.slice(0, 2_000) : 'Zima Runtime 运行失败'),
    retryable: raw?.retryable === true,
  }
}

/** 完整 assistant 才能持久化；按流事件顺序重建块，完整负载提供最终工具参数。 */
function assistantPayload(data: JsonObject, sessionId: string, order?: ZimaAssistantOrder): AgentStreamPayload {
  const message = asObject(data.message)
  if (!message || typeof message.message_id !== 'string') throw new Error('Zima 完整回复缺少消息 ID')
  const tools = toolCallsFromMessage(message.tool_calls)
  let content: SDKContentBlock[] = []
  if (order?.blocks.length) {
    const text = order.blocks.filter((block) => block.type === 'text').map((block) => (block as { text?: string }).text ?? '').join('')
    const thinking = order.blocks.filter((block) => block.type === 'thinking').map((block) => (block as { thinking?: string }).thinking ?? '').join('')
    // 完整负载与 delta 不一致时不持久化残缺草稿；无顺序元数据只能按完整字段回退。
    if (text === (message.content ?? '') && thinking === (message.reasoning_content ?? '')) {
      const toolsById = new Map(tools.filter(isToolUse).map((block) => [block.id, block]))
      for (const block of order.blocks) {
        if (isToolUse(block)) {
          const tool = toolsById.get(block.id)
          if (tool) content.push(tool)
        } else {
          content.push(block)
        }
      }
      for (const tool of tools) {
        if (isToolUse(tool) && !order.toolIndices.has(tool.id)) content.push(tool)
      }
    }
  }
  if (content.length === 0) {
    if (typeof message.content === 'string') content.push({ type: 'text', text: message.content })
    if (typeof message.reasoning_content === 'string' && message.reasoning_content) {
      content.push({ type: 'thinking', thinking: message.reasoning_content })
    }
    content.push(...tools)
  }
  return {
    kind: 'sdk_message',
    message: {
      type: 'assistant',
      uuid: message.message_id,
      session_id: sessionId,
      parent_tool_use_id: null,
      message: {
        content,
        usage: usageFrom(data.usage),
        ...(typeof data.model === 'string' ? { model: data.model } : {}),
      },
    },
  }
}

function toolResultPayload(data: JsonObject, sessionId: string): AgentStreamPayload {
  const toolCallId = data.tool_call_id
  if (typeof toolCallId !== 'string' || !toolCallId) throw new Error('Zima 工具结果缺少调用 ID')
  const result = asObject(data.result)
  const content = result?.content ?? result?.text ?? result ?? ''
  return {
    kind: 'sdk_message',
    message: {
      type: 'user',
      uuid: `zima-tool-${toolCallId}`,
      session_id: sessionId,
      parent_tool_use_id: null,
      message: {
        content: [{
          type: 'tool_result',
          tool_use_id: toolCallId,
          content: typeof content === 'string' ? content : JSON.stringify(content),
          is_error: result?.status === 'error',
        }],
      },
    },
  }
}

/** Zima 的终态只映射一次；服务层随后负责落应用 JSONL 与广播完成事件。 */
function resultPayload(
  data: JsonObject,
  sessionId: string,
  usage: SDKMessageUsage,
  stoppedByUser: boolean,
): AgentStreamPayload {
  const status = data.status
  const success = status === 'success'
  const stopped = status === 'aborted'
  const error = success || stopped ? undefined : typedRunError(data.error)
  const result: SDKResultMessage = {
    type: 'result',
    subtype: success ? 'success' : status === 'max_steps' ? 'error_max_turns' : 'error_during_execution',
    terminal_reason: success ? 'completed' : stopped ? 'canceled' : 'failed',
    stopped_by_user: stopped && stoppedByUser,
    session_id: sessionId,
    usage,
    ...(error ? { error, errors: [error.message] } : {}),
  }
  return { kind: 'sdk_message', message: result }
}

/** 从已提交的 Zima 检查点提取本次摘要；只接受当前会话、匹配 ID 且校验完整的快照。 */
function readCompactionSummary(artifactDirectory: string, sessionId: string, summaryId: string): string {
  const statePath = join(artifactDirectory, 'state.json')
  if (statSync(statePath).size > 1_000_000) throw new Error('Zima 压缩状态文件过大')
  const state = asObject(JSON.parse(readFileSync(statePath, 'utf8')))
  const filename = state?.messages_file
  if (state?.session_id !== sessionId || typeof filename !== 'string' || !/^messages\.[a-f0-9]{32}\.jsonl$/.test(filename)) {
    throw new Error('Zima 压缩状态与当前会话不匹配')
  }
  const snapshotPath = join(artifactDirectory, filename)
  if (relative(realpathSync(artifactDirectory), realpathSync(snapshotPath)).startsWith('..')) {
    throw new Error('Zima 压缩消息快照越界')
  }
  if (statSync(snapshotPath).size > 64_000_000) throw new Error('Zima 压缩消息快照过大')
  const snapshot = readFileSync(snapshotPath, 'utf8')
  if (createHash('sha256').update(snapshot).digest('hex') !== state.messages_sha256) {
    throw new Error('Zima 压缩消息快照校验失败')
  }
  for (const line of snapshot.split('\n')) {
    if (!line) continue
    const message = asObject(asObject(JSON.parse(line))?.message)
    const metadata = asObject(message?.metadata)
    if (metadata?.kind !== 'context_summary' || metadata.summary_id !== summaryId) continue
    const content = message?.content
    if (typeof content !== 'string') break
    const match = /^<context_summary>\n([\s\S]*)\n<\/context_summary>$/.exec(content)
    if (match?.[1]) return match[1]
    break
  }
  throw new Error('Zima 压缩摘要未进入已提交的消息快照')
}

function compactionPayload(data: JsonObject, sessionId: string, summary: string): AgentStreamPayload {
  const before = data.before_tokens
  const after = data.after_tokens
  const message: SDKSystemMessage = {
    type: 'system',
    subtype: 'compact_boundary',
    session_id: sessionId,
    compact_result: 'success',
    compact_reason: 'threshold',
    summary,
    ...(typeof before === 'number' && Number.isFinite(before) && before >= 0
      ? { context_tokens_before: before } : {}),
    ...(typeof after === 'number' && Number.isFinite(after) && after >= 0
      ? { context_tokens_after: after } : {}),
    ...(typeof data.summary_id === 'string' ? { runtime_summary_id: data.summary_id } : {}),
  }
  return { kind: 'sdk_message', message }
}

/** 将独立 Zima 进程的一轮查询映射到中立事件流；只暴露应用会话归属。 */
export class ZimaAgentAdapter implements AgentProviderAdapter {
  private readonly active = new Map<string, ActiveZimaRun>()

  constructor(private readonly pythonExecutable: string, private readonly clientVersion: string) { }

  /** Zima v2 接受完整中立等级，并由自身 Provider 边界编码，不借用 Pi 模型目录。 */
  getReasoningCapability(_input: AgentReasoningCapabilityInput): AgentReasoningCapability {
    return {
      levels: ['off', 'minimal', 'low', 'medium', 'high', 'xhigh', 'max'],
      defaultLevel: 'medium',
    }
  }

  /** 回答 Zima 反向调用：内置工具走权限策略，宿主工具由 Axon 执行后回传。 */
  private async resolveCallback(
    event: JsonObject,
    input: AgentQueryInput,
    run: ActiveZimaRun,
  ): Promise<void> {
    const { requestId, toolCallId, name, args } = callbackFields(event)
    const target = { request_id: requestId, session_id: run.runtimeSessionId, run_id: run.runId }
    if (event.event === 'approval.requested') {
      let decision: Awaited<ReturnType<NonNullable<AgentQueryInput['canUseTool']>>>
      try {
        decision = input.canUseTool
          ? await input.canUseTool(name, permissionInput(name, args), {
            signal: input.abortSignal,
            toolUseId: toolCallId,
            permissionMode: run.permissionMode,
          })
          : { behavior: 'deny', message: '当前会话没有工具授权能力' }
      } catch {
        decision = { behavior: 'deny', message: '工具授权失败或已取消' }
      }
      if (input.abortSignal?.aborted) return
      await run.transport.request('approval.resolve', {
        ...target,
        behavior: decision.behavior,
        updated_arguments: decision.behavior === 'allow'
          ? restoredArguments(args, decision.updatedInput)
          : null,
        message: decision.message ?? null,
      })
      return
    }
    if (event.event === 'host_tool.requested') {
      const tool = input.customTools?.find((candidate) => candidate.name === name)
      let result: Awaited<ReturnType<AgentCustomToolDefinition['execute']>>
      try {
        if (!tool || input.abortSignal?.aborted) throw new Error('宿主工具不可用或运行已停止')
        result = await tool.execute(args, { signal: input.abortSignal, toolUseId: toolCallId })
      } catch {
        result = { content: '宿主工具执行失败', isError: true }
      }
      if (input.abortSignal?.aborted) return
      await run.transport.request('host_tool.resolve', {
        ...target,
        content: result.content,
        is_error: result.isError === true,
        details: result.details ?? null,
      })
      return
    }
    if (event.event === 'interaction.requested') {
      const askUser = input.customTools?.find((tool) => tool.name === 'AskUserQuestion')
      let answers: JsonObject[] = []
      if (askUser && !input.abortSignal?.aborted) {
        try {
          const result = await askUser.execute(args, { signal: input.abortSignal, toolUseId: toolCallId })
          const content = asObject(result.content)
          const answerMap = asObject(content?.answers)
          if (!result.isError && answerMap) {
            answers = Object.entries(answerMap)
              .filter((entry): entry is [string, string] => typeof entry[1] === 'string')
              .map(([id, answer]) => ({ id, answer }))
          }
        } catch { /* 用户取消或窗口关闭由空答案收束，不悬挂 runtime 回调。 */ }
      }
      if (input.abortSignal?.aborted) return
      await run.transport.request('interaction.resolve', { ...target, answers })
    }
  }

  async *query(input: AgentQueryInput): AsyncIterable<AgentStreamPayload> {
    if (this.active.has(input.sessionId)) throw new Error('Zima 会话已有运行中的查询')
    const runId = randomUUID()
    const params = buildRunParams(input, runId)
    const events: JsonObject[] = []
    let wake: (() => void) | undefined
    let transportFailure: Error | undefined
    const transport = await ZimaRuntimeTransport.connect({
      pythonExecutable: this.pythonExecutable,
      clientVersion: this.clientVersion,
      onEvent: (event) => {
        if (events.length >= MAX_QUEUED_EVENTS) {
          transportFailure = new Error('Zima Runtime 事件队列超过限制')
        } else {
          events.push(event)
        }
        wake?.()
      },
      onFailure: (error) => { transportFailure = error; wake?.() },
    })
    let onAbort: (() => void) | undefined
    try {
      if (input.abortSignal?.aborted) throw new Error('Zima 查询已取消')
      const run: ActiveZimaRun = {
        transport, runId, runtimeSessionId: input.resumeSessionId ?? input.sessionId,
        abortRequested: false, permissionMode: input.permissionMode ?? 'default',
      }
      this.active.set(input.sessionId, run)
      onAbort = () => this.abort(input.sessionId)
      input.abortSignal?.addEventListener('abort', onAbort, { once: true })
      const accepted = await transport.request('session.run', params)
      if (accepted.accepted !== true || accepted.run_id !== runId || typeof accepted.session_id !== 'string') {
        throw new Error('Zima Runtime 未接受本轮查询')
      }
      run.runtimeSessionId = accepted.session_id
      const artifactDirectory = accepted.artifact_directory
      if (typeof artifactDirectory !== 'string' || !isAbsolute(artifactDirectory)) {
        throw new Error('Zima Runtime 未返回合法 artifact 目录')
      }
      const root = canonicalArtifactPath(resolve(input.runtimeSessionDir!, 'zima'))
      const descendant = relative(root, canonicalArtifactPath(artifactDirectory))
      if (!descendant || descendant.startsWith('..') || isAbsolute(descendant)) {
        throw new Error('Zima Runtime 返回的 artifact 目录越界')
      }
      input.onRuntimeSession?.(accepted.session_id, join(artifactDirectory, 'state.json'))

      // 与本轮下发的 runtime 配置保持一致，供会话历史恢复和输入区圆环读取窗口上限。
      yield {
        kind: 'sdk_message', message: {
          type: 'system', subtype: 'init', session_id: run.runtimeSessionId,
          model: input.model, context_window_tokens: ZIMA_CONTEXT_WINDOW_TOKENS,
        }
      }

      let lastSequence = 0
      let runUsage: SDKMessageUsage = { input_tokens: 0, output_tokens: 0 }
      let terminal = false
      let retryAttempt: number | undefined
      const assistantOrders = new Map<string, ZimaAssistantOrder>()
      while (!terminal) {
        if (transportFailure) throw transportFailure
        if (events.length === 0) {
          await new Promise<void>((resolveWake) => { wake = resolveWake })
          wake = undefined
          continue
        }
        const event = events.shift()!
        if (event.session_id !== run.runtimeSessionId || event.run_id !== runId) continue
        const sequence = event.sequence
        if (typeof sequence !== 'number' || !Number.isSafeInteger(sequence) || sequence <= lastSequence) continue
        lastSequence = sequence
        const data = asObject(event.data)
        if (!data) throw new Error('Zima Runtime 事件数据无效')
        if (event.event === 'assistant.delta') {
          const messageId = data.message_id
          if (typeof messageId !== 'string') continue
          let order = assistantOrders.get(messageId)
          if (!order) {
            order = { blocks: [], toolIndices: new Map() }
            assistantOrders.set(messageId, order)
          }
          const channel = data.channel
          if (channel === 'tool_call') {
            const toolCallId = data.tool_call_id
            if (typeof toolCallId !== 'string') continue
            const contentIndex = appendOrderedTool(order, toolCallId, typeof data.name === 'string' ? data.name : '')
            yield {
              kind: 'sdk_delta',
              delta: {
                uuid: messageId,
                session_id: run.runtimeSessionId,
                deltas: data.phase === 'start'
                  ? [{
                    type: 'toolcall_start', contentIndex, toolCall: {
                      id: toolCallId, name: typeof data.name === 'string' ? data.name : '',
                    }
                  }]
                  : [{
                    type: 'toolcall_delta', contentIndex,
                    delta: typeof data.delta === 'string' ? data.delta : '',
                    toolCall: { id: toolCallId, name: typeof data.name === 'string' ? data.name : '' },
                  }],
              },
            }
            continue
          }
          if ((channel !== 'text' && channel !== 'thinking') || typeof data.delta !== 'string') continue
          const contentIndex = appendOrderedDelta(order, channel, data.delta)
          yield {
            kind: 'sdk_delta',
            delta: {
              uuid: messageId,
              session_id: run.runtimeSessionId,
              deltas: [{ type: channel === 'text' ? 'text_delta' : 'thinking_delta', contentIndex, delta: data.delta }],
            },
          }
        } else if (event.event === 'assistant.message') {
          if (retryAttempt !== undefined) {
            yield { kind: 'retry_status', status: { phase: 'finished', attempt: retryAttempt, success: true } }
            retryAttempt = undefined
          }
          const messageId = asObject(data.message)?.message_id
          yield assistantPayload(data, run.runtimeSessionId, typeof messageId === 'string' ? assistantOrders.get(messageId) : undefined)
          if (typeof messageId === 'string') assistantOrders.delete(messageId)
        } else if (event.event === 'tool.started' || event.event === 'tool.progress') {
          if (typeof data.tool_call_id === 'string' && typeof data.name === 'string') {
            yield {
              kind: 'sdk_message', message: {
                type: 'tool_progress', tool_use_id: data.tool_call_id,
                tool_name: data.name, parent_tool_use_id: null, session_id: run.runtimeSessionId,
              }
            }
          }
        } else if (event.event === 'tool.finished') {
          yield toolResultPayload(data, run.runtimeSessionId)
        } else if (
          event.event === 'approval.requested'
          || event.event === 'host_tool.requested'
          || event.event === 'interaction.requested'
        ) {
          // 回调必须并行处理；等待用户授权期间仍要继续消费停止和进度事件。
          const task = this.resolveCallback(event, input, run)
          void task.catch((error) => { transportFailure = error instanceof Error ? error : new Error('Zima 回调失败'); wake?.() })
        } else if (event.event === 'usage.updated') {
          runUsage = usageFrom(data.run_usage)
        } else if (event.event === 'context.compaction_started') {
          yield { kind: 'compaction_status', status: { phase: 'started', reason: 'threshold' } }
        } else if (event.event === 'context.compacted') {
          // 边界必须先于压缩后的下一条 assistant 落盘，UI 才能立即换用新基线。
          if (retryAttempt !== undefined) {
            yield { kind: 'retry_status', status: { phase: 'finished', attempt: retryAttempt, success: true } }
            retryAttempt = undefined
          }
          if (typeof data.summary_id !== 'string' || !data.summary_id) {
            throw new Error('Zima 压缩事件缺少摘要 ID')
          }
          // runtime 已先提交检查点再发事件；摘要与边界必须作为同一条应用消息落盘。
          const summary = readCompactionSummary(artifactDirectory, run.runtimeSessionId, data.summary_id)
          yield compactionPayload(data, run.runtimeSessionId, summary)
          yield {
            kind: 'compaction_status',
            status: { phase: 'finished', reason: 'threshold', result: 'success' },
          }
        } else if (event.event === 'retry.scheduled') {
          if (Array.isArray(data.discarded_message_ids)) {
            for (const id of data.discarded_message_ids) {
              if (typeof id === 'string') {
                assistantOrders.delete(id)
                yield { kind: 'discard_assistant', uuid: id }
              }
            }
          }
          const nextAttempt = data.next_attempt
          const maxAttempts = data.max_attempts
          const delay = data.delay_seconds
          if (
            typeof nextAttempt === 'number' && Number.isSafeInteger(nextAttempt)
            && typeof maxAttempts === 'number' && Number.isSafeInteger(maxAttempts)
            && typeof delay === 'number' && Number.isFinite(delay)
          ) {
            retryAttempt = nextAttempt
            yield {
              kind: 'retry_status', status: {
                phase: 'scheduled', attempt: nextAttempt, maxAttempts, delayMs: Math.max(0, delay * 1_000),
              }
            }
          }
        } else if (event.event === 'run.result') {
          if (retryAttempt !== undefined) {
            yield {
              kind: 'retry_status', status: {
                phase: 'finished', attempt: retryAttempt, success: data.status === 'success',
              }
            }
          }
          terminal = true
          yield resultPayload(data, run.runtimeSessionId, runUsage, run.abortRequested)
        }
      }
    } finally {
      if (onAbort) input.abortSignal?.removeEventListener('abort', onAbort)
      this.active.delete(input.sessionId)
      await transport.close()
    }
  }

  abort(sessionId: string): void {
    const run = this.active.get(sessionId)
    if (!run || run.abortRequested) return
    run.abortRequested = true
    void run.transport.request('session.abort', {
      session_id: run.runtimeSessionId, run_id: run.runId, reason: '用户停止',
    }).catch(() => { })
  }

  /** 计划批准后只热切换宿主权限判定；Zima 的工具 schema 保持本轮不变。 */
  async setPermissionMode(sessionId: string, mode: string): Promise<void> {
    const run = this.active.get(sessionId)
    if (!run) throw new Error('Zima 会话当前没有运行')
    if (!['default', 'acceptEdits', 'bypassPermissions', 'plan'].includes(mode)) {
      throw new Error('Zima 权限模式无效')
    }
    run.permissionMode = mode as AgentPermissionMode
  }

  dispose(): void {
    for (const run of this.active.values()) run.transport.terminate()
    this.active.clear()
  }
}
