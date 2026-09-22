import * as React from 'react'
import { useAtomValue } from 'jotai'
import { tabsAtom, activeTabIdAtom, type TabItem } from '@/atoms/tab-atoms'
import { MessageSquare } from 'lucide-react'
import { cn } from '@/lib/utils'
import { useChatController } from '@/components/chat/ChatStateProvider'
import { useAgentController } from '@/components/agent/AgentStateProvider'
const AgentViewShell = React.lazy(() => import('@/components/agent/AgentViewShell').then((module) => ({
  default: module.AgentViewShell,
})))

const ChatViewShell = React.lazy(() => import('@/components/chat/ChatViewShell').then((module) => ({
  default: module.ChatViewShell,
})))

/**
 * 当前会话内容区：左侧栏负责选择，内部缓存只用于保留已打开会话状态。
 */
export function TabContent(): React.ReactElement {
  const tabs = useAtomValue(tabsAtom)
  const activeTabId = useAtomValue(activeTabIdAtom)

  if (!activeTabId || !tabs.some((tab) => tab.id === activeTabId)) {
    return (
      <div className="flex min-h-0 flex-1 flex-col items-center justify-center gap-2 bg-[hsl(var(--tab-surface))] text-muted-foreground">
        <MessageSquare size={28} />
        <p className="text-sm text-foreground">尚未选择会话</p>
        <p className="text-xs opacity-60">请从左侧新建或选择会话</p>
      </div>
    )
  }

  return (
    <div className="relative min-h-0 flex-1">
      {tabs.map((tab) => (
        <TabPane key={tab.id} tab={tab} isActive={tab.id === activeTabId} />
      ))}
    </div>
  )
}

function TabPane({ tab, isActive }: { tab: TabItem; isActive: boolean }): React.ReactElement {
  const chatController = useChatController()
  const agentController = useAgentController()
  React.useEffect(() => {
    if (!isActive) return
    // 已挂载但隐藏的会话可能由快捷浮窗写入；重新选中时读取权威历史。
    if (tab.type === 'chat') void chatController.loadMessages(tab.sessionId)
    else void agentController.loadMessages(tab.sessionId)
  }, [agentController, chatController, isActive, tab.sessionId, tab.type])
  if (tab.type === 'chat') {
    return (
      <div aria-hidden={!isActive} className={cn('absolute inset-0', !isActive && 'hidden')}>
        <React.Suspense fallback={<div className="flex h-full items-center justify-center text-xs text-muted-foreground">正在加载 Chat…</div>}>
          <ChatViewShell conversationId={tab.sessionId} />
        </React.Suspense>
      </div>
    )
  }

  return <div aria-hidden={!isActive} className={cn('absolute inset-0', !isActive && 'hidden')}><React.Suspense fallback={<div className="flex h-full items-center justify-center text-xs text-muted-foreground">正在加载 Agent…</div>}><AgentViewShell sessionId={tab.sessionId} /></React.Suspense></div>
}
