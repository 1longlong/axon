import { afterEach, describe, expect, test } from 'bun:test'
import { existsSync, mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { createBackendPaths, initializeBackendDirectories } from './backend-paths'

const directories: string[] = []
afterEach(() => {
  for (const directory of directories.splice(0)) rmSync(directory, { recursive: true, force: true })
})

describe('后端显式数据路径', () => {
  test('纯计算不创建目录，业务路径与 Skills 优先级根目录保持现行布局', () => {
    const directory = mkdtempSync(join(tmpdir(), 'axon-backend-paths-'))
    directories.push(directory)
    const homeDir = join(directory, 'user')
    const dataDir = join(homeDir, '.axon-dev')
    const paths = createBackendPaths({ dataDir, homeDir })
    expect(existsSync(homeDir)).toBe(false)
    expect(paths.settingsPath).toBe(join(dataDir, 'settings.json'))
    expect(paths.agentSessionsDir).toBe(join(dataDir, 'agent-sessions'))
    expect(paths.runtimeSessionsDir).toBe(join(dataDir, 'runtime', 'sessions'))
    expect(paths.shellSnapshotsDir).toBe(join(dataDir, 'shell_snapshots'))
    expect(paths.managedSkillsDir).toBe(join(homeDir, '.axon', 'skills'))
    expect(paths.skillInstallationsPath).toBe(join(homeDir, '.axon', 'skill-installations.json'))
    expect(paths.userSkillsDir).toBe(join(homeDir, '.agents', 'skills'))

    initializeBackendDirectories(paths)
    expect(existsSync(paths.conversationsDir)).toBe(true)
    expect(existsSync(paths.agentProjectsDir)).toBe(true)
    expect(existsSync(paths.runtimeSessionsDir)).toBe(true)
    // 私有快照和管理 Skills 的创建、权限仍由自己的发布流程控制。
    expect(existsSync(paths.shellSnapshotsDir)).toBe(false)
    expect(existsSync(paths.managedSkillsDir)).toBe(false)
  })

  test('不同实例不共享路径缓存，边界拒绝相对路径及 NUL', () => {
    const first = createBackendPaths({ dataDir: '/tmp/axon-first', homeDir: '/tmp/axon-user' })
    const second = createBackendPaths({ dataDir: '/tmp/axon-second', homeDir: '/tmp/axon-user' })
    expect(first.channelsPath).not.toBe(second.channelsPath)
    expect(first.managedSkillsDir).toBe(second.managedSkillsDir)
    expect(() => createBackendPaths({ dataDir: './relative', homeDir: '/tmp/user' })).toThrow('绝对路径')
    expect(() => createBackendPaths({ dataDir: '/tmp/data', homeDir: 'relative' })).toThrow('绝对路径')
    expect(() => createBackendPaths({ dataDir: '/tmp/data\0', homeDir: '/tmp/user' })).toThrow('绝对路径')
  })
})
