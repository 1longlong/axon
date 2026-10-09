import { afterEach, beforeEach, describe, expect, test } from 'bun:test'
import { mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { buildAgentSandboxPolicy } from './agent-sandbox-policy'

let directory: string

beforeEach(() => {
  directory = mkdtempSync(join(tmpdir(), 'axon-sandbox-policy-'))
})

afterEach(() => rmSync(directory, { recursive: true, force: true }))

describe('AgentSandboxPolicy', () => {
  test('workspaceWrite 允许项目根写入，但保留目录优先保持只读且默认断网', () => {
    const policy = buildAgentSandboxPolicy({ projectRoot: directory, mode: 'workspaceWrite' })
    const canonicalDirectory = realpathSync(directory)

    expect(policy).toEqual({
      platform: 'macos',
      mode: 'workspaceWrite',
      workingDirectory: canonicalDirectory,
      readAccess: { type: 'fullAccess' },
      writableRoots: [canonicalDirectory],
      protectedReadOnlyRoots: [
        join(canonicalDirectory, '.git'),
        join(canonicalDirectory, '.axon'),
        join(canonicalDirectory, '.agents'),
      ],
      networkAccess: false,
    })
  })

  test('readOnly 不提供任何可写根', () => {
    const policy = buildAgentSandboxPolicy({ projectRoot: directory, mode: 'readOnly' })
    expect(policy.writableRoots).toEqual([])
  })

  test('worktree 的外置 gitdir 也进入只读保护范围', () => {
    const gitDirectory = join(directory, 'git-data', 'worktrees', 'feature')
    const projectRoot = join(directory, 'workspace')
    mkdirSync(gitDirectory, { recursive: true })
    mkdirSync(projectRoot)
    writeFileSync(join(projectRoot, '.git'), 'gitdir: ../git-data/worktrees/feature\n', 'utf8')

    const policy = buildAgentSandboxPolicy({ projectRoot, mode: 'workspaceWrite' })
    expect(policy.protectedReadOnlyRoots).toContain(realpathSync(gitDirectory))
  })

  test('拒绝相对路径与文件路径', () => {
    expect(() => buildAgentSandboxPolicy({ projectRoot: 'relative', mode: 'workspaceWrite' })).toThrow()
    const file = join(directory, 'not-a-directory')
    writeFileSync(file, 'x', 'utf8')
    expect(() => buildAgentSandboxPolicy({ projectRoot: file, mode: 'workspaceWrite' })).toThrow()
  })
})
