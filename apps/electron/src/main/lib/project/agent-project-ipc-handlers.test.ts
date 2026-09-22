import { afterEach, beforeEach, describe, expect, test } from 'bun:test'
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type { AgentSessionMeta } from '@axon/shared'
import { AgentProjectIpcController } from './agent-project-ipc-handlers'
import { AgentProjectManager } from './agent-project-manager'

let directory: string
let manager: AgentProjectManager
let sessions: AgentSessionMeta[]

beforeEach(() => {
  directory = mkdtempSync(join(tmpdir(), 'axon-project-ipc-'))
  manager = new AgentProjectManager({
    indexPath: join(directory, 'projects.json'),
    projectsDir: join(directory, 'managed'),
    createId: () => 'project-1',
    now: () => 10,
  })
  sessions = []
})

afterEach(() => rmSync(directory, { recursive: true, force: true }))

function controller(): AgentProjectIpcController {
  return new AgentProjectIpcController({
    projects: manager,
    sessions: { list: () => sessions },
  })
}

describe('AgentProjectIpcController 项目与工作区边界', () => {
  test('CRUD 只接受项目 DTO，项目被会话引用时禁止删除', () => {
    const ipc = controller()
    const created = ipc.create({ name: '桌面端', workspace: { kind: 'managed' } })
    expect(ipc.list()).toEqual([created])
    expect(ipc.get(created.id)).toEqual(created)
    expect(ipc.update(created.id, { name: '桌面应用' }).name).toBe('桌面应用')
    expect(() => ipc.create({ name: '非法', projectRootPath: '/tmp' })).toThrow()

    sessions = [{ id: 'session-1', runtimeId: 'pi', title: '会话', projectId: created.id, createdAt: 1, updatedAt: 1 }]
    expect(() => ipc.delete(created.id)).toThrow(/仍有 Agent 会话/)
    sessions = []
    expect(ipc.delete(created.id).id).toBe(created.id)
  })

  test('文件树与预览先通过 projectId 解析唯一工作区', async () => {
    const local = join(directory, 'local')
    mkdirSync(local)
    writeFileSync(join(local, 'README.md'), '# Axon')
    const created = controller().create({ name: 'Local', workspace: { kind: 'local', path: local } })

    expect(await controller().listDirectory(created.id)).toMatchObject({
      projectId: created.id,
      entries: [{ name: 'README.md', relativePath: 'README.md', kind: 'file' }],
    })
    expect(await controller().readFile(created.id, 'README.md')).toMatchObject({
      projectId: created.id,
      relativePath: 'README.md',
      kind: 'text',
      content: '# Axon',
    })
  })

  test('监听器使用项目作为所有权键，并支持 renderer 级清理', () => {
    const created = controller().create({ name: 'Managed', workspace: { kind: 'managed' } })
    const calls: string[] = []
    const ipc = new AgentProjectIpcController({
      projects: manager,
      sessions: { list: () => sessions },
      watcher: {
        watch: (ownerId, projectId) => { calls.push(`watch:${ownerId}:${projectId}`) },
        unwatch: (ownerId, projectId) => { calls.push(`unwatch:${ownerId}:${projectId}`) },
        clearOwner: (ownerId) => { calls.push(`clear:${ownerId}`) },
      },
    })
    ipc.watchDirectory(7, created.id, () => {})
    ipc.unwatchDirectory(7, created.id)
    ipc.clearDirectoryWatches(7)
    expect(calls).toEqual(['watch:7:project-1', 'unwatch:7:project-1', 'clear:7'])
  })

})
