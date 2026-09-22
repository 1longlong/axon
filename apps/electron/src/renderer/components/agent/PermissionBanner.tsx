import * as React from 'react'
import { ShieldAlert } from 'lucide-react'
import { useAtomValue } from 'jotai'
import { agentPendingPermissionsAtom } from '@/atoms/agent-state'
import { useAgentController } from './AgentStateProvider'

/** 最小权限横幅：先处理每个会话的第一条请求，避免多个确认同时覆盖。 */
export function PermissionBanner({ sessionId }: { sessionId: string }): React.ReactElement | null {
  const controller = useAgentController()
  const pending = useAtomValue(agentPendingPermissionsAtom)[sessionId] ?? []
  const request = pending[0]
  if (!request) return null

  const respond = (behavior: 'allow' | 'deny', alwaysAllow = false): void => {
    void controller.respondPermission({ requestId: request.requestId, behavior, alwaysAllow })
  }

  return <div className="mx-4 mb-2 shrink-0 rounded-md border border-amber-500/40 bg-amber-500/10 p-3 text-sm"><div className="flex items-start gap-2"><ShieldAlert size={17} className="mt-0.5 shrink-0 text-amber-600" /><div className="min-w-0 flex-1"><p className="font-medium">Agent 请求执行：{request.toolName}</p><p className="mt-1 break-words text-xs text-muted-foreground">{request.description}</p><div className="mt-3 flex flex-wrap gap-2"><button type="button" onClick={() => respond('allow')} className="rounded-md bg-primary px-3 py-1.5 text-xs text-primary-foreground">允许一次</button>{request.allowAlways && <button type="button" onClick={() => respond('allow', true)} className="rounded-md border px-3 py-1.5 text-xs hover:bg-muted">始终允许</button>}<button type="button" onClick={() => respond('deny')} className="rounded-md border border-destructive/40 px-3 py-1.5 text-xs text-destructive hover:bg-destructive/10">拒绝</button></div></div></div></div>
}
