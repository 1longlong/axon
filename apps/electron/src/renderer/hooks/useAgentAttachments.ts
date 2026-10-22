/** 主窗和快捷入口共用附件草稿；实际文件与接管状态始终以后端为准。 */
import * as React from 'react'
import { MAX_AGENT_ATTACHMENT_CHUNK_BYTES, MAX_AGENT_ATTACHMENT_BYTES } from '@axon/shared'
import type { AgentAttachmentDraft, AgentAttachmentUpload, AgentInputPart, AgentSendInput, AgentSendResult, SDKUserMessage } from '@axon/shared'
import type { AgentComposerValue } from '@/lib/agent-composer-document'
import { arrayBufferToBase64 } from '@/lib/chat-attachment'

interface DraftScope {
  active: boolean
  generation: number
  draft?: AgentAttachmentDraft
  creating?: Promise<AgentAttachmentDraft>
  queue: Promise<void>
  pending: number
  submitting: boolean
  uncertain: boolean
  error?: string
  listeners: Set<() => void>
  pastedTexts: Map<string, string>
}
interface DraftView { scope: DraftScope; draft?: AgentAttachmentDraft; busy: boolean; error?: string }

function asDraft(value: unknown): AgentAttachmentDraft {
  if (!value || typeof value !== 'object' || !('attachments' in value) || !Array.isArray(value.attachments)) {
    throw new Error('附件草稿响应无效')
  }
  return value as AgentAttachmentDraft
}
function asUpload(value: unknown): AgentAttachmentUpload {
  if (!value || typeof value !== 'object' || !('receivedBytes' in value)) throw new Error('附件上传响应无效')
  return value as AgentAttachmentUpload
}
async function discard(draftId: string): Promise<void> {
  try { await window.axon.agent.attachmentCommand({ action: 'discardDraft', draftId }) }
  catch { /* 原入口已失效或清理失败时由后端生命周期收束，不自动重发用户输入。 */ }
}

export function useAgentAttachments(sessionId: string, enabled: boolean) {
  const scope = React.useMemo<DraftScope>(() => ({ active: true, generation: 0, queue: Promise.resolve(),
    pending: 0, submitting: false, uncertain: false, listeners: new Set(), pastedTexts: new Map() }), [sessionId, enabled])
  const [view, setView] = React.useState<DraftView>({ scope, busy: false })
  const refresh = (): void => {
    if (scope.active) setView({ scope, draft: scope.draft, busy: scope.pending > 0 || scope.submitting || scope.uncertain, error: scope.error })
  }
  React.useEffect(() => {
    scope.active = true
    return () => {
      scope.active = false
      scope.generation += 1
      for (const stop of scope.listeners) stop()
      scope.listeners.clear()
      scope.pastedTexts.clear()
      // 后端权威区分草稿与已接管输入；取消入口只清未提交数据，不删除运行/历史资产。
      if (scope.draft) void discard(scope.draft.id)
    }
  }, [scope])

  const check = (generation: number): void => {
    if (!scope.active || scope.generation !== generation || !enabled) throw new Error('附件准备已取消')
  }
  /** 同一输入入口只初始化一份草稿，迟到创建结果不得写入另一会话。 */
  const ensureDraft = async (generation: number): Promise<AgentAttachmentDraft> => {
    check(generation)
    if (scope.draft) return scope.draft
    if (scope.creating) return scope.creating
    const creating = window.axon.agent.attachmentCommand({ action: 'createDraft', sessionId }).then((value) => {
      const draft = asDraft(value)
      if (!scope.active || scope.generation !== generation) { void discard(draft.id); throw new Error('附件准备已取消') }
      scope.draft = draft
      refresh()
      return draft
    })
    scope.creating = creating
    try { return await creating } finally { if (scope.creating === creating) scope.creating = undefined }
  }
  /** 导入/移除串行处理，避免旧快照覆盖后一次选择；每个异步边界复核输入入口。 */
  const run = (action: (draft: AgentAttachmentDraft, generation: number) => Promise<AgentAttachmentDraft>): Promise<void> => {
    if (!enabled || scope.submitting || scope.uncertain) return Promise.resolve()
    const generation = scope.generation
    scope.pending += 1
    scope.error = undefined
    refresh()
    const pending = scope.queue.then(async () => {
      const draft = await ensureDraft(generation)
      check(generation)
      const next = await action(draft, generation)
      check(generation)
      scope.draft = next
    }).catch(async (error: unknown) => {
      if (!scope.active || scope.generation !== generation) return
      scope.error = error instanceof Error ? error.message : '附件操作失败'
      if (!scope.draft) return
      try {
        const actual = asDraft(await window.axon.agent.attachmentCommand({ action: 'getDraft', draftId: scope.draft.id }))
        for (const upload of actual.uploads) await window.axon.agent.attachmentCommand({ action: 'cancelUpload', uploadId: upload.id })
        const next = asDraft(await window.axon.agent.attachmentCommand({ action: 'getDraft', draftId: actual.id }))
        if (scope.active && scope.generation === generation) scope.draft = next
      } catch { scope.uncertain = true; scope.error = '附件准备状态尚未确认，请重新打开会话后再添加' }
    }).finally(() => {
      scope.pending -= 1
      // 切页时后端可能仍在解码，首次丢弃会被写入口锁拒绝；真实操作结束后再释放原草稿。
      if (!scope.pending && !scope.active && scope.draft) void discard(scope.draft.id)
      refresh()
    })
    scope.queue = pending
    return pending
  }

  const pick = (): Promise<void> => run(async (draft) =>
    await window.axon.agent.pickAttachments(draft.id) ?? draft)

  /** 无稳定路径的 File 按有界块上传，不把百兆附件整体编码到单个 IPC 请求。 */
  const addFiles = (files: readonly File[], pastedText?: string): Promise<void> => run(async (draft, generation) => {
    let current = draft
    for (const file of files) {
      check(generation)
      const native = pastedText === undefined ? await window.axon.agent.addNativeFile(draft.id, file) : null
      check(generation)
      if (native) { current = native; continue }
      if (file.size > MAX_AGENT_ATTACHMENT_BYTES) throw new Error('附件超过 100 MB 上限')
      const upload = asUpload(await window.axon.agent.attachmentCommand({ action: 'beginUpload', draftId: draft.id,
        name: file.name || 'attachment', mediaType: file.type || 'application/octet-stream', size: file.size,
        kind: pastedText !== undefined ? 'pastedText' : /^image\/(png|jpeg|webp|gif)$/.test(file.type) ? 'image' : 'file' }))
      for (let offset = 0; offset < file.size; offset += MAX_AGENT_ATTACHMENT_CHUNK_BYTES) {
        check(generation)
        const data = arrayBufferToBase64(await file.slice(offset, offset + MAX_AGENT_ATTACHMENT_CHUNK_BYTES).arrayBuffer())
        check(generation)
        await window.axon.agent.attachmentCommand({ action: 'uploadChunk', uploadId: upload.id, offset, data })
      }
      check(generation)
      current = asDraft(await window.axon.agent.attachmentCommand({ action: 'finishUpload', uploadId: upload.id }))
      check(generation)
      if (pastedText !== undefined && pastedText.length <= 100_000) scope.pastedTexts.set(upload.id, pastedText)
    }
    return current
  })
  const remove = (attachmentId: string): Promise<void> => run(async (draft) => {
    const next = asDraft(await window.axon.agent.attachmentCommand({ action: 'remove', draftId: draft.id, attachmentId }))
    scope.pastedTexts.delete(attachmentId)
    return next
  })
  const addPastedText = (text: string): Promise<void> => addFiles([new File([text], `粘贴文本-${Date.now()}.txt`, { type: 'text/plain' })], text)
  const restorePastedText = (attachmentId: string, restore: (text: string) => void): Promise<void> => run(async (draft, generation) => {
    const text = scope.pastedTexts.get(attachmentId)
    if (text === undefined) throw new Error('此粘贴内容超过内联长度或已不在当前草稿中')
    check(generation)
    // 先把全文交回输入框；删除回执丢失也不能同时失去附件和内联原文。
    restore(text)
    scope.pastedTexts.delete(attachmentId)
    try { return asDraft(await window.axon.agent.attachmentCommand({ action: 'remove', draftId: draft.id, attachmentId })) }
    catch { throw new Error('文字已还原到输入框，但附件移除未确认；请检查并移除重复附件后再发送') }
  })

  /** 接纳凭据来自真实用户消息或队列回执；不在模型结束时误清用户的新草稿。 */
  const submit = (text: string, send: (input: AgentSendInput) => Promise<AgentSendResult>, onAccepted: () => void,
    imageModelConsent?: AgentSendInput['imageModelConsent'], inputParts?: AgentInputPart[]): void => {
    const draft = scope.draft, generation = scope.generation
    if (!draft?.attachments.length || scope.pending || scope.submitting || scope.uncertain) return
    scope.submitting = true
    scope.error = undefined
    refresh()
    let accepted = false
    let stop = (): void => {}
    const acknowledge = (): void => {
      if (accepted) return
      accepted = true
      stop()
      scope.listeners.delete(stop)
      if (scope.draft?.id === draft.id) scope.draft = undefined
      scope.pastedTexts.clear()
      scope.submitting = false
      scope.uncertain = false
      if (scope.active && scope.generation === generation) { onAccepted(); refresh() }
    }
    stop = window.axon.agent.onEvent((event) => {
      if (event.sessionId !== sessionId || event.type !== 'stream' || event.payload.kind !== 'sdk_message'
        || event.payload.message.type !== 'user') return
      const message = event.payload.message as SDKUserMessage
      const ids = new Set(message.attachments?.map((item) => item.id))
      if (draft.attachments.every((item) => ids.has(item.id))) acknowledge()
    })
    scope.listeners.add(stop)
    void send({ sessionId, text, attachmentDraftId: draft.id, ...(inputParts ? { inputParts } : {}), ...(imageModelConsent ? { imageModelConsent } : {}) }).then(async (result) => {
      if (accepted) return
      if (result.success) { acknowledge(); return }
      // 传输失败不代表后端没接纳，先查询原草稿状态，禁止自动重发。
      try {
        const actual = asDraft(await window.axon.agent.attachmentCommand({ action: 'getDraft', draftId: draft.id }))
        if (actual.status !== 'draft') { acknowledge(); return }
        scope.error = result.message
        if (!scope.active) void discard(draft.id)
      } catch { scope.uncertain = true; scope.error = '发送状态尚未确认，请先查看会话历史，不要重复发送' }
    }).catch(() => {
      if (!accepted) { scope.uncertain = true; scope.error = '发送状态尚未确认，请先查看会话历史，不要重复发送' }
    }).finally(() => {
      if (scope.uncertain) { scope.submitting = false; refresh(); return }
      stop()
      scope.listeners.delete(stop)
      if (!accepted) { scope.submitting = false; refresh() }
    })
  }

  /** 发送前把编辑器中仍存在的 Skill 同步到草稿；删除/撤销只改本地文档，失效来源不得继续发送。 */
  const submitWithSkills = async (value: AgentComposerValue, send: (input: AgentSendInput) => Promise<AgentSendResult>,
    onAccepted: () => void, imageModelConsent?: AgentSendInput['imageModelConsent']): Promise<void> => {
    if (scope.pending || scope.submitting || scope.uncertain || !scope.active) return
    const generation = scope.generation
    const { text, skills, parts } = value
    let inputParts: AgentInputPart[] = []
    let prepared = false
    await run(async (draft, currentGeneration) => {
      let current = draft
      const selected = new Set(skills.map((skill) => skill.sourceId))
      for (const item of current.attachments) {
        if (item.kind !== 'skill' || selected.has(item.sourceId)) continue
        current = asDraft(await window.axon.agent.attachmentCommand({ action: 'remove', draftId: draft.id, attachmentId: item.id }))
        check(currentGeneration)
      }
      for (const sourceId of selected) {
        if (current.attachments.some((item) => item.kind === 'skill' && item.sourceId === sourceId)) continue
        current = asDraft(await window.axon.agent.attachmentCommand({ action: 'addSkill', draftId: draft.id, sourceId }))
        check(currentGeneration)
      }
      // 来源先物化为当前草稿 ID，再编码顺序；页面不自报 Skill 名称或任意文件路径。
      inputParts = parts.map((part) => {
        if (part.type === 'text') return { ...part }
        const attachment = current.attachments.find((item) => item.kind === 'skill' && item.sourceId === part.sourceId)
        if (!attachment) throw new Error('行内 Skill 不在当前草稿中，请重新选择')
        return { type: 'skill', attachmentId: attachment.id }
      })
      prepared = true
      return current
    })
    // run 会展示并吸收准备错误，必须单独检查成功标志，不能在失败后发送半份选择。
    if (!prepared || !scope.active || scope.generation !== generation || scope.uncertain || scope.error) return
    if (scope.draft?.attachments.length) submit(text, send, onAccepted, imageModelConsent, inputParts.length ? inputParts : undefined)
    else if (text.trim()) { onAccepted(); void send({ sessionId, text, ...(inputParts.length ? { inputParts } : {}) }) }
  }

  const current: DraftView = view.scope === scope ? view : { scope, busy: false }
  return { draft: current.draft, busy: current.busy, error: current.error, pick, addFiles, addPastedText,
    remove, submitWithSkills, restorePastedText, canRestorePastedText: (attachmentId: string): boolean => scope.pastedTexts.has(attachmentId) }
}
