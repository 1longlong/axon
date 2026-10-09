import { describe, expect, test } from 'bun:test'
import type { AgentMemoryFile, AgentMemoryFileStates, AgentMemorySummary } from '@axon/shared'
import { AgentMemoryServiceError } from './agent-memory-service'
import {
  buildAgentMemoryPromptSection,
  createAgentMemoryTools,
  resolveAgentMemoryContext,
} from './agent-memory-tools'

const toolContext = { toolUseId: 'tool-1' }

function file(relativePath: string, content: string, updatedAt = 1): AgentMemoryFile {
  return { projectId: 'project-1', relativePath, content, size: Buffer.byteLength(content), updatedAt }
}

function summary(states: AgentMemoryFileStates): AgentMemorySummary {
  return {
    projectId: 'project-1',
    indexExists: Boolean(states['MEMORY.md']),
    totalBytes: Object.values(states).reduce((total, state) => total + state.size, 0),
    files: Object.entries(states).map(([relativePath, state]) => ({ relativePath, ...state })),
  }
}

describe('Agent 记忆工具', () => {
  test('列表、读取和写入转换为中立结果，并只在成功后推进会话基线', async () => {
    const reads: string[] = []
    const writes: string[] = []
    const memoryFile = file('preferences.md', '使用中文。', 10)
    const tools = createAgentMemoryTools({
      projectId: 'project-1',
      memory: {
        list: () => summary({ 'preferences.md': { size: memoryFile.size, updatedAt: 10 } }),
        read: (_projectId, path) => ({ ...memoryFile, relativePath: String(path) }),
        write: (_projectId, path, content) => file(String(path), String(content), 11),
      },
      onRead: (value) => reads.push(value.relativePath),
      onWrite: (value) => writes.push(value.relativePath),
    })

    expect(tools.map((tool) => tool.name)).toEqual(['MemoryList', 'MemoryRead', 'MemoryWrite'])
    expect(await tools[0]!.execute({}, toolContext)).toMatchObject({ content: { files: [{ path: 'preferences.md' }] } })
    expect(await tools[1]!.execute({ path: 'preferences.md' }, toolContext)).toMatchObject({
      content: { path: 'preferences.md', content: '使用中文。' },
    })
    expect(await tools[2]!.execute({ path: 'decisions.md', content: '# 决策' }, toolContext)).toMatchObject({
      content: { path: 'decisions.md' },
    })
    expect(reads).toEqual(['preferences.md'])
    expect(writes).toEqual(['decisions.md'])
  })

  test('无效输入和服务错误以工具错误返回，不泄露未知异常', async () => {
    const tools = createAgentMemoryTools({
      projectId: 'project-1',
      memory: {
        list: () => { throw new Error('secret') },
        read: () => { throw new AgentMemoryServiceError('not_found', '记忆文件不存在') },
        write: () => { throw new Error('secret') },
      },
    })
    expect(await tools[0]!.execute({}, toolContext)).toEqual({ content: '项目记忆操作失败', isError: true })
    expect(await tools[1]!.execute({}, toolContext)).toEqual({ content: '记忆路径无效', isError: true })
    expect(await tools[1]!.execute({ path: 'missing.md' }, toolContext)).toEqual({ content: '记忆文件不存在', isError: true })
    expect(await tools[2]!.execute({ path: 'x.md' }, toolContext)).toEqual({ content: '记忆路径或内容无效', isError: true })
  })
})

describe('Agent 记忆上下文', () => {
  test('首次只建立索引基线，不预读主题正文或误报已有文件', () => {
    const reads: string[] = []
    const states = {
      'MEMORY.md': { updatedAt: 1, size: 8 },
      'preferences.md': { updatedAt: 1, size: 12 },
    }
    const context = resolveAgentMemoryContext('project-1', {
      list: () => summary(states),
      read: (_projectId, path) => {
        reads.push(String(path))
        return file('MEMORY.md', '# 索引', 1)
      },
    }, undefined)

    expect(reads).toEqual(['MEMORY.md'])
    expect(context.fileStates).toEqual({ 'MEMORY.md': states['MEMORY.md'] })
    expect(context.prompt).not.toContain('<memory_changes>')
    expect(context.shouldPersistStates).toBe(true)
  })

  test('索引自动推进，主题修改持续提醒到重读推进基线，删除只提醒一次', () => {
    const before = {
      'MEMORY.md': { updatedAt: 1, size: 8 },
      'preferences.md': { updatedAt: 1, size: 10 },
      'removed.md': { updatedAt: 1, size: 5 },
    }
    const current = {
      'MEMORY.md': { updatedAt: 2, size: 9 },
      'preferences.md': { updatedAt: 2, size: 11 },
    }
    const memory = {
      list: () => summary(current),
      read: () => file('MEMORY.md', '# <索引&>', 2),
    }
    const first = resolveAgentMemoryContext('project-1', memory, before)
    expect(first.prompt).toContain('kind="modified" path="memory/MEMORY.md"')
    expect(first.prompt).toContain('kind="modified" path="memory/preferences.md"')
    expect(first.prompt).toContain('kind="deleted" path="memory/removed.md"')
    expect(first.prompt).toContain('# &lt;索引&amp;&gt;')
    expect(first.fileStates).toEqual({
      'MEMORY.md': current['MEMORY.md'],
      'preferences.md': before['preferences.md'],
    })

    const second = resolveAgentMemoryContext('project-1', memory, first.fileStates)
    expect(second.prompt).not.toContain('removed.md')
    expect(second.prompt).toContain('preferences.md')
    expect(second.prompt).not.toContain('kind="modified" path="memory/MEMORY.md"')

    const afterRead = { ...second.fileStates, 'preferences.md': current['preferences.md'] }
    const settled = resolveAgentMemoryContext('project-1', memory, afterRead)
    expect(settled.prompt).not.toContain('<memory_changes>')
    expect(settled.shouldPersistStates).toBe(false)
  })

  test('缺少索引时给出 missing 标记且不读取正文', () => {
    let read = false
    const context = resolveAgentMemoryContext('project-1', {
      list: () => summary({}),
      read: () => { read = true; return file('MEMORY.md', '') },
    }, undefined)
    expect(read).toBe(false)
    expect(context.prompt).toContain('status="missing"')
  })

  test('提示词只在明确长期记忆条件下要求写入', () => {
    const prompt = buildAgentMemoryPromptSection(null)
    expect(prompt).toContain('明确要求跨轮次记住')
    expect(prompt).toContain('稳定规则、偏好或决策')
    expect(prompt).toContain('更新已有主题前先读取并合并')
  })
})
