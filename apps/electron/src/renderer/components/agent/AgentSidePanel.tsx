import * as React from 'react'
import { useAtom, useAtomValue } from 'jotai'
import { Brain, FolderTree, Globe2, PanelRightClose, PanelRightOpen, Terminal } from 'lucide-react'
import type { LucideIcon } from 'lucide-react'
import {
  CONVERSATION_MIN_WIDTH,
  LEFT_SIDEBAR_COLLAPSED_WIDTH,
  PANEL_RESIZE_HANDLE_WIDTH,
  RIGHT_PANEL_DEFAULT_WIDTH,
  RIGHT_PANEL_MAX_WIDTH,
  RIGHT_PANEL_MIN_WIDTH,
  RIGHT_PANEL_RAIL_WIDTH,
  leftSidebarWidthAtom,
  rightPanelCollapsedAtom,
  rightPanelWidthAtom,
  sidebarCollapsedAtom,
} from '@/atoms/panel-layout'
import { PanelResizeHandle } from '@/components/app-shell/PanelResizeHandle'
import { WorkspaceFileTree } from './WorkspaceFileTree'
import { ProjectMemoryPanel } from './ProjectMemoryPanel'

type AgentSidePanelView = 'files' | 'memory' | 'terminal' | 'browser'

interface AgentSidePanelProps {
  projectId: string | undefined
  workspaceUpdatedAt: number | undefined
  memoryEnabled: boolean
}

const PANEL_ITEMS: ReadonlyArray<{
  id: AgentSidePanelView
  label: string
  icon: LucideIcon
}> = [
  { id: 'files', label: '文件', icon: FolderTree },
  { id: 'memory', label: '项目记忆', icon: Brain },
  { id: 'terminal', label: '终端', icon: Terminal },
  { id: 'browser', label: '浏览器', icon: Globe2 },
]

/** 统一承载 Agent 辅助窗口；图标轨只切换视图，具体能力由各面板独立管理。 */
export function AgentSidePanel({ projectId, workspaceUpdatedAt, memoryEnabled }: AgentSidePanelProps): React.ReactElement {
  const [activeView, setActiveView] = React.useState<AgentSidePanelView>('files')
  const [collapsed, setCollapsed] = useAtom(rightPanelCollapsedAtom)
  const [width, setWidth] = useAtom(rightPanelWidthAtom)
  const leftCollapsed = useAtomValue(sidebarCollapsedAtom)
  const leftWidth = useAtomValue(leftSidebarWidthAtom)

  const getMaxWidth = (): number => {
    const leftSpace = leftCollapsed
      ? LEFT_SIDEBAR_COLLAPSED_WIDTH
      : leftWidth + PANEL_RESIZE_HANDLE_WIDTH
    return Math.max(RIGHT_PANEL_MIN_WIDTH, Math.min(
      RIGHT_PANEL_MAX_WIDTH,
      window.innerWidth - CONVERSATION_MIN_WIDTH - leftSpace - RIGHT_PANEL_RAIL_WIDTH - PANEL_RESIZE_HANDLE_WIDTH,
    ))
  }

  return <aside aria-label="Agent 右侧工具面板" className="flex h-full shrink-0 border-l bg-[hsl(var(--sidebar-surface))]">
    {!collapsed && <PanelResizeHandle
      ariaLabel="调整右侧栏宽度"
      side="right"
      width={width}
      minWidth={RIGHT_PANEL_MIN_WIDTH}
      defaultWidth={RIGHT_PANEL_DEFAULT_WIDTH}
      getMaxWidth={getMaxWidth}
      onResize={setWidth}
    />}
    {!collapsed && <div className="flex min-w-0 flex-col" style={{ width }}>
      {activeView === 'files' && (
        projectId && workspaceUpdatedAt !== undefined
          ? <WorkspaceFileTree projectId={projectId} workspaceUpdatedAt={workspaceUpdatedAt} />
          : <PanelPlaceholder title="工作区文件">请先为当前会话选择工作区</PanelPlaceholder>
      )}
      {activeView === 'terminal' && <PanelPlaceholder title="终端">终端功能将在后续阶段接入</PanelPlaceholder>}
      {activeView === 'browser' && <PanelPlaceholder title="浏览器">浏览器功能将在后续阶段接入</PanelPlaceholder>}
      {activeView === 'memory' && (
        !projectId || workspaceUpdatedAt === undefined
          ? <PanelPlaceholder title="项目记忆">请先为当前会话选择项目</PanelPlaceholder>
          : memoryEnabled
            ? <ProjectMemoryPanel projectId={projectId} workspaceUpdatedAt={workspaceUpdatedAt} />
            : <PanelPlaceholder title="项目记忆">请先从左侧项目菜单启用项目记忆</PanelPlaceholder>
      )}
    </div>}
    <nav aria-label="切换右侧工具面板" style={{ width: RIGHT_PANEL_RAIL_WIDTH }} className="titlebar-drag-region flex shrink-0 flex-col items-center gap-1 border-l px-1.5 pb-2 pt-2" role="toolbar" aria-orientation="vertical">
      {PANEL_ITEMS.map((item) => {
        const Icon = item.icon
        const active = !collapsed && activeView === item.id
        return <button
          type="button"
          key={item.id}
          title={item.label}
          aria-label={`打开${item.label}面板`}
          aria-pressed={active}
          onClick={() => {
            setActiveView(item.id)
            setCollapsed(false)
          }}
          className={`titlebar-no-drag flex h-8 w-8 items-center justify-center rounded-md transition-colors ${active ? 'bg-muted text-foreground' : 'text-muted-foreground hover:bg-muted/70 hover:text-foreground'}`}
        >
          <Icon size={17} />
        </button>
      })}
      <button
        type="button"
        title={collapsed ? '展开右侧栏' : '收起右侧栏'}
        aria-label={collapsed ? '展开右侧栏' : '收起右侧栏'}
        onClick={() => setCollapsed((value) => !value)}
        className="titlebar-no-drag mt-auto flex h-8 w-8 items-center justify-center rounded-md text-muted-foreground hover:bg-muted hover:text-foreground"
      >
        {collapsed ? <PanelRightOpen size={17} /> : <PanelRightClose size={17} />}
      </button>
    </nav>
  </aside>
}

function PanelPlaceholder({ title, children }: {
  title: string
  children: React.ReactNode
}): React.ReactElement {
  return <section aria-label={`${title}面板`} className="flex h-full min-h-0 flex-col">
    <div className="titlebar-drag-region flex h-12 shrink-0 items-center border-b px-3 text-xs font-medium">{title}</div>
    <div className="flex min-h-0 flex-1 items-center justify-center px-4 text-center text-xs text-muted-foreground">{children}</div>
  </section>
}
