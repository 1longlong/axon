import { afterEach, beforeEach, describe, expect, test } from 'bun:test'
import { existsSync, mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { createCredentialCodec } from '../channel/channel-credential-codec'
import { McpProjectConfigManager, McpProjectConfigManagerError } from './mcp-project-config-manager'

let directory: string
let manager: McpProjectConfigManager
let configPath: string

const firstConfig = {
  version: 1,
  servers: {
    local: { type: 'stdio', command: 'server-one', env: { SECRET: 'private-token' } },
  },
}

beforeEach(() => {
  directory = mkdtempSync(join(tmpdir(), 'axon-mcp-config-'))
  configPath = join(directory, 'mcp.json')
  manager = new McpProjectConfigManager({
    credentialCodec: createCredentialCodec(),
    resolveProjectDataDir: (projectId) => {
      if (projectId !== 'project-1') throw new Error('missing')
      return directory
    },
  })
})

afterEach(() => rmSync(directory, { recursive: true, force: true }))

describe('MCP 项目配置持久化', () => {
  test('完整配置编码落盘且返回副本', () => {
    const saved = manager.save('project-1', firstConfig)
    expect(readFileSync(configPath, 'utf-8')).not.toContain('private-token')
    expect(saved.servers.local).toMatchObject({ enabled: true, required: false })
    saved.servers = {}
    expect(Object.keys(manager.get('project-1').servers)).toEqual(['local'])
    if (process.platform !== 'win32') expect(statSync(configPath).mode & 0o777).toBe(0o600)
  })

  test('无文件时返回空配置，项目不存在时返回稳定错误', () => {
    expect(manager.get('project-1')).toEqual({ version: 1, servers: {} })
    expect(() => manager.get('missing')).toThrow(McpProjectConfigManagerError)
  })

  test('无效更新不会覆盖上一份有效配置', () => {
    manager.save('project-1', firstConfig)
    expect(() => manager.save('project-1', { version: 1, servers: { bad: { type: 'stdio', command: '' } } })).toThrow()
    expect(manager.get('project-1').servers.local).toBeDefined()
  })

  test('主文件损坏时从备份恢复并重建主文件', () => {
    manager.save('project-1', firstConfig)
    manager.save('project-1', {
      version: 1,
      servers: { local: { type: 'stdio', command: 'server-two' } },
    })
    writeFileSync(configPath, '{broken')
    expect(manager.get('project-1').servers.local).toMatchObject({ command: 'server-one' })
    expect(() => JSON.parse(readFileSync(configPath, 'utf-8'))).not.toThrow()
  })

  test('删除主文件与恢复快照', () => {
    manager.save('project-1', firstConfig)
    manager.save('project-1', firstConfig)
    expect(existsSync(`${configPath}.bak`)).toBe(true)
    expect(manager.delete('project-1')).toBe(true)
    expect(existsSync(configPath)).toBe(false)
    expect(existsSync(`${configPath}.bak`)).toBe(false)
  })
})
