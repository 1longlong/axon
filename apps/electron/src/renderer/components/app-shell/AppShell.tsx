/**
 * 应用主布局骨架：[左侧会话导航] | [当前会话内容]。
 */

import * as React from 'react'
import { useAtom, useAtomValue, useSetAtom } from 'jotai'
import { appModeAtom } from '@/atoms/app-mode'
import {
  activeTabIdAtom,
  createInitialTabState,
  openTab,
  reconcileAgentTabs,
  reconcileChatTabs,
  sanitizePersistedTabState,
  tabsAtom,
} from '@/atoms/tab-atoms'
import {
  CONVERSATION_MIN_WIDTH,
  LEFT_SIDEBAR_DEFAULT_WIDTH,
  LEFT_SIDEBAR_MAX_WIDTH,
  LEFT_SIDEBAR_MIN_WIDTH,
  RIGHT_PANEL_DEFAULT_WIDTH,
  RIGHT_PANEL_MAX_WIDTH,
  RIGHT_PANEL_MIN_WIDTH,
  clampPanelWidth,
  leftSidebarWidthAtom,
  rightPanelCollapsedAtom,
  rightPanelWidthAtom,
  sidebarCollapsedAtom,
} from '@/atoms/panel-layout'
import { detectIsWindows } from '@/lib/platform'
import { cn } from '@/lib/utils'
import { WindowControls } from '@/components/WindowControls'
import { TabContent } from '@/components/tabs/TabContent'
import { LeftSidebar } from './LeftSidebar'
import type { AppSettings } from '@/types/settings'
import { settingsOpenAtom, settingsEditingAtom } from '@/atoms/settings-tab'
import { canLeaveSettings } from '@/lib/channel-form'
import { SettingsPanel } from '@/components/settings/SettingsPanel'
import { chatDraftsAtom, chatStateAtom, pruneChatDrafts, sanitizePersistedChatDrafts } from '@/atoms/chat-state'
import { agentStateAtom } from '@/atoms/agent-state'
import { useChatController } from '@/components/chat/ChatStateProvider'
import { useCreateChatConversation } from '@/components/chat/useCreateChatConversation'
import { useCreateAgentSession } from '@/components/agent/useCreateAgentSession'
import { useAgentController } from '@/components/agent/AgentStateProvider'
import type { DesktopAction } from '@/types/desktop'

const SHELL_PERSIST_DEBOUNCE_MS = 180

export function AppShell(): React.ReactElement {
  const [tabs, setTabs] = useAtom(tabsAtom)
  const [activeTabId, setActiveTabId] = useAtom(activeTabIdAtom)
  const [sidebarCollapsed, setSidebarCollapsed] = useAtom(sidebarCollapsedAtom)
  const [leftSidebarWidth, setLeftSidebarWidth] = useAtom(leftSidebarWidthAtom)
  const [rightPanelCollapsed, setRightPanelCollapsed] = useAtom(rightPanelCollapsedAtom)
  const [rightPanelWidth, setRightPanelWidth] = useAtom(rightPanelWidthAtom)
  const [chatDrafts, setChatDrafts] = useAtom(chatDraftsAtom)
  const [settingsOpen, setSettingsOpen] = useAtom(settingsOpenAtom)
  const editing = useAtomValue(settingsEditingAtom)
  const chatState = useAtomValue(chatStateAtom)
  const agentState = useAtomValue(agentStateAtom)
  const chatController = useChatController()
  const agentController = useAgentController()
  const { createChatConversation, creationReady } = useCreateChatConversation()
  const { createAgentSession } = useCreateAgentSession()
  const setAppMode = useSetAtom(appModeAtom)
  const [didRestore, setDidRestore] = React.useState(false)
  const [persistenceError, setPersistenceError] = React.useState<string | null>(null)
  const [desktopActions, setDesktopActions] = React.useState<DesktopAction[]>([])
  const [processingDesktopAction, setProcessingDesktopAction] = React.useState(false)
  const [desktopActionError, setDesktopActionError] = React.useState<string | null>(null)
  const isWindows = React.useMemo(() => detectIsWindows(), [])

  /** 其他窗口的流事件只发给其 owner；回到主窗口时从共用 JSONL 校准当前会话。 */
  React.useEffect(() => {
    if (!didRestore) return
    const refresh = (): void => {
      const active = tabs.find((tab) => tab.id === activeTabId)
      if (active?.type === 'chat') void chatController.loadMessages(active.sessionId)
      if (active?.type === 'agent') void agentController.loadMessages(active.sessionId)
      void chatController.refreshConversations()
      void agentController.refreshSessions()
    }
    window.addEventListener('focus', refresh)
    return () => window.removeEventListener('focus', refresh)
  }, [activeTabId, agentController, chatController, didRestore, tabs])

  React.useEffect(() => {
    let cancelled = false

    window.axon.settings.get()
      .then((settings: AppSettings) => {
        if (cancelled) return
        const restored = sanitizePersistedTabState(settings.tabState)
        setTabs(restored.tabs)
        setActiveTabId(restored.activeTabId)
        setSidebarCollapsed(settings.sidebarCollapsed === true)
        setLeftSidebarWidth(clampPanelWidth(settings.leftSidebarWidth, LEFT_SIDEBAR_DEFAULT_WIDTH, LEFT_SIDEBAR_MIN_WIDTH, LEFT_SIDEBAR_MAX_WIDTH))
        setRightPanelCollapsed(settings.rightPanelCollapsed === true)
        setRightPanelWidth(clampPanelWidth(settings.rightPanelWidth, RIGHT_PANEL_DEFAULT_WIDTH, RIGHT_PANEL_MIN_WIDTH, RIGHT_PANEL_MAX_WIDTH))
        // 草稿水合只补缺：恢复期间用户已输入的内容优先，不被磁盘快照覆盖。
        if (settings.chatDrafts) {
          const restoredDrafts = sanitizePersistedChatDrafts(settings.chatDrafts)
          setChatDrafts((current) => Object.keys(current).length === 0 ? restoredDrafts : { ...restoredDrafts, ...current })
        }

        const activeTab = restored.tabs.find((tab) => tab.id === restored.activeTabId)
        if (activeTab) setAppMode(activeTab.type)
      })
      .catch((error: unknown) => {
        if (cancelled) return
        const fallback = createInitialTabState()
        setTabs(fallback.tabs)
        setActiveTabId(fallback.activeTabId)
        setPersistenceError(error instanceof Error ? error.message : String(error))
      })
      .finally(() => {
        if (!cancelled) setDidRestore(true)
      })

    return () => {
      cancelled = true
    }
  }, [setChatDrafts, setActiveTabId, setAppMode, setLeftSidebarWidth, setRightPanelCollapsed, setRightPanelWidth, setSidebarCollapsed, setTabs])

  React.useEffect(() => window.axon.desktop.onAction((action) => {
    setDesktopActions((current) => [...current, action])
  }), [])

  /**
   * 托盘动作在布局恢复后串行消费，再复用现有创建 hook 落盘并打开真实会话。
   * Chat 还需等待渠道快照，否则无法可靠选择默认模型。
   */
  React.useEffect(() => {
    if (!didRestore || processingDesktopAction || desktopActions.length === 0) return
    const action = desktopActions[0]!
    if (action.type === 'new_chat' && !creationReady) return

    setProcessingDesktopAction(true)
    setDesktopActions((current) => current.slice(1))
    setDesktopActionError(null)
    setSettingsOpen(false)

    const processAction = async (): Promise<void> => {
      if (action.type === 'new_chat') {
        setAppMode('chat')
        if (!await createChatConversation()) setDesktopActionError('从托盘新建 Chat 失败')
        return
      }

      setAppMode('agent')
      const session = await createAgentSession(action.projectId)
      if (!session) {
        setDesktopActionError('从托盘新建 Agent 失败')
        return
      }
      const item = {
        type: 'agent',
        sessionId: session.id,
        title: session.title,
      } as const
      setTabs((current) => openTab(current, item).tabs)
      setActiveTabId(session.id)
    }

    void processAction().finally(() => setProcessingDesktopAction(false))
  }, [createAgentSession, createChatConversation, creationReady, desktopActions, didRestore, processingDesktopAction, setActiveTabId, setAppMode, setSettingsOpen, setTabs])

  React.useEffect(() => {
    if (!didRestore) return

    const timer = window.setTimeout(() => {
      void window.axon.settings.update({
        tabState: { tabs, activeTabId },
        sidebarCollapsed,
        leftSidebarWidth,
        rightPanelCollapsed,
        rightPanelWidth,
        chatDrafts,
      }).then(() => setPersistenceError(null)).catch((error: unknown) => {
        setPersistenceError(error instanceof Error ? error.message : String(error))
      })
    }, SHELL_PERSIST_DEBOUNCE_MS)

    return () => window.clearTimeout(timer)
  }, [activeTabId, chatDrafts, didRestore, leftSidebarWidth, rightPanelCollapsed, rightPanelWidth, sidebarCollapsed, tabs])

  React.useEffect(() => {
    if (!didRestore || chatState.conversationsStatus !== 'ready') return
    const reconciled = reconcileChatTabs(tabs, activeTabId, chatState.conversations)
    if (reconciled.tabs !== tabs) setTabs(reconciled.tabs)
    if (reconciled.activeTabId !== activeTabId) setActiveTabId(reconciled.activeTabId)
    // 会话列表就绪后修剪草稿：清理已删除会话的残留草稿，防止输入内容“复活”。
    const pruned = pruneChatDrafts(chatDrafts, chatState.conversations.map((conversation) => conversation.id))
    if (pruned !== chatDrafts) setChatDrafts(pruned)
  }, [chatDrafts, chatState.conversations, chatState.conversationsStatus, didRestore, activeTabId, setChatDrafts, setActiveTabId, setTabs, tabs])

  React.useEffect(() => {
    if (!didRestore || agentState.sessionsStatus !== 'ready') return
    const reconciled = reconcileAgentTabs(tabs, activeTabId, agentState.sessions)
    if (reconciled.tabs !== tabs) setTabs(reconciled.tabs)
    if (reconciled.activeTabId !== activeTabId) setActiveTabId(reconciled.activeTabId)
  }, [activeTabId, agentState.sessions, agentState.sessionsStatus, didRestore, setActiveTabId, setTabs, tabs])

  const handleCloseSettings = React.useCallback(() => {
    if (!canLeaveSettings(editing, () => window.confirm('放弃未保存的渠道更改？'))) return
    setSettingsOpen(false)
    void chatController.refreshChannels()
  }, [chatController, editing, setSettingsOpen])

  return (
    <>
      <WindowControls />
      <div className={cn('h-screen w-screen overflow-hidden bg-background text-foreground', isWindows && 'pt-8')}>
        {settingsOpen ? (
          <SettingsPanel onClose={handleCloseSettings} />
        ) : (
          <div className="flex h-full w-full">
            <LeftSidebar isWindows={isWindows} />
            <main style={{ minWidth: CONVERSATION_MIN_WIDTH }} className="flex flex-1 flex-col bg-content-area">
              <TabContent />
            </main>
          </div>
        )}
      </div>
      {persistenceError && (
        <div className="fixed bottom-3 right-3 z-[110] max-w-sm rounded-md bg-destructive px-3 py-2 text-xs text-destructive-foreground shadow-lg">
          布局保存失败：{persistenceError}
        </div>
      )}
      {desktopActionError && (
        <div className="fixed bottom-3 left-1/2 z-[110] -translate-x-1/2 rounded-md bg-destructive px-3 py-2 text-xs text-destructive-foreground shadow-lg">
          {desktopActionError}
        </div>
      )}
    </>
  )
}
