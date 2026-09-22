import { describe, expect, test } from 'bun:test'
import type { AgentProject } from '@axon/shared'
import { AgentMemoryIpcController } from './agent-memory-ipc-handlers'
import { AgentMemoryServiceError } from './agent-memory-service'

function project(memoryEnabled: boolean): AgentProject {
  return {
    id: 'project-1', name: '项目', slug: 'project', workspace: { kind: 'managed' },
    memoryEnabled, createdAt: 1, updatedAt: 1,
  }
}

function controller(memoryEnabled = true) {
  const calls: string[] = []
  const value = new AgentMemoryIpcController({
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
      watch: (ownerId, projectId, root) => calls.push(`watch:${ownerId}:${projectId}:${root}`),
      unwatch: (ownerId, projectId) => calls.push(`unwatch:${ownerId}:${projectId}`),
      clearOwner: (ownerId) => calls.push(`clear:${ownerId}`),
    },
  })
  return { value, calls }
}

describe('AgentMemoryIpcController', () => {
  test('收束文本参数并只把可信项目 cwd 交给监听器', () => {
    const { value, calls } = controller()
    expect(value.list(' project-1 ').projectId).toBe('project-1')
    expect(value.read(' project-1 ', ' MEMORY.md ').relativePath).toBe('MEMORY.md')
    value.watch(7, ' project-1 ', () => {})
    value.unwatch(7, 'project-1')
    value.clearWatches(7)
    expect(calls).toEqual([
      'watch:7:project-1:/trusted/workspace',
      'unwatch:7:project-1',
      'clear:7',
    ])
  })

  test('记忆关闭、项目不存在和非法写入均在主进程拒绝', () => {
    const disabled = controller(false).value
    expect(() => disabled.watch(1, 'project-1', () => {})).toThrow(AgentMemoryServiceError)
    expect(() => disabled.watch(1, 'missing', () => {})).toThrow('Agent 项目不存在')
    expect(() => disabled.write('project-1', 'MEMORY.md', 1)).toThrow('记忆内容无效')
    expect(() => disabled.list('')).toThrow('项目标识无效')
  })
})
