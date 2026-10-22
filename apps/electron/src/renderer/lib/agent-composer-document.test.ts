import { expect, test } from 'bun:test'
import { agentComposerTextNodes, readAgentComposerDocument } from './agent-composer-document'

test('编辑文档提取不改写空格、Markdown 和连续换行，不把 Skill 标签写入正文', () => {
  const skill = { type: 'agentSkill', attrs: { sourceId: 'source-1', name: 'pdf' } }
  expect(readAgentComposerDocument({ type: 'doc', content: [{ type: 'paragraph', content: [
    ...agentComposerTextNodes('  **前文** '), skill, ...agentComposerTextNodes(' 后文\n\n末尾  '),
  ] }] })).toEqual({ text: '  **前文**  后文\n\n末尾  ', skills: [{ sourceId: 'source-1', name: 'pdf' }], parts: [
    { type: 'text', text: '  **前文** ' }, { type: 'skill', sourceId: 'source-1' }, { type: 'text', text: ' 后文\n\n末尾  ' },
  ] })
})

test('纯 Skill 文档正文为空，同来源去重，不同来源保持选择顺序', () => {
  const skill = (sourceId: string, name: string) => ({ type: 'agentSkill', attrs: { sourceId, name } })
  expect(readAgentComposerDocument({ type: 'doc', content: [{ type: 'paragraph', content: [
    skill('b', 'documents'), skill('a', 'pdf'), skill('b', 'documents'),
  ] }] })).toEqual({ text: '', skills: [{ sourceId: 'b', name: 'documents' }, { sourceId: 'a', name: 'pdf' }], parts: [
    { type: 'skill', sourceId: 'b' }, { type: 'skill', sourceId: 'a' }, { type: 'skill', sourceId: 'b' },
  ] })
})

test('多段换行和空文档保持一致，普通文字不能产生 Skill 引用', () => {
  expect(readAgentComposerDocument({ type: 'doc', content: [
    { type: 'paragraph', content: agentComposerTextNodes('/skills $pdf <span data-agent-inline-skill>pdf</span>') },
    { type: 'paragraph' }, { type: 'paragraph', content: agentComposerTextNodes('end') },
  ] })).toEqual({ text: '/skills $pdf <span data-agent-inline-skill>pdf</span>\n\nend', skills: [], parts: [
    { type: 'text', text: '/skills $pdf <span data-agent-inline-skill>pdf</span>\n\nend' },
  ] })
  expect(readAgentComposerDocument({ type: 'doc', content: [{ type: 'paragraph' }] })).toEqual({ text: '', skills: [], parts: [] })
  expect(agentComposerTextNodes('')).toEqual([])
})
