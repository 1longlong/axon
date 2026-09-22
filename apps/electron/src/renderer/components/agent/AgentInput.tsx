import * as React from 'react'
import { Loader2, Settings, Square } from 'lucide-react'
import { agentStateAtom } from '@/atoms/agent-state'
import { chatStateAtom } from '@/atoms/chat-state'
import { settingsOpenAtom, settingsTabAtom } from '@/atoms/settings-tab'
import { useAtomValue, useSetAtom } from 'jotai'
import { buildChatModelOptions, decodeChatModelOption, encodeChatModelOption } from '@/lib/chat-model-options'
import { useAgentController } from './AgentStateProvider'
import { RichTextInput } from '@/components/chat/RichTextInput'
import { ContextUsageIndicator } from './ContextUsageIndicator'
import { AgentMessageQueue } from './AgentMessageQueue'
import { AGENT_RUNTIME_CAPABILITIES } from '@axon/shared'
import type { AgentPermissionMode, AgentReasoningCapability, AgentThinkingLevel } from '@axon/shared'

const MAX_AGENT_INPUT_LENGTH = 100_000
const THINKING_LEVELS: readonly AgentThinkingLevel[] = ['off', 'minimal', 'low', 'medium', 'high', 'xhigh', 'max']

/** 与 adapter 的档位收窄方向一致，保证模型切换时选择框显示实际生效值。 */
function visibleThinkingLevel(level: AgentThinkingLevel, available: readonly AgentThinkingLevel[]): AgentThinkingLevel {
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

/** Agent 输入只负责本地草稿和 send/stop；流事件继续由全局 controller 接收。 */
export function AgentInput({ sessionId }: { sessionId: string }): React.ReactElement {
  const controller = useAgentController()
  const state = useAtomValue(agentStateAtom)
  const chatState = useAtomValue(chatStateAtom)
  const setSettingsOpen = useSetAtom(settingsOpenAtom)
  const setSettingsTab = useSetAtom(settingsTabAtom)
  const [value, setValue] = React.useState('')
  const [savingModel, setSavingModel] = React.useState(false)
  const [savingPermissionMode, setSavingPermissionMode] = React.useState(false)
  const [savingThinkingLevel, setSavingThinkingLevel] = React.useState(false)
  const [modelError, setModelError] = React.useState<string | undefined>(undefined)
  const [permissionModeError, setPermissionModeError] = React.useState<string | undefined>(undefined)
  const [thinkingLevelError, setThinkingLevelError] = React.useState<string | undefined>(undefined)
  const [reasoningCapability, setReasoningCapability] = React.useState<{
    key: string
    value?: AgentReasoningCapability
  } | undefined>(undefined)
  const running = state.activeRunsBySession[sessionId] !== undefined
  const runSource = state.activeRunSourcesBySession[sessionId]
  const externalRunning = runSource === 'external'
  const queuedMessages = state.queuedMessagesBySession[sessionId] ?? []
  const session = state.sessions.find((item) => item.id === sessionId)
  const runtimeCapabilities = session ? AGENT_RUNTIME_CAPABILITIES[session.runtimeId] : undefined
  const messages = state.messagesBySession[sessionId] ?? []
  const modelOptions = React.useMemo(() => buildChatModelOptions(
    session?.runtimeId === 'zima'
      ? chatState.channels.filter((channel) => channel.hasApiKey && ['openai', 'custom', 'anthropic', 'anthropic-compatible', 'google'].includes(channel.provider))
      : chatState.channels,
  ), [chatState.channels, session?.runtimeId])
  const currentModel = session?.channelId && session.modelId
    ? encodeChatModelOption(session.channelId, session.modelId)
    : ''
  const hasModel = modelOptions.some((option) => encodeChatModelOption(option.channelId, option.modelId) === currentModel)
  const unavailable = !session?.projectId || !hasModel
  const permissionMode = session?.permissionMode ?? 'default'
  const thinkingLevel = session?.thinkingLevel ?? 'medium'
  const modelKey = session?.channelId && session.modelId && runtimeCapabilities?.thinkingLevel
    ? `${session.runtimeId}\0${session.channelId}\0${session.modelId}` : undefined
  const capability = runtimeCapabilities?.thinkingLevel && modelKey && reasoningCapability?.key === modelKey
    ? reasoningCapability.value : undefined

  /** 模型切换后重新问主进程；旧请求晚返回时不得覆盖当前模型能力。 */
  React.useEffect(() => {
    if (!runtimeCapabilities?.thinkingLevel || !session?.channelId || !session.modelId || !modelKey || !hasModel) return
    let canceled = false
    setReasoningCapability(undefined)
    void window.axon.agent.getReasoningCapability(session.id)
      .then((value) => { if (!canceled) setReasoningCapability({ key: modelKey, value }) })
      .catch(() => { if (!canceled) setReasoningCapability({ key: modelKey }) })
    return () => { canceled = true }
  }, [runtimeCapabilities?.thinkingLevel, session?.channelId, session?.modelId, modelKey, hasModel])

  /** 输入区更新 Agent 会话模型；保存期间阻止发送，避免请求使用旧配置。 */
  const selectModel = React.useCallback(async (nextValue: string): Promise<void> => {
    if (!session) return
    const selection = decodeChatModelOption(nextValue)
    if (!selection) return
    setSavingModel(true)
    setModelError(undefined)
    try {
      await controller.updateSession(session.id, selection)
    } catch {
      setModelError('更新模型失败')
    } finally {
      setSavingModel(false)
    }
  }, [controller, session])

  /** 模式保存到会话元数据；运行期间禁用切换，保证本轮 prompt 与权限边界一致。 */
  const selectPermissionMode = React.useCallback(async (nextMode: AgentPermissionMode): Promise<void> => {
    if (!session) return
    setSavingPermissionMode(true)
    setPermissionModeError(undefined)
    try {
      await controller.updateSession(session.id, { permissionMode: nextMode })
    } catch {
      setPermissionModeError('更新模式失败')
    } finally {
      setSavingPermissionMode(false)
    }
  }, [controller, session])

  /** 思考等级按会话持久化；下一轮由 adapter 映射到 runtime 当前模型支持的等级。 */
  const selectThinkingLevel = React.useCallback(async (nextLevel: AgentThinkingLevel): Promise<void> => {
    if (!session) return
    setSavingThinkingLevel(true)
    setThinkingLevelError(undefined)
    try {
      await controller.updateSession(session.id, { thinkingLevel: nextLevel })
    } catch {
      setThinkingLevelError('更新思考等级失败')
    } finally {
      setSavingThinkingLevel(false)
    }
  }, [controller, session])

  const openChannelSettings = (): void => {
    setSettingsTab('channels')
    setSettingsOpen(true)
  }

  const send = React.useCallback(() => {
    const text = value.trim()
    if (!text || text.length > MAX_AGENT_INPUT_LENGTH || externalRunning || savingModel || savingPermissionMode || savingThinkingLevel || unavailable) return
    setValue('')
    void controller.send({ sessionId, text })
  }, [controller, externalRunning, savingModel, savingPermissionMode, savingThinkingLevel, sessionId, unavailable, value])

  const inputError = modelError ?? permissionModeError ?? thinkingLevelError ?? (value.length > MAX_AGENT_INPUT_LENGTH ? `输入超过 ${MAX_AGENT_INPUT_LENGTH.toLocaleString()} 字` : undefined)

  return <div className="shrink-0 px-4 pb-4 pt-2">
    <AgentMessageQueue sessionId={sessionId} messages={queuedMessages} />
    <div className={`mx-auto max-w-3xl rounded-xl border bg-[hsl(var(--input-surface))] p-2 shadow-sm ${permissionMode === 'plan' ? 'border-dashed border-primary/70' : ''}`}>
      <RichTextInput value={value} disabled={externalRunning || unavailable} onChange={setValue} onSubmit={send} />
      <div className="flex items-center justify-between gap-3 px-1 pt-1">
        <div className="flex min-w-0 items-center gap-1.5">
          <ContextUsageIndicator messages={messages} draft={value} />
          <span className="truncate text-[11px] text-destructive">{inputError}</span>
        </div>
        <div className="flex items-center gap-1.5">
          {capability ? <select
            aria-label="选择 Agent 思考等级"
            title="选择 Agent 思考等级"
            value={visibleThinkingLevel(thinkingLevel, capability.levels)}
            disabled={running || savingModel || savingPermissionMode || savingThinkingLevel}
            onChange={(event) => void selectThinkingLevel(event.target.value as AgentThinkingLevel)}
            className="h-8 rounded-md border bg-background px-2 text-xs text-foreground outline-none focus:ring-1 focus:ring-ring disabled:opacity-50"
          >
            {capability.levels.map((level) => <option key={level} value={level}>{level}</option>)}
          </select> : null}
          <select
            aria-label="选择 Agent 权限模式"
            title="选择 Agent 权限模式"
            value={permissionMode}
            disabled={running || savingModel || savingPermissionMode || savingThinkingLevel}
            onChange={(event) => void selectPermissionMode(event.target.value as AgentPermissionMode)}
            className="h-8 rounded-md border bg-background px-2 text-xs text-foreground outline-none focus:ring-1 focus:ring-ring disabled:opacity-50"
          >
            <option value="default">操作确认</option>
            <option value="acceptEdits">允许编辑</option>
            <option value="bypassPermissions">完全自动</option>
            <option value="plan">计划模式</option>
          </select>
          {modelOptions.length > 0 ? <select
            aria-label="选择 Agent 渠道和模型"
            value={hasModel ? currentModel : ''}
            disabled={running || savingModel || savingPermissionMode || savingThinkingLevel}
            onChange={(event) => void selectModel(event.target.value)}
            className="h-8 w-48 max-w-[55%] rounded-md border bg-background px-2 text-xs text-foreground outline-none focus:ring-1 focus:ring-ring disabled:opacity-50"
          >
            <option value="" disabled>选择渠道 / 模型</option>
            {modelOptions.map((option) => <option
              key={encodeChatModelOption(option.channelId, option.modelId)}
              value={encodeChatModelOption(option.channelId, option.modelId)}
            >
              {option.channelName} / {option.modelName}
            </option>)}
          </select> : <button type="button" onClick={openChannelSettings} className="flex h-8 items-center gap-1.5 rounded-md border px-2 text-xs text-muted-foreground hover:bg-muted hover:text-foreground">
            <Settings size={13} />{chatState.channelsStatus === 'loading' ? '加载渠道…' : '配置渠道'}
          </button>}
          {running ? externalRunning
            ? <span className="flex h-8 items-center gap-1.5 rounded-md border px-3 text-xs text-muted-foreground"><Loader2 size={12} className="animate-spin" />外部运行中</span>
            : <><button type="button" onClick={send} disabled={!value.trim() || savingModel || savingPermissionMode || savingThinkingLevel} className="flex h-8 items-center rounded-md bg-primary px-3 text-xs text-primary-foreground disabled:opacity-40">排队</button><button type="button" onClick={() => void controller.stop(sessionId)} className="flex h-8 items-center gap-1.5 rounded-md bg-destructive px-3 text-xs text-destructive-foreground"><Square size={12} fill="currentColor" />停止</button></>
            : <button type="button" onClick={send} disabled={!value.trim() || savingModel || savingPermissionMode || savingThinkingLevel || unavailable} className="flex h-8 items-center gap-1.5 rounded-md bg-primary px-3 text-xs text-primary-foreground disabled:opacity-40"><Loader2 size={12} className="hidden" />发送</button>}
        </div>
      </div>
    </div>
    {session && <p className="mx-auto mt-1 max-w-3xl px-1 text-[10px] text-muted-foreground">Runtime: {session.runtimeId === 'zima' ? 'Zima' : 'Pi'}</p>}
  </div>
}
