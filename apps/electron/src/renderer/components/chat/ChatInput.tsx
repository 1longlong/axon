import * as React from 'react'
import { useAtom, useAtomValue, useSetAtom } from 'jotai'
import { CornerDownLeft, Loader2, Paperclip, Settings, Square } from 'lucide-react'
import { MAX_CHAT_INPUT_LENGTH } from '@axon/shared'
import type { ConversationMeta, FileAttachment } from '@axon/shared'
import { chatDraftsAtom, chatStateAtom } from '@/atoms/chat-state'
import { contextUsageLabel, estimateContextTokens } from '@/lib/chat-context'
import { appendPendingAttachments, type PendingAttachment } from '@/lib/chat-attachment'
import { getChatInputAvailability } from '@/lib/chat-input'
import { settingsOpenAtom, settingsTabAtom } from '@/atoms/settings-tab'
import { buildChatModelOptions, decodeChatModelOption, encodeChatModelOption } from '@/lib/chat-model-options'
import { useChatController } from './ChatStateProvider'
import { AttachmentPreviewItem } from './AttachmentPreviewItem'
import { RichTextInput } from './RichTextInput'

/** 输入区将会话草稿转换为 send/stop 动作，流结果由全局事件订阅写回状态。 */
export function ChatInput({ conversation }: { conversation: ConversationMeta }): React.ReactElement {
  const controller = useChatController()
  const [drafts, setDrafts] = useAtom(chatDraftsAtom)
  const state = useAtomValue(chatStateAtom)
  const setSettingsOpen = useSetAtom(settingsOpenAtom)
  const setSettingsTab = useSetAtom(settingsTabAtom)
  const contextTokens = estimateContextTokens(state.messagesByConversation[conversation.id] ?? [])
  const contextLabel = contextUsageLabel(contextTokens)
  const value = drafts[conversation.id] ?? ''
  const sending = state.sendingByConversation[conversation.id] === true
  const modelOptions = React.useMemo(() => buildChatModelOptions(state.channels), [state.channels])
  const currentModel = conversation.channelId && conversation.modelId
    ? encodeChatModelOption(conversation.channelId, conversation.modelId)
    : ''
  const hasModel = modelOptions.some((option) => (
    encodeChatModelOption(option.channelId, option.modelId) === currentModel
  ))
  const [savingModel, setSavingModel] = React.useState(false)
  const [modelError, setModelError] = React.useState<string | undefined>(undefined)
  const availability = getChatInputAvailability(value, {
    hasModel,
    sending: sending || savingModel,
  })

  // 待发送附件是 renderer 内存草稿：发送时才统一落盘，取消发送不产生磁盘文件。
  const [pending, setPending] = React.useState<PendingAttachment[]>([])
  const [attachmentError, setAttachmentError] = React.useState<string | undefined>(undefined)
  const fileInputRef = React.useRef<HTMLInputElement>(null)

  const setValue = React.useCallback((next: string) => {
    setDrafts((current) => {
      if (!next) {
        const copy = { ...current }
        delete copy[conversation.id]
        return copy
      }
      return { ...current, [conversation.id]: next }
    })
  }, [conversation.id, setDrafts])

  const addFiles = React.useCallback((files: FileList | File[]) => {
    setAttachmentError(undefined)
    const sources = [...files].map((file) => ({
      name: file.name,
      mediaType: file.type,
      size: file.size,
      bytes: file.arrayBuffer(),
    }))
    // arrayBuffer 是 Promise：批量读取后一次性进入校验，避免半批状态。
    void Promise.all(sources.map(async (source) => ({ ...source, bytes: await source.bytes })))
      .then((resolved) => {
        const batch = appendPendingAttachments(resolved, pendingRef.current)
        if (batch.error) setAttachmentError(batch.error)
        if (batch.attachments.length > 0) setPending((current) => [...current, ...batch.attachments])
      })
      .catch(() => setAttachmentError('读取附件失败'))
  }, [])

  // addFiles 在异步回调里需要最新列表，用 ref 镜像 pending 避免闭包读到旧值。
  const pendingRef = React.useRef<PendingAttachment[]>([])
  pendingRef.current = pending

  const removePending = React.useCallback((id: string) => {
    setPending((current) => current.filter((item) => item.id !== id))
    setAttachmentError(undefined)
  }, [])

  /** 输入区直接更新会话模型；成功后新的会话元数据会驱动后续发送。 */
  const selectModel = React.useCallback(async (nextValue: string): Promise<void> => {
    const selection = decodeChatModelOption(nextValue)
    if (!selection) return
    setSavingModel(true)
    setModelError(undefined)
    try {
      await controller.updateConversation(conversation.id, selection)
    } catch {
      setModelError('更新模型失败')
    } finally {
      setSavingModel(false)
    }
  }, [controller, conversation.id])

  const openChannelSettings = (): void => {
    setSettingsTab('channels')
    setSettingsOpen(true)
  }

  /**
   * 两阶段发送：先把附件逐个落盘换取安全元数据，再随消息一起提交。
   * 任一附件保存失败则中止发送并保留草稿；全部成功后清空草稿与待发送列表，
   * 即使后续 send 失败也不回滚（磁盘上可能留下无引用文件，与无孤儿扫描的约定一致）。
   */
  const send = React.useCallback((valueOverride?: string) => {
    const current = getChatInputAvailability(valueOverride ?? value, { hasModel, sending })
    if (!current.canSend) return
    void (async () => {
      const attachments: FileAttachment[] = []
      for (const item of pendingRef.current) {
        const result = await window.axon.attachments.save({
          conversationId: conversation.id,
          filename: item.filename,
          mediaType: item.mediaType,
          data: item.data,
        })
        if (!result.success) {
          setAttachmentError(result.message)
          return
        }
        attachments.push(result.attachment)
      }
      setValue('')
      setPending([])
      setAttachmentError(undefined)
      void controller.send({
        conversationId: conversation.id,
        text: current.text,
        ...(attachments.length > 0 ? { attachments } : {}),
      })
    })()
  }, [controller, conversation.id, hasModel, sending, setValue, value])

  const hint = availability.reason === 'model_required'
    ? '请先选择渠道和模型'
    : availability.reason === 'too_long'
      ? `输入不能超过 ${MAX_CHAT_INPUT_LENGTH.toLocaleString()} 个字符`
      : pending.length > 0 && !value.trim()
        ? '发送附件前请输入配套文字'
        : undefined
  const statusText = modelError ?? contextLabel ?? hint

  return (
    <div className="shrink-0 px-4 pb-4 pt-2">
      <div
        className="mx-auto max-w-3xl rounded-xl border bg-[hsl(var(--input-surface))] p-2 shadow-sm"
        onPaste={(event) => {
          // 粘贴的文件（主要是截图）与选择文件走同一条待发送草稿链路。
          if (event.clipboardData.files.length > 0) {
            event.preventDefault()
            addFiles(event.clipboardData.files)
          }
        }}
      >
        {pending.length > 0 && (
          <div className="flex flex-wrap gap-2 px-1 pb-2">
            {pending.map((item) => (
              <AttachmentPreviewItem key={item.id} attachment={item} onRemove={removePending} />
            ))}
          </div>
        )}
        <RichTextInput
          // 生成状态切换时以 atom 草稿重建编辑器，避免 TipTap 内部文档保留已发送内容。
          key={`${conversation.id}:${sending ? 'sending' : 'idle'}`}
          value={value}
          disabled={sending}
          onChange={setValue}
          onSubmit={send}
        />
        {attachmentError && (
          <p className="px-1 pt-1 text-[11px] text-destructive">{attachmentError}</p>
        )}
        <div className="flex items-center justify-between gap-3 px-1 pt-1">
          <span className={cnHint(contextLabel, Boolean(attachmentError || modelError))}>{statusText}</span>
          <div className="flex items-center gap-1.5">
            <input
              ref={fileInputRef}
              type="file"
              multiple
              className="hidden"
              onChange={(event) => {
                if (event.target.files) addFiles(event.target.files)
                event.target.value = ''
              }}
            />
            <button
              type="button"
              aria-label="添加附件"
              disabled={sending}
              onClick={() => fileInputRef.current?.click()}
              className="flex h-8 w-8 items-center justify-center rounded-md text-muted-foreground hover:bg-muted hover:text-foreground disabled:cursor-not-allowed disabled:opacity-40"
            >
              <Paperclip size={14} />
            </button>
            {modelOptions.length > 0 ? <select
              aria-label="选择渠道和模型"
              value={hasModel ? currentModel : ''}
              disabled={sending || savingModel}
              onChange={(event) => void selectModel(event.target.value)}
              className="h-8 w-48 max-w-[45%] rounded-md border bg-background px-2 text-xs text-foreground outline-none focus:ring-1 focus:ring-ring disabled:opacity-50"
            >
              <option value="" disabled>选择渠道 / 模型</option>
              {modelOptions.map((option) => <option
                key={encodeChatModelOption(option.channelId, option.modelId)}
                value={encodeChatModelOption(option.channelId, option.modelId)}
              >
                {option.channelName} / {option.modelName}
              </option>)}
            </select> : <button
              type="button"
              onClick={openChannelSettings}
              className="flex h-8 items-center gap-1.5 rounded-md border px-2 text-xs text-muted-foreground hover:bg-muted hover:text-foreground"
            >
              <Settings size={13} />{state.channelsStatus === 'loading' ? '加载渠道…' : '配置渠道'}
            </button>}
            {sending ? (
              <button
                type="button"
                aria-label="停止生成"
                onClick={() => void controller.stop(conversation.id)}
                className="flex h-8 shrink-0 items-center gap-1.5 rounded-md bg-destructive px-3 text-xs text-destructive-foreground hover:opacity-90"
              >
                <Square size={12} fill="currentColor" />
                停止
              </button>
            ) : (
              <button
                type="button"
                aria-label="发送消息"
                disabled={!availability.canSend}
                onClick={() => send()}
                className="flex h-8 shrink-0 items-center gap-1.5 rounded-md bg-primary px-3 text-xs text-primary-foreground disabled:cursor-not-allowed disabled:opacity-40"
              >
                {state.generationsByConversation[conversation.id] ? <Loader2 size={13} className="animate-spin" /> : <CornerDownLeft size={13} />}
                发送
              </button>
            )}
          </div>
        </div>
      </div>
    </div>
  )
}

function cnHint(contextLabel: string | null | undefined, hasError: boolean): string {
  if (hasError) return 'truncate text-[11px] text-destructive'
  return contextLabel ? 'truncate text-[11px] text-amber-600' : 'truncate text-[11px] text-muted-foreground'
}
