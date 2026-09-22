import { describe, expect, test } from 'bun:test'
import {
  closeTab,
  createInitialTabState,
  openTab,
  reconcileAgentTabs,
  reconcileChatTabs,
  sanitizePersistedTabState,
  updateTabTitle,
  type TabItem,
} from './tab-atoms'

const CHAT_TAB: TabItem = {
  id: 'chat-1',
  type: 'chat',
  sessionId: 'chat-1',
  title: '对话一',
}

const AGENT_TAB: TabItem = {
  id: 'agent-1',
  type: 'agent',
  sessionId: 'agent-1',
  title: 'Agent 一',
}

describe('Tab 状态操作', () => {
  test('打开新标签时追加并激活', () => {
    const result = openTab([CHAT_TAB], {
      type: 'agent',
      sessionId: 'agent-1',
      title: 'Agent 一',
    })

    expect(result.tabs).toEqual([CHAT_TAB, AGENT_TAB])
    expect(result.activeTabId).toBe('agent-1')
  })

  test('重复打开同一会话时只聚焦且不重复添加', () => {
    const tabs = [CHAT_TAB, AGENT_TAB]
    const result = openTab(tabs, {
      type: 'chat',
      sessionId: 'chat-1',
      title: '不会覆盖已有标题',
    })

    expect(result.tabs).toBe(tabs)
    expect(result.activeTabId).toBe('chat-1')
  })

  test('关闭激活标签时选择其右侧相邻项，末项则回到左侧', () => {
    const third: TabItem = { ...CHAT_TAB, id: 'chat-2', sessionId: 'chat-2' }

    expect(closeTab([CHAT_TAB, AGENT_TAB, third], 'agent-1', 'agent-1')).toEqual({
      tabs: [CHAT_TAB, third],
      activeTabId: 'chat-2',
    })
    expect(closeTab([CHAT_TAB, AGENT_TAB], 'agent-1', 'agent-1')).toEqual({
      tabs: [CHAT_TAB],
      activeTabId: 'chat-1',
    })
  })

  test('关闭非激活标签时保持当前激活项', () => {
    expect(closeTab([CHAT_TAB, AGENT_TAB], 'chat-1', 'agent-1')).toEqual({
      tabs: [CHAT_TAB],
      activeTabId: 'chat-1',
    })
  })

  test('标题更新只影响同一会话', () => {
    expect(updateTabTitle([CHAT_TAB, AGENT_TAB], 'chat-1', '新标题')).toEqual([
      { ...CHAT_TAB, title: '新标题' },
      AGENT_TAB,
    ])
  })

  test('会话索引同步标题并移除已删除的 Chat 标签', () => {
    const result = reconcileChatTabs([CHAT_TAB, AGENT_TAB], 'chat-1', [{
      id: 'chat-2',
      title: '服务端标题',
      createdAt: 1,
      updatedAt: 1,
    }])
    expect(result).toEqual({ tabs: [AGENT_TAB], activeTabId: 'agent-1' })

    expect(reconcileChatTabs([{ ...CHAT_TAB, title: '旧标题' }], 'chat-1', [{
      id: 'chat-1',
      title: '新标题',
      createdAt: 1,
      updatedAt: 2,
    }])).toEqual({
      tabs: [{ ...CHAT_TAB, title: '新标题' }],
      activeTabId: 'chat-1',
    })
  })

  test('Agent 会话索引同步标题并移除失效视图', () => {
    expect(reconcileAgentTabs([CHAT_TAB, AGENT_TAB], 'agent-1', [{
      id: 'agent-1', runtimeId: 'pi', title: '自动标题', createdAt: 1, updatedAt: 2,
    }])).toEqual({
      tabs: [CHAT_TAB, { ...AGENT_TAB, title: '自动标题' }],
      activeTabId: 'agent-1',
    })
    expect(reconcileAgentTabs([AGENT_TAB], 'agent-1', [])).toEqual({
      tabs: [], activeTabId: null,
    })
  })
})

describe('Tab 持久化恢复', () => {
  test('没有快照时创建首次启动标签', () => {
    expect(sanitizePersistedTabState(undefined)).toEqual(createInitialTabState())
  })

  test('过滤无效项和重复 ID，并修正失效的 activeTabId', () => {
    const result = sanitizePersistedTabState({
      tabs: [
        CHAT_TAB,
        { ...CHAT_TAB, title: '重复项' },
        { id: 'bad', type: 'preview', sessionId: 'bad', title: '越界类型' },
        AGENT_TAB,
      ],
      activeTabId: 'missing',
    })

    expect(result).toEqual({
      tabs: [CHAT_TAB, AGENT_TAB],
      activeTabId: 'agent-1',
    })
  })

  test('用户主动关闭全部标签后保留空状态', () => {
    expect(sanitizePersistedTabState({ tabs: [], activeTabId: null })).toEqual({
      tabs: [],
      activeTabId: null,
    })
  })
})
