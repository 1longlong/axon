import { expect, test } from 'bun:test'
import * as React from 'react'
import { renderToStaticMarkup } from 'react-dom/server'
import type { SDKUserMessage } from '@axon/shared'
import { AgentMessageItem } from './AgentMessageItem'
import { agentMessageText } from '@/lib/agent-message'

test('历史按文字/Skill/文字渲染，Skill 不再重复出现在上方，复制保留顺序', () => {
  const user: SDKUserMessage = { type: 'user', uuid: 'user', parent_tool_use_id: null,
    message: { content: [{ type: 'text', text: '前文 后文' }] },
    attachments: [{ id: 'skill', kind: 'skill', name: 'pdf', sourceId: 'source', createdAt: 1 }],
    inputParts: [{ type: 'text', text: '前文 ' }, { type: 'skill', attachmentId: 'skill' }, { type: 'text', text: '后文' }],
  }
  const html = renderToStaticMarkup(<AgentMessageItem message={user} />)
  expect(html.indexOf('前文')).toBeLessThan(html.indexOf('data-agent-skill-reference'))
  expect(html.indexOf('data-agent-skill-reference')).toBeLessThan(html.indexOf('后文'))
  expect(html).not.toContain('aria-label="消息附件"')
  expect(html.match(/data-agent-skill-reference/g)).toHaveLength(1)
  expect(agentMessageText(user)).toBe('前文 $pdf后文')
  const onlySkill: SDKUserMessage = { ...user, message: { content: [{ type: 'text', text: '' }] }, inputParts: [{ type: 'skill', attachmentId: 'skill' }] }
  expect(renderToStaticMarkup(<AgentMessageItem message={onlySkill} />)).toContain('data-agent-input-body')
  expect(agentMessageText(onlySkill)).toBe('$pdf')
})
