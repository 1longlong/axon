import { describe, expect, test } from 'bun:test'
import { MAX_CHANNEL_MODELS } from '@axon/shared'
import type { Channel, ChannelModel } from '@axon/shared'
import { addManualChannelModel, buildChannelCreateInput, buildChannelUpdateInput, canLeaveSettings, createChannelDraft, hasPendingChannelModel, mergeFetchedChannelModels } from './channel-form'

const channel: Channel = {
  id: 'channel', name: '测试渠道', provider: 'openai', baseUrl: 'https://example.test/v1',
  hasApiKey: true, enabled: false, models: [{ id: 'test', name: '测试模型', enabled: true }], createdAt: 1, updatedAt: 1,
}

describe('渠道表单', () => {
  test('拉取合并保留已有来源、名称和启停，新增默认停用，空目录不删除旧项', () => {
    const existing: ChannelModel[] = [{ id: 'same', name: '我的别名', enabled: true, source: 'manual' }, { id: 'old', name: '旧项', enabled: false, source: 'fetched' }]
    const fetched: ChannelModel[] = [{ id: 'same', name: '远端名字', enabled: false, source: 'fetched' }, { id: 'new', name: '新增', enabled: true, source: 'fetched' }]
    const merged = mergeFetchedChannelModels(existing, fetched)
    expect(merged).toEqual([...existing, { ...fetched[1]!, enabled: false }])
    expect(mergeFetchedChannelModels(existing, [])).toEqual(existing)
    expect(existing).toHaveLength(2)
    const full = Array.from({ length: MAX_CHANNEL_MODELS }, (_, i) => ({ id: `${i}`, name: '模型', enabled: true }))
    expect(() => mergeFetchedChannelModels(full, fetched)).toThrow('超过')
    expect(full).toHaveLength(MAX_CHANNEL_MODELS)
  })
  test('创建默认使用 OpenAI 地址，编辑不回显凭据', () => {
    expect(createChannelDraft(null).baseUrl).toBe('https://api.openai.com/v1')
    expect(createChannelDraft(channel)).toEqual({ name: channel.name, provider: channel.provider, baseUrl: channel.baseUrl, apiKey: '', models: channel.models, pendingModel: { id: '', name: '' } })
  })
  test('普通编辑不发送密钥、模型或启用状态', () => {
    const initial = createChannelDraft(channel)
    const input = buildChannelUpdateInput({ ...initial, name: ' 新名称 ', apiKey: '  ' }, initial)
    expect(input.name).toBe('新名称')
    for (const key of ['apiKey', 'models', 'enabled', 'hasApiKey']) expect(input).not.toHaveProperty(key)
  })
  test('主动输入的密钥才进入更新负载；创建支持无鉴权服务', () => {
    const initial = createChannelDraft(channel)
    expect(buildChannelUpdateInput({ ...initial, apiKey: ' new-secret ' }, initial).apiKey).toBe('new-secret')
    expect(buildChannelCreateInput(createChannelDraft(null)).apiKey).toBe('')
  })
  test('离开保护覆盖干净、脏表单与保存中状态', () => {
    let confirmations = 0
    const cancel = (): boolean => { confirmations += 1; return false }
    expect(canLeaveSettings({ dirty: false, busy: false }, cancel)).toBe(true)
    expect(canLeaveSettings({ dirty: true, busy: true }, cancel)).toBe(false)
    expect(confirmations).toBe(0)
    expect(canLeaveSettings({ dirty: true, busy: false }, cancel)).toBe(false)
    expect(confirmations).toBe(1)
    expect(canLeaveSettings({ dirty: true, busy: false }, () => true)).toBe(true)
  })

  test('模型草稿与安全 DTO 不共享可变对象', () => {
    const draft = createChannelDraft(channel)
    draft.models[0]!.name = '草稿别名'
    draft.models[0]!.enabled = false
    expect(channel.models[0]!.name).toBe('测试模型')
    expect(channel.models[0]!.enabled).toBe(true)
  })

  test('手动添加修剪 ID、默认名称、默认启用并标记来源', () => {
    const models = addManualChannelModel(channel.models, { id: ' second-model ', name: ' ' })
    expect(models[1]).toEqual({ id: 'second-model', name: 'second-model', enabled: true, source: 'manual' })
    expect(channel.models).toHaveLength(1)
    expect(addManualChannelModel([], { id: 'model', name: ' 名称 ' })[0]!.name).toBe('名称')
  })

  test('拒绝空白 ID、重复 ID 和模型数量超限', () => {
    expect(() => addManualChannelModel([], { id: ' ', name: '名称' })).toThrow('不能为空')
    expect(() => addManualChannelModel(channel.models, { id: ' test ', name: '' })).toThrow('已存在')
    const models: ChannelModel[] = Array.from({ length: MAX_CHANNEL_MODELS - 1 }, (_, index) => ({ id: `model-${index}`, name: '模型', enabled: true }))
    const full = addManualChannelModel(models, { id: 'last', name: '' })
    expect(full).toHaveLength(MAX_CHANNEL_MODELS)
    expect(() => addManualChannelModel(full, { id: 'overflow', name: '' })).toThrow('最多配置')
  })

  test('模型变更随创建或编辑发送，名称留空回退 ID，来源和启停保留', () => {
    const initial = createChannelDraft(channel)
    const draft = { ...initial, models: [{ ...initial.models[0]!, name: ' ', enabled: false, source: 'fetched' as const }] }
    const expected: ChannelModel[] = [{ id: 'test', name: 'test', enabled: false, source: 'fetched' }]
    expect(buildChannelCreateInput(draft).models).toEqual(expected)
    expect(buildChannelUpdateInput(draft, initial).models).toEqual(expected)
    expect(draft.models[0]!.name).toBe(' ')
    expect(buildChannelUpdateInput({ ...initial, models: [] }, initial).models).toEqual([])
  })

  test('待添加输入参与未保存保护，不能悄悄随渠道保存丢弃', () => {
    const initial = createChannelDraft(channel)
    expect(hasPendingChannelModel(initial.pendingModel)).toBe(false)
    for (const pendingModel of [{ id: 'new', name: '' }, { id: '', name: '别名' }, { id: ' ', name: '' }]) {
      expect(hasPendingChannelModel(pendingModel)).toBe(true)
      const draft = { ...initial, pendingModel }
      expect(JSON.stringify(draft)).not.toBe(JSON.stringify(initial))
      expect(() => buildChannelCreateInput(draft)).toThrow('请先添加模型')
      expect(() => buildChannelUpdateInput(draft, initial)).toThrow('请先添加模型')
    }
    expect(buildChannelCreateInput(initial)).not.toHaveProperty('pendingModel')
  })
})
