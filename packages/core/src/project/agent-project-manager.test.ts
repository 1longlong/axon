import { afterEach, beforeEach, describe, expect, test } from 'bun:test'
import { existsSync, mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { AgentProjectManager, AgentProjectManagerError } from './agent-project-manager'

let directory: string
let sequence: number

beforeEach(() => {
  directory = mkdtempSync(join(tmpdir(), 'axon-projects-'))
  sequence = 0
})

afterEach(() => rmSync(directory, { recursive: true, force: true }))

function createManager(): AgentProjectManager {
  return new AgentProjectManager({
    indexPath: join(directory, 'agent-projects.json'),
    projectsDir: join(directory, 'managed'),
    createId: () => `project-${++sequence}`,
    now: () => 100 + sequence,
  })
}

function expectCode(action: () => unknown, code: AgentProjectManagerError['code']): void {
  try {
    action()
    throw new Error('expected AgentProjectManagerError')
  } catch (error) {
    expect(error).toBeInstanceOf(AgentProjectManagerError)
    expect((error as AgentProjectManagerError).code).toBe(code)
  }
}

describe('AgentProjectManager 项目与唯一工作区', () => {
  test('项目默认使用应用管理目录，并可在本地与默认工作区之间整体切换', () => {
    const manager = createManager()
    const project = manager.create({ name: 'Desktop App' })
    expect(project.workspace).toEqual({ kind: 'managed' })
    expect(project.memoryEnabled).toBe(false)
    expect(manager.resolveProjectCwd(project.id)).toBe(join(directory, 'managed', 'desktop-app', 'workspace-files'))

    const localPath = join(directory, 'local-project')
    mkdirSync(localPath)
    const canonicalLocalPath = realpathSync(localPath)
    const local = manager.update(project.id, { workspace: { kind: 'local', path: localPath } })
    expect(local.workspace).toMatchObject({ kind: 'local', path: canonicalLocalPath, status: 'available' })
    expect(manager.resolveProjectCwd(project.id)).toBe(canonicalLocalPath)

    const managed = manager.update(project.id, { workspace: { kind: 'managed' } })
    expect(managed.workspace).toEqual({ kind: 'managed' })
    expect(manager.update(project.id, { memoryEnabled: true }).memoryEnabled).toBe(true)
    expect(createManager().get(project.id)?.memoryEnabled).toBe(true)
  })

  test('本地工作区失效时拒绝运行，删除项目不删除用户目录', () => {
    const manager = createManager()
    const localPath = join(directory, 'keep-local')
    mkdirSync(localPath)
    const project = manager.create({ name: 'Local', workspace: { kind: 'local', path: localPath } })
    rmSync(localPath, { recursive: true })
    expect(manager.get(project.id)?.workspace).toMatchObject({ status: 'missing' })
    expectCode(() => manager.resolveProjectCwd(project.id), 'workspace_unavailable')

    mkdirSync(localPath)
    manager.delete(project.id)
    expect(existsSync(localPath)).toBe(true)
  })

  test('拒绝重复名称、非法工作区形状和损坏的新索引', () => {
    const manager = createManager()
    manager.create({ name: 'Project' })
    expectCode(() => manager.create({ name: ' project ' }), 'duplicate')
    expectCode(() => manager.update('project-1', { workspace: { kind: 'local' } as never }), 'invalid_input')
    writeFileSync(join(directory, 'agent-projects.json'), '{broken')
    expectCode(() => manager.list(), 'storage_error')
  })
})
