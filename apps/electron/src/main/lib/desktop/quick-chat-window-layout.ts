import { screen, type BrowserWindow, type Rectangle } from 'electron'

export const QUICK_CHAT_COMPACT_HEIGHT = 104
const DEFAULT_EXPANDED_HEIGHT = 630

interface QuickChatWindowLayoutState {
  compactBounds?: Rectangle
  expandedBounds?: Rectangle
  expandedHeight?: number
  expanded: boolean
  composerExtraHeight?: number
}

const layoutStates = new WeakMap<BrowserWindow, QuickChatWindowLayoutState>()

function samePositionAndWidth(left: Rectangle, right: Rectangle): boolean {
  return left.x === right.x && left.y === right.y && left.width === right.width
}

function clampCompactBounds(bounds: Rectangle, workArea: Rectangle, height: number): Rectangle {
  return {
    x: Math.max(workArea.x, Math.min(bounds.x, workArea.x + workArea.width - bounds.width)),
    y: Math.max(workArea.y, Math.min(bounds.y, workArea.y + workArea.height - height)),
    width: bounds.width,
    height,
  }
}

/**
 * 在紧凑态与展开态之间切换，并区分屏幕边界校正和用户主动拖动。
 * 上游由窗口 IPC/再次唤起调用，下游只修改对应快捷浮窗的原生 bounds。
 */
export function setQuickChatWindowExpanded(window: BrowserWindow, expanded: boolean, composerExtraHeight?: number): void {
  if (window.isDestroyed()) return
  const current = window.getBounds()
  const state = layoutStates.get(window) ?? { expanded: current.height > QUICK_CHAT_COMPACT_HEIGHT }
  const workArea = screen.getDisplayMatching(current).workArea
  if (composerExtraHeight !== undefined) {
    const oldHeight = QUICK_CHAT_COMPACT_HEIGHT + (state.composerExtraHeight ?? 0)
    state.composerExtraHeight = Math.max(0, Math.min(200, composerExtraHeight))
    if (state.compactBounds) {
      const height = QUICK_CHAT_COMPACT_HEIGHT + state.composerExtraHeight
      state.compactBounds = { ...state.compactBounds, y: state.compactBounds.y + oldHeight - height, height }
    }
  }
  const compactHeight = QUICK_CHAT_COMPACT_HEIGHT + (state.composerExtraHeight ?? 0)
  const minimumHeight = Math.min(workArea.height, expanded ? Math.max(300, compactHeight + 120) : compactHeight)
  window.setMinimumSize(800, minimumHeight)

  if (expanded) {
    if (state.expanded) {
      if (current.height < minimumHeight) {
        const stillAtAutomaticPosition = state.expandedBounds && samePositionAndWidth(current, state.expandedBounds)
        window.setBounds({ ...current, height: minimumHeight,
          y: Math.max(workArea.y, Math.min(current.y + current.height - minimumHeight, workArea.y + workArea.height - minimumHeight)),
        }, false)
        if (stillAtAutomaticPosition) state.expandedBounds = window.getBounds()
      }
      layoutStates.set(window, state)
      return
    }
    state.compactBounds = current
    const height = Math.min(state.expandedHeight ?? DEFAULT_EXPANDED_HEIGHT, workArea.height)
    const target = {
      x: current.x,
      y: Math.max(workArea.y, Math.min(current.y + current.height - height, workArea.y + workArea.height - height)),
      width: current.width,
      height,
    }
    window.setBounds(target, false)
    // 保存系统实际采用的坐标；收起时据此判断展开后是否又被用户拖动。
    state.expandedBounds = window.getBounds()
    state.expanded = true
    layoutStates.set(window, state)
    return
  }

  if (current.height > 300) state.expandedHeight = current.height
  const userMovedExpandedWindow = state.expanded
    && state.expandedBounds !== undefined
    && !samePositionAndWidth(current, state.expandedBounds)
  const target = state.expanded && !userMovedExpandedWindow && state.compactBounds
    ? clampCompactBounds(state.compactBounds, workArea, compactHeight)
    : clampCompactBounds({ ...current, y: current.y + current.height - compactHeight }, workArea, compactHeight)
  window.setBounds(target, false)
  state.compactBounds = window.getBounds()
  state.expandedBounds = undefined
  state.expanded = false
  layoutStates.set(window, state)
}

/** 把手势计算出的窗口左上角限制在当前显示器工作区，避免拖动后完全无法找回。 */
export function moveQuickChatWindow(window: BrowserWindow, x: number, y: number): void {
  if (window.isDestroyed()) return
  const bounds = window.getBounds()
  const workArea = screen.getDisplayNearestPoint({ x, y }).workArea
  window.setPosition(
    Math.max(workArea.x, Math.min(Math.round(x), workArea.x + workArea.width - bounds.width)),
    Math.max(workArea.y, Math.min(Math.round(y), workArea.y + workArea.height - bounds.height)),
    false,
  )
}
