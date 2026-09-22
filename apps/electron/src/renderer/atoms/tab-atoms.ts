/**
 * 会话视图缓存（保留既有 tab 字段名以兼容 settings.json）
 *
 * 左侧栏是唯一导航入口；tabsAtom 只保存已打开视图与当前选择，页面不渲染顶部标签栏。
 * 持久化到 settings.json 的 tabState（重启恢复）。
 */

import { atom } from 'jotai'
import type { PersistedTabState } from '@/types/settings'
import type { AgentSessionMeta, ConversationMeta } from '@axon/shared'

// ===== 类型定义 =====

/** 会话视图类型（Settings 保留独立视图） */
export type TabType = 'chat' | 'agent'

/** 已打开会话视图数据。 */
export interface TabItem {
  /** 唯一视图 ID（直接使用 sessionId） */
  id: string
  /** 会话类型 */
  type: TabType
  /** Chat conversationId 或 Agent sessionId */
  sessionId: string
  /** 会话显示标题 */
  title: string
}

// ===== 核心 Atoms =====

/** 内部视图缓存列表。 */
export const tabsAtom = atom<TabItem[]>([])

/** 当前激活的会话视图 ID。 */
export const activeTabIdAtom = atom<string | null>(null)

// ===== 派生 Atoms =====

/** 当前活跃会话视图。 */
export const activeTabAtom = atom<TabItem | null>((get) => {
  const activeId = get(activeTabIdAtom)
  if (!activeId) return null
  return get(tabsAtom).find((t) => t.id === activeId) ?? null
})

/** 当前活跃视图所属的会话 ID。 */
export const activeSessionIdAtom = atom<string | null>((get) => {
  const activeTab = get(activeTabAtom)
  return activeTab?.sessionId ?? null
})

// ===== 操作函数（纯函数，便于测试） =====

/**
 * 打开或聚焦会话视图：同 sessionId + 同类型已存在则聚焦，否则加入缓存并激活。
 */
export function openTab(
  tabs: TabItem[],
  item: { type: TabType; sessionId: string; title: string },
): { tabs: TabItem[]; activeTabId: string } {
  const existingTab = tabs.find((t) => t.sessionId === item.sessionId && t.type === item.type)
  if (existingTab) {
    return { tabs, activeTabId: existingTab.id }
  }

  const newTab: TabItem = {
    id: item.sessionId,
    type: item.type,
    sessionId: item.sessionId,
    title: item.title,
  }
  return {
    tabs: [...tabs, newTab],
    activeTabId: newTab.id,
  }
}

/** 从内部视图缓存移除会话；若移除当前项则切换到相邻会话。 */
export function closeTab(
  tabs: TabItem[],
  activeTabId: string | null,
  tabId: string,
): { tabs: TabItem[]; activeTabId: string | null } {
  const tabIndex = tabs.findIndex((t) => t.id === tabId)
  if (tabIndex === -1) return { tabs, activeTabId }

  const newTabs = tabs.filter((t) => t.id !== tabId)

  let newActiveTabId = activeTabId
  if (activeTabId === tabId) {
    if (newTabs.length > 0) {
      const nextIndex = Math.min(tabIndex, newTabs.length - 1)
      newActiveTabId = newTabs[nextIndex]!.id
    } else {
      newActiveTabId = null
    }
  }

  return { tabs: newTabs, activeTabId: newActiveTabId }
}

/** 会话标题生成后，同步更新内部视图缓存。 */
export function updateTabTitle(
  tabs: TabItem[],
  sessionId: string,
  title: string,
): TabItem[] {
  return tabs.map((t) =>
    t.sessionId === sessionId ? { ...t, title } : t
  )
}

/** 首次启动保持空视图；真实会话由 Chat 或 Agent 流程创建后打开。 */
export function createInitialTabState(): PersistedTabState {
  return { tabs: [], activeTabId: null }
}

/** 用主进程会话索引移除失效 Chat 视图并同步标题，Agent 视图保持不变。 */
export function reconcileChatTabs(
  tabs: TabItem[],
  activeTabId: string | null,
  conversations: readonly ConversationMeta[],
): { tabs: TabItem[]; activeTabId: string | null } {
  const conversationsById = new Map(conversations.map((conversation) => [conversation.id, conversation]))
  let changed = false
  const nextTabs = tabs.flatMap((tab) => {
    if (tab.type !== 'chat') return [tab]
    const conversation = conversationsById.get(tab.sessionId)
    if (!conversation) {
      changed = true
      return []
    }
    if (tab.title === conversation.title) return [tab]
    changed = true
    return [{ ...tab, title: conversation.title }]
  })

  const activeStillExists = nextTabs.some((tab) => tab.id === activeTabId)
  const nextActiveTabId = activeStillExists ? activeTabId : nextTabs.at(-1)?.id ?? null
  if (nextActiveTabId !== activeTabId) changed = true
  return { tabs: changed ? nextTabs : tabs, activeTabId: nextActiveTabId }
}

/** 用 Agent 会话索引移除失效视图并同步标题，避免内部持久化缓存保留旧名称。 */
export function reconcileAgentTabs(
  tabs: TabItem[],
  activeTabId: string | null,
  sessions: readonly AgentSessionMeta[],
): { tabs: TabItem[]; activeTabId: string | null } {
  const sessionsById = new Map(sessions.map((session) => [session.id, session]))
  let changed = false
  const nextTabs = tabs.flatMap((tab) => {
    if (tab.type !== 'agent') return [tab]
    const session = sessionsById.get(tab.sessionId)
    if (!session) {
      changed = true
      return []
    }
    if (tab.title === session.title) return [tab]
    changed = true
    return [{ ...tab, title: session.title }]
  })
  const nextActiveTabId = nextTabs.some((tab) => tab.id === activeTabId)
    ? activeTabId
    : nextTabs.at(-1)?.id ?? null
  if (nextActiveTabId !== activeTabId) changed = true
  return { tabs: changed ? nextTabs : tabs, activeTabId: nextActiveTabId }
}

/**
 * 清洗磁盘中的会话视图快照。
 * settings.json 属于用户可编辑文件，renderer 不能假定反序列化后的结构始终可信。
 */
export function sanitizePersistedTabState(value: unknown): PersistedTabState {
  if (!value || typeof value !== 'object') return createInitialTabState()

  const candidate = value as { tabs?: unknown; activeTabId?: unknown }
  if (!Array.isArray(candidate.tabs)) return createInitialTabState()

  const seenIds = new Set<string>()
  const tabs: TabItem[] = []
  for (const item of candidate.tabs) {
    if (!item || typeof item !== 'object') continue
    const tab = item as Record<string, unknown>
    if (
      typeof tab.id !== 'string'
      || (tab.type !== 'chat' && tab.type !== 'agent')
      || typeof tab.sessionId !== 'string'
      || typeof tab.title !== 'string'
      || seenIds.has(tab.id)
    ) continue

    seenIds.add(tab.id)
    tabs.push({
      id: tab.id,
      type: tab.type,
      sessionId: tab.sessionId,
      title: tab.title,
    })
  }

  const activeTabId = typeof candidate.activeTabId === 'string' && seenIds.has(candidate.activeTabId)
    ? candidate.activeTabId
    : tabs.at(-1)?.id ?? null

  return { tabs, activeTabId }
}
