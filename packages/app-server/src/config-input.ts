/** 配置协议输入只恢复明确 DTO；领域校验与原子写仍在 core，不接收任意配置键。 */
import { validateQuickChatShortcuts, validateSystemPromptTemplates } from '@axon/core'
import type { AppSettings, MainWindowState, PersistedTabItem, PersistedTabState, UserProfile } from '@axon/shared'
import { RpcFault } from './json-rpc-peer'

function invalid(): never { throw new RpcFault(-32602, '配置更新参数无效') }
export function configObject(value: unknown, keys: readonly string[]): Record<string, unknown> {
  if (!value || typeof value !== 'object' || Array.isArray(value)
    || Object.keys(value).some((key) => !keys.includes(key))) return invalid()
  return value as Record<string, unknown>
}
function string(value: unknown): string { return typeof value === 'string' ? value : invalid() }
function boolean(value: unknown): boolean { return typeof value === 'boolean' ? value : invalid() }
function number(value: unknown, positive = false): number {
  return typeof value === 'number' && Number.isFinite(value) && (!positive || value > 0) ? value : invalid()
}
function windowState(value: unknown): MainWindowState {
  const item = configObject(value, ['width', 'height', 'x', 'y', 'isMaximized'])
  return { width: number(item.width, true), height: number(item.height, true), x: number(item.x), y: number(item.y),
    isMaximized: boolean(item.isMaximized) }
}
function tabState(value: unknown): PersistedTabState {
  const item = configObject(value, ['tabs', 'activeTabId'])
  if (!Array.isArray(item.tabs)) return invalid()
  const ids = new Set<string>()
  const tabs = item.tabs.map((entry: unknown): PersistedTabItem => {
    const tab = configObject(entry, ['id', 'type', 'sessionId', 'title'])
    const id = string(tab.id)
    const sessionId = string(tab.sessionId)
    if (!id.trim() || !sessionId.trim() || ids.has(id) || tab.type !== 'chat' && tab.type !== 'agent') return invalid()
    ids.add(id)
    return { id, type: tab.type, sessionId, title: string(tab.title) }
  })
  if (item.activeTabId !== null && (typeof item.activeTabId !== 'string' || !ids.has(item.activeTabId))) return invalid()
  return { tabs, activeTabId: item.activeTabId }
}

/** 按提交字段构造局部更新；先校验整份补丁，再交给 core，失败不保存其中一部分。 */
export function parseSettingsUpdate(value: unknown): Partial<AppSettings> {
  const item = configObject(value, ['themeMode', 'mainWindowState', 'tabState', 'sidebarCollapsed', 'leftSidebarWidth',
    'rightPanelCollapsed', 'rightPanelWidth', 'markdownFontSize', 'agentSystemPrompt', 'agentSystemPromptTemplates',
    'gitAttributionEnabled', 'chatDrafts', 'quickChatShortcuts'])
  const patch: Partial<AppSettings> = {}
  for (const [key, entry] of Object.entries(item)) {
    switch (key) {
      case 'themeMode':
        if (entry !== 'light' && entry !== 'dark' && entry !== 'system') return invalid()
        patch.themeMode = entry; break
      case 'mainWindowState': patch.mainWindowState = windowState(entry); break
      case 'tabState': patch.tabState = tabState(entry); break
      case 'sidebarCollapsed': patch.sidebarCollapsed = boolean(entry); break
      case 'leftSidebarWidth': patch.leftSidebarWidth = number(entry, true); break
      case 'rightPanelCollapsed': patch.rightPanelCollapsed = boolean(entry); break
      case 'rightPanelWidth': patch.rightPanelWidth = number(entry, true); break
      case 'gitAttributionEnabled': patch.gitAttributionEnabled = boolean(entry); break
      case 'markdownFontSize':
        if (entry !== 'small' && entry !== 'medium' && entry !== 'large') return invalid()
        patch.markdownFontSize = entry; break
      case 'agentSystemPrompt': patch.agentSystemPrompt = string(entry); break
      case 'chatDrafts': {
        if (!entry || typeof entry !== 'object' || Array.isArray(entry)) return invalid()
        patch.chatDrafts = Object.fromEntries(Object.entries(entry).map(([id, text]) => [id, string(text)])); break
      }
      case 'agentSystemPromptTemplates':
        if (!Array.isArray(entry)) return invalid()
        for (const template of entry) configObject(template, ['id', 'name', 'content'])
        try { patch.agentSystemPromptTemplates = validateSystemPromptTemplates(entry) } catch { return invalid() }
        break
      case 'quickChatShortcuts':
        if (!Array.isArray(entry)) return invalid()
        for (const binding of entry) configObject(binding, ['id', 'accelerator', 'sessionType', 'sessionId'])
        try { patch.quickChatShortcuts = validateQuickChatShortcuts(entry) } catch { return invalid() }
        break
    }
  }
  // agentSkillCatalogIds 只能走专用安装 controller，避免普通保存绕过安装事务。
  return patch
}

/** 只接受当前资料字段；空白值的默认处理仍交给现有 core normalize。 */
export function parseUserProfileUpdate(value: unknown): Partial<UserProfile> {
  const item = configObject(value, ['userName', 'avatar'])
  const patch: Partial<UserProfile> = {}
  if ('userName' in item) patch.userName = string(item.userName)
  if ('avatar' in item) patch.avatar = string(item.avatar)
  return patch
}
