/**
 * 窗口控制与菜单 IPC 通道定义（IPC 四层契约第 1 层）
 */

/** 窗口控制 IPC 通道（Windows 自定义标题栏按钮） */
export const WINDOW_IPC_CHANNELS = {
  MINIMIZE: 'window:minimize',
  MAXIMIZE: 'window:maximize',
  CLOSE: 'window:close',
  IS_MAXIMIZED: 'window:is-maximized',
  /** 主进程 → 渲染进程：窗口尺寸变化（含最大化/还原） */
  ON_RESIZE: 'window:resize',
} as const
