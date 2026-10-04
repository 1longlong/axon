import * as React from 'react'
import { ShieldAlert } from 'lucide-react'
import { useAtomValue } from 'jotai'
import { agentPendingPermissionsAtom } from '@/atoms/agent-state'
import { useAgentController } from './AgentStateProvider'
import type { AgentPermissionRequest } from '@axon/shared'

export interface PermissionBannerContent {
  title: string
  kind?: string
  description: string
  detail?: string
  target?: string
}

/** 把普通工具确认与沙箱升级翻译成明确文案，不在 renderer 推测授权范围。 */
export function buildPermissionBannerContent(request: AgentPermissionRequest): PermissionBannerContent {
  const escalation = request.sandboxEscalation
  if (!escalation) return {
    title: `Agent 请求执行：${request.toolName}`,
    description: request.description,
  }
  const kind = escalation.reason === 'networkAccess'
    ? '网络访问'
    : escalation.reason === 'protectedPathWrite'
      ? '受保护路径写入'
      : '工作区外写入'
  return {
    title: `Agent 请求扩展沙箱权限：${request.toolName}`,
    kind,
    description: request.description,
    detail: escalation.message,
    ...(escalation.target ? { target: escalation.target } : {}),
  }
}

/** 最小权限横幅：先处理每个会话的第一条请求，避免多个确认同时覆盖。 */
export function PermissionBanner({ sessionId }: { sessionId: string }): React.ReactElement | null {
  const controller = useAgentController()
  const pending = useAtomValue(agentPendingPermissionsAtom)[sessionId] ?? []
  const request = pending[0]
  if (!request) return null
  const content = buildPermissionBannerContent(request)

  const respond = (behavior: 'allow' | 'deny', alwaysAllow = false): void => {
    void controller.respondPermission({ requestId: request.requestId, behavior, alwaysAllow })
  }

  return <div className="mx-4 mb-2 shrink-0 rounded-md border border-amber-500/30 bg-[hsl(var(--input-surface))] p-3 text-[13px]">
    <div className="flex items-start gap-2">
      <ShieldAlert size={17} className="mt-0.5 shrink-0 text-amber-700 dark:text-amber-300" />
      <div className="min-w-0 flex-1">
        <div className="flex flex-wrap items-center gap-2">
          <p className="font-medium">{content.title}</p>
          {content.kind && <span className="rounded border border-amber-500/30 bg-amber-500/5 px-1.5 py-0.5 text-[11px] text-amber-700 dark:text-amber-300">{content.kind}</span>}
          {pending.length > 1 && <span className="text-[11px] text-muted-foreground">另有 {pending.length - 1} 项等待确认</span>}
        </div>
        <p className="mt-1 break-words text-xs text-muted-foreground">{content.description}</p>
        {content.target && <p className="mt-1 break-all font-mono text-[11px] text-foreground">{content.target}</p>}
        {content.detail && <p className="mt-2 break-words text-xs text-amber-800 dark:text-amber-200">{content.detail}</p>}
        {request.sandboxEscalation && <p className="mt-1 text-[11px] text-muted-foreground">批准后只携带本项权限重试当前工具一次。</p>}
        <div className="mt-3 flex flex-wrap gap-2">
          <button type="button" onClick={() => respond('allow')} className="h-8 rounded-md bg-primary px-3 text-xs text-primary-foreground hover:opacity-90 focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-ring">本次允许</button>
          {request.allowAlways && <button type="button" onClick={() => respond('allow', true)} className="h-8 rounded-md border px-3 text-xs hover:bg-muted focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-ring">当前会话允许</button>}
          <button type="button" onClick={() => respond('deny')} className="h-8 rounded-md border border-destructive/40 px-3 text-xs text-destructive hover:bg-destructive/10 focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-ring">拒绝</button>
        </div>
      </div>
    </div>
  </div>
}
