/**
 * 设置视图开关：Settings 不作为 Tab，保留独立覆盖视图
 */

import { atom } from 'jotai'
import type { SettingsEditingState } from '../lib/channel-form'

export type SettingsTab = 'profile' | 'appearance' | 'agent' | 'shortcuts' | 'channels' | 'about'

export const settingsOpenAtom = atom<boolean>(false)

/** 设置分类只保留当前迭代已实现的入口，后续迭代按功能追加。 */
export const settingsTabAtom = atom<SettingsTab>('profile')

export const settingsEditingAtom = atom<SettingsEditingState>({ dirty: false, busy: false })
