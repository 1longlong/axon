import * as React from 'react'
import { useAtomValue } from 'jotai'
import { ArrowDown, Bot, Loader2 } from 'lucide-react'
import type { SDKToolUseBlock } from '@axon/shared'
import { agentStateAtom } from '@/atoms/agent-state'
import { agentTaskStateAtom } from '@/atoms/agent-task-state'
import { collectAgentTurnFileChanges } from '@/lib/agent-file-changes'
import { getResultSkillActivations } from '@/lib/agent-skill-usage'
import { indexAgentToolMessages } from '@/lib/agent-tool-messages'
import { groupAgentTurns, hasActiveAgentTurnOutput } from '@/lib/agent-turn-groups'
import { useAgentTaskController } from './AgentStateProvider'
import { AgentAssistantTurnItem, AgentMessageItem } from './AgentMessageItem'
import { TaskProgressCard } from './TaskProgressCard'
import { TurnFileChangesSummary } from './TurnFileChangesSummary'
import { TurnSkillUsageSummary } from './TurnSkillUsageSummary'

/** 根 Agent 消息列表；按 toolUseId 展示任务卡片，流式输出只在阅读位置接近底部时跟随。 */
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
  const followOutputRef = React.useRef(true)
  const [showReturnToLatest, setShowReturnToLatest] = React.useState(false)
  const fileChangesByResult = React.useMemo(() => new Map(
    collectAgentTurnFileChanges(messages).map((summary) => [summary.resultIndex, summary.files]),
  ), [messages])
  const skillActivationsByResult = React.useMemo(() => new Map(messages.flatMap((message, index) => {
    const activations = getResultSkillActivations(message)
    return activations.length > 0 ? [[index, activations] as const] : []
  })), [messages])
  const toolMessageIndex = React.useMemo(() => indexAgentToolMessages(messages), [messages])
  const displayGroups = React.useMemo(() => groupAgentTurns(messages), [messages])
  const waitingForOutput = running && !hasActiveAgentTurnOutput(displayGroups)
  const activeToolUseIds = React.useMemo(() => new Set(state.activeToolUseIdsBySession[sessionId] ?? []), [sessionId, state.activeToolUseIdsBySession])
  const streamingAssistantUuid = state.streamingAssistantUuidBySession[sessionId]
  const attachedTaskToolUseIds = React.useMemo(() => new Set(
    (taskState.tasksByRootSession[sessionId] ?? []).map((task) => task.parentToolUseId),
  ), [sessionId, taskState.tasksByRootSession])

  React.useEffect(() => { void taskController.loadTasks(sessionId) }, [sessionId, taskController])
  React.useLayoutEffect(() => {
    followOutputRef.current = true
    setShowReturnToLatest(false)
  }, [sessionId])

  // 与 Chat 保持相同的底部跟随边界；查看历史时让新输出继续落在原位置下方。
  React.useLayoutEffect(() => {
    const scroller = scrollerRef.current
    if (scroller && followOutputRef.current) scroller.scrollTop = scroller.scrollHeight
  }, [messages, running, sessionId, status])

  /** 用户主动回到最新消息后恢复自动跟随，后续流式输出继续在底部展示。 */
  const returnToLatest = (): void => {
    const scroller = scrollerRef.current
    if (!scroller) return
    followOutputRef.current = true
    scroller.scrollTop = scroller.scrollHeight
    setShowReturnToLatest(false)
  }

  if (status === 'loading' && messages.length === 0) return <div className="flex flex-1 items-center justify-center text-xs text-muted-foreground">正在读取 Agent 消息…</div>
  if (status === 'error' && messages.length === 0) return <div className="flex flex-1 items-center justify-center text-xs text-destructive">读取 Agent 消息失败</div>

  const renderToolUse = (tool: SDKToolUseBlock): React.ReactNode => tool.name === 'Agent'
    ? <TaskProgressCard rootSessionId={sessionId} toolUse={tool} />
    : null

  const hideToolResult = (toolUseId: string): boolean => {
    const toolUse = toolMessageIndex.toolUsesById.get(toolUseId)
    return toolUse !== undefined && (toolUse.name !== 'Agent' || attachedTaskToolUseIds.has(toolUseId))
  }

  return <div className="relative min-h-0 flex-1"><div ref={scrollerRef}
    onScroll={(event) => {
      const scroller = event.currentTarget
      // 隐藏的缓存会话没有可用视口，不用它的零尺寸改写用户的阅读位置。
      if (scroller.clientHeight === 0) return
      const nearBottom = scroller.scrollHeight - scroller.scrollTop - scroller.clientHeight < 96
      followOutputRef.current = nearBottom
      setShowReturnToLatest(!nearBottom)
    }}
    className="h-full overflow-y-auto px-5 py-4"><div className="mx-auto flex max-w-3xl flex-col gap-4">
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
        : waitingForOutput && <span className="flex items-center gap-1.5 text-xs text-muted-foreground"><Loader2 size={13} className="animate-spin motion-reduce:animate-none" />{runSource === 'external' ? 'Agent 正由外部任务运行…' : runSource === 'background_notification' ? 'Agent 正在处理后台任务结果…' : 'Agent 运行中…'}</span>}
  </div></div>
    {showReturnToLatest && <button type="button" onClick={returnToLatest}
      className="absolute bottom-3 right-4 flex items-center gap-1.5 rounded-md border bg-popover px-3 py-2 text-xs text-popover-foreground shadow-md transition-colors hover:bg-muted focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring">
      <ArrowDown size={13} />回到最新
    </button>}
  </div>
}
