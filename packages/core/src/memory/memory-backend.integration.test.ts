import { afterEach, beforeEach, describe, expect, test } from 'bun:test'
import { existsSync, mkdtempSync, readFileSync, rmSync, utimesSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type { AgentMemoryFile, AgentMemoryFileStates } from '@axon/shared'
import {
  AgentMemoryController,
  BackendClientRegistry,
  AgentMemoryService,
  AgentMemoryWatcher,
  AgentProjectManager,
  AgentSessionManager,
  createAgentMemoryTools,
  createBackendPaths,
  initializeBackendDirectories,
  resolveAgentMemoryContext,
} from '../index'

let directory: string
beforeEach(() => { directory = mkdtempSync(join(tmpdir(), 'axon-core-memory-')) })
afterEach(() => rmSync(directory, { recursive: true, force: true }))

describe('core 记忆非 Electron 装配', () => {
  test('项目开关、索引注入、按需读取及陈旧基线在存储重建后形成完整链路', async () => {
    expect(process.versions.electron).toBeUndefined()
    const paths = createBackendPaths({ dataDir: join(directory, 'data'), homeDir: join(directory, 'home') })
    initializeBackendDirectories(paths)
    const projectOptions = { indexPath: paths.agentProjectsIndexPath, projectsDir: paths.agentProjectsDir }
    const sessionOptions = { indexPath: paths.agentSessionsIndexPath, sessionsDir: paths.agentSessionsDir }
    const projects = new AgentProjectManager(projectOptions)
    const project = projects.create({ name: 'Memory Project' })
    const memory = new AgentMemoryService({ projects })
    const watcher = new AgentMemoryWatcher()
    const clients = new BackendClientRegistry()
    const controller = new AgentMemoryController({ clients, memory, projects, watcher })
    const workspace = projects.resolveProjectCwd(project.id)
    const memoryRoot = join(workspace, 'memory')
    expect(() => controller.write(project.id, 'preferences.md', '# 旧规则')).toThrow('尚未启用记忆')
    expect(existsSync(memoryRoot)).toBe(false)
    projects.update(project.id, { memoryEnabled: true })
    controller.write(project.id, 'MEMORY.md', '- preferences.md：偏好')
    const original = controller.write(project.id, 'preferences.md', '# 旧规则')

    let sessions = new AgentSessionManager(sessionOptions)
    const session = sessions.create({ projectId: project.id })
    const bodyReads: string[] = []
    const contextMemory = {
      list: (id: string) => memory.list(id),
      read: (id: string, path: unknown) => { bodyReads.push(String(path)); return memory.read(id, path) },
    }
    const first = resolveAgentMemoryContext(project.id, contextMemory, undefined)
    expect(bodyReads).toEqual(['MEMORY.md'])
    expect(first.fileStates['preferences.md']).toBeUndefined()
    expect(first.prompt).not.toContain('# 旧规则')
    sessions.update(session.id, { memoryFileStates: first.fileStates })

    /** 生产装配的中立回调：成功读/写后只推进该会话的元信息，不把正文放进 state。 */
    const remember = (file: AgentMemoryFile): void => {
      const current = sessions.get(session.id)!
      sessions.update(session.id, {
        memoryFileStates: { ...current.memoryFileStates, [file.relativePath]: { updatedAt: file.updatedAt, size: file.size } },
      })
    }
    const tools = createAgentMemoryTools({ projectId: project.id, memory, onRead: remember, onWrite: remember })
    const read = tools.find((tool) => tool.name === 'MemoryRead')!
    const write = tools.find((tool) => tool.name === 'MemoryWrite')!
    expect(write.permissionMode).not.toBe('managed')
    expect(read.permissionMode).toBe('managed')
    expect(await read.execute({ path: 'preferences.md' }, { toolUseId: 'first-read' }))
      .toMatchObject({ content: { content: '# 旧规则' } })

    // 外部写入不调用 remember；同字节长度、不同 mtime 也必须触发提醒。
    controller.write(project.id, 'preferences.md', '# 新规则')
    const topicPath = join(memoryRoot, 'preferences.md')
    const modifiedAt = new Date(original.updatedAt + 5_000)
    utimesSync(topicPath, modifiedAt, modifiedAt)
    sessions = new AgentSessionManager(sessionOptions)
    const baseline = sessions.get(session.id)?.memoryFileStates
    expect(baseline?.['preferences.md']?.updatedAt).toBe(original.updatedAt)
    bodyReads.length = 0
    const stale = resolveAgentMemoryContext(project.id, contextMemory, baseline)
    expect(bodyReads).toEqual(['MEMORY.md'])
    expect(stale.prompt).toContain('kind="modified" path="memory/preferences.md"')
    expect(stale.prompt).not.toContain('# 新规则')
    expect(stale.fileStates['preferences.md']).toEqual(baseline?.['preferences.md'])
    expect(resolveAgentMemoryContext(project.id, contextMemory, stale.fileStates).prompt).toContain('<memory_changes>')
    const diskState = readFileSync(join(paths.agentSessionsDir, session.id, 'state.json'), 'utf8')
    expect(diskState).not.toContain('# 旧规则')
    expect(diskState).not.toContain('# 新规则')

    const reread = await read.execute({ path: 'preferences.md' }, { toolUseId: 'reread' })
    expect(reread).toMatchObject({ content: { content: '# 新规则' } })
    let known: AgentMemoryFileStates | undefined = sessions.get(session.id)?.memoryFileStates
    expect(resolveAgentMemoryContext(project.id, contextMemory, known).prompt).not.toContain('<memory_changes>')
    await write.execute({ path: 'preferences.md', content: '# 自身更新' }, { toolUseId: 'own-write' })
    known = new AgentSessionManager(sessionOptions).get(session.id)?.memoryFileStates
    expect(resolveAgentMemoryContext(project.id, contextMemory, known).prompt).not.toContain('<memory_changes>')

    // 已创建的工具也在实际访问时重查开关，不能沿用上一轮启用状态。
    projects.update(project.id, { memoryEnabled: false })
    expect((await read.execute({ path: 'preferences.md' }, { toolUseId: 'disabled-read' })).isError).toBe(true)
    expect((await write.execute({ path: 'preferences.md', content: '不能写入' }, { toolUseId: 'disabled-write' })).isError).toBe(true)
    expect(readFileSync(topicPath, 'utf8')).toBe('# 自身更新')
    clients.dispose()
    controller.dispose()
    watcher.dispose()
  })
})
