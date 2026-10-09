import { afterEach, beforeEach, describe, expect, test } from 'bun:test'
import { mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { createAgentSkillReadScope } from './agent-skill-read-tool'
import { discoverProjectSkills } from './project-skill-discovery'

let projectRoot: string

beforeEach(() => {
  projectRoot = mkdtempSync(join(tmpdir(), 'axon-skill-read-'))
  const skillRoot = join(projectRoot, '.axon', 'skills', 'review-code')
  mkdirSync(join(skillRoot, 'references'), { recursive: true })
  writeFileSync(join(skillRoot, 'SKILL.md'), [
    '---',
    'name: review-code',
    'description: 审查关键代码',
    '---',
    '',
    '# 审查步骤',
  ].join('\n'))
  writeFileSync(join(skillRoot, 'references', 'rules.md'), '# 规则')
})

afterEach(() => rmSync(projectRoot, { recursive: true, force: true }))

describe('统一 SkillRead 工具', () => {
  test('读取入口后记录一次激活，读取引用文件不会新增激活', async () => {
    const scope = createAgentSkillReadScope(discoverProjectSkills({ projectRoot }))
    const entry = await scope.tool.execute({ name: 'review-code' }, { toolUseId: 'entry' })
    const reference = await scope.tool.execute(
      { name: 'review-code', relative_path: 'references/rules.md' },
      { toolUseId: 'reference' },
    )

    expect(entry.isError).not.toBe(true)
    expect(String(entry.content)).toContain('# 审查步骤')
    expect(String(reference.content)).toContain('# 规则')
    expect(scope.getActivations()).toEqual([{
      name: 'review-code',
      directoryKind: 'axon',
      relativeInstructionPath: '.axon/skills/review-code/SKILL.md',
      sources: ['skill_read'],
    }])
  })

  test('拒绝未知 Skill、路径穿越和运行中替换的越界符号链接', async () => {
    const scope = createAgentSkillReadScope(discoverProjectSkills({ projectRoot }))
    const outside = join(projectRoot, 'outside.md')
    writeFileSync(outside, 'secret')
    symlinkSync(outside, join(projectRoot, '.axon', 'skills', 'review-code', 'escape.md'))

    expect((await scope.tool.execute({ name: 'missing' }, { toolUseId: 'missing' })).isError).toBe(true)
    expect((await scope.tool.execute(
      { name: 'review-code', relative_path: '../outside.md' },
      { toolUseId: 'traversal' },
    )).isError).toBe(true)
    expect((await scope.tool.execute(
      { name: 'review-code', relative_path: 'escape.md' },
      { toolUseId: 'symlink' },
    )).isError).toBe(true)
    expect(scope.getActivations()).toEqual([])
  })
})
