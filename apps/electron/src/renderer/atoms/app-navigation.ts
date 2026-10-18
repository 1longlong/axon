/** 应用模块与会话类型分离；导航只改变视图，不触发任何运行控制。 */
import { atom } from 'jotai'
import { appModeAtom } from './app-mode'
import type { AppMode } from './app-mode'
import { activeTabIdAtom, tabsAtom } from './tab-atoms'
import { loopFormEditingAtom, loopPageAtom } from './loop-page'
import type { LoopPage } from './loop-page'
import { settingsOpenAtom } from './settings-tab'

export type AppSection = AppMode | 'loop'
export type AppDestination = { section: AppSection } | { page: LoopPage } | { settings: true }

const loopActiveAtom = atom(false)
const lastConversationIdsAtom = atom<Partial<Record<AppMode, string>>>({})
export const appSectionAtom = atom<AppSection>((get) => get(loopActiveAtom) ? 'loop' : get(appModeAtom))

/** 先保护未提交的表单，再切换模块/页面；确认丢弃后回到安全路由，不保留脏表单。 */
export const navigateAppAtom = atom(null, (get, set, destination: AppDestination,
  confirmDiscard: () => boolean = () => window.confirm('放弃未保存的 Loop 更改？')): boolean => {
  const section = get(appSectionAtom)
  const page = get(loopPageAtom)
  if ('section' in destination && destination.section === section) return true
  if ('page' in destination && section === 'loop' && JSON.stringify(page) === JSON.stringify(destination.page)) return true

  if (section === 'loop') {
    const editing = get(loopFormEditingAtom)
    if (editing.busy || editing.dirty && !confirmDiscard()) return false
    if (editing.dirty) {
      set(loopFormEditingAtom, { dirty: false, busy: false })
      set(loopPageAtom, page?.kind === 'settings' ? { kind: 'detail', id: page.id } : { kind: 'overview' })
    }
  }
  if ('settings' in destination) {
    set(settingsOpenAtom, true)
    return true
  }

  // 记录真正选中的会话，而不是用最后创建的会话冒充最近查看的位置。
  const tabs = get(tabsAtom)
  const current = tabs.find((tab) => tab.id === get(activeTabIdAtom))
  if (current) set(lastConversationIdsAtom, { ...get(lastConversationIdsAtom), [current.type]: current.id })
  if ('page' in destination || destination.section === 'loop') {
    if ('page' in destination) set(loopPageAtom, destination.page)
    else if (!page) set(loopPageAtom, { kind: 'overview' })
    set(loopActiveAtom, true)
  } else {
    const mode = destination.section
    const previousId = get(lastConversationIdsAtom)[mode]
    const target = tabs.find((tab) => tab.type === mode && tab.id === previousId)
      ?? [...tabs].reverse().find((tab) => tab.type === mode)
    set(appModeAtom, mode)
    set(activeTabIdAtom, target?.id ?? null)
    set(loopActiveAtom, false)
  }
  return true
})
