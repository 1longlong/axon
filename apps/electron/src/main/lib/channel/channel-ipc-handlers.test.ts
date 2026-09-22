import { afterEach, beforeEach, describe, expect, test } from 'bun:test'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { MAX_CHANNEL_MODELS } from '@axon/shared'
import { ChannelManager, ChannelManagerError } from './channel-manager'
import { createChannelCredentialCodec } from './channel-credential-codec'
import { createChannelIpcHandlers } from './channel-ipc-handlers'

describe('渠道 IPC 边界', () => {
  let directory: string
  let manager: ChannelManager
  let handlers: ReturnType<typeof createChannelIpcHandlers>
  beforeEach(() => {
    directory = mkdtempSync(join(tmpdir(), 'axon-channel-ipc-'))
    manager = new ChannelManager({ configPath: join(directory, 'channels.json'), credentialCodec: createChannelCredentialCodec() })
    handlers = createChannelIpcHandlers(manager)
  })
  afterEach(() => rmSync(directory, { recursive: true, force: true }))

  test('CRUD 只返回安全 DTO，空密钥更新保留凭据，重建管理器后数据仍在', () => {
    expect(handlers.list()).toEqual([])
    const created = handlers.create({ name: '测试渠道', provider: 'openai', apiKey: 'test-secret' })
    const updated = handlers.update(created.id, { enabled: false, apiKey: '' })
    expect(updated.enabled).toBe(false)
    expect(manager.resolve(created.id).apiKey).toBe('test-secret')
    const reopened = new ChannelManager({ configPath: join(directory, 'channels.json'), credentialCodec: createChannelCredentialCodec() })
    expect(reopened.list()).toEqual([updated])
    const removed = handlers.delete(created.id)
    for (const value of [created, updated, removed]) {
      expect(value.hasApiKey).toBe(true)
      expect(value).not.toHaveProperty('apiKey')
      expect(value).not.toHaveProperty('encryptedCredential')
      expect(JSON.stringify(value)).not.toContain('test-secret')
    }
    expect(handlers.list()).toEqual([])
    expect(handlers).not.toHaveProperty('resolve')
  })

  test('拒绝缺失字段、错误类型、未知字段与无效模型，且不落盘', () => {
    const valid = { name: '测试渠道', provider: 'openai', apiKey: '' }
    for (const value of [null, [], 1, {}, { ...valid, apiKey: 1 }, { ...valid, enabled: 'false' }, { ...valid, baseUrl: 42 }, { ...valid, provider: 'unknown' }, { ...valid, encryptedCredential: 'secret' }, { ...valid, models: [{}] }, { ...valid, models: 'bad' }, { ...valid, baseUrl: 'file:///tmp' }]) {
      expect(() => handlers.create(value)).toThrow(ChannelManagerError)
    }
    expect(handlers.list()).toEqual([])
  })

  test('更新的非法负载和 ID 不改变现有渠道', () => {
    const channel = handlers.create({ name: '测试渠道', provider: 'openai', apiKey: '' })
    for (const value of [null, [], { apiKey: {} }, { enabled: null }, { name: 1 }, { models: [null] }]) {
      expect(() => handlers.update(channel.id, value)).toThrow(ChannelManagerError)
    }
    for (const id of [null, {}, 1, '', ' ']) {
      expect(() => handlers.update(id, {})).toThrow(ChannelManagerError)
      expect(() => handlers.delete(id)).toThrow(ChannelManagerError)
    }
    expect(() => handlers.delete('missing')).toThrow('渠道不存在')
    expect(handlers.list()).toEqual([channel])
  })

  test('模型添加、别名、启停与删除通过原渠道 IPC 持久化，凭据不变', () => {
    const channel = handlers.create({ name: '模型渠道', provider: 'openai', apiKey: 'test-secret', models: [{ id: 'model-a', name: '模型 A', enabled: true, source: 'manual' }] })
    const updated = handlers.update(channel.id, { models: [{ ...channel.models[0]!, name: '别名', enabled: false }] })
    expect(updated.models).toEqual([{ id: 'model-a', name: '别名', enabled: false, source: 'manual' }])
    expect(manager.resolve(channel.id).apiKey).toBe('test-secret')
    expect(handlers.update(channel.id, { name: '普通编辑' }).models).toEqual(updated.models)
    expect(handlers.update(channel.id, { models: [] }).models).toEqual([])
    const reopened = new ChannelManager({ configPath: join(directory, 'channels.json'), credentialCodec: createChannelCredentialCodec() })
    expect(reopened.get(channel.id)?.models).toEqual([])
  })

  test('主进程独立拒绝重复模型和超限负载，不依赖前端校验', () => {
    const channel = handlers.create({ name: '模型渠道', provider: 'openai', apiKey: '' })
    const model = { id: 'same', name: '模型', enabled: true }
    expect(() => handlers.update(channel.id, { models: [model, { ...model, id: ' same ' }] })).toThrow('重复')
    expect(() => handlers.update(channel.id, { models: Array.from({ length: MAX_CHANNEL_MODELS + 1 }, (_, index) => ({ ...model, id: `id-${index}` })) })).toThrow('最多配置')
    expect(handlers.list()).toEqual([channel])
  })
})
