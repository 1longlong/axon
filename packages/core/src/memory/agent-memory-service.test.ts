import { afterEach, beforeEach, describe, expect, test } from 'bun:test'
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { MAX_AGENT_MEMORY_FILE_BYTES } from '@axon/shared'
import type { AgentProject } from '@axon/shared'
import { AgentMemoryService, AgentMemoryServiceError } from './agent-memory-service'

let directory: string
let enabled: boolean

beforeEach(() => {
  directory = mkdtempSync(join(tmpdir(), 'axon-memory-'))
  enabled = true
})

afterEach(() => rmSync(directory, { recursive: true, force: true }))

function project(memoryEnabled = enabled): AgentProject {
  return {
    id: 'project-1', name: '项目', slug: 'project', workspace: { kind: 'local', path: directory },
    memoryEnabled, createdAt: 1, updatedAt: 1,
  }
}

function service(): AgentMemoryService {
  return new AgentMemoryService({
    projects: {
      get: (id) => id === 'project-1' ? project() : undefined,
      resolveProjectCwd: (id) => {
        if (id !== 'project-1') throw new Error('missing')
        return directory
      },
    },
  })
}

function expectCode(action: () => unknown, code: AgentMemoryServiceError['code']): void {
  try {
    action()
    throw new Error(`应当抛出 ${code}`)
  } catch (error) {
    expect(error).toBeInstanceOf(AgentMemoryServiceError)
    expect((error as AgentMemoryServiceError).code).toBe(code)
  }
}

describe('AgentMemoryService', () => {
  test('空目录、嵌套原子写入、排序与读取形成完整文件链路', () => {
    const memory = service()
    expect(memory.list('project-1')).toMatchObject({ indexExists: false, totalBytes: 0, files: [] })

    const topic = memory.write('project-1', 'topics/preferences.md', '使用中文。')
    memory.write('project-1', 'MEMORY.md', '# 索引')
    writeFileSync(join(directory, 'memory', 'ignored.txt'), 'ignore')

    expect(topic).toMatchObject({ relativePath: 'topics/preferences.md', content: '使用中文。' })
    expect(memory.list('project-1')).toMatchObject({
      indexExists: true,
      files: [
        { relativePath: 'MEMORY.md' },
        { relativePath: 'topics/preferences.md' },
      ],
    })
    expect(memory.read('project-1', 'topics/preferences.md').content).toBe('使用中文。')
    expect(existsSync(join(directory, 'memory', 'topics', 'preferences.md.tmp'))).toBe(false)
  })

  test('项目开关和项目存在性在所有文件访问之前生效', () => {
    const memory = service()
    enabled = false
    expectCode(() => memory.list('project-1'), 'disabled')
    expect(existsSync(join(directory, 'memory'))).toBe(false)
    expectCode(() => memory.read('missing', 'MEMORY.md'), 'project_unavailable')
  })

  test('拒绝越界路径、非 Markdown、过深目录和超大文件', () => {
    const memory = service()
    for (const path of ['../escape.md', '/absolute.md', 'bad\\path.md', 'note.txt', 'a/b/c/d/e.md']) {
      expectCode(() => memory.write('project-1', path, 'x'), 'invalid_input')
    }
    expectCode(
      () => memory.write('project-1', 'large.md', 'x'.repeat(MAX_AGENT_MEMORY_FILE_BYTES + 1)),
      'limit_exceeded',
    )
  })

  test('拒绝无效 UTF-8 和 memory 内的符号链接', () => {
    const memory = service()
    mkdirSync(join(directory, 'memory'))
    writeFileSync(join(directory, 'memory', 'broken.md'), Buffer.from([0xff]))
    expectCode(() => memory.read('project-1', 'broken.md'), 'storage_error')

    if (process.platform !== 'win32') {
      const outside = join(directory, 'outside.md')
      writeFileSync(outside, 'outside')
      symlinkSync(outside, join(directory, 'memory', 'linked.md'))
      expectCode(() => memory.read('project-1', 'linked.md'), 'storage_error')
      expectCode(() => memory.write('project-1', 'linked.md', 'replace'), 'storage_error')
    }
  })
})
