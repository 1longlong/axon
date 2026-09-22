import type { AgentProject, AgentSessionMeta } from '@axon/shared'

export interface AgentProjectTreeEntry {
  project: AgentProject
  sessions: AgentSessionMeta[]
}

function normalizeSearchText(value: string): string {
  return value.trim().toLocaleLowerCase('zh-CN')
}

/**
 * 将项目与会话索引关联为左侧树；命中项目名时保留全部子会话，
 * 只命中会话标题时仅保留匹配子项，空项目仍可按项目名找到。
 */
export function buildAgentProjectTree(
  projects: readonly AgentProject[],
  sessions: readonly AgentSessionMeta[],
  query: string,
): AgentProjectTreeEntry[] {
  const normalizedQuery = normalizeSearchText(query)
  return projects.flatMap((project) => {
    const children = sessions.filter((session) => session.projectId === project.id)
    if (!normalizedQuery) return [{ project, sessions: children }]
    if (normalizeSearchText(project.name).includes(normalizedQuery)) {
      return [{ project, sessions: children }]
    }
    const matched = children.filter((session) => (
      normalizeSearchText(session.title).includes(normalizedQuery)
    ))
    return matched.length ? [{ project, sessions: matched }] : []
  })
}
