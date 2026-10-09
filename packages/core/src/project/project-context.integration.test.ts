import { afterEach, beforeEach, describe, expect, test } from 'bun:test'
import { mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import {
  AgentProjectManager,
  buildAgentSkillSystemPrompt,
  buildProjectInstructionSystemPrompt,
  createAgentSkillReadScope,
  createBackendPaths,
  discoverAgentSkills,
  initializeBackendDirectories,
  listWorkspaceDirectory,
  readWorkspaceFilePreview,
  resolveProjectInstructions,
} from '../index'

let directory: string
beforeEach(() => { directory = mkdtempSync(join(tmpdir(), 'axon-core-project-context-')) })
afterEach(() => rmSync(directory, { recursive: true, force: true }))

/** 隔离来源内创建同名 Skill，用正文差异检查实际读取来源，而非只检查目录标签。 */
function writeSkill(root: string, body: string): void {
  const target = join(root, 'review-code')
  mkdirSync(target, { recursive: true })
  writeFileSync(join(target, 'SKILL.md'), `---\nname: review-code\ndescription: 审查代码\n---\n${body}`)
}

describe('core 项目上下文公开入口', () => {
  test.each(['managed', 'local'] as const)('%s 工作区在存储重建后继续提供指令、渐进工具和文件预览', async (kind) => {
    expect(process.versions.electron).toBeUndefined()
    const paths = createBackendPaths({ dataDir: join(directory, 'data'), homeDir: join(directory, 'home') })
    initializeBackendDirectories(paths)
    const options = { indexPath: paths.agentProjectsIndexPath, projectsDir: paths.agentProjectsDir }
    const projects = new AgentProjectManager(options)
    const localRoot = join(directory, 'workspace')
    mkdirSync(localRoot)
    const project = projects.create({
      name: 'Project Context',
      ...(kind === 'local' ? { workspace: { kind: 'local' as const, path: localRoot } } : {}),
    })
    const root = projects.resolveProjectCwd(project.id)
    mkdirSync(join(root, 'src'))
    writeFileSync(join(root, 'AGENTS.md'), '根规则')
    writeFileSync(join(root, 'src', 'AGENTS.md'), '子目录规则')
    writeFileSync(join(root, 'src', 'index.ts'), 'export const value = 1\n')
    writeSkill(join(root, '.axon', 'skills'), '# 项目正文')
    writeSkill(paths.managedSkillsDir, '# 内置正文')
    writeSkill(paths.userSkillsDir, '# 用户正文')

    const restoredRoot = new AgentProjectManager(options).resolveProjectCwd(project.id)
    expect(restoredRoot).toBe(root)
    if (kind === 'local') expect(restoredRoot).toBe(realpathSync(localRoot))
    const instructions = resolveProjectInstructions({ projectRoot: restoredRoot })
    const nested = resolveProjectInstructions({ projectRoot: restoredRoot, targetPath: join(restoredRoot, 'src', 'index.ts') })
    expect(instructions.sources.map((item) => item.scopeRoot)).toEqual(['.'])
    expect(nested.sources.map((item) => item.scopeRoot)).toEqual(['.', 'src'])

    const catalog = discoverAgentSkills({
      projectRoot: restoredRoot,
      builtinSkillsRoot: paths.managedSkillsDir,
      userSkillsRoot: paths.userSkillsDir,
    })
    const prompt = buildAgentSkillSystemPrompt(buildProjectInstructionSystemPrompt('基础规则', instructions), catalog)
    expect(prompt).toContain('根规则')
    expect(prompt).toContain('review-code')
    expect(prompt).not.toContain('# 项目正文')
    expect(catalog.shadowedSkills.map((item) => item.directoryKind)).toEqual(['builtin', 'user'])
    const scope = createAgentSkillReadScope(catalog)
    const result = await scope.tool.execute({ name: 'review-code' }, { toolUseId: 'skill-read' })
    expect(result.isError).not.toBe(true)
    expect(result.content).toContain('# 项目正文')
    expect(scope.getActivations()[0]?.directoryKind).toBe('axon')

    const preview = await readWorkspaceFilePreview(restoredRoot, 'src/index.ts')
    expect(preview).toMatchObject({ kind: 'text', relativePath: 'src/index.ts', content: 'export const value = 1\n' })
    expect((await listWorkspaceDirectory(restoredRoot)).entries.some((item) => item.name === 'src')).toBe(true)
    await expect(readWorkspaceFilePreview(restoredRoot, '../outside.txt')).rejects.toMatchObject({ code: 'outside_workspace' })
    const canceled = new AbortController()
    canceled.abort()
    expect((await scope.tool.execute({ name: 'review-code' }, { toolUseId: 'canceled', signal: canceled.signal })).isError).toBe(true)
  })
})
