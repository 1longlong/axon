import { afterEach, beforeEach, describe, expect, test } from 'bun:test'
import { existsSync, mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { createFixtureCredentialCodec } from '../../test-support/credential-codec'
import { ChannelManager, ChannelManagerError } from './channel-manager'
import type { ChannelCreateInput } from '@axon/shared'
import { createCredentialCodec } from './credential-codec'

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
    credentialCodec: createFixtureCredentialCodec(),
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
  test('创建渠道时应用默认 URL、加密凭据且不向列表暴露密文', async () => {
    const manager = createManager()
    const channel = (await manager.create(createInput()))

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
    expect((await manager.resolve(channel.id)).apiKey).toBe('sk-test-secret')
  })

  test('更新空 API Key 时保留凭据，非空时替换并保持 createdAt', async () => {
    const manager = createManager()
    const created = (await manager.create(createInput()))

    nowValue = 2_000
    const preserved = (await manager.update(created.id, { name: '新名称', apiKey: '' }))
    expect(preserved.createdAt).toBe(1_000)
    expect(preserved.updatedAt).toBe(2_000)
    expect((await manager.resolve(created.id)).apiKey).toBe('sk-test-secret')

    nowValue = 3_000
    await manager.update(created.id, { apiKey: 'sk-replaced' })
    expect((await manager.resolve(created.id)).apiKey).toBe('sk-replaced')
  })

  test('切换供应商且未显式传 URL 时采用新供应商默认值', async () => {
    const manager = createManager()
    const created = (await manager.create(createInput()))

    const updated = (await manager.update(created.id, { provider: 'anthropic' }))
    expect(updated.baseUrl).toBe('https://api.anthropic.com')
  })

  test('删除渠道返回安全 DTO 并从配置移除', async () => {
    const manager = createManager()
    const created = (await manager.create(createInput()))

    expect(manager.delete(created.id).id).toBe(created.id)
    expect(manager.list()).toEqual([])
    expect(manager.get(created.id)).toBeUndefined()
  })

  test('操作不存在渠道时返回稳定 not_found 错误码', async () => {
    const manager = createManager()

    for (const operation of [
      async () => (await manager.update('missing', { name: 'x' })),
      () => manager.delete('missing'),
      async () => (await manager.resolve('missing')),
    ]) {
      try {
        await operation()
        throw new Error('应当失败')
      } catch (error) {
        expect(error).toBeInstanceOf(ChannelManagerError)
        expect((error as ChannelManagerError).code).toBe('not_found')
      }
    }
  })

  test('返回值是副本，renderer 侧修改不会污染磁盘状态', async () => {
    const manager = createManager()
    await manager.create(createInput())
    const listed = manager.list()
    listed[0]!.name = '被外部修改'
    listed[0]!.models[0]!.name = '被外部修改的模型'

    expect(manager.list()[0]!.name).toBe('OpenAI 主渠道')
    expect(manager.list()[0]!.models[0]!.name).toBe('GPT Test')
  })
})

describe('ChannelManager 校验与恢复', () => {
  test('自定义渠道必须提供 HTTP(S) URL', async () => {
    const manager = createManager()
    await expect(manager.create(createInput({ provider: 'custom', baseUrl: '' }))).rejects.toThrow('必须填写 Base URL')
    await expect(manager.create(createInput({ baseUrl: 'file:///tmp/api' }))).rejects.toThrow('有效的 HTTP(S) 地址')
  })

  test('拒绝重复模型 ID', async () => {
    const manager = createManager()
    await expect(manager.create(createInput({
      models: [
        { id: 'same', name: '模型一', enabled: true },
        { id: 'same', name: '模型二', enabled: false },
      ],
    }))).rejects.toThrow('模型 ID 重复')
  })

  test('读取时过滤无效和重复记录并回写当前版本', async () => {
    const codec = createFixtureCredentialCodec()
    const valid = {
      id: 'valid',
      name: '有效渠道',
      provider: 'google',
      baseUrl: 'https://generativelanguage.googleapis.com',
      encryptedCredential: (await codec.encrypt('google-key')),
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

  test('主配置损坏时从备份恢复到上一个完整版本', async () => {
    const manager = createManager()
    const channel = (await manager.create(createInput()))
    await manager.update(channel.id, { name: '第二版名称' })
    writeFileSync(configPath, '{ broken', 'utf-8')

    expect(manager.get(channel.id)?.name).toBe('OpenAI 主渠道')
  })

  test('配置文件使用仅当前用户可读写权限', async () => {
    const manager = createManager()
    await manager.create(createInput())

    expect(existsSync(configPath)).toBe(true)
    if (process.platform !== 'win32') {
      expect(statSync(configPath).mode & 0o777).toBe(0o600)
    }
  })
})

describe('渠道异步宿主凭据边界', () => {
  test('创建等待加密时，另一条渠道先保存也不会被陈旧整表覆盖', async () => {
    const codec = createFixtureCredentialCodec()
    let finish: (value: string) => void = () => { throw new Error('加密未启动') }
    const delayed = new Promise<string>((resolve) => { finish = resolve })
    const manager = new ChannelManager({ configPath, credentialCodec: {
      ...codec, encrypt: (value) => value === 'slow-key' ? delayed : codec.encrypt(value),
    } })
    const first = manager.create(createInput({ name: '慢渠道', apiKey: 'slow-key' }))
    const second = await manager.create(createInput({ name: '快渠道' }))
    finish(await codec.encrypt('slow-key'))
    const created = await first
    expect(manager.list().map((item) => item.name).sort()).toEqual(['快渠道', '慢渠道'])
    expect(created.id).not.toBe(second.id)
    expect((await manager.resolve(created.id)).apiKey).toBe('slow-key')
  })

  test('凭据更新等待期间保留新模型和启停状态，空密钥编辑不压掉新凭据', async () => {
    const codec = createFixtureCredentialCodec()
    let finish: (value: string) => void = () => { throw new Error('加密未启动') }
    const delayed = new Promise<string>((resolve) => { finish = resolve })
    const manager = new ChannelManager({ configPath, credentialCodec: {
      ...codec, encrypt: (value) => value === 'new-key' ? delayed : codec.encrypt(value),
    } })
    const channel = await manager.create(createInput())
    const pending = manager.update(channel.id, { apiKey: 'new-key' })
    await manager.update(channel.id, { name: '新名称', enabled: false, models: [] })
    finish(await codec.encrypt('new-key'))
    await pending
    const edited = await manager.update(channel.id, { name: '最终名称', apiKey: '' })
    expect(edited).toMatchObject({ name: '最终名称', enabled: false, models: [] })
    expect((await manager.resolve(channel.id)).apiKey).toBe('new-key')
  })

  test('加密期间渠道被删除时拒绝旧更新，不复活记录', async () => {
    const codec = createFixtureCredentialCodec()
    let finish: (value: string) => void = () => { throw new Error('加密未启动') }
    const delayed = new Promise<string>((resolve) => { finish = resolve })
    const manager = new ChannelManager({ configPath, credentialCodec: {
      ...codec, encrypt: (value) => value === 'new-key' ? delayed : codec.encrypt(value),
    } })
    const channel = await manager.create(createInput())
    const pending = manager.update(channel.id, { apiKey: 'new-key' })
    manager.delete(channel.id)
    finish(await codec.encrypt('new-key'))
    await expect(pending).rejects.toMatchObject({ code: 'not_found' })
    expect(manager.list()).toEqual([])
  })

  test('无宿主或宿主失败时不写凭据、不回显内部异常，已保存配置保持原样', async () => {
    const unavailable = new ChannelManager({ configPath, credentialCodec: createCredentialCodec() })
    await expect(unavailable.create(createInput())).rejects.toMatchObject({ code: 'credential_error' })
    expect(existsSync(configPath)).toBe(false)
    const channel = await createManager().create(createInput())
    const previous = readFileSync(configPath, 'utf8')
    const codec = createFixtureCredentialCodec()
    const failed = new ChannelManager({ configPath, credentialCodec: {
      ...codec,
      encrypt: async () => { throw new Error('private-token') },
      decrypt: async () => { throw new Error('private-token') },
    } })
    await expect(failed.update(channel.id, { apiKey: 'another-key' })).rejects.toThrow('保存渠道凭据失败')
    await expect(failed.resolve(channel.id)).rejects.toThrow('读取渠道凭据失败')
    expect(readFileSync(configPath, 'utf8')).toBe(previous)
  })
})
