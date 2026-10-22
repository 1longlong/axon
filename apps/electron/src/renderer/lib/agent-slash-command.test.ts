import { expect, test } from 'bun:test'
import type { JSONContent } from '@tiptap/react'
import { agentComposerTextNodes } from './agent-composer-document'
import { matchAgentLocalCommands, matchAgentSlashCandidates, readAgentSlashInput, resolveAgentSlashCommand } from './agent-slash-command'
import type { AgentSkillChoice } from '@axon/shared'

const skills: AgentSkillChoice[] = [
  { sourceId: 'review', name: 'review-code', description: '代码审查', directoryKind: 'axon', relativeInstructionPath: '.axon/skills/review/SKILL.md' },
  { sourceId: 'pdf', name: 'pdf', description: '处理文档', directoryKind: 'builtin', relativeInstructionPath: 'pdf/SKILL.md' },
]

test('斜杠候选同时包含命令和 Skill，逐字匹配名称或描述，不要求先输入 skills', () => {
  const match = (text: string) => matchAgentSlashCandidates(readAgentSlashInput(document(text))!, skills)
  expect(match('/').map((item) => item.kind)).toEqual(['command', 'skill', 'skill'])
  for (const text of ['/r', '/re', '/review', '/REVIEW', '/审查']) {
    expect(match(text)).toEqual([{ kind: 'skill', skill: skills[0]! }])
  }
  expect(match('/pd')).toEqual([{ kind: 'skill', skill: skills[1]! }])
  expect(match('/missing')).toEqual([])
  expect(match('/review arg')).toEqual([])
  expect(matchAgentSlashCandidates(readAgentSlashInput(document('/'))!, [])).toEqual([
    { kind: 'command', command: { name: 'skills', description: '选择本轮使用的 Skill' } },
  ])
})

const document = (text: string): JSONContent => ({ type: 'doc', content: [{ type: 'paragraph', content: agentComposerTextNodes(text) }] })

test('仅注册 skills：斜杠/前缀可选择补全，完整命令可直接提交', () => {
  for (const text of ['/', '/s', '/sk', '/skills']) {
    const input = readAgentSlashInput(document(text))!
    expect(matchAgentLocalCommands(input).map((item) => item.name)).toEqual(['skills'])
    expect(resolveAgentSlashCommand(input, true).kind).toBe('command')
  }
  expect(resolveAgentSlashCommand(readAgentSlashInput(document('/skills  '))!, false).kind).toBe('command')
  expect(resolveAgentSlashCommand(readAgentSlashInput(document('/sk'))!, false).kind).toBe('error')
})

test('完整路径、文件后缀、代码、URL、正文内斜杠和后续行不识别为命令', () => {
  for (const text of ['/Users/me/file.ts', '/tmp/', '/skills/example', '//server/share', '/README.md',
    'https://example.com/skills', '`/skills`', '```\n/skills\n```', '请使用 /skills', ' /skills', '正文\n/skills']) {
    expect(readAgentSlashInput(document(text))).toBeUndefined()
  }
})

test('未知或带参数的命令返回错误，不推断其他本地动作', () => {
  for (const text of ['/unknown', '/model', '/skills pdf', '/skills /tmp/file', '/Skills']) {
    const input = readAgentSlashInput(document(text))!
    expect(matchAgentLocalCommands(input)).toHaveLength(0)
    expect(resolveAgentSlashCommand(input, true).kind).toBe('error')
  }
})

test('命令删除范围仅包含首行和分隔符，不吃掉下方正文；硬换行与段落都可用', () => {
  expect(readAgentSlashInput(document('/skills\n保留正文\n尾部'))).toEqual({ name: 'skills', arguments: '', from: 1, to: 9, lineEnd: 8 })
  expect(readAgentSlashInput({ type: 'doc', content: [
    { type: 'paragraph', content: agentComposerTextNodes('/skills') },
    { type: 'paragraph', content: agentComposerTextNodes('保留正文') },
  ] })).toEqual({ name: 'skills', arguments: '', from: 0, to: 9, lineEnd: 8 })
  expect(readAgentSlashInput(document('/skills'))).toEqual({ name: 'skills', arguments: '', from: 1, to: 8, lineEnd: 8 })
})

test('首行有 Skill 时不把相邻文字拼成命令，下方 Skill 不影响首行', () => {
  const skill = { type: 'agentSkill', attrs: { sourceId: 'source', name: 'pdf' } }
  expect(readAgentSlashInput({ type: 'doc', content: [{ type: 'paragraph', content: [
    skill, ...agentComposerTextNodes('/skills'),
  ] }] })).toBeUndefined()
  expect(readAgentSlashInput({ type: 'doc', content: [{ type: 'paragraph', content: [
    ...agentComposerTextNodes('/skills'), skill,
  ] }] })).toBeUndefined()
  expect(readAgentSlashInput({ type: 'doc', content: [{ type: 'paragraph', content: [
    ...agentComposerTextNodes('/skills\n'), skill,
  ] }] })?.name).toBe('skills')
})
