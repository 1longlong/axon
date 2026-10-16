import { describe, expect, test } from 'bun:test'
import * as React from 'react'
import { renderToStaticMarkup } from 'react-dom/server'
import type { SDKAssistantMessage, SDKContentBlock, SDKMessage } from '@axon/shared'
import { indexAgentToolMessages } from '@/lib/agent-tool-messages'
import { groupAgentTurns } from '@/lib/agent-turn-groups'
import { AgentAssistantTurnItem } from './AgentMessageItem'

const read: SDKContentBlock = { type: 'tool_use', id: 'read-1', name: 'Read', input: { path: 'a.ts' } }
const assistant = (...content: SDKContentBlock[]): SDKAssistantMessage => ({
  type: 'assistant', uuid: 'assistant-1', message: { content }, parent_tool_use_id: null,
})

function render(messages: SDKMessage[], running: boolean, blockedToolUseIds?: ReadonlySet<string>): string {
  const index = indexAgentToolMessages(messages)
  return renderToStaticMarkup(<AgentAssistantTurnItem messages={messages} running={running}
    toolResultsById={index.resultsByToolUseId} hideToolResult={(id) => index.toolUsesById.has(id)}
    blockedToolUseIds={blockedToolUseIds} />)
}

describe('Agent 活动组渲染', () => {
  test('原轮继续只保留一个回复尾部时间/复制栏，活动不被旧停止切断', () => {
    const history: SDKMessage[] = [
      { type: 'user', uuid: 'turn-1', message: { content: [{ type: 'text', text: '任务' }] } },
      { ...assistant({ type: 'text', text: '旧正文' }, { type: 'thinking', thinking: '中断前思考' }), createdAt: 1000 },
      { type: 'result', uuid: 'stop-1', subtype: 'error', terminal_reason: 'stopped', stopped_by_user: true },
      { type: 'system', subtype: 'axon_continued', turn_id: 'turn-1', stopped_result_uuid: 'stop-1' },
      { ...assistant(read, { type: 'text', text: '继续后的正文' }), uuid: 'new-assistant', createdAt: 2000 },
      { type: 'result', subtype: 'success' },
    ]
    const group = groupAgentTurns(history)[1]
    if (group?.kind !== 'reply') throw new Error('缺少合并回复')
    const html = render([...group.messages], false)
    expect(html.match(/<time /g)).toHaveLength(1)
    expect(html.match(/aria-label="复制消息"/g)).toHaveLength(1)
    expect(html).toContain(new Date(2000).toISOString())
    expect(html).not.toContain(new Date(1000).toISOString())
    expect(html).toContain('旧正文')
    expect(html).toContain('继续后的正文')
    expect(html.match(/aria-label="执行活动组"/g)).toHaveLength(1)
    expect(render([...group.messages], true)).not.toContain('<time ')
  })
  test('停止保持已有正文/尾活动展开，不显示停止错误卡；真实错误仍显示', () => {
    const stopped: SDKMessage = { type: 'result', subtype: 'error', terminal_reason: 'stopped', stopped_by_user: true,
      errors: ['Agent 执行已停止'] }
    const html = render([assistant({ type: 'text', text: '中断前正文' }, read), stopped], false)
    expect(html).toContain('中断前正文')
    expect(html).toContain('aria-expanded="true"')
    expect(html).not.toContain('hidden=""')
    expect(html).not.toContain('Agent 执行已停止')
    expect(html).not.toContain('animate-spin')
    expect(render([stopped], false)).not.toContain('Agent 执行已停止')
    const failed = render([{ ...stopped, terminal_reason: 'failed',
      error: { code: 'runtime_cleanup_failed', category: 'runtime', message: '实际清理失败', retryable: false } }], false)
    expect(failed).toContain('实际清理失败')
  })
  test('中断工具结果未知保持可见，不标成执行成功或确定失败', () => {
    const html = render([assistant(read), {
      type: 'user', isSynthetic: true, parent_tool_use_id: null, message: { content: [{
        type: 'tool_result', tool_use_id: 'read-1', execution_status: 'unknown', is_error: true,
        content: '是否完成未知，续做前核实',
      }] },
    }], false)
    expect(html).toContain('1 项结果未知')
    expect(html).toContain('aria-label="执行结果未知"')
    expect(html).not.toContain('执行成功')
    expect(html).not.toContain('1 项失败')
    expect(html).not.toContain('hidden=""')
  })
  test('进行中的组默认展开，下一段正文到达后默认收起', () => {
    const active = render([assistant({ type: 'thinking', thinking: '检查入口' }, read)], true)
    expect(active).toContain('aria-expanded="true"')
    expect(active).not.toContain('hidden=""')
    const closed = render([assistant(read, { type: 'text', text: '正文结论' })], true)
    expect(closed).toContain('aria-expanded="false"')
    expect(closed).toContain('hidden=""')
    expect(closed.indexOf('执行活动组')).toBeLessThan(closed.indexOf('正文结论'))
  })

  test('组收起后，失败工具和完整结果入口仍可见，不出现第二个工具结果框', () => {
    const html = render([
      assistant(read, { type: 'text', text: '说明失败原因' }),
      { type: 'user', parent_tool_use_id: null, message: { content: [{ type: 'tool_result', tool_use_id: 'read-1', content: '文件不存在', is_error: true }] } },
    ], false)
    expect(html).toContain('1 项失败')
    expect(html).toContain('文件不存在')
    expect(html).not.toContain('hidden=""')
    expect(html).not.toContain('group/result')
  })

  test('待交互工具在收起组中仍然可见', () => {
    const html = render([assistant(read, { type: 'text', text: '等待批准' })], true, new Set(['read-1']))
    expect(html).toContain('等待交互')
    expect(html).not.toContain('hidden=""')
  })

  test('失败终态单独展示，只有思考的历史也有可展开摘要', () => {
    const html = render([
      assistant({ type: 'thinking', thinking: '尚未完成' }),
      { type: 'result', subtype: 'error', errors: ['模型请求失败'], usage: {} },
    ], false)
    expect(html).toContain('aria-expanded="false"')
    expect(html).toContain('思考 1 段')
    expect(html.indexOf('执行活动组')).toBeLessThan(html.indexOf('模型请求失败'))
  })

  test('混合成功/失败调用收起时，仅普通记录隐藏，失败行保留', () => {
    const html = render([
      assistant(read, { type: 'tool_use', id: 'bash-1', name: 'Bash', input: { command: 'pwd' } }, { type: 'text', text: '结果说明' }),
      { type: 'user', parent_tool_use_id: null, message: { content: [
        { type: 'tool_result', tool_use_id: 'read-1', content: '读取失败', is_error: true },
        { type: 'tool_result', tool_use_id: 'bash-1', content: '/project' },
      ] } },
    ], false)
    expect(html.match(/hidden=""/g)).toHaveLength(1)
    expect(html).toContain('1 项失败')
    expect(html).toContain('<div><details class="group/tool')
  })

  test('独立子任务卡片和追问入口不会被完成摘要隐藏', () => {
    const html = render([assistant(
      { type: 'tool_use', id: 'task-1', name: 'Agent', input: { description: '检查代码' } },
      { type: 'tool_use', id: 'ask-1', name: 'AskUserQuestion', input: { questions: [] } },
      { type: 'text', text: '继续处理' },
    )], false)
    expect(html).not.toContain('hidden=""')
  })
})
