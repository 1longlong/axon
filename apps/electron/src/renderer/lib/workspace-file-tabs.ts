import type { AgentWorkspaceFilePreview } from '@axon/shared'

export interface WorkspaceFileTab {
  relativePath: string
  preview: AgentWorkspaceFilePreview | null
  loading: boolean
  error: boolean
  requestId: number
}

export interface WorkspaceFileTabsState {
  tabs: WorkspaceFileTab[]
  activePath: string | null
}

export type WorkspaceFileTabsAction =
  | { type: 'load'; relativePath: string; requestId: number; activate: boolean }
  | { type: 'loaded'; relativePath: string; requestId: number; preview: AgentWorkspaceFilePreview }
  | { type: 'failed'; relativePath: string; requestId: number }
  | { type: 'activate'; relativePath: string }
  | { type: 'close'; relativePath: string }
  | { type: 'clear' }

export const EMPTY_WORKSPACE_FILE_TABS: WorkspaceFileTabsState = { tabs: [], activePath: null }

/** 将文件选择与异步读取结果投影成 Tab；请求编号隔离刷新、关闭重开和工作区重置后的迟到结果。 */
export function workspaceFileTabsReducer(state: WorkspaceFileTabsState, action: WorkspaceFileTabsAction): WorkspaceFileTabsState {
  if (action.type === 'clear') return EMPTY_WORKSPACE_FILE_TABS
  const index = state.tabs.findIndex((tab) => tab.relativePath === action.relativePath)
  if (action.type === 'activate') return index < 0 ? state : { ...state, activePath: action.relativePath }
  if (action.type === 'close') {
    if (index < 0) return state
    const tabs = state.tabs.filter((tab) => tab.relativePath !== action.relativePath)
    return {
      tabs,
      activePath: state.activePath === action.relativePath
        ? (tabs[Math.max(0, index - 1)]?.relativePath ?? null)
        : state.activePath,
    }
  }
  if (action.type === 'load') {
    // 监听只刷新已有文件，不能重新打开用户刚关闭的 Tab。
    if (index < 0 && !action.activate) return state
    const tab: WorkspaceFileTab = {
      relativePath: action.relativePath, preview: index < 0 ? null : state.tabs[index]!.preview,
      loading: true, error: false, requestId: action.requestId,
    }
    return {
      tabs: index < 0 ? [...state.tabs, tab] : state.tabs.map((entry, position) => position === index ? tab : entry),
      activePath: action.activate ? action.relativePath : state.activePath,
    }
  }
  if (index < 0 || state.tabs[index]!.requestId !== action.requestId) return state
  return {
    ...state,
    tabs: state.tabs.map((tab, position) => position !== index ? tab : {
      ...tab, loading: false, error: action.type === 'failed', preview: action.type === 'loaded' ? action.preview : null,
    }),
  }
}
