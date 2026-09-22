import * as React from 'react'
import { useAtomValue } from 'jotai'
import { AlertCircle, Bot } from 'lucide-react'
import type { AgentEnvironmentCheckResult } from '@axon/shared'
import { agentStateAtom } from '@/atoms/agent-state'
import { useAgentController } from './AgentStateProvider'
import { AgentInput } from './AgentInput'
import { AgentMessages } from './AgentMessages'
import { PermissionBanner } from './PermissionBanner'
import { AgentSidePanel } from './AgentSidePanel'
import { AskUserBanner } from './AskUserBanner'
import { ExitPlanModeBanner } from './ExitPlanModeBanner'
import { AgentHeader } from './AgentHeader'
import { QuickConversationLayout, type QuickConversationLayoutOptions } from '@/components/app-shell/QuickConversationLayout'
import { QuickComposer } from '@/components/app-shell/QuickComposer'

/** Agent 页面按“项目归属、会话元数据、权限、消息流、输入动作”组合。 */
export function AgentViewShell({ sessionId, compact = false, quick }: { sessionId: string; compact?: boolean; quick?: QuickConversationLayoutOptions & { onSent: () => void } }): React.ReactElement {
  const controller = useAgentController()
  const state = useAtomValue(agentStateAtom)
  const session = state.sessions.find((item) => item.id === sessionId)
  const currentProject = state.projects.find((project) => project.id === session?.projectId)
  const [environment, setEnvironment] = React.useState<AgentEnvironmentCheckResult | null>(null)

  React.useEffect(() => {
    if (!session) return
    void controller.loadMessages(session.id)
  }, [controller, session?.id])

  /** 项目工作区变更后重新检查运行环境，并丢弃迟到结果。 */
  React.useEffect(() => {
    if (!session || !currentProject) {
      setEnvironment(null)
      return
    }
    let cancelled = false
    void controller.checkEnvironment(session.projectId ? { projectId: session.projectId } : {}).then((result) => {
      if (!cancelled) setEnvironment(result)
    }).catch(() => { if (!cancelled) setEnvironment(null) })
    return () => { cancelled = true }
  }, [controller, currentProject?.updatedAt, currentProject?.workspace.kind, session?.id, session?.projectId])

  if (!session) {
    return <div className="flex h-full flex-col items-center justify-center gap-2 text-muted-foreground">
      <Bot size={28} />
      <p className="text-sm text-foreground">Agent 会话不存在或已删除</p>
    </div>
  }

  const directoryIssue = environment
    && (!environment.directory.available || !environment.directory.writable)
  if (quick) return <QuickConversationLayout
    options={{ ...quick, title: session.title }}
    context={<AgentMessages sessionId={session.id} />}
    composer={<>
      {quick.expanded && <>
        {state.lastError?.scope === 'run' && state.lastError.sessionId === session.id && <Notice variant="error">{state.lastError.message}</Notice>}
        {directoryIssue && <Notice>工作目录不可用：{environment.directory.message}</Notice>}
        {!session.projectId && <Notice>请先创建或选择项目，再发送 Agent 任务。</Notice>}
        {(!session.channelId || !session.modelId) && <Notice>请先选择渠道和模型，再发送 Agent 任务。</Notice>}
        <AskUserBanner sessionId={session.id} />
        <ExitPlanModeBanner sessionId={session.id} />
        <PermissionBanner sessionId={session.id} />
      </>}
      <QuickComposer key={quick.resetEpoch} sessionType="agent" sessionId={session.id} expanded={quick.expanded} onSent={quick.onSent} />
    </>}
  />
  return <div className="flex h-full min-h-0 bg-[hsl(var(--tab-surface))]">
    <main className="flex min-w-0 flex-1 flex-col">
      <AgentHeader session={session} project={currentProject} />
      {state.lastError?.scope === 'run' && state.lastError.sessionId === session.id
        && <Notice variant="error">{state.lastError.message}</Notice>}
      {directoryIssue && <Notice>工作目录不可用：{environment.directory.message}</Notice>}
      {!session.projectId && <Notice>请先创建或选择项目，再发送 Agent 任务。</Notice>}
      {(!session.channelId || !session.modelId)
        && <Notice>请先选择渠道和模型，再发送 Agent 任务。</Notice>}
      <AskUserBanner sessionId={session.id} />
      <ExitPlanModeBanner sessionId={session.id} />
      <AgentMessages sessionId={session.id} />
      <PermissionBanner sessionId={session.id} />
      <AgentInput sessionId={session.id} />
    </main>
    {!compact && <AgentSidePanel
      projectId={currentProject?.id}
      workspaceUpdatedAt={currentProject?.updatedAt}
      memoryEnabled={currentProject?.memoryEnabled === true}
    />}
  </div>
}

function Notice({ children, variant = 'warning' }: {
  children: React.ReactNode
  variant?: 'warning' | 'error'
}): React.ReactElement {
  const tone = variant === 'error'
    ? 'border-destructive/40 bg-destructive/5 text-destructive'
    : 'border-amber-500/40 bg-amber-500/5 text-amber-700'
  return <div className={`mx-4 mt-3 flex shrink-0 items-center gap-2 rounded-md border px-3 py-2 text-xs ${tone}`}>
    <AlertCircle size={14} />{children}
  </div>
}
