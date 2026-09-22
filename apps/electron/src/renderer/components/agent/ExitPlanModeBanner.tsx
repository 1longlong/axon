import * as React from 'react'
import { Check, FileText, MessageSquare, ShieldCheck, X, Zap } from 'lucide-react'
import type { AgentExecutionPermissionMode, AgentExitPlanResponse } from '@axon/shared'
import { useAtomValue } from 'jotai'
import { agentStateAtom } from '@/atoms/agent-state'
import { useAgentController } from './AgentStateProvider'

/** 展示当前会话第一份待审批计划；成功响应后由主进程事件移除并同步权限模式。 */
export function ExitPlanModeBanner({ sessionId }: { sessionId: string }): React.ReactElement | null {
  const controller = useAgentController()
  const request = useAtomValue(agentStateAtom).pendingExitPlansBySession[sessionId]?.[0]
  const [showFeedback, setShowFeedback] = React.useState(false)
  const [feedback, setFeedback] = React.useState('')
  const [submitting, setSubmitting] = React.useState(false)
  const [error, setError] = React.useState<string | undefined>(undefined)

  React.useEffect(() => {
    setShowFeedback(false)
    setFeedback('')
    setError(undefined)
  }, [request?.requestId])

  if (!request) return null

  const submit = async (response: AgentExitPlanResponse): Promise<void> => {
    if (submitting) return
    setSubmitting(true)
    setError(undefined)
    const accepted = await controller.respondExitPlan(response)
    if (!accepted) setError('审批已失效或权限模式切换失败')
    setSubmitting(false)
  }
  const approve = (targetMode: AgentExecutionPermissionMode): void => {
    void submit({ requestId: request.requestId, action: 'approve', targetMode })
  }

  return <section className="mx-4 mt-3 shrink-0 overflow-hidden rounded-lg border border-primary/35 bg-primary/5 text-sm">
    <div className="flex items-start gap-2 border-b border-primary/15 px-3 py-2.5">
      <FileText size={17} className="mt-0.5 shrink-0 text-primary" />
      <div className="min-w-0 flex-1">
        <p className="font-medium">Agent 已完成计划，等待审批</p>
        <p className="mt-0.5 text-xs text-muted-foreground">批准后会立即退出只读模式并继续当前轮。</p>
      </div>
    </div>
    <div className="max-h-52 overflow-y-auto whitespace-pre-wrap px-3 py-2.5 text-xs leading-5 text-foreground/90">
      {request.plan}
    </div>
    {request.allowedOperations.length > 0 && <div className="border-t border-primary/15 px-3 py-2">
      <p className="mb-1.5 text-[11px] text-muted-foreground">预计执行操作</p>
      <ul className="space-y-1 text-xs">
        {request.allowedOperations.map((operation) => <li key={operation} className="flex gap-1.5">
          <span className="text-muted-foreground">•</span><span>{operation}</span>
        </li>)}
      </ul>
    </div>}
    <div className="flex flex-wrap gap-2 border-t border-primary/15 px-3 py-2.5">
      <ActionButton disabled={submitting} onClick={() => approve('acceptEdits')} primary icon={<Check size={13} />}>
        批准并允许编辑
      </ActionButton>
      <ActionButton disabled={submitting} onClick={() => approve('default')} icon={<ShieldCheck size={13} />}>
        批准，操作仍确认
      </ActionButton>
      <ActionButton disabled={submitting} onClick={() => approve('bypassPermissions')} icon={<Zap size={13} />} title="后续工具全部自动允许">
        完全自动执行
      </ActionButton>
      <ActionButton disabled={submitting} onClick={() => setShowFeedback((value) => !value)} icon={<MessageSquare size={13} />}>
        修改计划
      </ActionButton>
      <ActionButton disabled={submitting} onClick={() => void submit({ requestId: request.requestId, action: 'reject' })} icon={<X size={13} />}>
        暂不执行
      </ActionButton>
    </div>
    {showFeedback && <div className="flex gap-2 border-t border-primary/15 px-3 py-2.5">
      <textarea
        autoFocus
        rows={2}
        maxLength={10_000}
        value={feedback}
        disabled={submitting}
        onChange={(event) => setFeedback(event.target.value)}
        placeholder="说明需要调整的内容"
        className="min-w-0 flex-1 resize-y rounded-md border bg-background px-2 py-1.5 text-xs outline-none focus:ring-1 focus:ring-ring"
      />
      <button
        type="button"
        disabled={submitting || !feedback.trim()}
        onClick={() => void submit({ requestId: request.requestId, action: 'feedback', feedback: feedback.trim() })}
        className="self-end rounded-md bg-primary px-3 py-1.5 text-xs text-primary-foreground disabled:opacity-40"
      >发送反馈</button>
    </div>}
    {error && <p className="border-t border-destructive/20 px-3 py-2 text-xs text-destructive">{error}</p>}
  </section>
}

function ActionButton({ children, icon, primary = false, ...props }: React.ButtonHTMLAttributes<HTMLButtonElement> & {
  icon: React.ReactNode
  primary?: boolean
}): React.ReactElement {
  return <button
    type="button"
    {...props}
    className={`flex items-center gap-1.5 rounded-md border px-2.5 py-1.5 text-xs disabled:opacity-40 ${primary ? 'border-primary bg-primary text-primary-foreground' : 'bg-background text-foreground hover:bg-muted'}`}
  >{icon}{children}</button>
}
