import * as React from 'react'

interface PanelResizeHandleProps {
  ariaLabel: string
  side: 'left' | 'right'
  width: number
  minWidth: number
  defaultWidth: number
  getMaxWidth(): number
  onResize(width: number): void
}

/** 处理左右面板的指针与键盘缩放，并在拖拽结束时恢复页面选择状态。 */
export function PanelResizeHandle({
  ariaLabel,
  side,
  width,
  minWidth,
  defaultWidth,
  getMaxWidth,
  onResize,
}: PanelResizeHandleProps): React.ReactElement {
  const drag = React.useRef<{ pointerId: number; startX: number; startWidth: number } | null>(null)
  const previousBodyStyle = React.useRef<{ cursor: string; userSelect: string } | null>(null)

  const finishDrag = React.useCallback((): void => {
    drag.current = null
    if (!previousBodyStyle.current) return
    document.body.style.cursor = previousBodyStyle.current.cursor
    document.body.style.userSelect = previousBodyStyle.current.userSelect
    previousBodyStyle.current = null
  }, [])

  React.useEffect(() => finishDrag, [finishDrag])

  const resizeFromDelta = React.useCallback((deltaX: number): void => {
    const next = (drag.current?.startWidth ?? width) + (side === 'left' ? deltaX : -deltaX)
    onResize(Math.min(getMaxWidth(), Math.max(minWidth, Math.round(next))))
  }, [getMaxWidth, minWidth, onResize, side, width])

  return <div
    role="separator"
    aria-label={ariaLabel}
    aria-orientation="vertical"
    aria-valuemin={minWidth}
    aria-valuemax={getMaxWidth()}
    aria-valuenow={width}
    tabIndex={0}
    className="group relative w-1 shrink-0 cursor-col-resize outline-none focus:bg-primary/20"
    onDoubleClick={() => onResize(defaultWidth)}
    onKeyDown={(event) => {
      if (event.key !== 'ArrowLeft' && event.key !== 'ArrowRight') return
      event.preventDefault()
      const physicalDelta = event.key === 'ArrowRight' ? 16 : -16
      resizeFromDelta(physicalDelta)
    }}
    onPointerDown={(event) => {
      event.preventDefault()
      drag.current = { pointerId: event.pointerId, startX: event.clientX, startWidth: width }
      previousBodyStyle.current = { cursor: document.body.style.cursor, userSelect: document.body.style.userSelect }
      document.body.style.cursor = 'col-resize'
      document.body.style.userSelect = 'none'
      event.currentTarget.setPointerCapture(event.pointerId)
    }}
    onPointerMove={(event) => {
      if (drag.current?.pointerId !== event.pointerId) return
      resizeFromDelta(event.clientX - drag.current.startX)
    }}
    onPointerUp={finishDrag}
    onPointerCancel={finishDrag}
    onLostPointerCapture={finishDrag}
  >
    <span className="absolute inset-y-0 left-1/2 w-px -translate-x-1/2 bg-border transition-colors group-hover:bg-primary/50" />
  </div>
}
