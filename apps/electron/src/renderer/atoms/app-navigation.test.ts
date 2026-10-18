import { describe, expect, test } from 'bun:test'
import { createStore } from 'jotai'
import { appSectionAtom, navigateAppAtom } from './app-navigation'
import { appModeAtom } from './app-mode'
import { loopFormEditingAtom, loopPageAtom } from './loop-page'
import { activeTabIdAtom, tabsAtom } from './tab-atoms'
import { settingsOpenAtom } from './settings-tab'

function setup() {
  const store = createStore()
  store.set(appModeAtom, 'agent')
  store.set(tabsAtom, [
    { id: 'agent-1', sessionId: 'agent-1', title: '先创建后查看', type: 'agent' },
    { id: 'agent-2', sessionId: 'agent-2', title: '后创建', type: 'agent' },
    { id: 'chat-1', sessionId: 'chat-1', title: '对话', type: 'chat' },
  ])
  store.set(activeTabIdAtom, 'agent-1')
  return store
}

describe('应用模块导航', () => {
  test('Loop 不改变会话类型，离开再返回保留执行页和最近实际会话', () => {
    const store = setup()
    store.set(navigateAppAtom, { page: { kind: 'run', id: 'loop-1', runId: 'run-1' } })
    expect(store.get(appSectionAtom)).toBe('loop')
    expect(store.get(appModeAtom)).toBe('agent')
    expect(store.get(activeTabIdAtom)).toBe('agent-1')
    store.set(navigateAppAtom, { section: 'chat' })
    expect(store.get(activeTabIdAtom)).toBe('chat-1')
    store.set(navigateAppAtom, { section: 'agent' })
    expect(store.get(activeTabIdAtom)).toBe('agent-1')
    store.set(navigateAppAtom, { section: 'loop' })
    expect(store.get(loopPageAtom)).toEqual({ kind: 'run', id: 'loop-1', runId: 'run-1' })
  })

  test('目标模块没有会话时显示空状态，不借用另一种会话', () => {
    const store = setup()
    store.set(tabsAtom, store.get(tabsAtom).filter((tab) => tab.type === 'agent'))
    store.set(navigateAppAtom, { section: 'chat' })
    expect(store.get(activeTabIdAtom)).toBeNull()
    store.set(navigateAppAtom, { section: 'agent' })
    expect(store.get(activeTabIdAtom)).toBe('agent-1')
  })

  test('取消丢弃保留表单、当前模块和原路由，设置入口也不能绕过', () => {
    const store = setup()
    store.set(navigateAppAtom, { page: { kind: 'create' } })
    store.set(loopFormEditingAtom, { dirty: true, busy: false })
    for (const target of [{ section: 'agent' } as const, { page: { kind: 'overview' } } as const, { settings: true } as const]) {
      expect(store.set(navigateAppAtom, target, () => false)).toBe(false)
      expect(store.get(appSectionAtom)).toBe('loop')
      expect(store.get(loopPageAtom)).toEqual({ kind: 'create' })
      expect(store.get(settingsOpenAtom)).toBe(false)
    }
    expect(store.set(navigateAppAtom, { section: 'chat' }, () => true)).toBe(true)
    expect(store.get(loopFormEditingAtom).dirty).toBe(false)
    expect(store.get(loopPageAtom)).toEqual({ kind: 'overview' })
  })

  test('保存期间不能切模块、页面或设置；确认丢弃编辑返回任务详情', () => {
    const store = setup()
    store.set(navigateAppAtom, { page: { kind: 'settings', id: 'loop-1' } })
    store.set(loopFormEditingAtom, { dirty: false, busy: true })
    for (const target of [{ section: 'chat' } as const, { page: { kind: 'overview' } } as const, { settings: true } as const]) {
      expect(store.set(navigateAppAtom, target, () => { throw new Error('保存中不应弹确认') })).toBe(false)
    }
    store.set(loopFormEditingAtom, { dirty: true, busy: false })
    expect(store.set(navigateAppAtom, { settings: true }, () => true)).toBe(true)
    expect(store.get(loopPageAtom)).toEqual({ kind: 'detail', id: 'loop-1' })
    expect(store.get(settingsOpenAtom)).toBe(true)
  })

  test('重选当前模块或页面不丢弃输入；已删除的最近会话回落到仍存在的同类会话', () => {
    const store = setup()
    store.set(navigateAppAtom, { page: { kind: 'create' } })
    store.set(loopFormEditingAtom, { dirty: true, busy: false })
    const unexpected = (): boolean => { throw new Error('同页不应确认') }
    expect(store.set(navigateAppAtom, { section: 'loop' }, unexpected)).toBe(true)
    expect(store.set(navigateAppAtom, { page: { kind: 'create' } }, unexpected)).toBe(true)
    store.set(navigateAppAtom, { section: 'chat' }, () => true)
    store.set(tabsAtom, store.get(tabsAtom).filter((tab) => tab.id !== 'agent-1'))
    store.set(navigateAppAtom, { section: 'agent' })
    expect(store.get(activeTabIdAtom)).toBe('agent-2')
  })
})
