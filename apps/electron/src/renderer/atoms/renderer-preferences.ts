/** 只同步已保存的全局偏好/资料，不覆盖各窗口的会话导航、输入或设置编辑草稿。 */
import type { AppSettings, UserProfile } from '@axon/shared'

export interface RendererPreferencesApi {
  settings: { get(): Promise<AppSettings>; onChanged(callback: (value: AppSettings) => void): () => void }
  userProfile: { get(): Promise<UserProfile>; onChanged(callback: (value: UserProfile) => void): () => void }
}
export interface RendererPreferencesConsumer {
  settings(value: AppSettings): void
  profile(value: UserProfile): void
  error(message: string): void
}

/** 先订阅再读初始化快照；新通知使旧读取失效，释放后不接受任何迟到结果。 */
export function subscribeRendererPreferences(api: RendererPreferencesApi, consumer: RendererPreferencesConsumer): () => void {
  let disposed = false, settingsVersion = 0, profileVersion = 0
  const settingsSubscription = api.settings.onChanged((value) => {
    if (disposed) return
    settingsVersion++; consumer.settings(value)
  })
  const profileSubscription = api.userProfile.onChanged((value) => {
    if (disposed) return
    profileVersion++; consumer.profile(value)
  })
  const initialSettings = settingsVersion, initialProfile = profileVersion
  void api.settings.get().then((value) => {
    if (!disposed && settingsVersion === initialSettings) consumer.settings(value)
  }).catch(() => {
    if (!disposed && settingsVersion === initialSettings) consumer.error('加载应用设置失败')
  })
  void api.userProfile.get().then((value) => {
    if (!disposed && profileVersion === initialProfile) consumer.profile(value)
  }).catch(() => {
    if (!disposed && profileVersion === initialProfile) consumer.error('加载用户资料失败')
  })
  return () => {
    if (disposed) return
    disposed = true; settingsSubscription(); profileSubscription()
  }
}
