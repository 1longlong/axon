import { afterEach, beforeEach, describe, expect, test } from 'bun:test'
import { existsSync, mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { createChannelCredentialCodec } from './channel-credential-codec'
import { ChannelManager, ChannelManagerError } from './channel-manager'
import type { ChannelCreateInput } from '@axon/shared'

let testDirectory: string
let configPath: string
let nowValue: number
let nextId: number

beforeEach(() => {
  testDirectory = mkdtempSync(join(tmpdir(), 'axon-channels-'))
  configPath = join(testDirectory, 'channels.json')
  nowValue = 1_000
  nextId = 1
})

afterEach(() => {
  rmSync(testDirectory, { recursive: true, force: true })
})

function createManager(): ChannelManager {
  return new ChannelManager({
    configPath,
    credentialCodec: createChannelCredentialCodec(),
    createId: () => `channel-${nextId++}`,
    now: () => nowValue,
  })
}

function createInput(overrides: Partial<ChannelCreateInput> = {}): ChannelCreateInput {
  return {
    name: 'OpenAI 主渠道',
    provider: 'openai',
    apiKey: 'sk-test-secret',
    models: [{ id: 'gpt-test', name: 'GPT Test', enabled: true }],
    enabled: true,
    ...overrides,
  }
}

describe('ChannelManager CRUD', () => {
  test('创建渠道时应用默认 URL、加密凭据且不向列表暴露密文', () => {
    const manager = createManager()
    const channel = manager.create(createInput())

    expect(channel).toEqual({
      id: 'channel-1',
      name: 'OpenAI 主渠道',
      provider: 'openai',
      baseUrl: 'https://api.openai.com/v1',
      models: [{ id: 'gpt-test', name: 'GPT Test', enabled: true }],
      enabled: true,
      hasApiKey: true,
      createdAt: 1_000,
      updatedAt: 1_000,
    })
    expect('apiKey' in channel).toBe(false)
    expect(readFileSync(configPath, 'utf-8')).not.toContain('sk-test-secret')
    expect(manager.resolve(channel.id).apiKey).toBe('sk-test-secret')
  })

  test('更新空 API Key 时保留凭据，非空时替换并保持 createdAt', () => {
    const manager = createManager()
    const created = manager.create(createInput())

    nowValue = 2_000
    const preserved = manager.update(created.id, { name: '新名称', apiKey: '' })
    expect(preserved.createdAt).toBe(1_000)
    expect(preserved.updatedAt).toBe(2_000)
    expect(manager.resolve(created.id).apiKey).toBe('sk-test-secret')

    nowValue = 3_000
    manager.update(created.id, { apiKey: 'sk-replaced' })
    expect(manager.resolve(created.id).apiKey).toBe('sk-replaced')
  })

  test('切换供应商且未显式传 URL 时采用新供应商默认值', () => {
    const manager = createManager()
    const created = manager.create(createInput())

    const updated = manager.update(created.id, { provider: 'anthropic' })
    expect(updated.baseUrl).toBe('https://api.anthropic.com')
  })

  test('删除渠道返回安全 DTO 并从配置移除', () => {
    const manager = createManager()
    const created = manager.create(createInput())

    expect(manager.delete(created.id).id).toBe(created.id)
    expect(manager.list()).toEqual([])
    expect(manager.get(created.id)).toBeUndefined()
  })

  test('操作不存在渠道时返回稳定 not_found 错误码', () => {
    const manager = createManager()

    for (const operation of [
      () => manager.update('missing', { name: 'x' }),
      () => manager.delete('missing'),
      () => manager.resolve('missing'),
    ]) {
      try {
        operation()
        throw new Error('应当失败')
      } catch (error) {
        expect(error).toBeInstanceOf(ChannelManagerError)
        expect((error as ChannelManagerError).code).toBe('not_found')
      }
    }
  })

  test('返回值是副本，renderer 侧修改不会污染磁盘状态', () => {
    const manager = createManager()
    manager.create(createInput())
    const listed = manager.list()
    listed[0]!.name = '被外部修改'
    listed[0]!.models[0]!.name = '被外部修改的模型'

    expect(manager.list()[0]!.name).toBe('OpenAI 主渠道')
    expect(manager.list()[0]!.models[0]!.name).toBe('GPT Test')
  })
})

describe('ChannelManager 校验与恢复', () => {
  test('自定义渠道必须提供 HTTP(S) URL', () => {
    const manager = createManager()
    expect(() => manager.create(createInput({ provider: 'custom', baseUrl: '' }))).toThrow('必须填写 Base URL')
    expect(() => manager.create(createInput({ baseUrl: 'file:///tmp/api' }))).toThrow('有效的 HTTP(S) 地址')
  })

  test('拒绝重复模型 ID', () => {
    const manager = createManager()
    expect(() => manager.create(createInput({
      models: [
        { id: 'same', name: '模型一', enabled: true },
        { id: 'same', name: '模型二', enabled: false },
      ],
    }))).toThrow('模型 ID 重复')
  })

  test('读取时过滤无效和重复记录并回写当前版本', () => {
    const codec = createChannelCredentialCodec()
    const valid = {
      id: 'valid',
      name: '有效渠道',
      provider: 'google',
      baseUrl: 'https://generativelanguage.googleapis.com',
      encryptedCredential: codec.encrypt('google-key'),
      models: [],
      enabled: true,
      createdAt: 10,
      updatedAt: 10,
    }
    writeFileSync(configPath, JSON.stringify({
      version: 0,
      channels: [valid, { ...valid }, { id: 'bad' }],
    }))

    const manager = createManager()
    expect(manager.list().map((channel) => channel.id)).toEqual(['valid'])
    expect(JSON.parse(readFileSync(configPath, 'utf-8')).version).toBe(1)
  })

  test('主配置损坏时从备份恢复到上一个完整版本', () => {
    const manager = createManager()
    const channel = manager.create(createInput())
    manager.update(channel.id, { name: '第二版名称' })
    writeFileSync(configPath, '{ broken', 'utf-8')

    expect(manager.get(channel.id)?.name).toBe('OpenAI 主渠道')
  })

  test('配置文件使用仅当前用户可读写权限', () => {
    const manager = createManager()
    manager.create(createInput())

    expect(existsSync(configPath)).toBe(true)
    if (process.platform !== 'win32') {
      expect(statSync(configPath).mode & 0o777).toBe(0o600)
    }
  })
})
