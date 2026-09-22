/** Agent 主进程编排：连接应用会话、渠道、可插拔 adapter 与事件总线。 */

import { randomUUID } from 'node:crypto'
import { AGENT_RUNTIME_CAPABILITIES, DEFAULT_AGENT_SESSION_TITLE } from '@axon/shared'
import type {
  AgentActiveRun,
  AgentCanUseTool,
  AgentCustomToolDefinition,
  AgentExecutionPermissionMode,
  AgentMemoryFileStates,
  AgentTypedError,
  AgentProviderAdapter,
  AgentPermissionMode,
  AgentQueryInput,
  AgentRunSource,
  AgentRuntimeId,
  AgentSendInput,
  AgentSessionMeta,
  AgentSubagentType,
  AgentStreamPayload,
  ResolvedChannel,
  SDKAssistantMessage,
  SDKMessage,
  SDKResultMessage,
} from '@axon/shared'
import { appendDeferredToolCatalogPrompt, resolveDeferredToolMode } from './agent-tool-search'
import type { ChannelManager } from '../channel/channel-manager'
import { AgentSessionManagerError } from './agent-session-manager'
import type { AgentSessionManager } from './agent-session-manager'
import type { AgentEventBus } from './agent-event-bus'
import { createUserStoppedResult, normalizePayloadAfterUserStop } from './agent-stop-policy'
import { buildAgentCompletionPayload } from './agent-completion-payload'
import { buildRecoveryPrompt } from './agent-session-context-prompt'
import { buildPlanModeSystemPrompt } from './agent-plan-mode'
import {
  buildProjectInstructionSystemPrompt,
  type ProjectInstructionManifest,
} from '../project/project-instruction-resolver'
import {
  buildAgentSkillSystemPrompt,
  type AgentSkillCatalog,
} from '../project/project-skill-discovery'
import {
  AGENT_SKILL_READ_TOOL_NAME,
  createAgentSkillReadScope,
  type AgentSkillReadScope,
} from '../project/agent-skill-read-tool'
import type { AgentTitleGenerationInput, AgentTitleGenerator } from './agent-title-generator'

const MAX_AGENT_INPUT_LENGTH = 100_000

export class AgentServiceError extends Error {
  constructor(
    readonly code: 'invalid_input' | 'not_found' | 'already_active' | 'queue_full' | 'channel_unavailable' | 'workspace_unavailable' | 'custom_tool_unavailable' | 'persistence_error' | 'runtime_error',
    message: string,
  ) {
    super(message)
    this.name = 'AgentServiceError'
  }
}

export interface AgentServiceOptions {
  adapter: AgentProviderAdapter
  /** 按已落盘的会话归属选择 adapter；未注入时只支持默认 Pi。 */
  resolveAdapter?: (runtimeId: AgentRuntimeId) => AgentProviderAdapter
  /** 发送前复核会话运行条件，防止渠道配置变更后写入无法交付的用户消息。 */
  validateRuntimeSession?: (session: AgentSessionMeta) => void
  channelManager: Pick<ChannelManager, 'resolve'>
  sessionManager: Pick<AgentSessionManager, 'get' | 'getMessages' | 'appendMessage' | 'update'>
  eventBus: AgentEventBus
  runtimeConfigDir: string
  runtimeSessionDir: string
  /** 将会话 projectId 解析为项目唯一工作区对应的可信 runtime cwd。 */
  resolveProjectCwd: (projectId: string) => string
  getSystemPrompt?: (session: AgentSessionMeta) => string
  /** 只从已解析的可信项目根读取指令；失败时本轮降级为无项目指令。 */
  resolveProjectInstructions?: (projectRoot: string) => ProjectInstructionManifest
  /** 按固定优先级发现项目、内置与用户 Skill；失败时本轮降级为无 Skills。 */
  discoverAgentSkills?: (projectRoot: string) => AgentSkillCatalog
  /** 读取当前项目的动态记忆上下文；关闭记忆时返回 undefined。 */
  getProjectMemoryContext?: (
    projectId: string,
    previous: AgentMemoryFileStates | undefined,
  ) => { prompt: string; fileStates: AgentMemoryFileStates; shouldPersistStates: boolean } | undefined
  getCustomTools?: (context: AgentCustomToolContext) =>
    AgentCustomToolDefinition[] | Promise<AgentCustomToolDefinition[]>
  /** 为每轮运行创建权限回调，使等待与该轮 AbortSignal 绑定。 */
  createCanUseTool?: (
    sessionId: string,
    runStartedAt: number,
    runSignal: AbortSignal,
  ) => AgentCanUseTool
  /** 停止某会话后同步取消其子任务；回调失败不能阻止当前会话中止。 */
  onStopSession?: (sessionId: string) => void
  /** 首轮成功后通过普通文本生成接口命名；未注入时保持默认标题。 */
  generateTitle?: AgentTitleGenerator
  createId?: () => string
  now?: () => number
}

export interface AgentCustomToolContext {
  sessionId: string
  projectId: string
  runStartedAt: number
  runSignal: AbortSignal
  permissionMode: AgentPermissionMode
}

interface ActiveAgentRun {
  controller: AbortController
  adapter: AgentProviderAdapter
  runStartedAt: number
  source: AgentRunSource
}

export interface AgentRunContext {
  source?: AgentRunSource
  /** 宿主判定的输入入口，仅写入用户消息来源，不传给 runtime。 */
  inputOrigin?: 'quick'
  /** 宿主内部续跑提示仍需进入 JSONL/runtime 上下文，但不显示成用户气泡。 */
  synthetic?: boolean
}

/** 一轮 Agent 的直接返回值；持久化仍由会话层负责，调用方无需回读 JSONL 获取终态。 */
export interface AgentRunOutcome {
  result: SDKResultMessage
  finalText?: string
}

function normalizeSendInput(value: AgentSendInput): AgentSendInput {
  if (!value || typeof value !== 'object') {
    throw new AgentServiceError('invalid_input', 'Agent 请求格式无效')
  }
  const sessionId = typeof value.sessionId === 'string' ? value.sessionId.trim() : ''
  const text = typeof value.text === 'string' ? value.text.trim() : ''
  if (!sessionId || !text || text.length > MAX_AGENT_INPUT_LENGTH) {
    throw new AgentServiceError('invalid_input', 'Agent 会话 ID 或消息正文无效')
  }
  return { sessionId, text }
}

function shouldPersistMessage(message: SDKMessage): boolean {
  return message.type !== 'tool_progress'
}

/** 把本轮宿主工具记录的 Skill 激活并入唯一 result，随后按普通中立消息落盘。 */
function withSkillActivations(
  result: SDKResultMessage,
  scope: AgentSkillReadScope,
): SDKResultMessage {
  const activated = scope.getActivations()
  if (activated.length === 0) return result
  const merged = new Map((result.skill_activations ?? []).map((item) => [item.name, item]))
  for (const item of activated) merged.set(item.name, item)
  return { ...result, skill_activations: [...merged.values()] }
}

function assistantText(message: SDKMessage): string | undefined {
  if (message.type !== 'assistant') return undefined
  const content = (message as SDKAssistantMessage).message.content
  const text = content
    .filter((block) => block.type === 'text' && typeof block.text === 'string')
    .map((block) => (block as { text: string }).text)
    .join('\n')
    .trim()
  return text || undefined
}

function allowedSubagentBuiltinTools(type: AgentSubagentType | undefined): string[] | undefined {
  if (type === 'explore') return ['Read', 'Glob', 'Grep', 'LS', 'Bash']
  if (type === 'plan') return ['Read', 'Glob', 'Grep', 'LS']
  return undefined
}

function createUserMessage(text: string, createId: () => string, synthetic = false, inputOrigin?: 'quick'): SDKMessage {
  return {
    type: 'user',
    message: { content: [{ type: 'text', text }] },
    parent_tool_use_id: null,
    uuid: createId(),
    ...(synthetic ? { isSynthetic: true } : {}),
    ...(inputOrigin === 'quick' ? { inputOrigin } : {}),
  }
}

/**
 * 将编排层异常分类为稳定错误。模型调用错误应由 adapter/runtime
 * 收束；能穿透到这里的未知异常不能假定可安全重试。
 */
function normalizeTerminalError(error: unknown, stopped: boolean): AgentTypedError {
  if (stopped) return {
    code: 'canceled', category: 'canceled', message: 'Agent 执行已停止', retryable: false,
  }
  if (error instanceof AgentServiceError && error.code === 'channel_unavailable') return {
    code: error.code, category: 'configuration', message: error.message, retryable: false,
  }
  if (error instanceof AgentServiceError && error.code === 'workspace_unavailable') return {
    code: error.code, category: 'workspace', message: error.message, retryable: false,
  }
  if (error instanceof AgentServiceError && error.code === 'custom_tool_unavailable') return {
    code: error.code, category: 'configuration', message: error.message, retryable: false,
  }
  if (error instanceof AgentServiceError && error.code === 'persistence_error') return {
    code: error.code, category: 'persistence', message: error.message, retryable: false,
  }
  return {
    code: error instanceof AgentServiceError ? error.code : 'runtime_error',
    category: 'runtime',
    message: 'Agent 运行意外终止',
    retryable: false,
  }
}

/** 把编排失败收束为可落盘的中立 result，供 renderer 分类展示。 */
function createTerminalError(sessionId: string, cause: unknown, stopped: boolean): SDKMessage {
  if (stopped) return createUserStoppedResult({ sessionId })
  const error = normalizeTerminalError(cause, stopped)
  return {
    type: 'result',
    subtype: 'error_during_execution',
    usage: { input_tokens: 0, output_tokens: 0 },
    terminal_reason: 'failed',
    errors: [error.message],
    error,
    session_id: sessionId,
  }
}

export class AgentService {
  private readonly activeRuns = new Map<string, ActiveAgentRun>()
  private readonly idleWaiters = new Map<string, Set<() => void>>()
  private readonly createId: () => string
  private readonly now: () => number
  private lastRunStartedAt = 0

  constructor(private readonly options: AgentServiceOptions) {
    this.createId = options.createId ?? randomUUID
    this.now = options.now ?? Date.now
  }

  /**
   * 执行一轮 Agent：用户消息先落盘，再解析渠道并消费 adapter 流；delta 仅广播，
   * 完整消息先落盘后广播，保证 UI 看到的终态一定可以从 JSONL 恢复；同时直接返回
   * 本轮 result 与最终文本，供协作编排消费而无需再次读取会话文件。
   */
  async sendMessage(rawInput: AgentSendInput, context: AgentRunContext = {}): Promise<AgentRunOutcome> {
    const input = normalizeSendInput(rawInput)
    const source = context.source ?? 'renderer'
    if (this.activeRuns.has(input.sessionId)) {
      throw new AgentServiceError('already_active', '该 Agent 会话已有任务正在执行')
    }
    const session = this.options.sessionManager.get(input.sessionId)
    if (!session) throw new AgentServiceError('not_found', 'Agent 会话不存在')
    // adapter 在用户消息落盘前解析；缺失 runtime 不能留下无法交付的半轮历史。
    let adapter: AgentProviderAdapter
    try {
      if (!this.options.resolveAdapter && session.runtimeId !== 'pi') throw new Error('Runtime 未装配')
      adapter = this.options.resolveAdapter?.(session.runtimeId) ?? this.options.adapter
      this.options.validateRuntimeSession?.(session)
    } catch (error) {
      throw new AgentServiceError('runtime_error', error instanceof Error ? error.message : 'Agent Runtime 不可用')
    }
    const permissionMode = session.permissionMode ?? 'default'

    // Date.now 可能在同一毫秒重复；强制单调递增，renderer 才能可靠区分新旧流。
    const runStartedAt = Math.max(this.now(), this.lastRunStartedAt + 1)
    this.lastRunStartedAt = runStartedAt
    const active: ActiveAgentRun = {
      controller: new AbortController(),
      adapter,
      runStartedAt,
      source,
    }
    this.activeRuns.set(input.sessionId, active)
    let terminalReceived = false
    let completionResult: SDKResultMessage | undefined
    let finalAssistantText: string | undefined
    let completionCause: unknown
    let completionPersisted = false
    let titleInput: AgentTitleGenerationInput | undefined

    try {
      // 当前用户消息尚未追加，恢复上下文只能包含前序历史，避免同一输入出现两次。
      const historyBeforeRun = this.options.sessionManager.getMessages(input.sessionId)
      // 先保存用户原始意图；后续渠道失效或 runtime 初始化失败时，失败终态会紧随其后。
      const persistedUser = this.options.sessionManager.appendMessage(
        input.sessionId,
        createUserMessage(input.text, this.createId, context.synthetic === true, context.inputOrigin),
      )
      this.options.eventBus.emit({
        type: 'run_started', sessionId: input.sessionId,
        runStartedAt: active.runStartedAt, source: active.source,
      })
      if (permissionMode === 'plan') {
        this.options.eventBus.emit({
          type: 'plan_mode_changed', sessionId: input.sessionId,
          runStartedAt: active.runStartedAt, active: true, mode: 'plan', source: 'initial',
        })
      }
      this.emitStream(input.sessionId, active, { kind: 'sdk_message', message: persistedUser })

      if (!session.channelId || !session.modelId) {
        throw new AgentServiceError('channel_unavailable', 'Agent 会话尚未选择渠道和模型')
      }
      let channel: ResolvedChannel
      try {
        channel = this.options.channelManager.resolve(session.channelId)
      } catch {
        throw new AgentServiceError('channel_unavailable', 'Agent 会话选择的渠道不可用')
      }
      const model = channel.models.find((item) => item.id === session.modelId)
      if (!channel.enabled || !model?.enabled) {
        throw new AgentServiceError('channel_unavailable', 'Agent 会话选择的渠道或模型不可用')
      }
      titleInput = {
        channel,
        modelId: session.modelId,
        userText: input.text,
        assistantText: '',
        signal: active.controller.signal,
      }

      // 会话不能自带目录；必须经所属项目解析，守住项目内会话共享工作区的边界。
      if (!session.projectId) throw new AgentServiceError('workspace_unavailable', 'Agent 会话尚未归入项目')
      let resolvedCwd: string
      try { resolvedCwd = this.options.resolveProjectCwd(session.projectId) }
      catch { throw new AgentServiceError('workspace_unavailable', 'Agent 项目或工作区不可用') }
      if (!resolvedCwd) throw new AgentServiceError('workspace_unavailable', 'Agent 项目无法解析运行目录')

      // 项目指令是可选上下文：读取失败不能吞掉用户消息或阻断模型请求。
      let systemPrompt = this.options.getSystemPrompt?.(session) ?? ''
      let projectInstructionManifest: ProjectInstructionManifest | undefined
      if (this.options.resolveProjectInstructions) {
        try {
          const manifest = this.options.resolveProjectInstructions(resolvedCwd)
          projectInstructionManifest = manifest
          systemPrompt = buildProjectInstructionSystemPrompt(systemPrompt, manifest)
          for (const diagnostic of manifest.diagnostics) {
            console.warn(`[项目指令] ${diagnostic.path}: ${diagnostic.message}`)
          }
        } catch (error) {
          console.warn('[项目指令] 本轮读取失败，已跳过注入:', error)
        }
      }

      // Skills 目录只注入元数据；正文统一由宿主 SkillRead 读取，不依赖 runtime 的文件工具。
      let skillReadScope: AgentSkillReadScope | undefined
      if (this.options.discoverAgentSkills) {
        try {
          const catalog = this.options.discoverAgentSkills(resolvedCwd)
          systemPrompt = buildAgentSkillSystemPrompt(systemPrompt, catalog)
          if (catalog.skills.length > 0) skillReadScope = createAgentSkillReadScope(catalog)
          for (const diagnostic of catalog.diagnostics) {
            console.warn(`[Agent Skills] ${diagnostic.path}: ${diagnostic.message}`)
          }
        } catch (error) {
          console.warn('[Agent Skills] 本轮发现失败，已跳过注入:', error)
        }
      }

      // 记忆索引与元信息必须逐轮读取；只在变化时持久化新基线，避免无意义索引写入。
      let memoryPrompt = ''
      if (this.options.getProjectMemoryContext) {
        try {
          const memoryContext = this.options.getProjectMemoryContext(
            session.projectId,
            session.memoryFileStates,
          )
          if (memoryContext) {
            memoryPrompt = memoryContext.prompt
            if (memoryContext.shouldPersistStates) {
              this.options.sessionManager.update(input.sessionId, {
                memoryFileStates: memoryContext.fileStates,
              })
            }
          }
        } catch (error) {
          console.warn('[项目记忆] 本轮上下文读取失败，已跳过注入:', error)
        }
      }

      // 自定义工具可能需要先连接项目 MCP；完成发现后才创建 query，避免 runtime 看见半份工具集。
      let customTools: AgentCustomToolDefinition[] | undefined
      if (this.options.getCustomTools) {
        try {
          customTools = await this.options.getCustomTools({
            sessionId: input.sessionId,
            projectId: session.projectId,
            runStartedAt: active.runStartedAt,
            runSignal: active.controller.signal,
            permissionMode,
          })
        } catch (error) {
          if (active.controller.signal.aborted) throw error
          throw new AgentServiceError(
            'custom_tool_unavailable',
            error instanceof Error ? error.message : 'Agent 自定义工具初始化失败',
          )
        }
      }

      // SkillRead 是宿主保留工具；即使 MCP 恰好重名，也必须由可信实现占用该名称。
      if (skillReadScope) {
        customTools = [
          ...(customTools ?? []).filter((tool) => tool.name !== AGENT_SKILL_READ_TOOL_NAME),
          skillReadScope.tool,
        ]
      }

      // 只有 adapter 明确认可的官方协议才启用懒加载；其余协议保持原有 eager 行为。
      if (customTools) {
        const supportsDeferredTools = await adapter.supportsDeferredTools?.({
          provider: channel.provider,
          model: session.modelId,
        }) ?? false
        customTools = resolveDeferredToolMode(customTools, supportsDeferredTools)
      }

      const query: AgentQueryInput = {
        sessionId: input.sessionId,
        prompt: input.text,
        model: session.modelId,
        cwd: resolvedCwd,
        abortSignal: active.controller.signal,
        connection: {
          provider: channel.provider,
          baseUrl: channel.baseUrl,
          apiKey: channel.apiKey,
        },
        // 动态 reminder 放在最终提示词末尾，使文件变化不会被前面的静态说明淹没。
        systemPrompt: appendDeferredToolCatalogPrompt([
          buildPlanModeSystemPrompt(systemPrompt, permissionMode),
          memoryPrompt.trim(),
        ].filter(Boolean).join('\n\n'), customTools ?? []),
        ...(projectInstructionManifest
          ? {
              projectInstructionScope: {
                projectRoot: projectInstructionManifest.projectRoot,
                initialSources: projectInstructionManifest.sources,
              },
            }
          : {}),
        ...(allowedSubagentBuiltinTools(session.subagentType)
          ? { allowedBuiltinTools: allowedSubagentBuiltinTools(session.subagentType) }
          : {}),
        permissionMode,
        ...(AGENT_RUNTIME_CAPABILITIES[session.runtimeId].thinkingLevel
          ? { thinkingLevel: session.thinkingLevel ?? 'medium' }
          : {}),
        runtimeConfigDir: this.options.runtimeConfigDir,
        runtimeSessionDir: this.options.runtimeSessionDir,
        ...(session.sdkSessionId ? { resumeSessionId: session.sdkSessionId } : {}),
        ...(session.runtimeSessionFile ? { runtimeSessionFile: session.runtimeSessionFile } : {}),
        ...((session.sdkSessionId || session.runtimeSessionFile)
          ? { recoveryPrompt: buildRecoveryPrompt(historyBeforeRun) }
          : {}),
        ...(customTools ? { customTools } : {}),
        ...(this.options.createCanUseTool
          ? {
              canUseTool: this.options.createCanUseTool(
                input.sessionId,
                active.runStartedAt,
                active.controller.signal,
              ),
            }
          : {}),
        onRuntimeSession: (runtimeSessionId, runtimeSessionFile) => {
          this.options.sessionManager.update(input.sessionId, {
            sdkSessionId: runtimeSessionId,
            ...(runtimeSessionFile ? { runtimeSessionFile } : {}),
          })
        },
      }

      for await (const incomingPayload of adapter.query(query)) {
        // token 引用是停止/未来替换运行后的 stale 防线；迟到事件不得污染新一轮。
        if (this.activeRuns.get(input.sessionId) !== active) continue
        // result 是本轮唯一终态；adapter 即使异常多发，后续载荷也不能再次落盘或更新 UI。
        if (terminalReceived) continue
        // 用户停止后只接受并规范化最终 result；迟到的流片段和工具活动全部丢弃。
        const payload = active.controller.signal.aborted
          ? normalizePayloadAfterUserStop(incomingPayload, input.sessionId)
          : incomingPayload
        if (!payload) continue
        if (payload.kind !== 'sdk_message') {
          // delta、重试状态和草稿清理都是瞬时投影，不得写入可恢复的历史。
          this.emitStream(input.sessionId, active, payload)
          continue
        }
        // Skill 激活属于应用中立历史；adapter 只负责模型协议，不再各自观察 Read。
        const neutralMessage = payload.message.type === 'result' && skillReadScope
          ? withSkillActivations(payload.message as SDKResultMessage, skillReadScope)
          : payload.message
        const message = shouldPersistMessage(neutralMessage)
          ? this.options.sessionManager.appendMessage(input.sessionId, neutralMessage)
          : neutralMessage
        finalAssistantText = assistantText(message) ?? finalAssistantText
        if (message.type === 'result') {
          terminalReceived = true
          completionResult = message as SDKResultMessage
          completionPersisted = true
        }
        this.emitStream(input.sessionId, active, { kind: 'sdk_message', message })
      }

      if (!terminalReceived) throw new AgentServiceError('runtime_error', 'Agent runtime 未返回结束消息')
    } catch (error) {
      completionCause = error
      // 存储已失效时不再尝试追加错误 result；直接通过 IPC 告知 renderer。
      if (error instanceof AgentSessionManagerError) {
        const persistenceError = new AgentServiceError('persistence_error', '无法保存 Agent 会话消息')
        completionCause = persistenceError
        throw persistenceError
      }
      if (!terminalReceived) {
        let terminal: SDKMessage
        try {
          terminal = this.options.sessionManager.appendMessage(
            input.sessionId,
            createTerminalError(input.sessionId, error, active.controller.signal.aborted),
          )
        } catch (persistenceError) {
          if (persistenceError instanceof AgentSessionManagerError) {
            const terminalPersistenceError = new AgentServiceError('persistence_error', '无法保存 Agent 运行结果')
            completionCause = terminalPersistenceError
            throw terminalPersistenceError
          }
          throw persistenceError
        }
        completionResult = terminal as SDKResultMessage
        completionPersisted = true
        this.emitStream(input.sessionId, active, { kind: 'sdk_message', message: terminal })
      }
      // 失败 result 已成功落盘即表示命令已收束；模型成败由消息终态表达。
    } finally {
      if (this.activeRuns.get(input.sessionId) === active) this.activeRuns.delete(input.sessionId)
      this.resolveIdleWaiters(input.sessionId)
      const completedAt = Math.max(this.now(), active.runStartedAt)
      const result = completionResult ?? createTerminalError(
        input.sessionId,
        completionCause ?? new AgentServiceError('runtime_error', 'Agent 运行未形成终态'),
        active.controller.signal.aborted,
      ) as SDKResultMessage
      this.options.eventBus.emit({
        type: 'run_finished',
        sessionId: input.sessionId,
        runStartedAt: active.runStartedAt,
        source: active.source,
        completion: buildAgentCompletionPayload(
          result,
          active.runStartedAt,
          completedAt,
          completionPersisted,
        ),
      })
    }
    if (!completionResult) {
      throw new AgentServiceError('runtime_error', 'Agent 运行未形成可返回的终态')
    }
    if (
      completionResult.subtype === 'success'
      && finalAssistantText
      && titleInput
      && !context.synthetic
      && !session.parentSessionId
    ) {
      // 标题是附属请求：不延长本轮完成时间，也不让失败反向污染 Agent 结果。
      void this.maybeGenerateTitle(
        input.sessionId,
        active.runStartedAt,
        { ...titleInput, assistantText: finalAssistantText },
      ).catch(() => {})
    }
    return {
      result: completionResult,
      ...(finalAssistantText ? { finalText: finalAssistantText } : {}),
    }
  }

  /** 仅占用默认标题；生成前后两次复查，避免覆盖用户并发完成的手动改名。 */
  private async maybeGenerateTitle(
    sessionId: string,
    runStartedAt: number,
    input: AgentTitleGenerationInput,
  ): Promise<void> {
    if (!this.options.generateTitle) return
    const session = this.options.sessionManager.get(sessionId)
    if (!session || session.title !== DEFAULT_AGENT_SESSION_TITLE) return
    const title = await this.options.generateTitle(input)
    if (!title) return
    const latest = this.options.sessionManager.get(sessionId)
    if (!latest || latest.title !== DEFAULT_AGENT_SESSION_TITLE) return
    const updated = this.options.sessionManager.update(sessionId, { title })
    this.options.eventBus.emit({
      type: 'session_title',
      sessionId,
      runStartedAt,
      title: updated.title,
      updatedAt: updated.updatedAt,
    })
  }

  /** 停止指定会话；始终中止该轮选中的 adapter，不受其他会话 runtime 影响。 */
  stop(sessionId: string): boolean {
    const active = this.activeRuns.get(sessionId)
    if (!active) return false
    active.controller.abort()
    active.adapter.abort(sessionId)
    try { this.options.onStopSession?.(sessionId) }
    catch (error) { console.warn('[Agent 协作] 向下取消子任务失败:', error) }
    return true
  }

  stopAll(): number {
    const sessionIds = [...this.activeRuns.keys()]
    for (const sessionId of sessionIds) this.stop(sessionId)
    return sessionIds.length
  }

  isActive(sessionId: string): boolean {
    return this.activeRuns.has(sessionId)
  }

  /** 等待当前会话结束正在执行的一轮；注册后复查，封住结束事件先发生的竞态。 */
  async waitUntilIdle(sessionId: string): Promise<void> {
    if (!this.activeRuns.has(sessionId)) return
    await new Promise<void>((resolve) => {
      const waiters = this.idleWaiters.get(sessionId) ?? new Set<() => void>()
      waiters.add(resolve)
      this.idleWaiters.set(sessionId, waiters)
      if (!this.activeRuns.has(sessionId)) this.resolveIdleWaiters(sessionId)
    })
  }

  /** 计划审批先热切换活跃 adapter，再写会话索引；持久化失败时回滚运行态。 */
  async setPermissionMode(sessionId: string, mode: AgentExecutionPermissionMode): Promise<void> {
    const active = this.activeRuns.get(sessionId)
    const session = this.options.sessionManager.get(sessionId)
    if (!active || !session) throw new AgentServiceError('not_found', 'Agent 运行或会话不存在')
    if (!active.adapter.setPermissionMode) {
      throw new AgentServiceError('runtime_error', '当前 Agent Runtime 不支持运行中切换权限模式')
    }
    const previousMode = session.permissionMode ?? 'default'
    await active.adapter.setPermissionMode(sessionId, mode)
    if (this.activeRuns.get(sessionId) !== active || active.controller.signal.aborted) {
      await active.adapter.setPermissionMode(sessionId, previousMode).catch(() => {})
      throw new AgentServiceError('runtime_error', 'Agent 运行已停止，无法批准计划')
    }
    try {
      this.options.sessionManager.update(sessionId, { permissionMode: mode })
    } catch (error) {
      await active.adapter.setPermissionMode(sessionId, previousMode).catch(() => {})
      throw error
    }
  }

  /** 返回不含 AbortController 的运行快照，供新打开或重载的窗口恢复运行标记。 */
  listActiveRuns(): AgentActiveRun[] {
    return [...this.activeRuns].map(([sessionId, run]) => ({
      sessionId,
      runStartedAt: run.runStartedAt,
      source: run.source,
    }))
  }

  private emitStream(sessionId: string, active: ActiveAgentRun, payload: AgentStreamPayload): void {
    this.options.eventBus.emit({
      type: 'stream',
      sessionId,
      runStartedAt: active.runStartedAt,
      source: active.source,
      payload,
    })
  }

  private resolveIdleWaiters(sessionId: string): void {
    const waiters = this.idleWaiters.get(sessionId)
    if (!waiters) return
    this.idleWaiters.delete(sessionId)
    for (const resolve of waiters) resolve()
  }
}
