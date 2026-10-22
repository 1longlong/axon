import { expect, test } from 'bun:test'
import type { AgentInputAttachment, AgentInputPart } from './types/agent-attachment'
import { agentInputDisplayText, parseAgentInputParts, validateAgentInputPartReferences } from './agent-input-parts'

const skill: AgentInputAttachment = { id: 'skill-1', kind: 'skill', name: 'pdf', sourceId: 'trusted-source', createdAt: 1 }
const parts: AgentInputPart[] = [{ type: 'text', text: ' 前文 ' }, { type: 'skill', attachmentId: 'skill-1' }, { type: 'text', text: '\n后文  ' }]

test('顺序正文逐字校验并复制，格式化不重读 Skill', () => {
  const parsed = parseAgentInputParts(parts, ' 前文 \n后文  ')!
  expect(parsed).toEqual(parts); expect(parsed).not.toBe(parts); expect(parsed[0]).not.toBe(parts[0])
  validateAgentInputPartReferences(parsed, [skill])
  expect(agentInputDisplayText(' 前文 \n后文  ', parsed, [skill])).toBe(' 前文 $pdf\n后文  ')
  expect(agentInputDisplayText('纯文字')).toBe('纯文字')
  expect(parseAgentInputParts(undefined, '纯文字')).toBeUndefined()
})

test('拒绝正文不一致、额外权限字段、稀疏数组和无界片段', () => {
  for (const value of [[], new Array(1), Array.from({ length: 22 }, () => ({ type: 'text', text: '' })),
    [{ type: 'text', text: '额外正文' }], [{ type: 'skill', attachmentId: 'skill-1', sourceId: 'fake' }],
    [{ type: 'skill', attachmentId: 'skill-1', path: '/private/path' }], [{ type: 'skill', attachmentId: '' }],
    [{ type: 'file', attachmentId: 'skill-1' }], [null], [{ type: 'text', text: 1 }]]) {
    expect(() => parseAgentInputParts(value, '')).toThrow()
  }
})

test('Skill 引用必须与本草稿完整一一对应，拒绝其他草稿/普通附件/遗漏/重复', () => {
  expect(() => validateAgentInputPartReferences([{ type: 'skill', attachmentId: 'other-draft' }], [skill])).toThrow()
  expect(() => validateAgentInputPartReferences(parts, [])).toThrow()
  expect(() => validateAgentInputPartReferences(undefined, [skill])).toThrow()
  expect(() => validateAgentInputPartReferences([{ type: 'text', text: '' }], [skill])).toThrow()
  expect(() => validateAgentInputPartReferences([...parts, { type: 'skill', attachmentId: 'skill-1' }], [skill])).toThrow()
  expect(() => validateAgentInputPartReferences([{ type: 'skill', attachmentId: 'file' }], [
    { id: 'file', kind: 'selection', name: '文本', text: '正文', createdAt: 1 },
  ])).toThrow()
  validateAgentInputPartReferences(undefined, [])
  validateAgentInputPartReferences([{ type: 'skill', attachmentId: 'skill-1' }], [skill])
})
