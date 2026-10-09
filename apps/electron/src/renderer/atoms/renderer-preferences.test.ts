import { describe, expect, test } from 'bun:test'
import type { AppSettings, UserProfile } from '@axon/shared'
import { subscribeRendererPreferences } from './renderer-preferences'

function settings(themeMode: AppSettings['themeMode']): AppSettings {
  return { themeMode, gitAttributionEnabled: true, agentSkillCatalogIds: [], agentSystemPromptTemplates: [], quickChatShortcuts: [] }
}
function open() {
  const initialSettings = Promise.withResolvers<AppSettings>(), initialProfile = Promise.withResolvers<UserProfile>()
  const values: string[] = [], order: string[] = [], callbacks: { settings?: (value: AppSettings) => void; profile?: (value: UserProfile) => void } = {}
  let released = 0
  const cleanup = subscribeRendererPreferences({
    settings: { onChanged: (callback) => { callbacks.settings = callback; order.push('settings-subscribe'); return () => { released++ } },
      get: () => { order.push('settings-read'); return initialSettings.promise } },
    userProfile: { onChanged: (callback) => { callbacks.profile = callback; order.push('profile-subscribe'); return () => { released++ } },
      get: () => { order.push('profile-read'); return initialProfile.promise } },
  }, { settings: (value) => { values.push(value.themeMode) }, profile: (value) => { values.push(value.userName) }, error: (message) => { values.push(message) } })
  return { initialSettings, initialProfile, values, order, callbacks, cleanup, get released() { return released } }
}

describe('已保存全局偏好投影', () => {
  test('先订阅再读；新通知使旧初始化失效，两类读取互不阻塞', async () => {
    const f = open()
    expect(f.order).toEqual(['settings-subscribe', 'profile-subscribe', 'settings-read', 'profile-read'])
    f.callbacks.settings?.(settings('light'))
    f.initialProfile.resolve({ userName: '资料', avatar: '' })
    f.initialSettings.resolve(settings('dark'))
    await Promise.resolve()
    expect(f.values).toEqual(['light', '资料'])
    f.callbacks.profile?.({ userName: '更新', avatar: '' })
    expect(f.values).toEqual(['light', '资料', '更新'])
    f.cleanup(); f.cleanup(); expect(f.released).toBe(2)
  })
  test('释放后旧读取、通知与错误均不能恢复状态', async () => {
    const f = open(); f.cleanup()
    f.callbacks.settings?.(settings('dark')); f.callbacks.profile?.({ userName: 'late', avatar: '' })
    f.initialSettings.reject(new Error('secret')); f.initialProfile.resolve({ userName: 'late', avatar: '' })
    await Promise.resolve(); await Promise.resolve()
    expect(f.values).toEqual([]); expect(f.released).toBe(2)
  })
  test('未知读取错误仅返回稳定提示；已收到通知的旧失败不覆盖新值', async () => {
    const f = open()
    f.callbacks.settings?.(settings('system'))
    f.initialSettings.reject(new Error('secret settings')); f.initialProfile.reject(new Error('secret profile'))
    await Promise.resolve(); await Promise.resolve()
    expect(f.values).toEqual(['system', '加载用户资料失败'])
    f.cleanup()
  })
})
