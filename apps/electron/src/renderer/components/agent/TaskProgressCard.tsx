import * as React from 'react'
import { useAtomValue } from 'jotai'
import { AlertCircle, Bot, CheckCircle2, ChevronRight, Circle, Clock3, Loader2, X } from 'lucide-react'
import type { AgentDelegation, AgentDelegationStatus, SDKMessage, SDKToolUseBlock } from '@axon/shared'
import { agentTaskStateAtom } from '@/atoms/agent-task-state'
import { cn } from '@/lib/utils'
import { indexAgentToolMessages } from '@/lib/agent-tool-messages'
import { groupAgentTurns } from '@/lib/agent-turn-groups'
import { useAgentTaskController } from './AgentStateProvider'
import { AgentAssistantTurnItem, AgentMessageItem } from './AgentMessageItem'

const STATUS_LABELS: Record<AgentDelegationStatus, string> = {
  queued: '等待运行', running: '运行中', blocked: '等待确认', completed: '已完成',
  failed: '失败', canceled: '已取消', interrupted: '已中断',
}

const ROLE_LABELS = { coder: '实现', explore: '探索', plan: '规划' } as const

function TaskStatusIcon({ status }: { status: AgentDelegationStatus }): React.ReactElement {
  if (status === 'running') return <Loader2 size={14} className="animate-spin text-primary" />
  if (status === 'completed') return <CheckCircle2 size={14} className="text-emerald-500" />
  if (status === 'failed') return <AlertCircle size={14} className="text-destructive" />
  if (status === 'blocked') return <Clock3 size={14} className="text-amber-500" />
  return <Circle size={14} className="text-muted-foreground" />
}

function messageId(message: SDKMessage, index: number): string {
  const uuid = (message as { uuid?: unknown }).uuid
  return typeof uuid === 'string' ? uuid : `${message.type}-${index}`
}

/** 已落盘消息为底，当前流中同 uuid 的完整/草稿消息覆盖它。 */
function mergeMessages(persisted: readonly SDKMessage[], live: readonly SDKMessage[]): SDKMessage[] {
  const merged = [...persisted]
  const positions = new Map(merged.map((message, index) => [messageId(message, index), index]))
  for (const message of live) {
    const key = messageId(message, merged.length)
    const position = positions.get(key)
    if (position === undefined) {
      positions.set(key, merged.length)
      merged.push(message)
    } else {
      merged[position] = message
    }
  }
  return merged
}

function durationText(task: AgentDelegation): string | null {
  if (!task.startedAt) return null
  const end = task.finishedAt ?? Date.now()
  const seconds = Math.max(0, Math.round((end - task.startedAt) / 1_000))
  return seconds < 60 ? `${seconds}s` : `${Math.floor(seconds / 60)}m ${seconds % 60}s`
}

/** 主消息中的紧凑任务入口；状态来自 task atom，点击后按需加载子 Agent JSONL。 */
export function TaskProgressCard({ rootSessionId, toolUse }: { rootSessionId: string; toolUse: SDKToolUseBlock }): React.ReactElement {
  const state = useAtomValue(agentTaskStateAtom)
  const task = (state.tasksByRootSession[rootSessionId] ?? [])
    .find((item) => item.parentToolUseId === toolUse.id)
  const loadStatus = state.taskStatusByRootSession[rootSessionId] ?? 'idle'
  const [open, setOpen] = React.useState(false)
  const title = task?.title
    ?? (typeof toolUse.input.description === 'string' ? toolUse.input.description : '子 Agent 任务')

  if (!task) {
    const loading = loadStatus === 'idle' || loadStatus === 'loading'
    return <div className="rounded-md border bg-muted/20 px-3 py-2 text-xs"><div className="flex items-center gap-2">{loading ? <Loader2 size={13} className="animate-spin text-muted-foreground" /> : <AlertCircle size={13} className="text-destructive" />}<span className="font-medium">{title}</span><span className={cn('ml-auto', loading ? 'text-muted-foreground' : 'text-destructive')}>{loading ? '正在读取任务状态…' : '子任务未建立'}</span></div></div>
  }

  return <>
    <button type="button" aria-label={`查看子任务 ${task.title}`} onClick={() => setOpen(true)} className="group w-full rounded-md border bg-muted/20 px-3 py-2 text-left text-xs transition-colors hover:bg-muted/40">
      <div className="flex items-center gap-2">
        <TaskStatusIcon status={task.status} />
        <span className="min-w-0 flex-1 truncate font-medium">{task.title}</span>
        <span className="rounded bg-muted px-1.5 py-0.5 text-[10px] text-muted-foreground">{ROLE_LABELS[task.subagentType]}</span>
        <span className={cn('text-[11px]', task.status === 'failed' ? 'text-destructive' : 'text-muted-foreground')}>{STATUS_LABELS[task.status]}</span>
        <ChevronRight size={13} className="text-muted-foreground transition-transform group-hover:translate-x-0.5" />
      </div>
      {(task.latestProgress || task.resultSummary) && <p className="mt-1.5 line-clamp-2 text-muted-foreground">{task.resultSummary ?? task.latestProgress}</p>}
    </button>
    {open && <TaskProgressOverlay rootSessionId={rootSessionId} task={task} onClose={() => setOpen(false)} />}
  </>
}

function TaskProgressOverlay({ rootSessionId, task, onClose }: { rootSessionId: string; task: AgentDelegation; onClose(): void }): React.ReactElement {
  const state = useAtomValue(agentTaskStateAtom)
  const controller = useAgentTaskController()
  const persisted = state.messagesByTask[task.id] ?? []
  const live = state.liveMessagesByTask[task.id] ?? []
  const messages = React.useMemo(() => mergeMessages(persisted, live), [persisted, live])
  const toolMessageIndex = React.useMemo(() => indexAgentToolMessages(messages), [messages])
  const displayGroups = React.useMemo(() => groupAgentTurns(messages), [messages])
  const activeToolUseIds = React.useMemo(() => new Set(state.activeToolUseIdsByTask[task.id] ?? []), [state.activeToolUseIdsByTask, task.id])
  const streamingAssistantUuid = state.streamingAssistantUuidByTask[task.id]
  const messageStatus = state.messageStatusByTask[task.id] ?? 'idle'
  const running = state.runningByTask[task.id] === true
  const retry = state.retryStatusByTask[task.id]
  const compaction = state.compactionStatusByTask[task.id]
  const duration = durationText(task)

  React.useEffect(() => { void controller.loadMessages(rootSessionId, task.id) }, [controller, rootSessionId, task.id])
  React.useEffect(() => {
    const closeOnEscape = (event: KeyboardEvent): void => { if (event.key === 'Escape') onClose() }
    document.addEventListener('keydown', closeOnEscape)
    return () => document.removeEventListener('keydown', closeOnEscape)
  }, [onClose])

  return <div role="dialog" aria-modal="true" aria-label={`子任务：${task.title}`} onMouseDown={(event) => { if (event.target === event.currentTarget) onClose() }} className="fixed inset-0 z-50 flex items-center justify-center bg-black/35 p-4">
    <div className="flex h-[min(720px,calc(100vh-32px))] w-full max-w-3xl flex-col rounded-lg border bg-background shadow-xl">
      <header className="flex items-start gap-3 border-b px-5 py-4">
        <span className="mt-0.5 flex size-8 shrink-0 items-center justify-center rounded-md bg-primary text-primary-foreground"><Bot size={16} /></span>
        <div className="min-w-0 flex-1"><div className="flex flex-wrap items-center gap-2"><h2 className="font-medium">{task.title}</h2><span className="rounded bg-muted px-1.5 py-0.5 text-[10px] text-muted-foreground">{ROLE_LABELS[task.subagentType]}</span><span className="flex items-center gap-1 text-xs text-muted-foreground"><TaskStatusIcon status={task.status} />{STATUS_LABELS[task.status]}{duration ? ` · ${duration}` : ''}</span></div><p className="mt-1 line-clamp-2 text-xs text-muted-foreground">{task.objective}</p></div>
        <button type="button" aria-label="关闭子任务详情" onClick={onClose} className="flex size-8 items-center justify-center rounded-md text-muted-foreground hover:bg-muted hover:text-foreground"><X size={15} /></button>
      </header>
      <main className="min-h-0 flex-1 overflow-y-auto px-5 py-5">
        <div className="mx-auto flex max-w-2xl flex-col gap-5">
          {messageStatus === 'loading' && messages.length === 0 && <p className="py-10 text-center text-xs text-muted-foreground">正在读取子 Agent 消息…</p>}
          {messageStatus === 'error' && messages.length === 0 && <p className="py-10 text-center text-xs text-destructive">读取子 Agent 消息失败</p>}
          {displayGroups.map((group, index) => group.kind === 'user'
            ? <AgentMessageItem key={`user-${index}`} message={group.message} />
            : <AgentAssistantTurnItem key={`reply-${index}`} messages={group.messages} toolResultsById={toolMessageIndex.resultsByToolUseId} activeToolUseIds={activeToolUseIds} streamingAssistantUuid={streamingAssistantUuid} hideToolResult={(toolUseId) => toolMessageIndex.toolUsesById.has(toolUseId)} />)}
          {retry?.phase === 'scheduled'
            ? <p className="flex items-center gap-1.5 text-xs text-muted-foreground"><Loader2 size={13} className="animate-spin" />模型请求暂时失败，正在自动重试（{retry.attempt}/{retry.maxAttempts}）</p>
            : compaction?.phase === 'started'
              ? <p className="flex items-center gap-1.5 text-xs text-muted-foreground"><Loader2 size={13} className="animate-spin" />正在自动压缩上下文…</p>
              : running && <p className="flex items-center gap-1.5 text-xs text-muted-foreground"><Loader2 size={13} className="animate-spin" />子 Agent 运行中…</p>}
          {task.error && <div className="rounded-md border border-destructive/40 bg-destructive/5 px-3 py-2 text-xs text-destructive">{task.error.message}</div>}
          {task.resultSummary && <div className="rounded-md border bg-muted/20 px-3 py-2 text-xs"><p className="font-medium">任务结果</p><p className="mt-1 whitespace-pre-wrap text-muted-foreground">{task.resultSummary}</p></div>}
        </div>
      </main>
    </div>
  </div>
}
