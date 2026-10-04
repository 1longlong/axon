import { describe, expect, test } from 'bun:test'
import type { AgentWorkspaceFilePreview } from '@axon/shared'
import { EMPTY_WORKSPACE_FILE_TABS, workspaceFileTabsReducer as reduce } from './workspace-file-tabs'

function preview(relativePath: string, content: string): AgentWorkspaceFilePreview {
  return { kind: 'text', projectId: 'project', relativePath, name: relativePath.split('/').at(-1)!, size: content.length, content }
}

function openFiles() {
  const first = reduce(EMPTY_WORKSPACE_FILE_TABS, { type: 'load', relativePath: 'a.ts', requestId: 1, activate: true })
  return reduce(first, { type: 'load', relativePath: 'b.ts', requestId: 2, activate: true })
}

describe('工作区文件 Tab 状态', () => {
  test('多个文件独立载入，迟到的后台结果不切换当前文件', () => {
    let state = openFiles()
    state = reduce(state, { type: 'loaded', relativePath: 'b.ts', requestId: 2, preview: preview('b.ts', 'beta') })
    state = reduce(state, { type: 'loaded', relativePath: 'a.ts', requestId: 1, preview: preview('a.ts', 'alpha') })
    expect(state.activePath).toBe('b.ts')
    expect(state.tabs.map((tab) => tab.preview?.kind === 'text' && tab.preview.content)).toEqual(['alpha', 'beta'])
  })

  test('同一路径去重，同名不同路径仍独立，切换保留已读取内容', () => {
    let state = openFiles()
    state = reduce(state, { type: 'load', relativePath: 'a.ts', requestId: 3, activate: true })
    state = reduce(state, { type: 'loaded', relativePath: 'a.ts', requestId: 3, preview: preview('a.ts', 'alpha') })
    state = reduce(state, { type: 'load', relativePath: 'src/a.ts', requestId: 4, activate: true })
    state = reduce(state, { type: 'activate', relativePath: 'a.ts' })
    expect(state.tabs.map((tab) => tab.relativePath)).toEqual(['a.ts', 'b.ts', 'src/a.ts'])
    expect(state.activePath).toBe('a.ts')
    expect(state.tabs[0]?.preview).toEqual(preview('a.ts', 'alpha'))
  })

  test('关闭后台文件不影响选择；关闭激活项选择相邻文件，最后一个关闭后为空', () => {
    const state = openFiles()
    const backgroundClosed = reduce(state, { type: 'close', relativePath: 'a.ts' })
    expect(backgroundClosed.activePath).toBe('b.ts')
    const activeClosed = reduce(state, { type: 'close', relativePath: 'b.ts' })
    expect(activeClosed.activePath).toBe('a.ts')
    const firstClosed = reduce(reduce(state, { type: 'activate', relativePath: 'a.ts' }), { type: 'close', relativePath: 'a.ts' })
    expect(firstClosed.activePath).toBe('b.ts')
    expect(reduce(activeClosed, { type: 'close', relativePath: 'a.ts' })).toEqual(EMPTY_WORKSPACE_FILE_TABS)
  })

  test('关闭或重置后迟到的读取结果不能重新打开 Tab，关闭重开不接受旧结果', () => {
    const state = openFiles()
    const closed = reduce(state, { type: 'close', relativePath: 'a.ts' })
    expect(reduce(closed, { type: 'loaded', relativePath: 'a.ts', requestId: 1, preview: preview('a.ts', 'old') })).toBe(closed)
    const reopened = reduce(closed, { type: 'load', relativePath: 'a.ts', requestId: 3, activate: true })
    expect(reduce(reopened, { type: 'failed', relativePath: 'a.ts', requestId: 1 })).toBe(reopened)
    const cleared = reduce(state, { type: 'clear' })
    expect(reduce(cleared, { type: 'loaded', relativePath: 'b.ts', requestId: 2, preview: preview('b.ts', 'old') })).toBe(cleared)
  })

  test('监听刷新不激活后台文件或重开已关闭项，旧刷新不能覆盖新结果', () => {
    let state = openFiles()
    state = reduce(state, { type: 'load', relativePath: 'a.ts', requestId: 3, activate: false })
    expect(state.activePath).toBe('b.ts')
    expect(reduce(state, { type: 'load', relativePath: 'closed.ts', requestId: 4, activate: false })).toBe(state)
    expect(reduce(state, { type: 'loaded', relativePath: 'a.ts', requestId: 1, preview: preview('a.ts', 'old') })).toBe(state)
    state = reduce(state, { type: 'loaded', relativePath: 'a.ts', requestId: 3, preview: preview('a.ts', 'new') })
    expect(state.tabs[0]?.preview).toEqual(preview('a.ts', 'new'))
  })

  test('单文件读取失败不污染其他 Tab，重新读取会清除错误状态', () => {
    let state = reduce(openFiles(), { type: 'failed', relativePath: 'a.ts', requestId: 1 })
    expect(state.tabs[0]?.error).toBe(true)
    expect(state.tabs[1]?.error).toBe(false)
    state = reduce(state, { type: 'load', relativePath: 'a.ts', requestId: 3, activate: true })
    expect(state.tabs[0]?.error).toBe(false)
    expect(state.tabs[0]?.loading).toBe(true)
  })
})
