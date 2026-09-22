/** Agent 运行事件的纯归并逻辑；不发起 IPC，也不读写 Jotai store。 */

import type {
  AgentAssistantDelta,
  AgentGenerationEvent,
  AgentSessionMeta,
  SDKAssistantMessage,
  SDKContentBlock,
  SDKMessage,
  SDKToolProgressMessage,
  SDKUserMessage,
} from '@axon/shared'
import { sortAgentSessions } from './agent-state-model'
import type { AgentRendererState } from './agent-state-model'

function touchSession(
  sessions: readonly AgentSessionMeta[],
  sessionId: string,
  updatedAt: number,
): AgentSessionMeta[] {
  return sortAgentSessions(sessions.map((session) => session.id === sessionId
    ? { ...session, updatedAt: Math.max(session.updatedAt, updatedAt) }
    : session))
}

function getMessageUuid(message: SDKMessage): string | undefined {
  const uuid = (message as { uuid?: unknown }).uuid
  return typeof uuid === 'string' && uuid ? uuid : undefined
}

/** 完整消息以 uuid 原位替换流式草稿；无 uuid 的兼容消息保持追加顺序。 */
function upsertMessage(messages: readonly SDKMessage[], message: SDKMessage): SDKMessage[] {
  const uuid = getMessageUuid(message)
  if (!uuid) return [...messages, message]
  const index = messages.findIndex((item) => getMessageUuid(item) === uuid)
  return index < 0
    ? [...messages, message]
    : messages.map((item, position) => position === index ? message : item)
}

function ensureBlock(content: SDKContentBlock[], index: number, block: SDKContentBlock): SDKContentBlock {
  while (content.length <= index) content.push({ type: 'unknown' })
  if (content[index]?.type === 'unknown') content[index] = block
  return content[index]!
}

/**
 * 把中立 delta 累计为临时 assistant 消息；工具参数片段只作临时展示，
 * toolcall_end 或随后到达的完整 SDKMessage 会用结构化 input 覆盖它。
 */
function applyAssistantDeltas(
  draft: SDKAssistantMessage,
  deltas: readonly AgentAssistantDelta[],
): SDKAssistantMessage {
  const content = draft.message.content.map((block) => ({ ...block }))
  for (const delta of deltas) {
    if (delta.type === 'start') continue
    if (delta.type === 'text_start') {
      ensureBlock(content, delta.contentIndex, { type: 'text', text: '' })
    } else if (delta.type === 'text_delta' || delta.type === 'text_end') {
      const block = ensureBlock(content, delta.contentIndex, { type: 'text', text: '' })
      if (block.type === 'text') block.text = delta.type === 'text_delta'
        ? `${typeof block.text === 'string' ? block.text : ''}${delta.delta}`
        : delta.content
    } else if (delta.type === 'thinking_start') {
      ensureBlock(content, delta.contentIndex, { type: 'thinking', thinking: '' })
    } else if (delta.type === 'thinking_delta' || delta.type === 'thinking_end') {
      const block = ensureBlock(content, delta.contentIndex, { type: 'thinking', thinking: '' })
      if (block.type === 'thinking') block.thinking = delta.type === 'thinking_delta'
        ? `${typeof block.thinking === 'string' ? block.thinking : ''}${delta.delta}`
        : delta.content
    } else if (delta.type === 'toolcall_start' || delta.type === 'toolcall_delta') {
      const toolCall = delta.toolCall
      const block = ensureBlock(content, delta.contentIndex, {
        type: 'tool_use',
        id: toolCall?.id ?? '',
        name: toolCall?.name ?? '',
        input: {},
      })
      if (block.type === 'tool_use') {
        if (toolCall?.id) block.id = toolCall.id
        if (toolCall?.name) block.name = toolCall.name
        if (delta.type === 'toolcall_delta') {
          const draftBlock = block as SDKContentBlock & { argumentsText?: string }
          const current = typeof draftBlock.argumentsText === 'string' ? draftBlock.argumentsText : ''
          draftBlock.argumentsText = `${current}${delta.delta}`
        }
      }
    } else if (delta.type === 'toolcall_end') {
      content[delta.contentIndex] = {
        type: 'tool_use',
        id: delta.toolCall.id,
        name: delta.toolCall.name,
        input: delta.toolCall.arguments ?? {},
      }
    }
  }
  return { ...draft, message: { ...draft.message, content } }
}

/** 将单条运行事件归并进 UI 快照；非当前 runStartedAt 的迟到流一律忽略。 */
export function reduceAgentGenerationEvent(
  state: AgentRendererState,
  event: AgentGenerationEvent,
): AgentRendererState {
  const currentRun = state.activeRunsBySession[event.sessionId]
  if (event.type === 'session_title') {
    return {
      ...state,
      sessions: state.sessions.map((session) => session.id === event.sessionId
        ? { ...session, title: event.title, updatedAt: event.updatedAt }
        : session),
    }
  }
  if (event.type === 'run_started') {
    if (currentRun !== undefined && event.runStartedAt < currentRun) return state
    return {
      ...state,
      sessions: touchSession(state.sessions, event.sessionId, event.runStartedAt),
      activeRunsBySession: {
        ...state.activeRunsBySession,
        [event.sessionId]: event.runStartedAt,
      },
      activeRunSourcesBySession: {
        ...state.activeRunSourcesBySession,
        [event.sessionId]: event.source,
      },
      activeToolUseIdsBySession: { ...state.activeToolUseIdsBySession, [event.sessionId]: [] },
      streamingAssistantUuidBySession: Object.fromEntries(
        Object.entries(state.streamingAssistantUuidBySession).filter(([sessionId]) => sessionId !== event.sessionId),
      ),
      retryStatusBySession: Object.fromEntries(
        Object.entries(state.retryStatusBySession).filter(([sessionId]) => sessionId !== event.sessionId),
      ),
      compactionStatusBySession: Object.fromEntries(
        Object.entries(state.compactionStatusBySession).filter(([sessionId]) => sessionId !== event.sessionId),
      ),
      lastError: state.lastError?.scope === 'run'
        && state.lastError.sessionId === event.sessionId ? null : state.lastError,
    }
  }
  const isDetachedChildRequest = (
    event.type === 'permission_request'
    || event.type === 'ask_user_request'
    || event.type === 'exit_plan_mode_request'
  ) && event.request.sessionId !== event.sessionId
  const isInteractionResolution = event.type === 'permission_resolved'
    || event.type === 'ask_user_resolved'
    || event.type === 'exit_plan_mode_resolved'
  if (currentRun !== event.runStartedAt && !isDetachedChildRequest && !isInteractionResolution) return state

  if (event.type === 'permission_request') {
    const pending = state.pendingPermissionsBySession[event.sessionId] ?? []
    if (pending.some((item) => item.requestId === event.request.requestId)) return state
    return {
      ...state,
      pendingPermissionsBySession: {
        ...state.pendingPermissionsBySession,
        [event.sessionId]: [...pending, event.request],
      },
    }
  }

  if (event.type === 'permission_resolved') {
    const pending = state.pendingPermissionsBySession[event.sessionId] ?? []
    return {
      ...state,
      pendingPermissionsBySession: {
        ...state.pendingPermissionsBySession,
        [event.sessionId]: pending.filter((item) => item.requestId !== event.requestId),
      },
    }
  }

  if (event.type === 'ask_user_request') {
    const pending = state.pendingAskUsersBySession[event.sessionId] ?? []
    if (pending.some((item) => item.requestId === event.request.requestId)) return state
    return {
      ...state,
      pendingAskUsersBySession: {
        ...state.pendingAskUsersBySession,
        [event.sessionId]: [...pending, event.request],
      },
    }
  }

  if (event.type === 'ask_user_resolved') {
    const pending = state.pendingAskUsersBySession[event.sessionId] ?? []
    return {
      ...state,
      pendingAskUsersBySession: {
        ...state.pendingAskUsersBySession,
        [event.sessionId]: pending.filter((item) => item.requestId !== event.requestId),
      },
    }
  }

  if (event.type === 'exit_plan_mode_request') {
    const pending = state.pendingExitPlansBySession[event.sessionId] ?? []
    if (pending.some((item) => item.requestId === event.request.requestId)) return state
    return {
      ...state,
      pendingExitPlansBySession: {
        ...state.pendingExitPlansBySession,
        [event.sessionId]: [...pending, event.request],
      },
    }
  }

  if (event.type === 'exit_plan_mode_resolved') {
    const pending = state.pendingExitPlansBySession[event.sessionId] ?? []
    return {
      ...state,
      pendingExitPlansBySession: {
        ...state.pendingExitPlansBySession,
        [event.sessionId]: pending.filter((item) => item.requestId !== event.requestId),
      },
    }
  }

  if (event.type === 'plan_mode_changed') {
    return {
      ...state,
      sessions: state.sessions.map((session) => session.id === event.sessionId
        ? { ...session, permissionMode: event.mode }
        : session),
    }
  }

  if (event.type === 'stream') {
    const messages = state.messagesBySession[event.sessionId] ?? []
    if (event.payload.kind === 'sdk_message' && event.payload.message.type === 'tool_progress') {
      const id = (event.payload.message as SDKToolProgressMessage).tool_use_id
      const active = state.activeToolUseIdsBySession[event.sessionId] ?? []
      return active.includes(id) ? state : {
        ...state,
        activeToolUseIdsBySession: { ...state.activeToolUseIdsBySession, [event.sessionId]: [...active, id] },
      }
    }
    if (event.payload.kind === 'discard_assistant') {
      const discardedUuid = event.payload.uuid
      return {
        ...state,
        messagesBySession: {
          ...state.messagesBySession,
          [event.sessionId]: messages.filter(
            (message) => getMessageUuid(message) !== discardedUuid,
          ),
        },
      }
    }
    if (event.payload.kind === 'retry_status') {
      const retryStatuses = { ...state.retryStatusBySession }
      if (event.payload.status.phase === 'scheduled') retryStatuses[event.sessionId] = event.payload.status
      else delete retryStatuses[event.sessionId]
      const discardedUuid = event.payload.status.phase === 'scheduled'
        ? event.payload.status.discardedAssistantUuid
        : undefined
      return {
        ...state,
        retryStatusBySession: retryStatuses,
        messagesBySession: discardedUuid
          ? {
              ...state.messagesBySession,
              [event.sessionId]: messages.filter((message) => getMessageUuid(message) !== discardedUuid),
            }
          : state.messagesBySession,
      }
    }
    if (event.payload.kind === 'compaction_status') {
      const compactionStatuses = { ...state.compactionStatusBySession }
      if (event.payload.status.phase === 'started') compactionStatuses[event.sessionId] = event.payload.status
      else delete compactionStatuses[event.sessionId]
      return { ...state, compactionStatusBySession: compactionStatuses }
    }
    let nextMessages: SDKMessage[]
    if (event.payload.kind === 'sdk_message') {
      nextMessages = upsertMessage(messages, event.payload.message)
    } else {
      const uuid = event.payload.delta.uuid
      const existing = messages.find((message) => getMessageUuid(message) === uuid)
      const draft: SDKAssistantMessage = existing?.type === 'assistant'
        ? existing as SDKAssistantMessage
        : {
            type: 'assistant',
            message: { content: [] },
            parent_tool_use_id: null,
            uuid,
            ...(event.payload.delta.session_id ? { session_id: event.payload.delta.session_id } : {}),
          }
      nextMessages = upsertMessage(
        messages,
        applyAssistantDeltas(draft, event.payload.delta.deltas),
      )
    }
    const payload = event.payload
    const active = new Set(state.activeToolUseIdsBySession[event.sessionId] ?? [])
    if (payload.kind === 'sdk_message') {
      if (payload.message.type === 'assistant') {
        for (const block of (payload.message as SDKAssistantMessage).message.content) {
          if (block.type === 'tool_use' && typeof block.id === 'string') active.add(block.id)
        }
      } else if (payload.message.type === 'user') {
        for (const block of (payload.message as SDKUserMessage).message?.content ?? []) {
          if (block.type === 'tool_result' && typeof block.tool_use_id === 'string') active.delete(block.tool_use_id)
        }
      }
    }
    const streamingAssistantUuidBySession = { ...state.streamingAssistantUuidBySession }
    if (payload.kind === 'sdk_delta') streamingAssistantUuidBySession[event.sessionId] = payload.delta.uuid
    else if (payload.message.type === 'assistant' && payload.message.uuid === streamingAssistantUuidBySession[event.sessionId]) {
      delete streamingAssistantUuidBySession[event.sessionId]
    }
    return {
      ...state,
      messagesBySession: { ...state.messagesBySession, [event.sessionId]: nextMessages },
      activeToolUseIdsBySession: { ...state.activeToolUseIdsBySession, [event.sessionId]: [...active] },
      streamingAssistantUuidBySession,
    }
  }

  const activeRuns = { ...state.activeRunsBySession }
  const activeRunSources = { ...state.activeRunSourcesBySession }
  const retryStatuses = { ...state.retryStatusBySession }
  const compactionStatuses = { ...state.compactionStatusBySession }
  const activeToolUseIds = { ...state.activeToolUseIdsBySession }
  const streamingAssistantUuids = { ...state.streamingAssistantUuidBySession }
  const pendingPermissions = { ...state.pendingPermissionsBySession }
  const pendingAskUsers = { ...state.pendingAskUsersBySession }
  const pendingExitPlans = { ...state.pendingExitPlansBySession }
  delete activeRuns[event.sessionId]
  delete activeRunSources[event.sessionId]
  delete retryStatuses[event.sessionId]
  delete compactionStatuses[event.sessionId]
  delete activeToolUseIds[event.sessionId]
  delete streamingAssistantUuids[event.sessionId]
  delete pendingPermissions[event.sessionId]
  delete pendingAskUsers[event.sessionId]
  delete pendingExitPlans[event.sessionId]
  return {
    ...state,
    activeRunsBySession: activeRuns,
    activeRunSourcesBySession: activeRunSources,
    retryStatusBySession: retryStatuses,
    compactionStatusBySession: compactionStatuses,
    activeToolUseIdsBySession: activeToolUseIds,
    streamingAssistantUuidBySession: streamingAssistantUuids,
    pendingPermissionsBySession: pendingPermissions,
    pendingAskUsersBySession: pendingAskUsers,
    pendingExitPlansBySession: pendingExitPlans,
  }
}
