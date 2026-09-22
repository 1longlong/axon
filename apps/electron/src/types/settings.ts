/**
 * 应用设置类型
 *
 * 主题模式、主窗口状态等设置相关定义。
 * IPC 通道常量也定义在这里（IPC 四层契约的第一层：shared/types 常量）。
 */

import type { ThemeMode } from '@axon/shared'

/** 应用设置（持久化到 ~/.axon/settings.json） */
export interface AppSettings {
  /** 主题模式 */
  themeMode: ThemeMode
  /** 主窗口状态（大小、位置、是否最大化） */
  mainWindowState?: MainWindowState
  /** 已打开会话与当前选择的恢复快照。 */
  tabState?: PersistedTabState
  /** 左侧栏是否收起 */
  sidebarCollapsed?: boolean
  /** 左侧栏展开宽度 */
  leftSidebarWidth?: number
  /** Agent 右侧工具栏是否收起 */
  rightPanelCollapsed?: boolean
  /** Agent 右侧工具窗口展开宽度（不含图标轨） */
  rightPanelWidth?: number
  /** Chat Markdown 显示字号 */
  markdownFontSize?: MarkdownFontSize
  /** Agent 专用的全局系统提示词；Chat 不读取。 */
  agentSystemPrompt?: string
  /** 用户保存的 Agent 系统提示词模板；内置模板由应用代码提供。 */
  agentSystemPromptTemplates: SystemPromptTemplate[]
  /** 用户期望由 Axon 管理安装的 Skill catalog ID。 */
  agentSkillCatalogIds: string[]
  /** Agent 创建 commit 或 PR/MR 时是否附加 Axon 标识。 */
  gitAttributionEnabled: boolean
  /** Chat 输入草稿（按会话 ID），跨重启恢复输入框内容 */
  chatDrafts?: Record<string, string>
  /** 快捷唤起绑定；同一个会话可配置多个不同组合键。 */
  quickChatShortcuts: QuickChatShortcutBinding[]
}

export interface SystemPromptTemplate {
  id: string
  name: string
  content: string
}

/** 全局组合键只定位现有会话；快捷窗口不另建会话或上下文。 */
export interface QuickChatShortcutBinding {
  id: string
  accelerator: string
  sessionType: 'chat' | 'agent'
  sessionId: string
}

export type MarkdownFontSize = 'small' | 'medium' | 'large'
export const DEFAULT_MARKDOWN_FONT_SIZE: MarkdownFontSize = 'medium'

/** 可持久化的会话视图快照；字段名为兼容已有 settings.json 保持不变。 */
export type PersistedTabType = 'chat' | 'agent'

export interface PersistedTabItem {
  id: string
  type: PersistedTabType
  sessionId: string
  title: string
}

export interface PersistedTabState {
  tabs: PersistedTabItem[]
  activeTabId: string | null
}

/** 主窗口大小、位置和最大化状态 */
export interface MainWindowState {
  width: number
  height: number
  x: number
  y: number
  isMaximized: boolean
}

/**
 * 设置 IPC 通道
 *
 * IPC 四层契约示例：这里定义通道常量与类型 → main/ipc.ts 注册 handler →
 * preload/index.ts 暴露 bridge → renderer 通过 window.axon 调用。
 */
export const SETTINGS_IPC_CHANNELS = {
  /** 获取应用设置 */
  GET: 'settings:get',
  /** 更新应用设置 */
  UPDATE: 'settings:update',
} as const
