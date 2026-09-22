import { describe, expect, test } from 'bun:test'
import type { AgentProject, AgentSessionMeta } from '@axon/shared'
import { buildAgentProjectTree } from './agent-session-list'

const projects: AgentProject[] = [
  { id: 'project-a', name: '桌面客户端', slug: 'desktop', workspace: { kind: 'managed' }, memoryEnabled: false, createdAt: 1, updatedAt: 2 },
  { id: 'project-b', name: '空项目', slug: 'empty', workspace: { kind: 'managed' }, memoryEnabled: false, createdAt: 1, updatedAt: 1 },
]
const sessions: AgentSessionMeta[] = [
  { id: 'session-1', runtimeId: 'pi', title: '修复登录', projectId: 'project-a', createdAt: 1, updatedAt: 3 },
  { id: 'session-2', runtimeId: 'pi', title: 'Write README', projectId: 'project-a', createdAt: 1, updatedAt: 2 },
  { id: 'orphan', runtimeId: 'pi', title: '旧孤立会话', createdAt: 1, updatedAt: 1 },
]

describe('Agent 项目会话树', () => {
  test('按项目顺序分组，只把 projectId 匹配的会话放入子节点', () => {
    expect(buildAgentProjectTree(projects, sessions, '')).toEqual([
      { project: projects[0]!, sessions: sessions.slice(0, 2) },
      { project: projects[1]!, sessions: [] },
    ])
  })

  test('项目名命中保留全部子项，会话名命中只保留匹配子项', () => {
    expect(buildAgentProjectTree(projects, sessions, ' 客户端 ')[0]?.sessions).toHaveLength(2)
    expect(buildAgentProjectTree(projects, sessions, 'write')[0]?.sessions.map((item) => item.id)).toEqual(['session-2'])
    expect(buildAgentProjectTree(projects, sessions, '空项目')[0]?.project.id).toBe('project-b')
  })

  test('无匹配返回空树且不修改输入', () => {
    expect(buildAgentProjectTree(projects, sessions, '不存在')).toEqual([])
    expect(sessions.map((item) => item.id)).toEqual(['session-1', 'session-2', 'orphan'])
  })
})
