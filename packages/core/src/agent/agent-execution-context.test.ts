/** 固定工作目录解析的主要边界；不调用模型、Shell 或项目配置。 */
import { expect, test } from 'bun:test'
import { mkdirSync, mkdtempSync, realpathSync, renameSync, rmSync, symlinkSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type { AgentSessionMeta } from '@axon/shared'
import { canonicalizeAgentWorkspace } from './agent-execution-context'
import { resolveBackendAgentContext } from '../backend-agent-session-context'

test('普通会话仍必须有项目，Loop 根与子会话取同一个真实目录', () => {
  const directory = realpathSync(mkdtempSync(join(tmpdir(), 'axon-execution-context-')))
  try {
    const ordinary: AgentSessionMeta = { id: 'ordinary', runtimeId: 'pi', title: '普通', createdAt: 1, updatedAt: 1 }
    const loop: AgentSessionMeta = { ...ordinary, id: 'loop-root', creationOrigin: 'loop', creationWorkspacePath: directory }
    let projectReads = 0
    const options = { getSession: (id: string) => id === loop.id ? loop : undefined,
      resolveProjectCwd: () => { projectReads++; return 'project-root' } }
    expect(() => resolveBackendAgentContext(ordinary, options)).toThrow('尚未归入项目')
    expect(resolveBackendAgentContext({ ...ordinary, projectId: 'project' }, options)).toEqual({ workspacePath: 'project-root' })
    projectReads = 0
    expect(resolveBackendAgentContext(loop, options)).toEqual({ workspacePath: directory })
    const child: AgentSessionMeta = { ...ordinary, id: 'child', parentSessionId: loop.id, rootSessionId: loop.id,
      parentToolUseId: 'call', subagentType: 'explore' }
    expect(resolveBackendAgentContext(child, options)).toEqual({ workspacePath: directory })
    expect(projectReads).toBe(0)
    expect(() => resolveBackendAgentContext({ ...child, projectId: 'unrelated' }, options)).toThrow('归属无效')
    expect(() => resolveBackendAgentContext(child, { ...options, getSession: () => undefined })).toThrow()
  } finally { rmSync(directory, { recursive: true }) }
})

test('创建规范化目录别名；运行时目录丢失、非目录或改指向均拒绝，不回退', () => {
  const directory = realpathSync(mkdtempSync(join(tmpdir(), 'axon-execution-directory-')))
  try {
    const workspace = join(directory, 'workspace'), other = join(directory, 'other'), alias = join(directory, 'alias')
    mkdirSync(workspace); mkdirSync(other); symlinkSync(workspace, alias); writeFileSync(join(directory, 'file'), '不是目录')
    expect(canonicalizeAgentWorkspace(alias)).toBe(workspace)
    expect(() => canonicalizeAgentWorkspace(join(directory, 'file'))).toThrow('不是文件夹')
    expect(() => canonicalizeAgentWorkspace('../workspace')).toThrow('工作目录无效')
    const root: AgentSessionMeta = { id: 'root', runtimeId: 'pi', title: 'Loop', createdAt: 1, updatedAt: 1,
      creationOrigin: 'loop', creationWorkspacePath: workspace }
    const options = { getSession: () => root, resolveProjectCwd: () => { throw new Error('不应调用项目解析') } }
    renameSync(workspace, join(directory, 'previous'))
    expect(() => resolveBackendAgentContext(root, options)).toThrow()
    symlinkSync(other, workspace)
    expect(() => resolveBackendAgentContext(root, options)).toThrow('已改变')
  } finally { rmSync(directory, { recursive: true }) }
})
