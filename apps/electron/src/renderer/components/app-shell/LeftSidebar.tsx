/**
 * 左侧栏：Chat 与 Agent 都展示主进程会话索引。
 */

import * as React from 'react'
import { createPortal } from 'react-dom'
import { useAtom, useAtomValue, useSetAtom } from 'jotai'
import { ChevronRight, PanelLeft, Plus, Search, Settings, Trash2 } from 'lucide-react'
import { AgentModeIcon, ChatIcon, ProjectFolderIcon } from '@/components/icons/WorkbenchIcons'
import { appModeAtom } from '@/atoms/app-mode'
import {
  activeTabIdAtom,
  closeTab,
  openTab,
  tabsAtom,
} from '@/atoms/tab-atoms'
import {
  CONVERSATION_MIN_WIDTH,
  LEFT_SIDEBAR_COLLAPSED_WIDTH,
  LEFT_SIDEBAR_DEFAULT_WIDTH,
  LEFT_SIDEBAR_MAX_WIDTH,
  LEFT_SIDEBAR_MIN_WIDTH,
  PANEL_RESIZE_HANDLE_WIDTH,
  RIGHT_PANEL_RAIL_WIDTH,
  leftSidebarWidthAtom,
  rightPanelCollapsedAtom,
  rightPanelWidthAtom,
  sidebarCollapsedAtom,
} from '@/atoms/panel-layout'
import { cn } from '@/lib/utils'
import { ModeSwitcher } from './ModeSwitcher'
import { settingsOpenAtom } from '@/atoms/settings-tab'
import { chatStateAtom } from '@/atoms/chat-state'
import { agentStateAtom } from '@/atoms/agent-state'
import { useChatController } from '@/components/chat/ChatStateProvider'
import { useCreateChatConversation } from '@/components/chat/useCreateChatConversation'
import type { AgentProject, ConversationMeta } from '@axon/shared'
import { useCreateAgentSession } from '@/components/agent/useCreateAgentSession'
import { AgentSessionCreateMenu } from '@/components/agent/AgentSessionCreateMenu'
import { useAgentController } from '@/components/agent/AgentStateProvider'
import { PanelResizeHandle } from './PanelResizeHandle'
import { buildAgentProjectTree } from '@/lib/agent-session-list'
import { ProjectActions, ProjectCreateActions } from '@/components/agent/ProjectActions'
import type { AgentRuntimeId } from '@axon/shared'

export function LeftSidebar({ isWindows }: { isWindows: boolean }): React.ReactElement {
  const appMode = useAtomValue(appModeAtom)
  const setAppMode = useSetAtom(appModeAtom)
  const [tabs, setTabs] = useAtom(tabsAtom)
  const [activeTabId, setActiveTabId] = useAtom(activeTabIdAtom)
  const [collapsed, setCollapsed] = useAtom(sidebarCollapsedAtom)
  const [width, setWidth] = useAtom(leftSidebarWidthAtom)
  const rightPanelCollapsed = useAtomValue(rightPanelCollapsedAtom)
  const rightPanelWidth = useAtomValue(rightPanelWidthAtom)
  const setSettingsOpen = useSetAtom(settingsOpenAtom)
  const chatState = useAtomValue(chatStateAtom)
  const chatController = useChatController()
  const { createChatConversation, creating: creatingChat, creationReady, createError: chatCreateError } = useCreateChatConversation()
  const { createAgentSession, creating: creatingAgent, createError: agentCreateError } = useCreateAgentSession()
  const agentController = useAgentController()
  const agentState = useAtomValue(agentStateAtom)
  const [deleteError, setDeleteError] = React.useState<string | null>(null)
  const [projectError, setProjectError] = React.useState<string | null>(null)
  const [agentSearchQuery, setAgentSearchQuery] = React.useState('')
  const [hoveredProject, setHoveredProject] = React.useState<{
    project: AgentProject; sessionCount: number; left: number; top: number
  } | null>(null)
  const [collapsedProjects, setCollapsedProjects] = React.useState<Set<string>>(() => new Set())
  const agentProjectTree = React.useMemo(
    () => buildAgentProjectTree(agentState.projects, agentState.sessions, agentSearchQuery),
    [agentSearchQuery, agentState.projects, agentState.sessions],
  )

  const handleCreate = React.useCallback(() => {
    if (appMode === 'chat') {
      void createChatConversation()
      return
    }
    setCollapsed(false)
  }, [appMode, createChatConversation, setCollapsed])

  /** 会话必须从具体项目节点创建，以此保证 projectId 在首次落盘时就明确。 */
  const handleCreateAgentSession = React.useCallback((projectId: string, runtimeId: AgentRuntimeId) => {
    setHoveredProject(null)
    void createAgentSession(projectId, runtimeId).then((session) => {
      if (!session) return
      const result = openTab(tabs, { type: 'agent', sessionId: session.id, title: session.title })
      setTabs(result.tabs)
      setActiveTabId(result.activeTabId)
      setAppMode('agent')
      setCollapsedProjects((current) => {
        const next = new Set(current)
        next.delete(projectId)
        return next
      })
    })
  }, [createAgentSession, setActiveTabId, setAppMode, setTabs, tabs])

  /** 悬停信息使用页面顶层定位，完整路径不会被侧栏滚动区域截断。 */
  const showProjectInfo = (project: AgentProject, sessionCount: number, target: HTMLElement): void => {
    const rect = target.getBoundingClientRect()
    setHoveredProject({
      project, sessionCount,
      left: Math.max(8, Math.min(rect.right + 8, window.innerWidth - 296)),
      top: Math.max(8, Math.min(rect.top, window.innerHeight - 160)),
    })
  }

  const handleSelect = React.useCallback((tabId: string) => {
    const tab = tabs.find((item) => item.id === tabId)
    if (!tab) return
    setAppMode(tab.type)
    setActiveTabId(tab.id)
  }, [setActiveTabId, setAppMode, tabs])

  const handleSelectConversation = React.useCallback((conversation: ConversationMeta) => {
    const result = openTab(tabs, {
      type: 'chat',
      sessionId: conversation.id,
      title: conversation.title,
    })
    setAppMode('chat')
    setTabs(result.tabs)
    setActiveTabId(result.activeTabId)
  }, [setActiveTabId, setAppMode, setTabs, tabs])

  const handleSelectAgentSession = React.useCallback((session: { id: string; title: string }) => {
    const result = openTab(tabs, { type: 'agent', sessionId: session.id, title: session.title })
    setTabs(result.tabs)
    setActiveTabId(result.activeTabId)
    setAppMode('agent')
  }, [setActiveTabId, setAppMode, setTabs, tabs])

  /** 删除会话后同步清理内部视图缓存；主进程已先完成索引和 JSONL 清理。 */
  const handleDeleteConversation = React.useCallback(async (conversation: ConversationMeta) => {
    if (!window.confirm(`删除对话“${conversation.title}”？此操作不可撤销。`)) return
    setDeleteError(null)
    try {
      await chatController.deleteConversation(conversation.id)
      const result = closeTab(tabs, activeTabId, conversation.id)
      setTabs(result.tabs)
      setActiveTabId(result.activeTabId)
    } catch {
      setDeleteError('删除对话失败')
    }
  }, [activeTabId, chatController, setActiveTabId, setTabs, tabs])

  /** 删除会话后同步清理视图缓存，但不影响所属项目及其他会话。 */
  const handleDeleteAgentSession = React.useCallback(async (session: { id: string; title: string }) => {
    if (!window.confirm(`删除 Agent 会话“${session.title}”？此操作不可撤销。`)) return
    setDeleteError(null)
    try {
      await agentController.deleteSession(session.id)
      const result = closeTab(tabs, activeTabId, session.id)
      setTabs(result.tabs)
      setActiveTabId(result.activeTabId)
    } catch {
      setDeleteError('删除 Agent 会话失败')
    }
  }, [activeTabId, agentController, setActiveTabId, setTabs, tabs])

  if (collapsed) {
    return (
      <aside
        aria-label="左侧会话栏"
        style={{ width: LEFT_SIDEBAR_COLLAPSED_WIDTH }}
        className={cn(
          'flex h-full shrink-0 flex-col items-center gap-1 border-r border-border-subtle bg-[hsl(var(--sidebar-surface))] px-2 pb-2',
          !isWindows && 'pt-10',
          isWindows && 'pt-2',
        )}
      >
        {(['agent', 'chat'] as const).map((mode) => {
          const Icon = mode === 'agent' ? AgentModeIcon : ChatIcon
          return (
            <button
              key={mode}
              type="button"
              title={mode === 'agent' ? 'Agent 模式' : 'Chat 模式'}
              aria-label={mode === 'agent' ? 'Agent 模式' : 'Chat 模式'}
              onClick={() => {
                setAppMode(mode)
                const existing = [...tabs].reverse().find((tab) => tab.type === mode)
                if (existing) setActiveTabId(existing.id)
              }}
              className={cn(
                'flex h-8 w-8 items-center justify-center rounded-md text-muted-foreground hover:bg-muted hover:text-foreground focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-ring',
                appMode === mode && 'bg-muted text-foreground',
              )}
            >
              <Icon size={14} />
            </button>
          )
        })}
        <button
          type="button"
          title={appMode === 'chat' ? '新建对话' : '新建 Agent 项目'}
          aria-label={appMode === 'chat' ? '新建对话' : '新建 Agent 项目'}
          disabled={creatingChat || creatingAgent || (appMode === 'chat' && !creationReady)}
          onClick={handleCreate}
          className="mt-1 flex h-8 w-8 items-center justify-center rounded-md border text-muted-foreground hover:bg-muted hover:text-foreground focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-ring"
        >
          <Plus size={14} />
        </button>
        <button
          type="button"
          title="设置"
          aria-label="设置"
          onClick={() => setSettingsOpen(true)}
          className="mt-auto flex h-8 w-8 items-center justify-center rounded-md text-muted-foreground hover:bg-muted hover:text-foreground"
        >
          <Settings size={14} />
        </button>
        <button
          type="button"
          title="展开侧栏"
          aria-label="展开侧栏"
          onClick={() => setCollapsed(false)}
          className="flex h-8 w-8 items-center justify-center rounded-md text-muted-foreground hover:bg-muted hover:text-foreground"
        >
          <PanelLeft size={14} />
        </button>
      </aside>
    )
  }

  const getMaxWidth = (): number => {
    const rightSpace = appMode === 'agent'
      ? RIGHT_PANEL_RAIL_WIDTH + (rightPanelCollapsed ? 0 : rightPanelWidth + PANEL_RESIZE_HANDLE_WIDTH)
      : 0
    return Math.max(LEFT_SIDEBAR_MIN_WIDTH, Math.min(
      LEFT_SIDEBAR_MAX_WIDTH,
      window.innerWidth - CONVERSATION_MIN_WIDTH - rightSpace - PANEL_RESIZE_HANDLE_WIDTH,
    ))
  }

  return <>
    <aside
      aria-label="左侧会话栏"
      style={{ width }}
      className={cn(
        'flex h-full shrink-0 flex-col border-r border-border-subtle bg-[hsl(var(--sidebar-surface))] px-2 pb-2',
        !isWindows && 'pt-10',
        isWindows && 'pt-2',
      )}
    >
      <div className="px-1"><ModeSwitcher /></div>

      {appMode === 'chat' ? <button
          type="button"
          disabled={creatingChat || !creationReady}
          onClick={handleCreate}
          className="mt-3 flex h-8 items-center justify-center gap-1.5 rounded-md border bg-background text-xs text-muted-foreground transition-colors hover:bg-muted hover:text-foreground disabled:opacity-40"
        >
          <Plus size={14} />
          {!creationReady ? '正在加载渠道…' : creatingChat ? '正在新建…' : '新建对话'}
        </button>
        : null}

      <div className="mt-2 flex min-h-6 items-center justify-between gap-1 px-2">
        <span className="font-mono text-[11px] font-medium text-muted-foreground">
          {appMode === 'chat' ? '全部对话' : '项目与会话'}
        </span>
        {appMode === 'agent' && <ProjectCreateActions compact disabled={creatingAgent} onError={setProjectError} />}
      </div>

      {appMode === 'agent' && agentState.projects.length > 0 && (
        <label className="relative mt-1 block px-1">
          <Search size={12} className="pointer-events-none absolute left-3 top-1/2 -translate-y-1/2 text-muted-foreground" />
          <input
            type="search"
            aria-label="搜索 Agent 会话"
            value={agentSearchQuery}
            onChange={(event) => setAgentSearchQuery(event.target.value)}
            placeholder="搜索项目或会话"
            className="h-7 w-full rounded border bg-muted/40 pl-7 pr-2 text-xs outline-none placeholder:text-muted-foreground focus:bg-background focus:ring-1 focus:ring-ring"
          />
        </label>
      )}

      <div onScroll={() => setHoveredProject(null)} className="mt-3 min-h-0 flex-1 space-y-2 overflow-y-auto scrollbar-none">
        {appMode === 'chat' ? (
          chatState.conversationsStatus === 'loading' && chatState.conversations.length === 0 ? (
            <p className="px-2 py-6 text-center text-xs text-muted-foreground">正在加载对话…</p>
          ) : chatState.conversationsStatus === 'error' && chatState.conversations.length === 0 ? (
            <p className="px-2 py-6 text-center text-xs text-destructive">加载对话失败</p>
          ) : chatState.conversations.length === 0 ? (
            <p className="px-2 py-6 text-center text-xs text-muted-foreground">暂无对话</p>
          ) : chatState.conversations.map((conversation) => (
            <div key={conversation.id} className={cn('group flex h-7 items-center rounded hover:bg-muted/60', activeTabId === conversation.id && 'bg-muted/70')}>
              <button
                type="button"
                onClick={() => handleSelectConversation(conversation)}
                className={cn(
                  'flex h-full min-w-0 flex-1 items-center gap-1.5 rounded px-2 text-left text-xs transition-colors focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-ring',
                  activeTabId === conversation.id ? 'text-foreground' : 'text-muted-foreground hover:text-foreground',
                )}
              >
                <span className="truncate">{conversation.title}</span>
              </button>
              <button
                type="button"
                aria-label={`删除对话 ${conversation.title}`}
                onClick={() => void handleDeleteConversation(conversation)}
                className="mr-1 flex size-6 shrink-0 items-center justify-center rounded text-muted-foreground opacity-0 hover:bg-background hover:text-destructive group-hover:opacity-100 group-focus-within:opacity-100 focus-visible:opacity-100 focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-ring"
              >
                <Trash2 size={12} />
              </button>
            </div>
          ))
        ) : agentState.projectsStatus === 'loading' && agentState.projects.length === 0 ? (
          <p className="px-2 py-6 text-center text-xs text-muted-foreground">正在加载 Agent 项目…</p>
        ) : agentState.projectsStatus === 'error' && agentState.projects.length === 0 ? (
          <p className="px-2 py-6 text-center text-xs text-destructive">加载 Agent 项目失败</p>
        ) : agentState.projects.length === 0 ? (
          <p className="px-2 py-6 text-center text-xs text-muted-foreground">暂无项目，请先新建项目</p>
        ) : agentProjectTree.length === 0 ? (
          <p className="px-2 py-6 text-center text-xs text-muted-foreground">没有匹配的项目或会话</p>
        ) : agentProjectTree.map(({ project, sessions }) => {
          const projectCollapsed = collapsedProjects.has(project.id) && !agentSearchQuery.trim()
          const projectSessionCount = agentState.sessions.filter((session) => session.projectId === project.id).length
          const projectActive = sessions.some((session) => tabs.some((tab) => tab.type === 'agent' && tab.sessionId === session.id && tab.id === activeTabId))
          return <section key={project.id} aria-label={`项目 ${project.name}`}>
            <div className="group flex min-h-7 items-center rounded-md px-1 hover:bg-muted/60"
              onMouseEnter={(event) => showProjectInfo(project, projectSessionCount, event.currentTarget)}
              onMouseLeave={() => setHoveredProject(null)} onClickCapture={() => setHoveredProject(null)}>
              <button type="button" aria-label={`${projectCollapsed ? '展开' : '收起'}项目 ${project.name}`}
                onClick={() => setCollapsedProjects((current) => {
                  const next = new Set(current)
                  if (next.has(project.id)) next.delete(project.id)
                  else next.add(project.id)
                  return next
                })}
                className="flex min-w-0 flex-1 items-center gap-1.5 rounded px-1 py-1.5 text-left focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-ring">
                <ChevronRight size={12} className={cn('shrink-0 text-muted-foreground transition-transform motion-reduce:transition-none', !projectCollapsed && 'rotate-90')} />
                <ProjectFolderIcon size={14} className={cn('shrink-0', projectActive ? 'text-amber-500 dark:text-amber-400' : 'text-muted-foreground')} />
                <span className="min-w-0 truncate text-xs font-medium text-foreground">{project.name}</span>
                {project.workspace.kind === 'local' && <span className="shrink-0 rounded bg-muted px-1 font-mono text-[10px] text-muted-foreground">本地</span>}
                <span className="shrink-0 font-mono text-[10px] text-muted-foreground">{projectSessionCount} 会话</span>
              </button>
              {/* 菜单平时不占标题宽度；鼠标悬停或键盘进入节点时显示，长名称仍可截断。 */}
              <div className="pointer-events-none flex w-0 shrink-0 items-center opacity-0 transition-opacity group-hover:pointer-events-auto group-hover:w-auto group-hover:opacity-100 group-focus-within:pointer-events-auto group-focus-within:w-auto group-focus-within:opacity-100 motion-reduce:transition-none">
                <AgentSessionCreateMenu projectName={project.name} disabled={creatingAgent}
                  onCreate={(runtimeId) => handleCreateAgentSession(project.id, runtimeId)} />
                <ProjectActions project={project} sessionCount={projectSessionCount} disabled={creatingAgent} onError={setProjectError} />
              </div>
            </div>
            {!projectCollapsed && <div className="mb-1 ml-4 space-y-0.5 pl-1">
              {sessions.length === 0
                ? <p className="px-2 py-2 text-[11px] text-muted-foreground">暂无会话</p>
                : sessions.map((session) => {
                    const tab = tabs.find((item) => item.type === 'agent' && item.sessionId === session.id)
                    const isActive = tab !== undefined && activeTabId === tab.id
                    const runSource = agentState.activeRunSourcesBySession[session.id]
                    return <div key={session.id} className={cn('group/session relative flex h-7 items-center rounded hover:bg-muted/60', isActive && 'bg-muted/70')}>
                      {isActive && <span aria-hidden="true" className="pointer-events-none absolute inset-y-1.5 left-0 w-0.5 rounded-full bg-indigo-500 dark:bg-indigo-400" />}
                      <button type="button" aria-current={isActive ? 'page' : undefined}
                        aria-label={runSource ? `${session.title}（${runSource === 'external' ? '外部任务运行中' : '运行中'}）` : undefined}
                        onClick={() => handleSelectAgentSession(session)}
                        className={cn(
                          'flex h-full min-w-0 flex-1 items-center gap-1.5 rounded px-2 text-left text-xs focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-ring',
                          isActive ? 'text-foreground' : 'text-muted-foreground hover:text-foreground',
                        )}>
                        <span className="truncate">{session.title}</span>
                        {session.runtimeId === 'zima' && <span className="shrink-0 rounded bg-muted px-1 font-mono text-[10px]">Zima</span>}
                        {runSource === 'external' && <span className="shrink-0 rounded bg-muted px-1 font-mono text-[10px]">外部</span>}
                      </button>
                      <button type="button" aria-label={`删除 Agent 会话 ${session.title}`}
                        onClick={() => void handleDeleteAgentSession(session)}
                        className="mr-1 flex size-6 shrink-0 items-center justify-center rounded text-muted-foreground opacity-0 hover:bg-background hover:text-destructive group-hover/session:opacity-100 group-focus-within/session:opacity-100 focus-visible:opacity-100 focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-ring">
                        <Trash2 size={12} />
                      </button>
                    </div>
                  })}
            </div>}
          </section>
        })}
        {(chatCreateError || agentCreateError || deleteError || projectError) && (
          <p className="px-2 py-2 text-xs text-destructive">{chatCreateError ?? agentCreateError ?? deleteError ?? projectError}</p>
        )}
      </div>

      <div className="flex h-9 shrink-0 items-end gap-1 border-t border-border-subtle pt-1">
        <button
          type="button"
          onClick={() => setSettingsOpen(true)}
          className="flex h-7 min-w-0 flex-1 items-center gap-1.5 rounded px-2 text-xs text-muted-foreground hover:bg-muted hover:text-foreground focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-ring"
        >
          <Settings size={14} />
          设置
        </button>
        <button
          type="button"
          title="收起侧栏"
          aria-label="收起侧栏"
          onClick={() => setCollapsed(true)}
          className="flex h-7 w-7 shrink-0 items-center justify-center rounded text-muted-foreground hover:bg-muted hover:text-foreground focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-ring"
        >
          <PanelLeft size={14} />
        </button>
      </div>
    </aside>
    {hoveredProject && createPortal(<div role="tooltip" aria-label={`项目 ${hoveredProject.project.name} 信息`}
      style={{ left: hoveredProject.left, top: hoveredProject.top }}
      className="pointer-events-none fixed z-[90] w-72 rounded-md border bg-popover p-3 text-xs text-popover-foreground shadow-lg">
      <p className="font-medium">{hoveredProject.project.name}</p>
      <p className="mt-2 text-muted-foreground">工作区 · {hoveredProject.project.workspace.kind === 'local' ? '本地目录' : '应用管理的默认目录'}</p>
      {hoveredProject.project.workspace.kind === 'local' && <p className="mt-1 break-all">{hoveredProject.project.workspace.path}</p>}
      {hoveredProject.project.workspace.kind === 'local' && hoveredProject.project.workspace.status && hoveredProject.project.workspace.status !== 'available'
        && <p className="mt-1 text-destructive">目录当前不可用</p>}
      <p className="mt-2 text-muted-foreground">{hoveredProject.sessionCount} 个会话 · 项目记忆{hoveredProject.project.memoryEnabled ? '已启用' : '未启用'}</p>
    </div>, document.body)}
    <PanelResizeHandle
      ariaLabel="调整左侧栏宽度"
      side="left"
      width={width}
      minWidth={LEFT_SIDEBAR_MIN_WIDTH}
      defaultWidth={LEFT_SIDEBAR_DEFAULT_WIDTH}
      getMaxWidth={getMaxWidth}
      onResize={setWidth}
    />
  </>
}
