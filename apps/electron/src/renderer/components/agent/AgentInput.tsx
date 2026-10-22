import * as React from 'react'
import { useAgentImageCapability } from '@/hooks/useAgentImageCapability'
import { AgentImageCapabilityNotice } from './AgentImageCapabilityNotice'
import { AgentSkillPicker } from './AgentSkillPicker'
import { AGENT_PASTED_TEXT_THRESHOLD } from '@axon/shared'
import { ChevronDown, Loader2, Paperclip, Settings } from 'lucide-react'
import { agentStateAtom } from '@/atoms/agent-state'
import { chatStateAtom } from '@/atoms/chat-state'
import { settingsOpenAtom, settingsTabAtom } from '@/atoms/settings-tab'
import { useAtomValue, useSetAtom } from 'jotai'
import { buildChatModelOptions, decodeChatModelOption, encodeChatModelOption } from '@/lib/chat-model-options'
import { useAgentController } from './AgentStateProvider'
import { AgentComposerEditor } from './AgentComposerEditor'
import type { AgentComposerEditorHandle } from './AgentComposerEditor'
import type { AgentComposerValue } from '@/lib/agent-composer-document'
import { ContextUsageIndicator } from './ContextUsageIndicator'
import { AgentMessageQueue } from './AgentMessageQueue'
import { AgentPermissionMenu } from './AgentPermissionMenu'
import { AgentRunControl } from './AgentRunControl'
import { AgentAttachmentTags } from './AgentAttachmentTags'
import { useAgentAttachments } from '@/hooks/useAgentAttachments'
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

/** Agent 输入负责草稿/Enter 排队；单个圆形按钮按状态切换发送、暂停和继续。 */
export function AgentInput({ sessionId }: { sessionId: string }): React.ReactElement {
  const controller = useAgentController()
  const state = useAtomValue(agentStateAtom)
  const chatState = useAtomValue(chatStateAtom)
  const setSettingsOpen = useSetAtom(settingsOpenAtom)
  const setSettingsTab = useSetAtom(settingsTabAtom)
  const [draft, setDraft] = React.useState<AgentComposerValue>({ text: '', skills: [], parts: [] })
  const [editorEpoch, resetEditor] = React.useReducer((value: number) => value + 1, 0)
  const [focusOnReset, setFocusOnReset] = React.useState(false)
  const [skillPickerOpen, setSkillPickerOpen] = React.useState(false)
  const editorRef = React.useRef<AgentComposerEditorHandle>(null)
  const composerRef = React.useRef<HTMLDivElement>(null)
  const value = draft.text
  const clearInput = React.useCallback(() => {
    setFocusOnReset(editorRef.current?.isFocused() === true)
    setDraft({ text: '', skills: [], parts: [] })
    // 接纳后重新创建编辑历史，Cmd+Z 不应恢复上一条已发送内容。
    resetEditor()
  }, [])
  const [savingModel, setSavingModel] = React.useState(false)
  const [savingThinkingLevel, setSavingThinkingLevel] = React.useState(false)
  const [modelError, setModelError] = React.useState<string | undefined>(undefined)
  const [thinkingLevelError, setThinkingLevelError] = React.useState<string | undefined>(undefined)
  const [reasoningCapability, setReasoningCapability] = React.useState<{
    key: string
    value?: AgentReasoningCapability
  } | undefined>(undefined)
  const running = state.activeRunsBySession[sessionId] !== undefined
  const pausing = state.pausesBySession[sessionId]?.state === 'pausing' || state.pauseOperationsBySession[sessionId] === 'pausing'
  const submittingContinue = state.pauseOperationsBySession[sessionId] === 'continuing'
  const runSource = state.activeRunSourcesBySession[sessionId]
  const observedOnly = running && !state.ownedRunsBySession[sessionId]
  const externalRunning = runSource === 'external'
  const queuedMessages = state.queuedMessagesBySession[sessionId] ?? []
  const session = state.sessions.find((item) => item.id === sessionId)
  const attachments = useAgentAttachments(sessionId, session?.runtimeId === 'pi')
  const fileAttachments = attachments.draft?.attachments.filter((item) => item.kind !== 'skill') ?? []
  const hasAttachments = fileAttachments.length > 0 || draft.skills.length > 0
  const hasImages = attachments.draft?.attachments.some((attachment) => attachment.kind === 'image') === true
  const imageCapability = useAgentImageCapability(sessionId, session?.channelId, session?.modelId, hasImages)
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
    if (editorRef.current?.handleLocalCommand()) return
    const text = value
    if ((!text.trim() && !hasAttachments) || !imageCapability.canSend || text.length > MAX_AGENT_INPUT_LENGTH || attachments.busy || observedOnly || pausing || submittingContinue || externalRunning || savingModel || savingThinkingLevel || unavailable) return
    if (hasAttachments || attachments.draft) {
      void attachments.submitWithSkills(draft, (input) => controller.send(input), clearInput, imageCapability.consent)
      return
    }
    clearInput()
    void controller.send({ sessionId, text })
  }, [controller, observedOnly, pausing, submittingContinue, externalRunning, savingModel, savingThinkingLevel, sessionId, unavailable, value, draft, clearInput, attachments, hasAttachments, imageCapability])

  const inputError = attachments.error ?? modelError ?? thinkingLevelError ?? (value.length > MAX_AGENT_INPUT_LENGTH ? `输入超过 ${MAX_AGENT_INPUT_LENGTH.toLocaleString()} 字` : undefined)
  const attachmentDisabled = attachments.busy || observedOnly || pausing || submittingContinue || externalRunning || unavailable

  return <div className="shrink-0 px-5 pb-3 pt-2">
    <AgentMessageQueue sessionId={sessionId} messages={queuedMessages} />
    <div ref={composerRef} data-agent-composer-surface className="mx-auto max-w-3xl rounded-[12px] border border-border bg-[hsl(var(--input-surface))] px-3 py-2 shadow-sm focus-within:border-ring/50 focus-within:ring-1 focus-within:ring-ring/15"
      onDragOver={(event) => { if (event.dataTransfer.types.includes('Files')) event.preventDefault() }}
      onDropCapture={(event) => {
        if (event.target instanceof Element && event.target.closest('[data-agent-context-dialog]')) return
        const files = Array.from(event.dataTransfer.files)
        if (!files.length) return
        event.preventDefault(); event.stopPropagation()
        if (session?.runtimeId === 'pi' && !attachmentDisabled) void attachments.addFiles(files)
      }}
      onPasteCapture={(event) => {
        if (!(event.target instanceof Element) || !event.target.closest('.chat-rich-input')) return
        const files = Array.from(event.clipboardData.files)
        if (session?.runtimeId !== 'pi') return
        if (files.length) {
          event.preventDefault(); event.stopPropagation()
          if (!attachmentDisabled) void attachments.addFiles(files)
          return
        }
        const text = event.clipboardData.getData('text/plain')
        if (text.length > AGENT_PASTED_TEXT_THRESHOLD) {
          event.preventDefault(); event.stopPropagation()
          if (!attachmentDisabled) void attachments.addPastedText(text)
        }
      }}>
      {fileAttachments.length > 0 && <div className="pb-1.5"><AgentAttachmentTags attachments={fileAttachments}
        imageSource={{ kind: 'draft', draftId: attachments.draft!.id }} disabled={attachments.busy} onRemove={(id) => void attachments.remove(id)}
        canRestoreText={attachments.canRestorePastedText} onRestoreText={(id) => void attachments.restorePastedText(id, (text) => editorRef.current?.appendText(text))} /></div>}
      {hasImages && <AgentImageCapabilityNotice state={imageCapability} disabled={attachmentDisabled} />}
      <div className="[&_.chat-rich-input]:min-h-12 [&_.chat-rich-input]:px-1 [&_.chat-rich-input]:text-[13px]">
        <AgentComposerEditor key={`${sessionId}:${editorEpoch}`} sessionId={sessionId} ref={editorRef} commandMenuAnchor={composerRef} autoFocus={focusOnReset} disabled={attachments.busy || pausing || submittingContinue || externalRunning || unavailable}
          onCommand={session?.runtimeId === 'pi' && !attachmentDisabled ? () => setSkillPickerOpen(true) : undefined} onChange={setDraft} onSubmit={send} />
      </div>
      <div className="flex items-center justify-between gap-2 pt-2">
        <div className="flex min-w-0 max-w-[40%] shrink-0 items-center gap-1.5">
          {session?.runtimeId === 'pi' && <>
            <AgentSkillPicker sessionId={sessionId} disabled={attachmentDisabled} open={skillPickerOpen} onOpenChange={setSkillPickerOpen}
              onSkill={async (skill) => { if (!editorRef.current) throw new Error('输入区尚未就绪'); editorRef.current.insertSkill(skill) }}
              onClose={() => editorRef.current?.focus()} />
            <button type="button" aria-label="添加附件" title="添加文件或文件夹" disabled={attachmentDisabled}
              onClick={() => void attachments.pick()} className="rounded p-1 text-muted-foreground hover:bg-muted/60 hover:text-foreground disabled:opacity-40"><Paperclip size={14} /></button>
          </>}
          {attachments.busy && <Loader2 size={12} className="shrink-0 animate-spin" aria-label="正在准备附件" />}
          <ContextUsageIndicator messages={messages} draft={value} appearance="workbench" />
          <span className="min-w-0 truncate text-[11px] text-destructive" title={inputError}>{inputError}</span>
        </div>
        <div className="flex min-w-0 flex-1 items-center justify-end gap-1">
          {capability ? <div className="relative shrink-0"><select
            aria-label="选择 Agent 思考等级"
            title="选择 Agent 思考等级"
            value={visibleThinkingLevel(thinkingLevel, capability.levels)}
            disabled={attachments.busy || pausing || submittingContinue || running || savingModel || savingThinkingLevel}
            onChange={(event) => void selectThinkingLevel(event.target.value as AgentThinkingLevel)}
            className="h-7 w-full appearance-none rounded bg-transparent pl-1.5 pr-5 font-mono text-[11px] text-muted-foreground outline-none hover:bg-muted/60 hover:text-foreground focus-visible:ring-1 focus-visible:ring-ring disabled:opacity-50"
          >
            {capability.levels.map((level) => <option key={level} value={level}>{level}</option>)}
          </select><ChevronDown size={10} strokeWidth={2.5} aria-hidden="true" className="pointer-events-none absolute right-1.5 top-1/2 -translate-y-1/2 text-muted-foreground" /></div> : null}
          <AgentPermissionMenu profile={permissionProfile} disabled={attachments.busy || pausing || submittingContinue || running || savingModel || savingThinkingLevel} supportsSandbox={session?.runtimeId !== 'zima'} />
          {modelOptions.length > 0 ? <div className="relative min-w-0 max-w-48 flex-1"><select
            aria-label="选择 Agent 渠道和模型"
            value={hasModel ? currentModel : ''}
            disabled={attachments.busy || pausing || submittingContinue || running || savingModel || savingThinkingLevel}
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
          {running && externalRunning
            ? <span className="flex h-8 shrink-0 items-center gap-1.5 whitespace-nowrap rounded px-2 text-xs text-muted-foreground"><Loader2 size={12} className="animate-spin" />外部运行中</span>
            : <AgentRunControl sessionId={sessionId} disabled={savingModel || savingThinkingLevel || unavailable}
              onSend={send} hasDraft={Boolean(value.trim()) || hasAttachments}
              sendDisabled={attachments.busy || !imageCapability.canSend || pausing || submittingContinue || (!value.trim() && !hasAttachments) || value.length > MAX_AGENT_INPUT_LENGTH || savingModel || savingThinkingLevel || unavailable} />}
        </div>
      </div>
    </div>
    {session && <p className="mx-auto mt-1.5 max-w-3xl px-1 font-mono text-[11px] text-muted-foreground">Runtime: {session.runtimeId === 'zima' ? 'Zima' : 'Pi'}</p>}
  </div>
}
