import * as React from 'react'
import { useAtom, useAtomValue } from 'jotai'
import { Globe, PanelRight, Terminal, X } from 'lucide-react'
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
import { FilesPanelIcon, ThinkingIcon } from '@/components/icons/WorkbenchIcons'
import { cn } from '@/lib/utils'
import { WorkspaceFileTree } from './WorkspaceFileTree'
import { ProjectMemoryPanel } from './ProjectMemoryPanel'

type AgentSidePanelView = 'files' | 'memory' | 'terminal' | 'browser'

interface AgentSidePanelProps {
  isActive: boolean
  projectId: string | undefined
  workspaceUpdatedAt: number | undefined
  memoryEnabled: boolean
}

interface PanelIconProps {
  size?: number
}

interface PanelItem {
  id: AgentSidePanelView
  label: string
  icon: (props: PanelIconProps) => React.ReactNode
}

const PANEL_ITEMS: readonly PanelItem[] = [
  { id: 'files', label: '文件', icon: FilesPanelIcon },
  { id: 'memory', label: '项目记忆', icon: ThinkingIcon },
  { id: 'terminal', label: '终端', icon: Terminal },
  { id: 'browser', label: '浏览器', icon: Globe },
]

/** 统一承载 Agent 辅助窗口；图标轨只切换视图，具体能力由各面板独立管理。 */
export function AgentSidePanel({ isActive, projectId, workspaceUpdatedAt, memoryEnabled }: AgentSidePanelProps): React.ReactElement {
  const [activeView, setActiveView] = React.useState<AgentSidePanelView>('files')
  const [fileTreeOpen, setFileTreeOpen] = React.useState(false)
  const [previewScope, setPreviewScope] = React.useState<string | null>(null)
  const fileButtonRef = React.useRef<HTMLButtonElement>(null)
  const fileTreeId = React.useId()
  const [collapsed, setCollapsed] = useAtom(rightPanelCollapsedAtom)
  const [width, setWidth] = useAtom(rightPanelWidthAtom)
  const leftCollapsed = useAtomValue(sidebarCollapsedAtom)
  const leftWidth = useAtomValue(leftSidebarWidthAtom)
  const workspaceKey = `${projectId}:${workspaceUpdatedAt}`
  const hasFilePreview = !!projectId && previewScope === workspaceKey
  const panelExpanded = isActive && !collapsed && (activeView !== 'files' || hasFilePreview)

  // 只有前台会话在选择/切换时同步共享布局；不订阅 collapsed 重写，避免后台旧投影竞争及覆盖手动收栏。
  React.useLayoutEffect(() => {
    if (isActive && activeView === 'files') setCollapsed(!hasFilePreview)
  }, [activeView, hasFilePreview, isActive, setCollapsed])

  /** 文件选择只报告当前工作区是否有预览；新选择展开，关闭或工作区切换收回空栏。 */
  const handlePreviewOpenChange = React.useCallback((open: boolean): void => {
    setPreviewScope(open ? workspaceKey : null)
  }, [workspaceKey])

  const getMaxWidth = (): number => {
    const leftSpace = leftCollapsed
      ? LEFT_SIDEBAR_COLLAPSED_WIDTH
      : leftWidth + PANEL_RESIZE_HANDLE_WIDTH
    return Math.max(RIGHT_PANEL_MIN_WIDTH, Math.min(
      RIGHT_PANEL_MAX_WIDTH,
      window.innerWidth - CONVERSATION_MIN_WIDTH - leftSpace - RIGHT_PANEL_RAIL_WIDTH - PANEL_RESIZE_HANDLE_WIDTH,
    ))
  }

  /** 只收起文件树；键盘/关闭按钮归还焦点，外部点击保留目标控件的焦点。 */
  const closeFileTree = React.useCallback((restoreFocus = true): void => {
    setFileTreeOpen(false)
    if (restoreFocus) fileButtonRef.current?.focus()
  }, [])

  return <aside aria-label="Agent 右侧工具面板" className="relative flex h-full shrink-0 border-l border-border-subtle bg-[hsl(var(--sidebar-surface))]">
    {panelExpanded && <PanelResizeHandle
      ariaLabel="调整右侧栏宽度"
      side="right"
      width={width}
      minWidth={RIGHT_PANEL_MIN_WIDTH}
      defaultWidth={RIGHT_PANEL_DEFAULT_WIDTH}
      getMaxWidth={getMaxWidth}
      onResize={setWidth}
    />}
    {/* 文件工作区保持挂载，零宽度时浮层仍能从工具轨打开，预览和监听不会被收栏丢弃。 */}
    <div className={cn('relative h-full min-h-0 min-w-0 shrink-0', activeView !== 'files' && 'hidden')} style={{ width: activeView === 'files' && panelExpanded ? width : 0 }}>
      {projectId && workspaceUpdatedAt !== undefined
        ? <WorkspaceFileTree key={workspaceKey} projectId={projectId} workspaceUpdatedAt={workspaceUpdatedAt}
            treeOpen={isActive && activeView === 'files' && fileTreeOpen} treeId={fileTreeId} treeAnchorRef={fileButtonRef}
            previewVisible={activeView === 'files' && panelExpanded} onPreviewOpenChange={handlePreviewOpenChange} onCloseTree={closeFileTree} />
        : fileTreeOpen && <section id={fileTreeId} role="dialog" aria-modal="false" aria-label="工作区文件树" className="workspace-file-tree-popover absolute right-3 top-2 z-30 w-64 rounded-[8px] border text-popover-foreground shadow-sm">
            <span aria-hidden="true" className="workspace-file-tree-pointer pointer-events-none absolute" />
            <div className="flex h-8 items-center justify-between border-b border-border-subtle px-3 text-xs font-medium">工作区文件<button type="button" aria-label="收起工作区文件树" onClick={() => closeFileTree()} className="flex size-6 items-center justify-center rounded text-muted-foreground hover:bg-muted/60 focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-ring"><X size={12} /></button></div>
            <p className="px-3 py-6 text-xs text-muted-foreground">请先为当前会话选择工作区</p>
          </section>}
    </div>
    {/* 后台记忆编辑器继续缓存，前台文件空态改变共享宽度时不能丢弃其未保存草稿。 */}
    {activeView !== 'files' && (!isActive || !collapsed) && <div hidden={!panelExpanded} className={cn('flex min-h-0 min-w-0 flex-col', !panelExpanded && 'hidden')} style={{ width }}>
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
    <nav aria-label="切换右侧工具面板" style={{ width: RIGHT_PANEL_RAIL_WIDTH }} className="titlebar-drag-region flex shrink-0 flex-col items-center gap-2 border-l border-border-subtle px-1.5 pb-2 pt-2.5" role="toolbar" aria-orientation="vertical">
      {PANEL_ITEMS.map((item) => {
        const Icon = item.icon
        const active = activeView === item.id && (item.id === 'files' ? fileTreeOpen : panelExpanded)
        return <button
          type="button"
          key={item.id}
          ref={item.id === 'files' ? fileButtonRef : undefined}
          title={item.label}
          aria-label={`打开${item.label}面板`}
          aria-pressed={active}
          aria-expanded={item.id === 'files' ? fileTreeOpen : undefined}
          aria-controls={item.id === 'files' ? fileTreeId : undefined}
          aria-haspopup={item.id === 'files' ? 'dialog' : undefined}
          onClick={() => {
            if (item.id === 'files' && activeView === 'files' && fileTreeOpen) {
              closeFileTree()
              return
            }
            setActiveView(item.id)
            setCollapsed(item.id === 'files' && !hasFilePreview)
            setFileTreeOpen(item.id === 'files')
          }}
          className={cn('titlebar-no-drag relative flex size-7 items-center justify-center rounded-md border border-transparent transition-colors focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-ring motion-reduce:transition-none', active ? 'border-border bg-background text-foreground shadow-xs' : 'text-muted-foreground hover:bg-muted/60 hover:text-foreground')}
        >
          {active && <span aria-hidden="true" className="absolute -left-1 top-1/2 h-3.5 w-0.5 -translate-y-1/2 rounded-r bg-foreground" />}
          <Icon size={14} />
        </button>
      })}
      {(activeView !== 'files' || hasFilePreview) && <button
        type="button"
        title={collapsed ? '展开右侧栏' : '收起右侧栏'}
        aria-label={collapsed ? '展开右侧栏' : '收起右侧栏'}
        onClick={() => {
          setFileTreeOpen(false)
          setCollapsed((value) => !value)
        }}
        className="titlebar-no-drag mt-auto flex size-7 items-center justify-center rounded-md text-muted-foreground hover:bg-muted/60 hover:text-foreground focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-ring"
      >
        <PanelRight size={14} />
      </button>}
    </nav>
  </aside>
}

function PanelPlaceholder({ title, children }: {
  title: string
  children: React.ReactNode
}): React.ReactElement {
  return <section aria-label={`${title}面板`} className="flex h-full min-h-0 flex-col">
    <div className="titlebar-drag-region flex h-11 shrink-0 items-center border-b border-border-subtle px-3 text-xs font-medium">{title}</div>
    <div className="flex min-h-0 flex-1 items-center justify-center px-4 text-center text-xs text-muted-foreground">{children}</div>
  </section>
}
