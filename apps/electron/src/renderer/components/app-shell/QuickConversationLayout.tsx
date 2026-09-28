import * as React from 'react'

export interface QuickConversationLayoutOptions {
  expanded: boolean
  onToggle: () => void
  title?: string
  resetEpoch: number
}

const nativeDragRegion = { WebkitAppRegion: 'drag' } as React.CSSProperties
const COMPACT_DRAG_THRESHOLD = 4

interface CompactDragGesture {
  pointerId: number
  startClientX: number
  startClientY: number
  dragging: boolean
}

/** 单击继续交给输入控件；移动超过阈值后才把紧凑胶囊切换成窗口拖拽。 */
function useCompactWindowDrag(enabled: boolean): React.HTMLAttributes<HTMLDivElement> {
  const gesture = React.useRef<CompactDragGesture>()
  const suppressClick = React.useRef(false)

  React.useEffect(() => {
    if (!enabled && gesture.current) {
      window.axon.desktop.dragQuickChat({ phase: 'end', screenX: 0, screenY: 0 })
      gesture.current = undefined
    }
  }, [enabled])

  React.useEffect(() => () => {
    if (gesture.current) window.axon.desktop.dragQuickChat({ phase: 'end', screenX: 0, screenY: 0 })
  }, [])

  return {
    onPointerDownCapture: (event) => {
      if (!enabled || event.button !== 0 || !event.isPrimary) return
      if ((event.target as Element).closest('button, select, label')) return
      gesture.current = {
        pointerId: event.pointerId,
        startClientX: event.clientX,
        startClientY: event.clientY,
        dragging: false,
      }
      // 捕获真实指针，避免快速拖出窗口内容区后收不到 pointerup。
      try { event.currentTarget.setPointerCapture(event.pointerId) } catch { /* 合成测试事件没有原生 pointer 可捕获。 */ }
      window.axon.desktop.dragQuickChat({ phase: 'start', screenX: event.screenX, screenY: event.screenY })
    },
    onPointerMoveCapture: (event) => {
      const current = gesture.current
      if (!current || current.pointerId !== event.pointerId) return
      if (!current.dragging && Math.hypot(event.clientX - current.startClientX, event.clientY - current.startClientY) < COMPACT_DRAG_THRESHOLD) return
      if (!current.dragging) {
        current.dragging = true
        suppressClick.current = true
        window.getSelection()?.removeAllRanges()
        if (document.activeElement instanceof HTMLElement) document.activeElement.blur()
      }
      event.preventDefault()
      window.axon.desktop.dragQuickChat({ phase: 'move', screenX: event.screenX, screenY: event.screenY })
    },
    onPointerUpCapture: (event) => {
      const current = gesture.current
      if (!current || current.pointerId !== event.pointerId) return
      window.axon.desktop.dragQuickChat({ phase: 'end', screenX: event.screenX, screenY: event.screenY })
      gesture.current = undefined
      if (event.currentTarget.hasPointerCapture(event.pointerId)) event.currentTarget.releasePointerCapture(event.pointerId)
      if (current.dragging) window.setTimeout(() => { suppressClick.current = false }, 0)
    },
    onPointerCancelCapture: (event) => {
      if (gesture.current?.pointerId !== event.pointerId) return
      window.axon.desktop.dragQuickChat({ phase: 'end', screenX: event.screenX, screenY: event.screenY })
      gesture.current = undefined
      if (event.currentTarget.hasPointerCapture(event.pointerId)) event.currentTarget.releasePointerCapture(event.pointerId)
      suppressClick.current = false
    },
    onClickCapture: (event) => {
      if (!suppressClick.current) return
      event.preventDefault()
      event.stopPropagation()
      suppressClick.current = false
    },
  }
}

/** 快捷窗口只在展开时挂载历史区；输入与权限交互始终留在底部。 */
export function QuickConversationLayout({ options, context, composer }: {
  options: QuickConversationLayoutOptions
  context: React.ReactNode
  composer: React.ReactNode
}): React.ReactElement {
  const [contextMounted, setContextMounted] = React.useState(options.expanded)
  React.useEffect(() => {
    if (options.expanded) setContextMounted(true)
  }, [options.expanded])
  const compactDragHandlers = useCompactWindowDrag(!options.expanded)

  return <div className={`relative h-full min-h-0 px-2 pb-2 ${options.expanded ? 'pt-3' : 'pt-5'}`}>
    {!options.expanded && <span
      data-quick-window-drag
      className="absolute left-6 top-0 z-20 max-w-48 cursor-grab select-none truncate rounded-full border border-[#E8ECF2] bg-white px-2.5 py-0.5 text-[11px] font-medium text-[#59616E] shadow-sm active:cursor-grabbing"
      style={nativeDragRegion}
      title={`${options.title ?? '快捷会话'} · 拖动调整位置`}
    >{options.title}</span>}
    <div {...compactDragHandlers} className={`flex min-h-0 flex-col border border-[#E9ECF0] bg-[#FFFFFF] text-[#333333] ${options.expanded ? 'h-full rounded-[28px] shadow-[0_12px_30px_rgba(30,45,70,0.12),0_2px_8px_rgba(30,45,70,0.06)]' : 'h-[70px] rounded-full shadow-[0_2px_6px_rgba(30,45,70,0.09),0_1px_3px_rgba(30,45,70,0.04)]'}`}>
    {contextMounted && <div className={`${options.expanded ? 'flex' : 'hidden'} min-h-0 flex-1 flex-col overflow-hidden rounded-t-[28px]`}>
      <div
        data-quick-window-drag
        className="shrink-0 cursor-grab select-none border-b border-[#F0F1F3] px-5 py-3 text-xs font-medium text-[#59616E] active:cursor-grabbing"
        style={nativeDragRegion}
        title={`${options.title ?? '快捷会话'} · 拖动调整位置`}
      >{options.title}</div>
      {context}
    </div>}
    <div className="relative shrink-0" style={{ WebkitAppRegion: 'drag' } as React.CSSProperties}>
      <button
        type="button"
        aria-label={options.expanded ? '收起会话上下文' : '展开会话上下文'}
        aria-expanded={options.expanded}
        onClick={options.onToggle}
        style={{ WebkitAppRegion: 'no-drag' } as React.CSSProperties}
        className="absolute -top-2 left-1/2 z-10 flex h-5 w-10 -translate-x-1/2 items-center justify-center rounded-full border border-[#ECEEF2] bg-white text-[#777777] shadow-sm transition-colors hover:bg-[#F3F5F7] hover:text-[#333333]"
      >
        <svg width="12" height="12" viewBox="0 0 12 12" fill="none" aria-hidden="true"><path d={options.expanded ? 'm2.5 4.5 3.5 3 3.5-3' : 'm2.5 7.5 3.5-3 3.5 3'} stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" strokeLinejoin="round" /></svg>
      </button>
      <div className={options.expanded ? 'mx-4 mb-4 mt-3 overflow-hidden rounded-full border border-[#D4DDE8] bg-white shadow-[0_2px_10px_rgba(30,45,70,0.06)]' : 'max-h-full overflow-y-auto'} style={{ WebkitAppRegion: 'no-drag' } as React.CSSProperties}>{composer}</div>
    </div>
  </div></div>
}
