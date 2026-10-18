/** 创建与编辑的关键可用状态；异步选择和 MCP 保存由源码桌面冒烟覆盖。 */
import { expect, test } from 'bun:test'
import { Provider } from 'jotai'
import { renderToStaticMarkup } from 'react-dom/server'
import type { LoopSummary } from '@axon/shared'
import { LoopForm } from './LoopForm'

function form(initial?: LoopSummary): string {
  return renderToStaticMarkup(<Provider><LoopForm initial={initial} onSaved={() => {}} onCancel={() => {}} /></Provider>)
}

const initial: LoopSummary = {
  id: 'loop-fixture', name: '测试', workspacePath: '/workspace/example', channelId: 'channel', modelId: 'model', task: '检查',
  cron: '0 0 1 1 *', timezone: 'UTC', goal: null, enabled: true, allowControl: true, notify: 'never', sandboxMode: 'workspaceWrite',
  runtimeId: 'pi', revision: 1, executionRevision: 1, taskFile: '/workspace/example/axon-loops/loop-fixture/task.md',
  workflow: null, ui: null, stateSchema: [], createdAt: 1, updatedAt: 1, preparation: 'ready', recentRuns: [], runCount: 0,
  completedAt: null, completionReason: null, nextRunAt: null, nextFire: null, running: false, queued: false, totalCostUsd: 0,
}

test('未选目录仍可配置 MCP；目录只显示选择按钮，工具发现禁用原因可见', () => {
  const html = form()
  const workspace = html.match(/<section[^>]*aria-labelledby="loop-workspace-label"[\s\S]*?<\/section>/)?.[0]
  expect(workspace).toContain('选择文件夹')
  expect(workspace).not.toContain('<input')
  expect(workspace).toContain('尚未选择本地文件夹')
  expect(html.match(/<button[^>]*>配置 MCP<\/button>/)?.[0]).not.toContain('disabled=""')
  expect(html.match(/<button[^>]*>刷新工具列表<\/button>/)?.[0]).toContain('disabled=""')
  expect(html).toContain('请先选择工作目录，再读取工具列表')
  expect(html).toContain('未配置 MCP 也能创建 Loop')
  expect(html).not.toContain('逗号分隔')
})

test.each(['running', 'queued'] as const)('已有 Loop %s 时解释配置禁用；已授权但未发现的工具仍可见', (state) => {
  const html = form({ ...initial, [state]: true, allowedMcpTools: ['mcp__local__lookup'] })
  expect(html.match(/<button[^>]*>配置 MCP<\/button>/)?.[0]).toContain('disabled=""')
  expect(html).toContain('请先停止此 Loop，再修改 MCP 配置')
  expect(html).toContain('mcp__local__lookup')
  expect(html).toContain('checked=""')
  expect(html).toContain('已选 1 项')
  expect(html).not.toContain('选择文件夹</button>')
})
