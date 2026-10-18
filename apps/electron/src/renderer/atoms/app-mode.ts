/**
 * 会话类型原子：Chat / Agent（应用模块由 appSectionAtom 决定）
 *
 * 决定会话模块的列表、"新建"动作和持久化会话选择，不包含 Loop。
 * localStorage 持久化，重启恢复。
 */

import { atomWithStorage } from 'jotai/utils'

export type AppMode = 'chat' | 'agent'

export const appModeAtom = atomWithStorage<AppMode>('axon-app-mode', 'chat')
