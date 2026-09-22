import * as React from 'react'
import { useAtomValue } from 'jotai'
import { agentStateAtom } from '@/atoms/agent-state'
import { useChatController } from '@/components/chat/ChatStateProvider'
import { useAgentController } from '@/components/agent/AgentStateProvider'

const AgentViewShell = React.lazy(() => import('@/components/agent/AgentViewShell').then((module) => ({ default: module.AgentViewShell })))
const ChatViewShell = React.lazy(() => import('@/components/chat/ChatViewShell').then((module) => ({ default: module.ChatViewShell })))

/** 浮窗使用独立轻量输入 UI；会话状态与发送仍由现有 controller 管理。 */
export function QuickChatWindow(): React.ReactElement {
  const params = React.useMemo(() => new URLSearchParams(window.location.search), [])
  const sessionType = params.get('sessionType')
  const sessionId = params.get('sessionId')
  const chatController = useChatController()
  const agentController = useAgentController()
  const agentState = useAtomValue(agentStateAtom)
  const [expanded, setExpanded] = React.useState(false)
  const [resetEpoch, setResetEpoch] = React.useState(0)
  const activeInvocation = React.useRef(true)
  const pendingAtOpen = React.useRef<Set<string>>(new Set())
  const pendingBaselineReady = React.useRef(false)

  const changeExpanded = React.useCallback((next: boolean): void => {
    setExpanded(next)
    void window.axon.desktop.setQuickChatExpanded(next)
  }, [])

  const pendingRequestIds = React.useCallback((): Set<string> => {
    if (!sessionId) return new Set()
    return new Set([
      ...(agentState.pendingPermissionsBySession[sessionId] ?? []),
      ...(agentState.pendingAskUsersBySession[sessionId] ?? []),
      ...(agentState.pendingExitPlansBySession[sessionId] ?? []),
    ].map((request) => request.requestId))
  }, [agentState.pendingAskUsersBySession, agentState.pendingExitPlansBySession, agentState.pendingPermissionsBySession, sessionId])

  /** 有效消息提交后立即展开原会话；后续消息仍由现有 controller 流程写入并展示。 */
  const onSent = React.useCallback((): void => {
    changeExpanded(true)
  }, [changeExpanded])

  React.useEffect(() => {
    if (!sessionId || sessionType !== 'agent' || expanded || !activeInvocation.current) return
    if (!pendingBaselineReady.current) {
      pendingAtOpen.current = pendingRequestIds()
      pendingBaselineReady.current = true
      return
    }
    if ([...pendingRequestIds()].some((id) => !pendingAtOpen.current.has(id))) changeExpanded(true)
  }, [changeExpanded, expanded, pendingRequestIds, sessionId, sessionType])

  React.useEffect(() => window.axon.desktop.onQuickChatOpened(() => {
    activeInvocation.current = true
    pendingAtOpen.current = pendingRequestIds()
    pendingBaselineReady.current = true
    setResetEpoch((current) => current + 1)
    changeExpanded(false)
  }), [changeExpanded, pendingRequestIds])

  /** 失焦或 Esc 取消本次唤起：丢弃草稿并收起浮窗，但不停止已发送的会话运行。 */
  React.useEffect(() => window.axon.desktop.onQuickChatCanceled(() => {
    activeInvocation.current = false
    pendingAtOpen.current = pendingRequestIds()
    pendingBaselineReady.current = true
    setResetEpoch((current) => current + 1)
    changeExpanded(false)
  }), [changeExpanded, pendingRequestIds])

  React.useEffect(() => {
    if (!sessionId) return
    const refresh = (): void => {
      if (sessionType === 'chat') void chatController.loadMessages(sessionId)
      if (sessionType === 'agent') void agentController.loadMessages(sessionId)
    }
    window.addEventListener('focus', refresh)
    return () => window.removeEventListener('focus', refresh)
  }, [agentController, chatController, sessionId, sessionType])

  React.useEffect(() => {
    const focusInput = (): void => {
      const editor = document.querySelector<HTMLElement>('input[data-quick-composer]')
      editor?.focus()
    }
    const observer = new MutationObserver(() => {
      if (document.querySelector('input[data-quick-composer]')) {
        observer.disconnect()
        focusInput()
      }
    })
    observer.observe(document.getElementById('root')!, { childList: true, subtree: true })
    window.addEventListener('focus', focusInput)
    focusInput()
    return () => { observer.disconnect(); window.removeEventListener('focus', focusInput) }
  }, [])

  if (!sessionId || (sessionType !== 'chat' && sessionType !== 'agent')) {
    return <div className="flex h-full items-center justify-center text-sm text-destructive">快捷会话参数无效</div>
  }

  return <div className="h-full min-h-0 bg-transparent text-foreground" aria-label="快捷会话窗口">
    <React.Suspense fallback={<div className="flex h-full items-center justify-center text-xs text-muted-foreground">正在加载会话…</div>}>
      {sessionType === 'chat'
        ? <ChatViewShell conversationId={sessionId} quick={{ expanded, onToggle: () => changeExpanded(!expanded), onSent, resetEpoch }} />
        : <AgentViewShell sessionId={sessionId} compact quick={{ expanded, onToggle: () => changeExpanded(!expanded), onSent, resetEpoch }} />}
    </React.Suspense>
  </div>
}
