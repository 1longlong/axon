import { describe, expect, test } from 'bun:test'
import { agentMessageText, stringifyAgentContent } from './agent-message'

describe('Agent 消息可见文本', () => {
  test('复制时保留用户/assistant/工具结果文本，不包含思考块和工具参数', () => {
    expect(agentMessageText({
      type: 'assistant',
      message: { content: [
        { type: 'thinking', thinking: '内部思考' },
        { type: 'text', text: '最终答案' },
        { type: 'tool_use', id: 'tool-1', name: 'Read', input: { path: 'secret' } },
      ] },
      parent_tool_use_id: null,
    })).toBe('最终答案')
    expect(agentMessageText({
      type: 'user',
      message: { content: [
        { type: 'text', text: '问题' },
        { type: 'tool_result', tool_use_id: 'tool-1', content: { output: '结果' } },
      ] },
      parent_tool_use_id: null,
    })).toContain('结果')
  })

  test('未知工具结果安全序列化，循环对象不使复制流程抛错', () => {
    expect(stringifyAgentContent({ ok: true })).toContain('"ok"')
    const circular: Record<string, unknown> = {}
    circular.self = circular
    expect(stringifyAgentContent(circular)).toBe('[无法显示工具结果]')
  })
})
