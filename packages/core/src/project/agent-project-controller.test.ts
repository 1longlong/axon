import { afterEach, beforeEach, describe, expect, test } from 'bun:test'
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type { AgentSessionMeta } from '@axon/shared'
import { BackendClientRegistry } from '../backend-client-registry'
import { AgentProjectController } from './agent-project-controller'
import { AgentProjectManager } from './agent-project-manager'

let directory: string
let manager: AgentProjectManager
let sessions: AgentSessionMeta[]
let clients: BackendClientRegistry
let owner: string

beforeEach(() => {
  directory = mkdtempSync(join(tmpdir(), 'axon-project-ipc-'))
  manager = new AgentProjectManager({
    indexPath: join(directory, 'projects.json'),
    projectsDir: join(directory, 'managed'),
    createId: () => 'project-1',
    now: () => 10,
  })
  sessions = []
  let count = 7
  clients = new BackendClientRegistry(() => `client-${count++}`)
  owner = clients.register()
})

afterEach(() => {
  clients.dispose()
  rmSync(directory, { recursive: true, force: true })
})

function controller(): AgentProjectController {
  return new AgentProjectController({
    clients,
    projects: manager,
    sessions: { list: () => sessions },
  })
}

describe('AgentProjectController 项目与工作区边界', () => {
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
    const ipc = new AgentProjectController({
      clients,
      projects: manager,
      sessions: { list: () => sessions },
      watcher: {
        watch: (ownerId, projectId) => { calls.push(`watch:${ownerId}:${projectId}`) },
        unwatch: (ownerId, projectId) => { calls.push(`unwatch:${ownerId}:${projectId}`) },
        clearOwner: (ownerId) => { calls.push(`clear:${ownerId}`) },
      },
    })
    ipc.watchDirectory(owner, created.id, () => {})
    ipc.unwatchDirectory(owner, created.id)
    clients.detach(owner)
    expect(calls).toEqual(['watch:client-7:project-1', 'unwatch:client-7:project-1', 'clear:client-7'])
  })

  test('拒绝未登记和失效身份；断开仅清理原入口，释放后不接受订阅或迟到投递', () => {
    const project = manager.create({ name: '订阅项目' })
    const second = clients.register()
    const callbacks = new Map<string, (time: number) => void>()
    const clears: string[] = []
    const events: string[] = []
    const value = new AgentProjectController({ clients, projects: manager, sessions: { list: () => [] }, watcher: {
      watch: (client, _project, _root, emit) => { callbacks.set(client, emit) },
      unwatch: () => {}, clearOwner: (client) => { clears.push(client) },
    } })
    expect(() => value.watchDirectory('未知入口', project.id, () => {})).toThrow('未登记')
    expect(callbacks.size).toBe(0)
    value.watchDirectory(owner, project.id, () => events.push('first'))
    value.watchDirectory(second, project.id, () => events.push('second'))
    clients.detach(owner)
    expect(clears).toEqual([owner])
    callbacks.get(owner)!(1)
    callbacks.get(second)!(1)
    expect(events).toEqual(['second'])
    expect(() => value.watchDirectory(owner, project.id, () => {})).toThrow('已断开')
    value.dispose()
    value.dispose()
    expect(clients.has(second)).toBe(true)
    expect(clears).toEqual([owner, second])
    callbacks.get(second)!(2)
    expect(events).toEqual(['second'])
    expect(() => value.watchDirectory(second, project.id, () => {})).toThrow('已断开')
  })

})
