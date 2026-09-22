/** 应用设置与用户资料 IPC；持久化仍由各自 service 负责。 */

import { ipcMain } from 'electron'
import { SETTINGS_IPC_CHANNELS, USER_PROFILE_IPC_CHANNELS } from '../../types'
import type { AppSettings, UserProfile } from '../../types'
import type { QuickChatShortcutService } from '../lib/desktop/quick-chat-shortcut-service'
import { getSettings, updateSettings, validateQuickChatShortcuts } from '../lib/settings/settings-service'
import { getUserProfile, updateUserProfile } from '../lib/settings/user-profile-service'

/** 注册偏好设置 handler；快捷键变更先占用系统组合键，写盘失败时恢复原注册状态。 */
export function registerSettingsIpcHandlers(shortcuts?: QuickChatShortcutService): void {
  ipcMain.handle(USER_PROFILE_IPC_CHANNELS.GET, () => {
    return getUserProfile()
  })
  ipcMain.handle(USER_PROFILE_IPC_CHANNELS.UPDATE, (_event, updates: unknown) => {
    if (!updates || typeof updates !== 'object') {
      throw new Error('无效的用户资料更新负载')
    }
    return updateUserProfile(updates as Partial<UserProfile>)
  })
  ipcMain.handle(SETTINGS_IPC_CHANNELS.GET, () => {
    return getSettings()
  })
  ipcMain.handle(SETTINGS_IPC_CHANNELS.UPDATE, (_event, updates: unknown) => {
    // 浅合并由 updateSettings 完成；这里只做“是对象”的最小校验。
    if (!updates || typeof updates !== 'object') {
      throw new Error('无效的设置更新负载')
    }
    const patch = updates as Partial<AppSettings>
    if (patch.agentSkillCatalogIds !== undefined) {
      throw new Error('请通过 Agent Skills 设置接口更新安装选择')
    }
    if (patch.quickChatShortcuts === undefined) return updateSettings(patch)
    if (!shortcuts) throw new Error('全局快捷键服务尚未就绪')
    const bindings = validateQuickChatShortcuts(patch.quickChatShortcuts)
    const change = shortcuts.prepare(bindings)
    try {
      const saved = updateSettings({ ...patch, quickChatShortcuts: bindings })
      change.commit()
      return saved
    } catch (error) {
      change.rollback()
      throw error
    }
  })
}
