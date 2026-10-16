import * as React from 'react'
import { AlertCircle, ArrowUp, Loader2, Pause, Play } from 'lucide-react'
import { useAtomValue } from 'jotai'
import { agentStateAtom } from '@/atoms/agent-state'
import { useAgentController } from './AgentStateProvider'

/** 同一图标位承载发送/暂停/继续；观察运行不授予控制权，继续只消费权威快照。 */
export function AgentRunControl({ sessionId, compact = false, disabled = false, onContinue, onSend, sendDisabled = false, hasDraft = false }: {
  sessionId: string; compact?: boolean; disabled?: boolean; onContinue?: () => void
  onSend?: () => void; sendDisabled?: boolean; hasDraft?: boolean
}): React.ReactElement | null {
  const state = useAtomValue(agentStateAtom)
  const controller = useAgentController()
  const snapshot = state.pausesBySession[sessionId]
  const operation = state.pauseOperationsBySession[sessionId]
  const running = state.activeRunsBySession[sessionId] !== undefined
  const target = state.ownedRunsBySession[sessionId]
  const failedRead = state.pauseStatusBySession[sessionId] === 'error'
  const busy = operation === 'pausing' || (!failedRead && snapshot?.state === 'pausing') ? '正在暂停…'
    : operation === 'continuing' ? '正在继续…' : undefined
  const style = compact
    ? 'flex size-8 shrink-0 items-center justify-center rounded-full text-[#555555] hover:bg-[#F3F5F7] disabled:opacity-50'
    : 'flex size-8 shrink-0 items-center justify-center rounded-full bg-primary text-primary-foreground shadow-xs hover:bg-primary/90 focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-ring focus-visible:ring-offset-1 disabled:opacity-40'
  if (busy) return <button type="button" disabled aria-label={busy} title={busy} className={style}><Loader2 size={18} aria-hidden="true" className="animate-spin" /></button>
  if (failedRead) return <button type="button" aria-label="重读 Agent 暂停状态" title="只重读状态，不重新提交暂停或继续"
    className={style} onClick={() => void controller.loadPause(sessionId, true)}><AlertCircle size={18} aria-hidden="true" /></button>
  if (running) return target && target.runStartedAt === state.activeRunsBySession[sessionId]
    ? <button type="button" aria-label="暂停 Agent" title="暂停当前任务" className={style} onClick={() => void controller.pause(sessionId)}><Pause size={18} aria-hidden="true" /></button>
    : <span className="shrink-0 text-xs text-muted-foreground">其他入口运行中</span>
  // 暂停空草稿提供继续；已有新输入时仍可走原发送链，消费旧暂停凭据。
  if (onSend && (snapshot?.state !== 'paused' || hasDraft)) return <button type="button" aria-label="发送消息" title="发送消息"
    onClick={onSend} disabled={sendDisabled} className={style}><ArrowUp size={18} aria-hidden="true" /></button>
  if (snapshot?.state !== 'paused') return null
  return <button type="button" aria-label="继续 Agent" title="继续刚才的任务" className={style}
    disabled={disabled || Boolean(target) || state.pauseStatusBySession[sessionId] !== 'ready'}
    onClick={() => { void controller.continue(sessionId); onContinue?.() }}><Play size={18} aria-hidden="true" /></button>
}
