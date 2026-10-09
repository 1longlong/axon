import { afterEach, beforeEach, describe, expect, test } from 'bun:test'
import { existsSync, mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { createFixtureCredentialCodec } from '../../test-support/credential-codec'
import { McpProjectConfigManager, McpProjectConfigManagerError } from './mcp-project-config-manager'
import { createCredentialCodec } from '../channel/credential-codec'

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
    credentialCodec: createFixtureCredentialCodec(),
    resolveProjectDataDir: (projectId) => {
      if (projectId !== 'project-1') throw new Error('missing')
      return directory
    },
  })
})

afterEach(() => rmSync(directory, { recursive: true, force: true }))

describe('MCP 项目配置持久化', () => {
  test('完整配置编码落盘且返回副本', async () => {
    const saved = (await manager.save('project-1', firstConfig))
    expect(readFileSync(configPath, 'utf-8')).not.toContain('private-token')
    expect(saved.servers.local).toMatchObject({ enabled: true, required: false })
    saved.servers = {}
    expect(Object.keys((await manager.get('project-1')).servers)).toEqual(['local'])
    if (process.platform !== 'win32') expect(statSync(configPath).mode & 0o777).toBe(0o600)
  })

  test('无文件时返回空配置，项目不存在时返回稳定错误', async () => {
    expect((await manager.get('project-1'))).toEqual({ version: 1, servers: {} })
    await expect(manager.get('missing')).rejects.toThrow(McpProjectConfigManagerError)
  })

  test('无效更新不会覆盖上一份有效配置', async () => {
    await manager.save('project-1', firstConfig)
    await expect(manager.save('project-1', { version: 1, servers: { bad: { type: 'stdio', command: '' } } })).rejects.toThrow()
    expect((await manager.get('project-1')).servers.local).toBeDefined()
  })

  test('主文件损坏时从备份恢复并重建主文件', async () => {
    await manager.save('project-1', firstConfig)
    await manager.save('project-1', {
      version: 1,
      servers: { local: { type: 'stdio', command: 'server-two' } },
    })
    writeFileSync(configPath, '{broken')
    expect((await manager.get('project-1')).servers.local).toMatchObject({ command: 'server-one' })
    expect(() => JSON.parse(readFileSync(configPath, 'utf-8'))).not.toThrow()
  })

  test('删除主文件与恢复快照', async () => {
    await manager.save('project-1', firstConfig)
    await manager.save('project-1', firstConfig)
    expect(existsSync(`${configPath}.bak`)).toBe(true)
    expect(manager.delete('project-1')).toBe(true)
    expect(existsSync(configPath)).toBe(false)
    expect(existsSync(`${configPath}.bak`)).toBe(false)
  })

  test('慢加密保存不能覆盖更晚保存的配置', async () => {
    const codec = createFixtureCredentialCodec()
    let finish: (value: string) => void = () => { throw new Error('加密未启动') }
    const delayed = new Promise<string>((resolve) => { finish = resolve })
    let first = true
    manager = new McpProjectConfigManager({
      resolveProjectDataDir: () => directory,
      credentialCodec: { ...codec, encrypt: (value) => {
        if (first) { first = false; return delayed }
        return codec.encrypt(value)
      } },
    })
    const pending = manager.save('project-1', firstConfig)
    await manager.save('project-1', { version: 1, servers: { new: { type: 'stdio', command: 'new-server' } } })
    const previous = readFileSync(configPath, 'utf8')
    finish(await codec.encrypt(JSON.stringify(firstConfig)))
    await expect(pending).rejects.toThrow('较新的操作替代')
    expect(readFileSync(configPath, 'utf8')).toBe(previous)
    expect((await manager.get('project-1')).servers.new).toBeDefined()
  })

  test('备份解密等待期间保存的新配置不会被旧备份恢复覆盖', async () => {
    await manager.save('project-1', firstConfig)
    await manager.save('project-1', firstConfig)
    writeFileSync(configPath, '{broken')
    const backup = JSON.parse(readFileSync(`${configPath}.bak`, 'utf8')) as { encryptedConfig: string }
    const codec = createFixtureCredentialCodec()
    let finish: (value: string) => void = () => { throw new Error('解密未启动') }
    const delayed = new Promise<string>((resolve) => { finish = resolve })
    let first = true
    manager = new McpProjectConfigManager({
      resolveProjectDataDir: () => directory,
      credentialCodec: { ...codec, decrypt: (value) => {
        if (first) { first = false; return delayed }
        return codec.decrypt(value)
      } },
    })
    const restoring = manager.get('project-1')
    await manager.save('project-1', { version: 1, servers: { new: { type: 'stdio', command: 'new-server' } } })
    const currentFile = readFileSync(configPath, 'utf8')
    finish(await codec.decrypt(backup.encryptedConfig))
    expect((await restoring).servers.new).toBeDefined()
    expect(readFileSync(configPath, 'utf8')).toBe(currentFile)
  })

  test('配置删除淘汰在途加密，项目消失也不能创建或复活私有目录', async () => {
    const codec = createFixtureCredentialCodec()
    for (const removeProject of [false, true]) {
      let finish: (value: string) => void = () => { throw new Error('加密未启动') }
      const delayed = new Promise<string>((resolve) => { finish = resolve })
      let projectExists = true
      manager = new McpProjectConfigManager({
        resolveProjectDataDir: () => {
          if (!projectExists) throw new Error('missing')
          return directory
        },
        credentialCodec: { ...codec, encrypt: () => delayed },
      })
      const pending = manager.save('project-1', firstConfig)
      if (removeProject) projectExists = false
      else manager.delete('project-1')
      finish(await codec.encrypt(JSON.stringify(firstConfig)))
      await expect(pending).rejects.toMatchObject({
        code: removeProject ? 'project_unavailable' : 'storage_error',
      })
      expect(existsSync(configPath)).toBe(false)
    }
  })

  test('缺少安全后端时拒绝保存或解密，不降级明文且不覆盖既有配置', async () => {
    const unavailable = new McpProjectConfigManager({
      resolveProjectDataDir: () => directory, credentialCodec: createCredentialCodec(),
    })
    await expect(unavailable.save('project-1', firstConfig)).rejects.toMatchObject({ code: 'credential_error' })
    expect(existsSync(configPath)).toBe(false)
    await manager.save('project-1', firstConfig)
    const previous = readFileSync(configPath, 'utf8')
    await expect(unavailable.get('project-1')).rejects.toMatchObject({ code: 'credential_error' })
    expect(readFileSync(configPath, 'utf8')).toBe(previous)
  })
})
