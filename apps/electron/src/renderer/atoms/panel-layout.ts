import { atom } from 'jotai'

export const CONVERSATION_MIN_WIDTH = 520
export const LEFT_SIDEBAR_COLLAPSED_WIDTH = 64
export const LEFT_SIDEBAR_DEFAULT_WIDTH = 256
export const LEFT_SIDEBAR_MIN_WIDTH = 220
export const LEFT_SIDEBAR_MAX_WIDTH = 380
export const RIGHT_PANEL_DEFAULT_WIDTH = 240
export const RIGHT_PANEL_MIN_WIDTH = 220
export const RIGHT_PANEL_MAX_WIDTH = 420
export const RIGHT_PANEL_RAIL_WIDTH = 44
export const PANEL_RESIZE_HANDLE_WIDTH = 4

/** 把磁盘恢复或拖拽产生的宽度限制在面板可用范围内。 */
export function clampPanelWidth(value: unknown, fallback: number, min: number, max: number): number {
  if (typeof value !== 'number' || !Number.isFinite(value)) return fallback
  return Math.min(max, Math.max(min, Math.round(value)))
}

export const sidebarCollapsedAtom = atom(false)
export const leftSidebarWidthAtom = atom(LEFT_SIDEBAR_DEFAULT_WIDTH)
export const rightPanelCollapsedAtom = atom(false)
export const rightPanelWidthAtom = atom(RIGHT_PANEL_DEFAULT_WIDTH)
