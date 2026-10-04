import * as React from 'react'
import { ArrowUp, ChevronDown, Loader2, Settings, Square } from 'lucide-react'
import { agentStateAtom } from '@/atoms/agent-state'
import { chatStateAtom } from '@/atoms/chat-state'
import { settingsOpenAtom, settingsTabAtom } from '@/atoms/settings-tab'
import { useAtomValue, useSetAtom } from 'jotai'
import { buildChatModelOptions, decodeChatModelOption, encodeChatModelOption } from '@/lib/chat-model-options'
import { useAgentController } from './AgentStateProvider'
import { RichTextInput } from '@/components/chat/RichTextInput'
import { ContextUsageIndicator } from './ContextUsageIndicator'
import { AgentMessageQueue } from './AgentMessageQueue'
import { AgentPermissionMenu } from './AgentPermissionMenu'
import type { AgentPermissionProfile } from './AgentPermissionMenu'
import { AGENT_RUNTIME_CAPABILITIES } from '@axon/shared'
import type { AgentReasoningCapability, AgentThinkingLevel } from '@axon/shared'

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
  const [savingThinkingLevel, setSavingThinkingLevel] = React.useState(false)
  const [modelError, setModelError] = React.useState<string | undefined>(undefined)
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
  const permissionProfile: AgentPermissionProfile = session?.approvalReviewer === 'autoReview'
    ? 'approveForMe' : 'askApproval'
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
    if (!text || text.length > MAX_AGENT_INPUT_LENGTH || externalRunning || savingModel || savingThinkingLevel || unavailable) return
    setValue('')
    void controller.send({ sessionId, text })
  }, [controller, externalRunning, savingModel, savingThinkingLevel, sessionId, unavailable, value])

  const inputError = modelError ?? thinkingLevelError ?? (value.length > MAX_AGENT_INPUT_LENGTH ? `输入超过 ${MAX_AGENT_INPUT_LENGTH.toLocaleString()} 字` : undefined)

  return <div className="shrink-0 px-5 pb-3 pt-2">
    <AgentMessageQueue sessionId={sessionId} messages={queuedMessages} />
    <div className="mx-auto max-w-3xl rounded-[12px] border border-border bg-[hsl(var(--input-surface))] px-3 py-2 shadow-sm focus-within:border-ring/50 focus-within:ring-1 focus-within:ring-ring/15">
      <div className="[&_.chat-rich-input]:min-h-12 [&_.chat-rich-input]:px-1 [&_.chat-rich-input]:text-[13px]">
        <RichTextInput value={value} disabled={externalRunning || unavailable} onChange={setValue} onSubmit={send} />
      </div>
      <div className="flex items-center justify-between gap-2 pt-2">
        <div className="flex min-w-0 max-w-[25%] shrink-0 items-center gap-1.5">
          <ContextUsageIndicator messages={messages} draft={value} appearance="workbench" />
          <span className="min-w-0 truncate text-[11px] text-destructive" title={inputError}>{inputError}</span>
        </div>
        <div className="flex min-w-0 flex-1 items-center justify-end gap-1">
          {capability ? <div className="relative shrink-0"><select
            aria-label="选择 Agent 思考等级"
            title="选择 Agent 思考等级"
            value={visibleThinkingLevel(thinkingLevel, capability.levels)}
            disabled={running || savingModel || savingThinkingLevel}
            onChange={(event) => void selectThinkingLevel(event.target.value as AgentThinkingLevel)}
            className="h-7 w-full appearance-none rounded bg-transparent pl-1.5 pr-5 font-mono text-[11px] text-muted-foreground outline-none hover:bg-muted/60 hover:text-foreground focus-visible:ring-1 focus-visible:ring-ring disabled:opacity-50"
          >
            {capability.levels.map((level) => <option key={level} value={level}>{level}</option>)}
          </select><ChevronDown size={10} strokeWidth={2.5} aria-hidden="true" className="pointer-events-none absolute right-1.5 top-1/2 -translate-y-1/2 text-muted-foreground" /></div> : null}
          <AgentPermissionMenu profile={permissionProfile} disabled={running || savingModel || savingThinkingLevel} supportsSandbox={session?.runtimeId !== 'zima'} />
          {modelOptions.length > 0 ? <div className="relative min-w-0 max-w-48 flex-1"><select
            aria-label="选择 Agent 渠道和模型"
            value={hasModel ? currentModel : ''}
            disabled={running || savingModel || savingThinkingLevel}
            onChange={(event) => void selectModel(event.target.value)}
            className="h-7 w-full min-w-0 appearance-none rounded bg-transparent pl-1.5 pr-5 text-xs text-muted-foreground outline-none hover:bg-muted/60 hover:text-foreground focus-visible:ring-1 focus-visible:ring-ring disabled:opacity-50"
          >
            <option value="" disabled>选择渠道 / 模型</option>
            {modelOptions.map((option) => <option
              key={encodeChatModelOption(option.channelId, option.modelId)}
              value={encodeChatModelOption(option.channelId, option.modelId)}
            >
              {option.channelName} / {option.modelName}
            </option>)}
          </select><ChevronDown size={10} strokeWidth={2.5} aria-hidden="true" className="pointer-events-none absolute right-1.5 top-1/2 -translate-y-1/2 text-muted-foreground" /></div> : <button type="button" onClick={openChannelSettings} className="flex h-7 min-w-0 items-center gap-1.5 whitespace-nowrap rounded px-2 text-xs text-muted-foreground hover:bg-muted/60 hover:text-foreground focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-ring">
            <Settings size={13} />{chatState.channelsStatus === 'loading' ? '加载渠道…' : '配置渠道'}
          </button>}
          {running ? externalRunning
            ? <span className="flex h-8 shrink-0 items-center gap-1.5 whitespace-nowrap rounded px-2 text-xs text-muted-foreground"><Loader2 size={12} className="animate-spin" />外部运行中</span>
            : <><button type="button" onClick={send} disabled={!value.trim() || savingModel || savingThinkingLevel} className="flex h-8 shrink-0 items-center whitespace-nowrap rounded-lg bg-primary px-3 text-xs font-medium text-primary-foreground shadow-xs hover:bg-primary/90 focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-ring focus-visible:ring-offset-1 disabled:opacity-40">排队</button><button type="button" onClick={() => void controller.stop(sessionId)} className="flex h-8 shrink-0 items-center gap-1.5 whitespace-nowrap rounded-lg bg-destructive px-3 text-xs font-medium text-destructive-foreground hover:bg-destructive/90 focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-ring focus-visible:ring-offset-1"><Square size={12} fill="currentColor" />停止</button></>
            : <button type="button" aria-label="发送消息" title="发送消息" onClick={send} disabled={!value.trim() || savingModel || savingThinkingLevel || unavailable} className="flex size-8 shrink-0 items-center justify-center rounded-full bg-primary text-primary-foreground shadow-xs hover:bg-primary/90 focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-ring focus-visible:ring-offset-1 disabled:opacity-40"><ArrowUp size={18} aria-hidden="true" /></button>}
        </div>
      </div>
    </div>
    {session && <p className="mx-auto mt-1.5 max-w-3xl px-1 font-mono text-[11px] text-muted-foreground">Runtime: {session.runtimeId === 'zima' ? 'Zima' : 'Pi'}</p>}
  </div>
}
