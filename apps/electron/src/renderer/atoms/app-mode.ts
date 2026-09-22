/**
 * 应用模式原子：Chat / Agent
 *
 * 决定左侧栏展示哪种会话列表、"新建"按钮创建哪种会话。
 * localStorage 持久化，重启恢复。
 */

import { atomWithStorage } from 'jotai/utils'

export type AppMode = 'chat' | 'agent'

export const appModeAtom = atomWithStorage<AppMode>('axon-app-mode', 'chat')
