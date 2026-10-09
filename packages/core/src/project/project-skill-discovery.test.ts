import { afterEach, beforeEach, describe, expect, test } from 'bun:test'
import { mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import {
  buildAgentSkillSystemPrompt,
  discoverAgentSkills,
  discoverGlobalAgentSkills,
  discoverProjectSkills,
} from './project-skill-discovery'

let directory: string
let projectRoot: string

function writeSkill(root: string, name: string, frontmatter = ''): void {
  const skillDirectory = join(root, name)
  mkdirSync(skillDirectory, { recursive: true })
  writeFileSync(join(skillDirectory, 'SKILL.md'), `---\nname: ${name}\ndescription: >\n  处理 ${name} 任务\n  并返回结果。\n${frontmatter}---\n\n# 正文\n仅在激活后读取。`)
}

beforeEach(() => {
  directory = mkdtempSync(join(tmpdir(), 'axon-project-skills-'))
  projectRoot = join(directory, 'project')
  mkdirSync(projectRoot)
})

afterEach(() => rmSync(directory, { recursive: true, force: true }))

describe('项目 Skills 发现', () => {
  test('仅发现 .axon/skills 与 .agents/skills 的直接子目录', () => {
    writeSkill(join(projectRoot, '.axon', 'skills'), 'native-skill')
    writeSkill(join(projectRoot, '.agents', 'skills'), 'shared-skill')
    writeSkill(join(projectRoot, '.claude', 'skills'), 'ignored-skill')
    writeSkill(join(projectRoot, '.agents', 'skills', 'nested'), 'too-deep')

    const catalog = discoverProjectSkills({ projectRoot })

    expect(catalog.skills.map((skill) => skill.name)).toEqual(['native-skill', 'shared-skill'])
    expect(catalog.skills.map((skill) => skill.directoryKind)).toEqual(['axon', 'agents'])
    expect(catalog.skills[0]?.description).toBe('处理 native-skill 任务 并返回结果。')
  })

  test('解析标准字段和常见调用控制扩展，但不加载正文到目录', () => {
    writeSkill(join(projectRoot, '.agents', 'skills'), 'release-check', [
      'compatibility: 需要 git',
      'metadata:',
      '  owner: team-a',
      'allowed-tools: Read Bash(git:*)',
      'disable-model-invocation: true',
      'user-invocable: false',
      'argument-hint: "[branch]"',
      '',
    ].join('\n'))

    const skill = discoverProjectSkills({ projectRoot }).skills[0]

    expect(skill).toMatchObject({
      name: 'release-check',
      compatibility: '需要 git',
      metadata: { owner: 'team-a' },
      allowedTools: ['Read', 'Bash(git:*)'],
      disableModelInvocation: true,
      userInvocable: false,
      argumentHint: '[branch]',
    })
    expect(skill && 'content' in skill).toBe(false)
  })

  test('.axon/skills 在同名冲突时覆盖 .agents/skills', () => {
    writeSkill(join(projectRoot, '.axon', 'skills'), 'review-code')
    writeSkill(join(projectRoot, '.agents', 'skills'), 'review-code')

    const catalog = discoverProjectSkills({ projectRoot })

    expect(catalog.skills).toHaveLength(1)
    expect(catalog.skills[0]?.directoryKind).toBe('axon')
    expect(catalog.diagnostics).toContainEqual(expect.objectContaining({ code: 'duplicate_skill' }))
  })

  test('system prompt 只列元数据，并排除禁止模型自动激活的 Skill', () => {
    writeSkill(join(projectRoot, '.agents', 'skills'), 'visible-skill')
    writeSkill(
      join(projectRoot, '.agents', 'skills'),
      'manual-only',
      'disable-model-invocation: true\n',
    )

    const prompt = buildAgentSkillSystemPrompt(
      '基础规则',
      discoverProjectSkills({ projectRoot }),
    )

    expect(prompt).toContain('基础规则\n\n## 可用 Skills')
    expect(prompt).toContain('SkillRead')
    expect(prompt).toContain('.agents/skills/visible-skill/SKILL.md')
    expect(prompt).not.toContain('manual-only')
    expect(prompt).not.toContain('# 正文')
  })

  test('无效 frontmatter、目录名不匹配和超大文件只产生诊断', () => {
    const root = join(projectRoot, '.agents', 'skills')
    const invalidDirectory = join(root, 'Bad_Name')
    mkdirSync(invalidDirectory, { recursive: true })
    writeFileSync(join(invalidDirectory, 'SKILL.md'), '没有 frontmatter')
    writeSkill(root, 'folder-name', 'name: another-name\n')
    const largeDirectory = join(root, 'large-skill')
    mkdirSync(largeDirectory, { recursive: true })
    writeFileSync(join(largeDirectory, 'SKILL.md'), 'x'.repeat(256 * 1024 + 1))

    const catalog = discoverProjectSkills({ projectRoot })

    expect(catalog.skills).toEqual([])
    expect(catalog.diagnostics).toHaveLength(3)
    expect(catalog.diagnostics.map((item) => item.code)).toContain('invalid_frontmatter')
    expect(catalog.diagnostics.map((item) => item.code)).toContain('invalid_skill_file')
  })

  test('忽略指向项目根外的 Skill 目录和 SKILL.md', () => {
    const root = join(projectRoot, '.agents', 'skills')
    mkdirSync(root, { recursive: true })
    const outsideSkill = join(directory, 'external-skill')
    writeSkill(directory, 'external-skill')
    symlinkSync(outsideSkill, join(root, 'external-skill'))

    const linkedFileDirectory = join(root, 'linked-file')
    mkdirSync(linkedFileDirectory)
    const outsideFile = join(directory, 'SKILL.md')
    writeFileSync(outsideFile, '---\nname: linked-file\ndescription: 外部\n---\n')
    symlinkSync(outsideFile, join(linkedFileDirectory, 'SKILL.md'))

    const catalog = discoverProjectSkills({ projectRoot })

    expect(catalog.skills).toEqual([])
    expect(catalog.diagnostics.filter((item) => item.code === 'outside_project')).toHaveLength(2)
  })
})

describe('多级 Skills 发现', () => {
  test('按项目 .axon、项目 .agents、Axon 管理、用户全局顺序选择同名 Skill', () => {
    const builtinRoot = join(directory, 'home', '.axon', 'skills')
    const userRoot = join(directory, 'home', '.agents', 'skills')
    writeSkill(join(projectRoot, '.axon', 'skills'), 'shared-skill')
    writeSkill(join(projectRoot, '.agents', 'skills'), 'shared-skill')
    writeSkill(builtinRoot, 'shared-skill')
    writeSkill(userRoot, 'shared-skill')
    writeSkill(join(projectRoot, '.agents', 'skills'), 'project-agents-only')
    writeSkill(builtinRoot, 'builtin-only')
    writeSkill(userRoot, 'user-only')

    const catalog = discoverAgentSkills({ projectRoot, builtinSkillsRoot: builtinRoot, userSkillsRoot: userRoot })

    expect(catalog.skills.map((skill) => [skill.name, skill.directoryKind])).toEqual([
      ['builtin-only', 'builtin'],
      ['project-agents-only', 'agents'],
      ['shared-skill', 'axon'],
      ['user-only', 'user'],
    ])
    expect(catalog.skills.find((skill) => skill.name === 'builtin-only')?.relativeInstructionPath)
      .toBe('$HOME/.axon/skills/builtin-only/SKILL.md')
    expect(catalog.skills.find((skill) => skill.name === 'user-only')?.relativeInstructionPath)
      .toBe('$HOME/.agents/skills/user-only/SKILL.md')
    expect(catalog.diagnostics.filter((item) => item.code === 'duplicate_skill')).toHaveLength(3)
    expect(catalog.shadowedSkills.map((skill) => skill.directoryKind)).toEqual(['agents', 'builtin', 'user'])
  })

  test('全局设置目录不依赖项目，并保留被 Axon 管理项覆盖的用户来源', () => {
    const builtinRoot = join(directory, 'home', '.axon', 'skills')
    const userRoot = join(directory, 'home', '.agents', 'skills')
    writeSkill(builtinRoot, 'shared-skill')
    writeSkill(userRoot, 'shared-skill')

    const catalog = discoverGlobalAgentSkills({ builtinSkillsRoot: builtinRoot, userSkillsRoot: userRoot })

    expect(catalog.skills[0]?.directoryKind).toBe('builtin')
    expect(catalog.shadowedSkills[0]?.directoryKind).toBe('user')
    expect(catalog.projectRoot).toBe('')
  })

  test('全局 Skill 的符号链接不能逃出各自来源根', () => {
    const builtinRoot = join(directory, 'home', '.axon', 'skills')
    const userRoot = join(directory, 'home', '.agents', 'skills')
    mkdirSync(builtinRoot, { recursive: true })
    const outsideSkill = join(directory, 'outside-global-skill')
    writeSkill(directory, 'outside-global-skill')
    symlinkSync(outsideSkill, join(builtinRoot, 'outside-global-skill'))

    const catalog = discoverAgentSkills({ projectRoot, builtinSkillsRoot: builtinRoot, userSkillsRoot: userRoot })

    expect(catalog.skills).toEqual([])
    expect(catalog.diagnostics).toContainEqual(expect.objectContaining({
      code: 'outside_project',
      message: expect.stringContaining('来源边界外'),
    }))
  })
})
