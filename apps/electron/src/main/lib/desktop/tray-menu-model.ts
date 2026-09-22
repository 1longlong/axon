export interface TrayProjectMenuItem {
  id: string
  name: string
}

export type TrayMenuCommand = 'toggle_window' | 'new_chat' | 'new_agent' | 'quit'

export type TrayMenuEntry =
  | { kind: 'command'; command: Exclude<TrayMenuCommand, 'new_agent'>; label: string }
  | { kind: 'separator' }
  | {
      kind: 'submenu'
      command: 'new_agent'
      label: string
      projects: TrayProjectMenuItem[]
    }

/**
 * 把窗口状态和项目索引转换成纯菜单模型；Electron 层只负责绑定点击动作。
 * Agent 必须从项目子菜单创建，避免绕过 projectId 与工作区归属约束。
 */
export function createTrayMenuModel(
  mainWindowVisible: boolean,
  projects: readonly TrayProjectMenuItem[],
): TrayMenuEntry[] {
  return [
    {
      kind: 'command',
      command: 'toggle_window',
      label: mainWindowVisible ? '隐藏 Axon' : '显示 Axon',
    },
    { kind: 'separator' },
    { kind: 'command', command: 'new_chat', label: '新建 Chat' },
    {
      kind: 'submenu',
      command: 'new_agent',
      label: '新建 Agent',
      projects: [...projects].sort((left, right) => left.name.localeCompare(right.name)),
    },
    { kind: 'separator' },
    { kind: 'command', command: 'quit', label: '退出 Axon' },
  ]
}
