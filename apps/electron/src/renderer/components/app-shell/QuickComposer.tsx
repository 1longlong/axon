import * as React from 'react'
import { useAtomValue } from 'jotai'
import { MAX_CHAT_INPUT_LENGTH, AGENT_PASTED_TEXT_THRESHOLD } from '@axon/shared'
import { Paperclip, Loader2 } from 'lucide-react'
import { chatStateAtom } from '@/atoms/chat-state'
import { agentStateAtom } from '@/atoms/agent-state'
import { useChatController } from '@/components/chat/ChatStateProvider'
import { useAgentController } from '@/components/agent/AgentStateProvider'
import { buildChatModelOptions, decodeChatModelOption, encodeChatModelOption } from '@/lib/chat-model-options'
import { ContextUsageIndicator } from '@/components/agent/ContextUsageIndicator'
import { getAgentContextWindowUsage } from '@/lib/agent-session-usage'
import { AgentRunControl } from '@/components/agent/AgentRunControl'
import { useAgentAttachments } from '@/hooks/useAgentAttachments'
import { useAgentImageCapability } from '@/hooks/useAgentImageCapability'
import { AgentAttachmentTags } from '@/components/agent/AgentAttachmentTags'
import { AgentImageCapabilityNotice } from '@/components/agent/AgentImageCapabilityNotice'
import { AgentSkillPicker } from '@/components/agent/AgentSkillPicker'
import { AgentComposerEditor } from '@/components/agent/AgentComposerEditor'
import type { AgentComposerEditorHandle } from '@/components/agent/AgentComposerEditor'
import type { AgentComposerValue } from '@/lib/agent-composer-document'

function AxonMark(): React.ReactElement {
  return <svg width="32" height="32" viewBox="0 0 32 32" aria-hidden="true" className="shrink-0 rounded-full shadow-[0_0_14px_rgba(55,126,245,0.32)]">
    <defs><linearGradient id="quick-axon-gradient" x1="0" y1="0" x2="1" y2="1"><stop stopColor="#68B5FF" /><stop offset="1" stopColor="#2860D9" /></linearGradient></defs>
    <circle cx="16" cy="16" r="16" fill="url(#quick-axon-gradient)" />
    <path transform="scale(0.0625)" d="M256 82 90 430h74l25-78h134l25 78h74L256 82Zm0 112 48 112h-96l48-112Z" fill="white" />
  </svg>
}

function Chevron(): React.ReactElement {
  return <svg width="12" height="12" viewBox="0 0 12 12" fill="none" aria-hidden="true"><path d="m3 4.5 3 3 3-3" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" strokeLinejoin="round" /></svg>
}

function Stop(): React.ReactElement {
  return <svg width="17" height="17" viewBox="0 0 17 17" fill="none" aria-hidden="true"><rect x="4" y="4" width="9" height="9" rx="1.5" stroke="currentColor" strokeWidth="1.8" /></svg>
}

/** 快捷输入是独立单行 UI；Agent 暂停/继续与主窗口共用控制器，不改变 Chat 停止语义。 */
export function QuickComposer({ sessionType, sessionId, expanded, onSent }: {
  sessionType: 'chat' | 'agent'
  sessionId: string
  expanded: boolean
  onSent: () => void
}): React.ReactElement {
  const [value, setValue] = React.useState('')
  const [agentDraft, setAgentDraft] = React.useState<AgentComposerValue>({ text: '', skills: [], parts: [] })
  const [editorEpoch, resetEditor] = React.useReducer((value: number) => value + 1, 0)
  const [skillPickerOpen, setSkillPickerOpen] = React.useState(false)
  const agentEditorRef = React.useRef<AgentComposerEditorHandle>(null)
  const composerRef = React.useRef<HTMLDivElement>(null)
  const clearAgentInput = (): void => { setValue(''); setAgentDraft({ text: '', skills: [], parts: [] }); resetEditor() }
  const [savingModel, setSavingModel] = React.useState(false)
  const [modelError, setModelError] = React.useState(false)
  const chat = useAtomValue(chatStateAtom)
  const agent = useAtomValue(agentStateAtom)
  const chatController = useChatController()
  const agentController = useAgentController()
  const conversation = chat.conversations.find((item) => item.id === sessionId)
  const session = agent.sessions.find((item) => item.id === sessionId)
  const supportsAttachments = sessionType === 'agent' && session?.runtimeId === 'pi'
  const attachments = useAgentAttachments(sessionId, supportsAttachments)
  const fileAttachments = attachments.draft?.attachments.filter((item) => item.kind !== 'skill') ?? []
  const hasAttachments = fileAttachments.length > 0 || agentDraft.skills.length > 0
  const hasImages = attachments.draft?.attachments.some((attachment) => attachment.kind === 'image') === true
  const imageCapability = useAgentImageCapability(sessionId, session?.channelId, session?.modelId, hasImages)
  const inputRef = React.useRef<HTMLTextAreaElement>(null)
  const chatSending = chat.sendingByConversation[sessionId] === true
  const agentRunning = agent.activeRunsBySession[sessionId] !== undefined
  const pausing = sessionType === 'agent' && (agent.pausesBySession[sessionId]?.state === 'pausing' || Boolean(agent.pauseOperationsBySession[sessionId]))
  const externalRunning = agent.activeRunSourcesBySession[sessionId] === 'external'
  const observedOnly = sessionType === 'agent' && agentRunning && !agent.ownedRunsBySession[sessionId]
  const options = React.useMemo(() => buildChatModelOptions(sessionType === 'agent' && session?.runtimeId === 'zima'
    ? chat.channels.filter((channel) => channel.hasApiKey && ['openai', 'custom', 'anthropic', 'anthropic-compatible', 'google'].includes(channel.provider))
    : chat.channels), [chat.channels, session?.runtimeId, sessionType])
  const selected = sessionType === 'chat' ? conversation : session
  const currentModel = selected?.channelId && selected.modelId ? encodeChatModelOption(selected.channelId, selected.modelId) : ''
  const hasModel = options.some((item) => encodeChatModelOption(item.channelId, item.modelId) === currentModel)
  const missingSetup = sessionType === 'chat' ? !hasModel : !session?.projectId || !hasModel
  const maxLength = sessionType === 'chat' ? MAX_CHAT_INPUT_LENGTH : 100_000
  const disabled = observedOnly || pausing || missingSetup || externalRunning || savingModel || attachments.busy || (sessionType === 'chat' && chatSending)
  const canSend = (value.trim().length > 0 || hasAttachments) && value.length <= maxLength && !disabled && imageCapability.canSend
  React.useLayoutEffect(() => {
    const input = inputRef.current
    if (!input) return
    input.style.height = 'auto'
    input.style.height = `${Math.min(input.scrollHeight, 96)}px`
  }, [value])

  /** 模型切换写回绑定会话；保存期间不允许发送，避免旧模型与新标签错位。 */
  const selectModel = async (encoded: string): Promise<void> => {
    const next = decodeChatModelOption(encoded)
    if (!next) return
    setSavingModel(true)
    setModelError(false)
    try {
      if (sessionType === 'chat') await chatController.updateConversation(sessionId, next)
      else await agentController.updateSession(sessionId, next)
    } catch {
      setModelError(true)
    } finally {
      setSavingModel(false)
    }
  }

  /** 有效输入交给原会话控制器，并立即展开浮窗以显示用户消息和后续回复。 */
  const send = (): void => {
    if (sessionType === 'agent' && agentEditorRef.current?.handleLocalCommand()) return
    if (!canSend) return
    const text = sessionType === 'agent' ? value : value.trim()
    if (sessionType === 'chat') {
      setValue('')
      void chatController.send({ conversationId: sessionId, text })
    } else if (hasAttachments || attachments.draft) {
      void attachments.submitWithSkills(agentDraft, (input) => agentController.send(input), clearAgentInput, imageCapability.consent)
    } else {
      clearAgentInput()
      void agentController.send({ sessionId, text })
    }
    onSent()
  }

  const stop = (): void => {
    void chatController.stop(sessionId)
  }

  const status = modelError ? '模型切换失败' : missingSetup ? '请先配置会话' : externalRunning ? '外部任务运行中' : value.length > maxLength ? '输入过长' : ''
  const agentMessages = agent.messagesBySession[sessionId] ?? []
  const contextUsage = sessionType === 'agent' ? getAgentContextWindowUsage(agentMessages, value) : undefined
  const contextTitle = contextUsage?.limitTokens
    ? `上下文窗口 ${(contextUsage.limitTokens / 1_000).toFixed(0)}K，已用 ${(contextUsage.usedTokens / 1_000).toFixed(1)}K，占比 ${Math.round((contextUsage.ratio ?? 0) * 100)}%`
    : '上下文窗口用量将在首次模型调用后显示'

  return <div ref={composerRef} data-agent-composer-surface className="min-w-0 text-[#333333]"
    onDragOver={(event) => { if (supportsAttachments && event.dataTransfer.types.includes('Files')) event.preventDefault() }}
    onDropCapture={(event) => {
      if (!supportsAttachments || event.target instanceof Element && event.target.closest('[data-agent-context-dialog]')) return
      const files = Array.from(event.dataTransfer.files)
      if (!files.length) return
      event.preventDefault(); event.stopPropagation()
      if (!disabled) void attachments.addFiles(files)
    }}
    onPasteCapture={(event) => {
      if (!supportsAttachments || !(event.target instanceof Element) || !event.target.closest('[data-quick-composer]')) return
      const files = Array.from(event.clipboardData.files), text = event.clipboardData.getData('text/plain')
      if (!files.length && text.length <= AGENT_PASTED_TEXT_THRESHOLD) return
      event.preventDefault(); event.stopPropagation()
      if (disabled) return
      if (files.length) void attachments.addFiles(files)
      else void attachments.addPastedText(text)
    }}>
    {(fileAttachments.length > 0 || hasImages || attachments.error) && <div className="max-h-40 overflow-y-auto px-5 pt-3">
      {fileAttachments.length > 0 && <AgentAttachmentTags attachments={fileAttachments} imageSource={{ kind: 'draft', draftId: attachments.draft!.id }}
        disabled={attachments.busy} onRemove={(id) => void attachments.remove(id)} onPreviewOpen={onSent}
        canRestoreText={attachments.canRestorePastedText} onRestoreText={(id) => void attachments.restorePastedText(id, (text) => agentEditorRef.current?.appendText(text))} />}
      {hasImages && <div className="pt-2"><AgentImageCapabilityNotice state={imageCapability} disabled={disabled} /></div>}
      {attachments.error && <p role="alert" className="mt-1 text-xs text-destructive">{attachments.error}</p>}
    </div>}
    <div className="flex min-h-[70px] min-w-0 items-center gap-3 px-5 py-3">
    {!expanded && <AxonMark />}
    {sessionType === 'agent' ? <AgentComposerEditor key={`${sessionId}:${editorEpoch}`} sessionId={sessionId} ref={agentEditorRef} commandMenuAnchor={composerRef} compact disabled={disabled}
      onCommand={supportsAttachments && !disabled ? () => { setSkillPickerOpen(true); onSent() } : undefined} onCommandMenuOpen={onSent}
      onChange={(next) => { setAgentDraft(next); setValue(next.text) }} onSubmit={send} onEscape={() => void window.axon.desktop.hideQuickChat()} /> : <textarea
        ref={inputRef}
        autoFocus
        rows={1}
        data-quick-composer
        aria-label="快捷输入消息"
        placeholder="请输入"
        value={value}
        disabled={disabled}
        onChange={(event) => setValue(event.target.value)}
        onKeyDown={(event) => {
          if (event.key === 'Escape') { event.preventDefault(); void window.axon.desktop.hideQuickChat(); return }
          if (event.key === 'Enter' && !event.shiftKey && !event.nativeEvent.isComposing) { event.preventDefault(); send() }
        }}
        className="min-h-6 max-h-24 min-w-0 flex-1 resize-none overflow-y-auto border-0 bg-transparent p-0 text-base leading-6 text-[#252B35] outline-none placeholder:text-[#999999] focus:ring-0 disabled:opacity-60"
      />}
    {supportsAttachments && <div className="flex shrink-0 items-center gap-1">
      <button type="button" aria-label="添加快捷会话附件" title="添加文件或文件夹" disabled={disabled} onClick={() => void attachments.pick()} className="rounded p-1 text-muted-foreground hover:bg-muted disabled:opacity-40"><Paperclip size={14} /></button>
      <AgentSkillPicker sessionId={sessionId} disabled={disabled} open={skillPickerOpen} onOpenChange={setSkillPickerOpen} onOpen={onSent}
        onSkill={async (skill) => { if (!agentEditorRef.current) throw new Error('输入区尚未就绪'); agentEditorRef.current.insertSkill(skill) }}
        onClose={() => agentEditorRef.current?.focus()} />
      {attachments.busy && <Loader2 size={12} className="animate-spin" aria-label="正在准备附件" />}
    </div>}
    {status && <span className="max-w-28 shrink-0 truncate text-[11px] text-[#A15A4E]" title={status}>{status}</span>}
    {sessionType === 'agent' && <span title={contextTitle}><ContextUsageIndicator messages={agentMessages} draft={value} /></span>}
    {sessionType === 'chat' && chatSending && <button type="button" aria-label="停止生成" title="停止生成" onClick={stop} className="flex h-8 w-8 shrink-0 items-center justify-center rounded-full text-[#555555] transition-colors hover:bg-[#F3F5F7]"><Stop /></button>}
    {sessionType === 'agent' && !externalRunning && <AgentRunControl sessionId={sessionId} compact disabled={disabled} onContinue={onSent}
      onSend={value.trim() || hasAttachments ? send : undefined} hasDraft={Boolean(value.trim() || hasAttachments)} sendDisabled={!canSend} />}
    <label className="relative flex max-w-44 shrink-0 items-center rounded-full px-2 py-1 text-[#666666] transition-colors hover:bg-[#F3F5F7]" title="选择模型">
        <select
          aria-label="选择快捷会话模型"
          value={hasModel ? currentModel : ''}
          disabled={attachments.busy || pausing || chatSending || agentRunning || savingModel || options.length === 0}
          onChange={(event) => void selectModel(event.target.value)}
          className="max-w-36 cursor-pointer appearance-none truncate border-0 bg-transparent pr-4 text-xs outline-none disabled:cursor-not-allowed disabled:opacity-50"
        >
          <option value="" disabled>选择模型</option>
          {options.map((item) => <option key={encodeChatModelOption(item.channelId, item.modelId)} value={encodeChatModelOption(item.channelId, item.modelId)}>{item.channelName} / {item.modelName}</option>)}
        </select>
        <span className="pointer-events-none absolute right-1"><Chevron /></span>
    </label>
  </div>
  </div>
}
