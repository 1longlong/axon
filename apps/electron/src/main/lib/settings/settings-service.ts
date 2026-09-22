/**
 * 应用设置服务
 *
 * 管理应用设置（主题模式、主窗口状态等）的读写。
 * 存储在 ~/.axon/settings.json，使用 safe-file 原子写。
 */

import { existsSync } from 'node:fs'
import { getSettingsPath } from '../core/config-paths'
import { readJsonFileSafe, writeJsonFileAtomic } from '../core/safe-file'
import { DEFAULT_THEME_MODE } from '@axon/shared'
import type { AppSettings, QuickChatShortcutBinding, SystemPromptTemplate } from '../../../types'

const DEFAULT_GIT_ATTRIBUTION_ENABLED = true

function getDefaultSettings(): AppSettings {
  return {
    themeMode: DEFAULT_THEME_MODE,
    gitAttributionEnabled: DEFAULT_GIT_ATTRIBUTION_ENABLED,
    quickChatShortcuts: [],
    agentSystemPromptTemplates: [],
    agentSkillCatalogIds: [],
  }
}

/** 校验用户模板，阻止损坏或超大设置进入 renderer 和模型请求链。 */
export function validateSystemPromptTemplates(value: unknown): SystemPromptTemplate[] {
  if (!Array.isArray(value) || value.length > 20) throw new Error('系统提示词模板格式无效或数量超过 20 个')
  const ids = new Set<string>()
  return value.map((item: unknown) => {
    if (!item || typeof item !== 'object' || Array.isArray(item)) throw new Error('系统提示词模板格式无效')
    const { id, name, content } = item as Record<string, unknown>
    if (
      typeof id !== 'string' || !id.trim() || id.length > 100
      || typeof name !== 'string' || !name.trim() || name.length > 100
      || typeof content !== 'string' || !content.trim() || content.length > 200_000
    ) throw new Error('系统提示词模板字段无效')
    const normalizedId = id.trim()
    if (ids.has(normalizedId)) throw new Error('系统提示词模板 ID 重复')
    ids.add(normalizedId)
    return { id: normalizedId, name: name.trim(), content: content.trim() }
  })
}

/** 设置写入边界验证绑定，避免重复组合键或损坏字段进入全局注册器。 */
export function validateQuickChatShortcuts(value: unknown): QuickChatShortcutBinding[] {
  if (!Array.isArray(value) || value.length > 20) throw new Error('快捷键绑定格式无效或数量超过 20 个')
  const accelerators = new Set<string>()
  const ids = new Set<string>()
  return value.map((item: unknown) => {
    if (!item || typeof item !== 'object' || Array.isArray(item)) throw new Error('快捷键绑定格式无效')
    const binding = item as Record<string, unknown>
    const { id, accelerator, sessionType, sessionId } = binding
    if (
      typeof id !== 'string' || !id.trim() || id.length > 100
      || typeof accelerator !== 'string' || !accelerator.trim() || accelerator.length > 100
      || (sessionType !== 'chat' && sessionType !== 'agent')
      || typeof sessionId !== 'string' || !sessionId.trim() || sessionId.length > 200
    ) throw new Error('快捷键绑定字段无效')
    const normalizedId = id.trim()
    const key = accelerator.trim().toLowerCase()
    if (ids.has(normalizedId) || accelerators.has(key)) throw new Error('快捷键 ID 或组合键重复')
    ids.add(normalizedId)
    accelerators.add(key)
    return { id: normalizedId, accelerator: accelerator.trim(), sessionType, sessionId: sessionId.trim() }
  })
}

/** 校验 Skill 期望状态；这里只保存稳定 catalog ID，不把安装结果混入设置。 */
export function validateAgentSkillCatalogIds(value: unknown): string[] {
  if (!Array.isArray(value) || value.length > 200) throw new Error('Skill catalog ID 列表格式无效')
  const ids = new Set<string>()
  for (const item of value) {
    if (typeof item !== 'string' || !item.trim() || item.length > 200) {
      throw new Error('Skill catalog ID 无效')
    }
    const id = item.trim()
    if (ids.has(id)) throw new Error('Skill catalog ID 重复')
    ids.add(id)
  }
  return [...ids]
}

/**
 * 获取应用设置
 *
 * 如果文件不存在或损坏，返回默认设置（损坏时按 .tmp/.bak 链恢复）。
 */
export function getSettings(): AppSettings {
  const filePath = getSettingsPath()

  if (!existsSync(filePath)) {
    return getDefaultSettings()
  }

  const data = readJsonFileSafe<Partial<AppSettings>>(filePath)
  if (!data) {
    console.error('[设置] 读取失败（主文件/.tmp/.bak 均不可用），使用默认设置')
    return getDefaultSettings()
  }

  return {
    ...getDefaultSettings(),
    ...data,
    themeMode: data.themeMode || DEFAULT_THEME_MODE,
    agentSystemPromptTemplates: (() => {
      try { return validateSystemPromptTemplates(data.agentSystemPromptTemplates) }
      catch { return [] }
    })(),
    quickChatShortcuts: (() => {
      try { return validateQuickChatShortcuts(data.quickChatShortcuts) }
      catch { return [] }
    })(),
    agentSkillCatalogIds: (() => {
      try { return validateAgentSkillCatalogIds(data.agentSkillCatalogIds) }
      catch { return [] }
    })(),
  }
}

/**
 * 更新应用设置
 *
 * 合并更新字段并原子写入文件。
 */
export function updateSettings(updates: Partial<AppSettings>): AppSettings {
  const current = getSettings()
  const quickChatShortcuts = updates.quickChatShortcuts === undefined
    ? current.quickChatShortcuts
    : validateQuickChatShortcuts(updates.quickChatShortcuts)
  const agentSystemPromptTemplates = updates.agentSystemPromptTemplates === undefined
    ? current.agentSystemPromptTemplates
    : validateSystemPromptTemplates(updates.agentSystemPromptTemplates)
  const agentSkillCatalogIds = updates.agentSkillCatalogIds === undefined
    ? current.agentSkillCatalogIds
    : validateAgentSkillCatalogIds(updates.agentSkillCatalogIds)
  const updated: AppSettings = {
    ...current,
    ...updates,
    quickChatShortcuts,
    agentSystemPromptTemplates,
    agentSkillCatalogIds,
  }
  const filePath = getSettingsPath()

  try {
    writeJsonFileAtomic(filePath, updated)
    console.log('[设置] 已更新 keys:', Object.keys(updates).join(', '))
  } catch (error) {
    console.error('[设置] 写入失败:', error)
    throw new Error('写入应用设置失败')
  }

  return updated
}
