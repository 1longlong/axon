import { Menu, nativeImage, Tray } from 'electron'
import type { MenuItemConstructorOptions } from 'electron'
import type { DesktopAction } from '../types'
import { createTrayMenuModel } from './lib/desktop/tray-menu-model'
import type { TrayMenuCommand, TrayMenuEntry, TrayProjectMenuItem } from './lib/desktop/tray-menu-model'

export interface TrayControllerOptions {
  isMainWindowVisible(): boolean
  showMainWindow(): void
  hideMainWindow(): void
  listProjects(): TrayProjectMenuItem[]
  dispatchAction(action: DesktopAction): void
  quit(): void
}

let tray: Tray | null = null
let controllerOptions: TrayControllerOptions | null = null

/** 使用内嵌单色位图创建模板图标，避开不同 Electron 版本的 SVG 解码差异。 */
function createTrayIcon() {
  const width = 18
  const height = 18
  const bitmap = Buffer.alloc(width * height * 4)
  const paint = (x: number, y: number): void => {
    if (x < 0 || x >= width || y < 0 || y >= height) return
    // createFromBitmap 使用 BGRA；模板图只需要黑色与透明度。
    bitmap[(y * width + x) * 4 + 3] = 255
  }
  const line = (fromX: number, fromY: number, toX: number, toY: number): void => {
    const steps = Math.max(Math.abs(toX - fromX), Math.abs(toY - fromY))
    for (let index = 0; index <= steps; index += 1) {
      const x = Math.round(fromX + ((toX - fromX) * index) / steps)
      const y = Math.round(fromY + ((toY - fromY) * index) / steps)
      paint(x, y)
      paint(x + 1, y)
    }
  }
  line(3, 14, 8, 3)
  line(8, 3, 14, 14)
  line(5, 10, 12, 10)

  const image = nativeImage.createFromBitmap(bitmap, { width, height, scaleFactor: 1 })
  if (process.platform === 'darwin') image.setTemplateImage(true)
  return image
}

function runCommand(command: Exclude<TrayMenuCommand, 'new_agent'>, options: TrayControllerOptions): void {
  switch (command) {
    case 'toggle_window':
      if (options.isMainWindowVisible()) options.hideMainWindow()
      else options.showMainWindow()
      return
    case 'new_chat':
      options.dispatchAction({ type: 'new_chat' })
      return
    case 'quit':
      options.quit()
  }
}

/** 把纯菜单模型绑定到当前窗口与项目动作；每次弹出前重建以反映最新状态。 */
function buildContextMenu(options: TrayControllerOptions): Menu {
  let projects: TrayProjectMenuItem[] = []
  try {
    projects = options.listProjects()
  } catch (error) {
    console.warn('[托盘] 读取 Agent 项目失败:', error)
  }

  const template = createTrayMenuModel(options.isMainWindowVisible(), projects).map(
    (entry): MenuItemConstructorOptions => toElectronMenuItem(entry, options),
  )
  return Menu.buildFromTemplate(template)
}

function toElectronMenuItem(
  entry: TrayMenuEntry,
  options: TrayControllerOptions,
): MenuItemConstructorOptions {
  if (entry.kind === 'separator') return { type: 'separator' }
  if (entry.kind === 'command') {
    return {
      label: entry.label,
      click: () => runCommand(entry.command, options),
    }
  }

  return {
    label: entry.label,
    enabled: entry.projects.length > 0,
    submenu: entry.projects.length > 0
      ? entry.projects.map((project) => ({
          label: project.name,
          click: () => options.dispatchAction({ type: 'new_agent', projectId: project.id }),
        }))
      : [{ label: '暂无项目', enabled: false }],
  }
}

/**
 * 创建进程级唯一托盘。左键在 macOS 打开菜单、其他平台显示主窗口，右键始终打开菜单。
 * 返回 false 时调用方不得启用非 macOS 的“关闭到托盘”，避免产生无法恢复的隐藏窗口。
 */
export function createTray(options: TrayControllerOptions): boolean {
  if (tray && !tray.isDestroyed()) return true

  const icon = createTrayIcon()
  if (icon.isEmpty()) {
    console.warn('[托盘] 图标创建失败，已跳过托盘初始化')
    return false
  }

  tray = new Tray(icon)
  controllerOptions = options
  tray.setToolTip('Axon')
  tray.on('click', () => {
    if (process.platform === 'darwin') tray?.popUpContextMenu(buildContextMenu(options))
    else options.showMainWindow()
  })
  tray.on('right-click', () => tray?.popUpContextMenu(buildContextMenu(options)))
  refreshTrayContextMenu()
  return true
}

export function hasTray(): boolean {
  return !!tray && !tray.isDestroyed()
}

/** Linux 的原生托盘由系统持有固定菜单，项目索引变化后必须重新设置。 */
export function refreshTrayContextMenu(): void {
  if (process.platform !== 'linux' || !tray || tray.isDestroyed() || !controllerOptions) return
  tray.setContextMenu(buildContextMenu(controllerOptions))
}

/** 明确退出时销毁原生托盘，释放系统状态栏资源。 */
export function destroyTray(): void {
  if (tray && !tray.isDestroyed()) tray.destroy()
  tray = null
  controllerOptions = null
}
