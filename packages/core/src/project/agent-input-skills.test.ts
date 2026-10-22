import { afterEach, beforeEach, describe, expect, test } from 'bun:test'
import { mkdirSync, mkdtempSync, realpathSync, rmSync, symlinkSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type { AgentSessionMeta, AgentSkillAttachment } from '@axon/shared'
import { AgentInputSkills } from './agent-input-skills'
import { createLocalSkillCatalogProvider } from './local-skill-catalog'
import { discoverAgentSkills, discoverProjectSkills } from './project-skill-discovery'
import { readAgentSkillResource } from './agent-skill-resource'
import { createAgentSkillReadScope } from './agent-skill-read-tool'

let root: string, session: AgentSessionMeta, inputs: AgentInputSkills
function writeSkill(base: string, name: string, body: string, flags = ''): string {
  const directory = join(base, name); mkdirSync(directory, { recursive: true })
  writeFileSync(join(directory, 'SKILL.md'), `---\nname: ${name}\ndescription: ${name} 的指引\n${flags}---\n${body}`)
  return directory
}
function selected(sourceId: string, name = 'review'): AgentSkillAttachment { return { kind: 'skill', id: 'selection', sourceId, name, createdAt: 1 } }
beforeEach(() => {
  root = realpathSync(mkdtempSync(join(tmpdir(), 'axon-input-skills-')))
  session = { id: 'session', runtimeId: 'pi', title: '测试', projectId: 'project', createdAt: 1, updatedAt: 1 }
  inputs = new AgentInputSkills(() => discoverAgentSkills({ projectRoot: root, builtinSkillsRoot: join(root, 'managed'), userSkillsRoot: join(root, 'user') }))
})
afterEach(() => rmSync(root, { recursive: true, force: true }))
describe('显式 Skill 来源与直接加载', () => {
  test('只展示生效来源，用户禁用项不展示，禁自动匹配项仍允许选择', () => {
    writeSkill(join(root, '.axon', 'skills'), 'review', '# project')
    writeSkill(join(root, '.agents', 'skills'), 'review', '# shared')
    writeSkill(join(root, 'managed'), 'review', '# managed')
    writeSkill(join(root, 'user'), 'review', '# global')
    writeSkill(join(root, 'user'), 'hidden', '# hidden', 'user-invocable: false\n')
    writeSkill(join(root, 'user'), 'manual', '# manual', 'disable-model-invocation: true\n')
    const choices = inputs.list(session)
    expect(choices.map((skill) => skill.name).sort()).toEqual(['manual', 'review'])
    expect(choices.find((skill) => skill.name === 'review')?.directoryKind).toBe('axon')
    expect(choices[0]?.sourceId).toMatch(/^[a-f0-9]{64}$/)
    expect(JSON.stringify(choices)).not.toContain(root)
    const manual = choices.find((skill) => skill.name === 'manual')!
    expect(inputs.prepare(session, [selected(manual.sourceId, 'manual')]).context).toContain('# manual')
  })
  test('正文作为 user 上下文准备、确切路径去重并保留 explicit 激活', async () => {
    const directory = writeSkill(join(root, '.axon', 'skills'), 'review', '# 当时指引')
    mkdirSync(join(directory, 'references')); writeFileSync(join(directory, 'references', 'rules.md'), '# 引用')
    const choice = inputs.list(session)[0]!, prepared = inputs.prepare(session, [selected(choice.sourceId), selected(choice.sourceId)])
    expect(prepared.context.match(/<skill>/g)).toHaveLength(1)
    expect(prepared.context).toContain('<name>review</name>'); expect(prepared.context).toContain('# 当时指引')
    expect(prepared.skillActivations?.[0]?.sources).toEqual(['explicit'])
    const scope = createAgentSkillReadScope(discoverProjectSkills({ projectRoot: root }), prepared.skillActivations)
    expect((await scope.tool.execute({ name: 'review', relative_path: 'references/rules.md' }, { toolUseId: 'ref' })).isError).not.toBe(true)
    await scope.tool.execute({ name: 'review' }, { toolUseId: 'entry' })
    expect(scope.getActivations()[0]?.sources).toEqual(['explicit', 'skill_read'])
  })
  test('伪造/跨会话/正文更新/高优先级覆盖的旧 ID 拒绝，历史旧正文不改写', () => {
    const path = writeSkill(join(root, 'user'), 'review', '# old')
    const choice = inputs.list(session)[0]!, prepared = inputs.prepare(session, [selected(choice.sourceId)])
    expect(() => inputs.resolve({ ...session, id: 'other' }, choice.sourceId)).toThrow()
    expect(() => inputs.resolve(session, 'f'.repeat(64))).toThrow()
    writeFileSync(join(path, 'SKILL.md'), '---\nname: review\ndescription: review 的指引\n---\n# new')
    expect(() => inputs.prepare(session, [selected(choice.sourceId)])).toThrow()
    expect(prepared.context).toContain('# old'); expect(prepared.context).not.toContain('# new')
    const updated = inputs.list(session)[0]!
    writeSkill(join(root, '.axon', 'skills'), 'review', '# project')
    expect(() => inputs.resolve(session, updated.sourceId)).toThrow()
  })
  test('总正文超预算不截断，公共读取拒绝替换、二进制及引用逃逸', () => {
    const directory = writeSkill(join(root, '.axon', 'skills'), 'review', 'x'.repeat(80_001))
    expect(() => inputs.prepare(session, [selected(inputs.list(session)[0]!.sourceId)])).toThrow('80,000')
    writeSkill(join(root, '.axon', 'skills'), 'review', '# normal')
    const descriptor = discoverProjectSkills({ projectRoot: root }).skills[0]!
    writeFileSync(join(root, 'secret.md'), 'not a skill')
    symlinkSync(join(root, 'secret.md'), join(directory, 'escape.md'))
    expect(() => readAgentSkillResource(descriptor, 'escape.md')).toThrow()
    expect(() => readAgentSkillResource(descriptor, '../secret.md')).toThrow()
    writeFileSync(join(directory, '..notes.md'), '合法根内文件')
    expect(readAgentSkillResource(descriptor, '..notes.md').content).toBe('合法根内文件')
    writeFileSync(join(directory, 'binary.dat'), Buffer.from([0xff, 0xfe]))
    expect(() => readAgentSkillResource(descriptor, 'binary.dat')).toThrow()
    writeFileSync(join(directory, 'SKILL.md'), '# replaced')
    expect(() => readAgentSkillResource(descriptor)).toThrow('已更新')
  })
  test('本地安装源包含引用/哈希且拒绝越界链接，不是额外发现根', () => {
    const directory = writeSkill(join(root, 'source'), 'review', '# native')
    mkdirSync(join(directory, 'references')); writeFileSync(join(directory, 'references', 'rules.md'), '# rules')
    const provider = createLocalSkillCatalogProvider(join(root, 'source'), [{ catalogId: 'axon/review', name: 'review', version: '1.0.0' }])
    const catalog = provider.getCatalog()
    expect(catalog).not.toBeInstanceOf(Promise)
    if (catalog instanceof Promise) throw new Error('本地来源应同步')
    expect(catalog.packages[0]?.files).toHaveLength(2)
    expect(catalog.packages[0]?.contentHash).toMatch(/^[a-f0-9]{64}$/)
    expect(inputs.list(session)).toEqual([])
    symlinkSync(join(root, 'source'), join(directory, 'escape'))
    expect(() => provider.getCatalog()).toThrow('符号链接')
  })
})
