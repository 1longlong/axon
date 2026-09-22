import * as React from 'react'
import { useAtomValue } from 'jotai'
import { Bot, Loader2 } from 'lucide-react'
import type { SDKToolUseBlock } from '@axon/shared'
import { agentStateAtom } from '@/atoms/agent-state'
import { agentTaskStateAtom } from '@/atoms/agent-task-state'
import { collectAgentTurnFileChanges } from '@/lib/agent-file-changes'
import { getResultSkillActivations } from '@/lib/agent-skill-usage'
import { indexAgentToolMessages } from '@/lib/agent-tool-messages'
import { groupAgentTurns } from '@/lib/agent-turn-groups'
import { useAgentTaskController } from './AgentStateProvider'
import { AgentAssistantTurnItem, AgentMessageItem } from './AgentMessageItem'
import { TaskProgressCard } from './TaskProgressCard'
import { TurnFileChangesSummary } from './TurnFileChangesSummary'
import { TurnSkillUsageSummary } from './TurnSkillUsageSummary'

/** 根 Agent 消息列表；Agent 工具块根据真实 toolUseId 就地替换为任务卡片。 */
export function AgentMessages({ sessionId }: { sessionId: string }): React.ReactElement {
  const state = useAtomValue(agentStateAtom)
  const taskState = useAtomValue(agentTaskStateAtom)
  const taskController = useAgentTaskController()
  const messages = state.messagesBySession[sessionId] ?? []
  const status = state.messageStatusBySession[sessionId] ?? 'idle'
  const running = state.activeRunsBySession[sessionId] !== undefined
  const runSource = state.activeRunSourcesBySession[sessionId]
  const retryStatus = state.retryStatusBySession[sessionId]
  const compactionStatus = state.compactionStatusBySession[sessionId]
  const projectId = state.sessions.find((session) => session.id === sessionId)?.projectId
  const scrollerRef = React.useRef<HTMLDivElement>(null)
  const fileChangesByResult = React.useMemo(() => new Map(
    collectAgentTurnFileChanges(messages).map((summary) => [summary.resultIndex, summary.files]),
  ), [messages])
  const skillActivationsByResult = React.useMemo(() => new Map(messages.flatMap((message, index) => {
    const activations = getResultSkillActivations(message)
    return activations.length > 0 ? [[index, activations] as const] : []
  })), [messages])
  const toolMessageIndex = React.useMemo(() => indexAgentToolMessages(messages), [messages])
  const displayGroups = React.useMemo(() => groupAgentTurns(messages), [messages])
  const activeToolUseIds = React.useMemo(() => new Set(state.activeToolUseIdsBySession[sessionId] ?? []), [sessionId, state.activeToolUseIdsBySession])
  const streamingAssistantUuid = state.streamingAssistantUuidBySession[sessionId]
  const attachedTaskToolUseIds = React.useMemo(() => new Set(
    (taskState.tasksByRootSession[sessionId] ?? []).map((task) => task.parentToolUseId),
  ), [sessionId, taskState.tasksByRootSession])

  React.useEffect(() => { void taskController.loadTasks(sessionId) }, [sessionId, taskController])
  React.useLayoutEffect(() => {
    const scroller = scrollerRef.current
    if (scroller) scroller.scrollTop = scroller.scrollHeight
  }, [messages, running])

  if (status === 'loading' && messages.length === 0) return <div className="flex flex-1 items-center justify-center text-xs text-muted-foreground">正在读取 Agent 消息…</div>
  if (status === 'error' && messages.length === 0) return <div className="flex flex-1 items-center justify-center text-xs text-destructive">读取 Agent 消息失败</div>

  const renderToolUse = (tool: SDKToolUseBlock): React.ReactNode => tool.name === 'Agent'
    ? <TaskProgressCard rootSessionId={sessionId} toolUse={tool} />
    : null

  const hideToolResult = (toolUseId: string): boolean => {
    const toolUse = toolMessageIndex.toolUsesById.get(toolUseId)
    return toolUse !== undefined && (toolUse.name !== 'Agent' || attachedTaskToolUseIds.has(toolUseId))
  }

  return <div className="relative min-h-0 flex-1"><div ref={scrollerRef} className="h-full overflow-y-auto px-4 py-6"><div className="mx-auto flex max-w-3xl flex-col gap-6">
    {messages.length === 0 && !running && <div className="flex min-h-48 flex-col items-center justify-center gap-2 text-muted-foreground"><Bot size={28} /><p className="text-sm text-foreground">开始一个 Agent 任务</p><p className="text-xs">工具执行前会请求权限</p></div>}
    {displayGroups.map((group, index) => group.kind === 'user'
      ? <AgentMessageItem key={`user-${index}`} message={group.message} />
      : <AgentAssistantTurnItem
          key={`reply-${index}`}
          messages={group.messages}
          renderToolUse={renderToolUse}
          toolResultsById={toolMessageIndex.resultsByToolUseId}
          activeToolUseIds={activeToolUseIds}
          streamingAssistantUuid={streamingAssistantUuid}
          hideToolResult={hideToolResult}
          footer={<>
            {group.resultIndex !== undefined && skillActivationsByResult.has(group.resultIndex) && <TurnSkillUsageSummary activations={skillActivationsByResult.get(group.resultIndex)!} />}
            {group.resultIndex !== undefined && projectId && fileChangesByResult.has(group.resultIndex) && <TurnFileChangesSummary projectId={projectId} files={fileChangesByResult.get(group.resultIndex)!} />}
          </>}
        />)}
    {retryStatus?.phase === 'scheduled'
      ? <span className="flex items-center gap-1.5 text-xs text-muted-foreground"><Loader2 size={13} className="animate-spin" />模型请求暂时失败，{Math.max(0, retryStatus.delayMs / 1_000).toFixed(1)} 秒后自动重试（{retryStatus.attempt}/{retryStatus.maxAttempts}）</span>
      : compactionStatus?.phase === 'started'
        ? <span className="flex items-center gap-1.5 text-xs text-muted-foreground"><Loader2 size={13} className="animate-spin" />正在自动压缩上下文…</span>
        : running && <span className="flex items-center gap-1.5 text-xs text-muted-foreground"><Loader2 size={13} className="animate-spin" />{runSource === 'external' ? 'Agent 正由外部任务运行…' : runSource === 'background_notification' ? 'Agent 正在处理后台任务结果…' : 'Agent 运行中…'}</span>}
  </div></div></div>
}
