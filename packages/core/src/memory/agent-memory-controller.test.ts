import { describe, expect, test } from 'bun:test'
import type { AgentProject } from '@axon/shared'
import { AgentMemoryController } from './agent-memory-controller'
import { AgentMemoryServiceError } from './agent-memory-service'
import { BackendClientRegistry } from '../backend-client-registry'

function project(memoryEnabled: boolean): AgentProject {
  return {
    id: 'project-1', name: '项目', slug: 'project', workspace: { kind: 'managed' },
    memoryEnabled, createdAt: 1, updatedAt: 1,
  }
}

function controller(memoryEnabled = true) {
  const calls: string[] = []
  let count = 7
  const clients = new BackendClientRegistry(() => `client-${count++}`)
  const owner = clients.register()
  const callbacks = new Map<string, (time: number, path?: string) => void>()
  const value = new AgentMemoryController({
    clients,
    memory: {
      list: (projectId) => ({ projectId, indexExists: false, totalBytes: 0, files: [] }),
      read: (projectId, relativePath) => ({ projectId, relativePath: String(relativePath), content: '', size: 0, updatedAt: 1 }),
      write: (projectId, relativePath, content) => ({ projectId, relativePath: String(relativePath), content: String(content), size: 0, updatedAt: 1 }),
    },
    projects: {
      get: (id) => id === 'project-1' ? project(memoryEnabled) : undefined,
      resolveProjectCwd: () => '/trusted/workspace',
    },
    watcher: {
      watch: (ownerId, projectId, root, emit) => {
        calls.push(`watch:${ownerId}:${projectId}:${root}`)
        callbacks.set(ownerId, emit)
      },
      unwatch: (ownerId, projectId) => calls.push(`unwatch:${ownerId}:${projectId}`),
      clearOwner: (ownerId) => calls.push(`clear:${ownerId}`),
    },
  })
  return { value, calls, clients, owner, callbacks }
}

describe('AgentMemoryController', () => {
  test('收束文本参数并只把可信项目 cwd 交给监听器', () => {
    const { value, calls, clients, owner } = controller()
    expect(value.list(' project-1 ').projectId).toBe('project-1')
    expect(value.read(' project-1 ', ' MEMORY.md ').relativePath).toBe('MEMORY.md')
    value.watch(owner, ' project-1 ', () => {})
    value.unwatch(owner, 'project-1')
    clients.detach(owner)
    expect(calls).toEqual([
      'watch:client-7:project-1:/trusted/workspace',
      'unwatch:client-7:project-1',
      'clear:client-7',
    ])
  })

  test('记忆关闭、项目不存在和非法写入均在后端拒绝', () => {
    const { value: disabled, owner } = controller(false)
    expect(() => disabled.watch(owner, 'project-1', () => {})).toThrow(AgentMemoryServiceError)
    expect(() => disabled.watch(owner, 'missing', () => {})).toThrow('Agent 项目不存在')
    expect(() => disabled.write('project-1', 'MEMORY.md', 1)).toThrow('记忆内容无效')
    expect(() => disabled.list('')).toThrow('项目标识无效')
  })

  test('拒绝未登记与失效入口，断开仅清理自己的记忆订阅，释放后丢弃迟到回调', () => {
    const { value, calls, clients, owner, callbacks } = controller()
    const second = clients.register()
    const events: string[] = []
    expect(() => value.watch('未知入口', 'project-1', () => {})).toThrow('未登记')
    expect(calls).toEqual([])
    value.watch(owner, 'project-1', () => events.push('first'))
    value.watch(second, 'project-1', () => events.push('second'))
    clients.detach(owner)
    expect(calls.filter((call) => call.startsWith('clear:'))).toEqual([`clear:${owner}`])
    callbacks.get(owner)!(1, 'MEMORY.md')
    callbacks.get(second)!(1, 'MEMORY.md')
    expect(events).toEqual(['second'])
    expect(() => value.watch(owner, 'project-1', () => {})).toThrow('已断开')
    value.dispose()
    value.dispose()
    expect(clients.has(second)).toBe(true)
    callbacks.get(second)!(2, 'MEMORY.md')
    expect(events).toEqual(['second'])
    expect(calls.filter((call) => call.startsWith('clear:'))).toEqual([`clear:${owner}`, `clear:${second}`])
    expect(() => value.watch(second, 'project-1', () => {})).toThrow('已断开')
    clients.dispose()
  })
})
