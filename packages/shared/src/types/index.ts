/**
 * 共享类型定义
 *
 * 随迭代逐步扩充（渠道、消息、Agent 协议等）。
 */

/** 主题模式 */
export type ThemeMode = 'light' | 'dark' | 'system'

/** 默认主题模式 */
export const DEFAULT_THEME_MODE: ThemeMode = 'dark'

export * from './agent'
export * from './agent-collaboration'
export * from './agent-project'
export * from './agent-memory'
export * from './agent-provider'
export * from './agent-workspace'
export * from './attachment'
export * from './channel'
export * from './channel-network'
export * from './chat'
export * from './mcp'
