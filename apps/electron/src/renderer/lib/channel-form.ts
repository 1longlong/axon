import { MAX_CHANNEL_MODELS, PROVIDER_DEFAULT_URLS } from '@axon/shared'
import type { Channel, ChannelCreateInput, ChannelModel, ChannelUpdateInput, ProviderType } from '@axon/shared'

export interface PendingChannelModel {
  id: string
  name: string
}

export interface ChannelDraft {
  name: string
  provider: ProviderType
  baseUrl: string
  apiKey: string
  models: ChannelModel[]
  pendingModel: PendingChannelModel
}

/** 编辑初始化只使用安全 DTO，凭据输入始终为空。 */
export function createChannelDraft(channel: Channel | null): ChannelDraft {
  return {
    name: channel?.name ?? '',
    provider: channel?.provider ?? 'openai',
    baseUrl: channel?.baseUrl ?? PROVIDER_DEFAULT_URLS.openai,
    apiKey: '',
    models: channel?.models.map((model) => ({ ...model })) ?? [],
    pendingModel: { id: '', name: '' },
  }
}

export function buildChannelCreateInput(draft: ChannelDraft): ChannelCreateInput {
  if (hasPendingChannelModel(draft.pendingModel)) throw new Error('请先添加模型，或清空待添加输入后再保存')
  return {
    name: draft.name.trim(), provider: draft.provider,
    baseUrl: draft.baseUrl.trim(), apiKey: draft.apiKey.trim(),
    models: draft.models.map((model) => ({ ...model, name: model.name.trim() || model.id })),
  }
}

export function buildChannelUpdateInput(draft: ChannelDraft, initial: ChannelDraft): ChannelUpdateInput {
  const { apiKey, models, ...input } = buildChannelCreateInput(draft)
  return {
    ...input, ...(apiKey ? { apiKey } : {}),
    // 未编辑模型时不覆盖列表；显式清空时仍发送 []。
    ...(JSON.stringify(draft.models) !== JSON.stringify(initial.models) ? { models } : {}),
  }
}

export function hasPendingChannelModel(model: PendingChannelModel): boolean {
  return model.id.length > 0 || model.name.length > 0
}

export function addManualChannelModel(models: readonly ChannelModel[], pending: PendingChannelModel): ChannelModel[] {
  const id = pending.id.trim()
  if (!id) throw new Error('模型 ID 不能为空')
  if (models.some((model) => model.id === id)) throw new Error('该模型 ID 已存在，请编辑现有模型')
  if (models.length >= MAX_CHANNEL_MODELS) throw new Error(`单个渠道最多配置 ${MAX_CHANNEL_MODELS} 个模型`)
  return [...models, { id, name: pending.name.trim() || id, enabled: true, source: 'manual' }]
}

/** 目录拉取只补充新项，不删除旧配置；保留手动来源、别名与启停。 */
export function mergeFetchedChannelModels(existing: readonly ChannelModel[], fetched: readonly ChannelModel[]): ChannelModel[] {
  const merged = new Map(existing.map((model) => [model.id, { ...model }]))
  for (const model of fetched) {
    if (!merged.has(model.id)) merged.set(model.id, { ...model, source: 'fetched', enabled: false })
  }
  if (merged.size > MAX_CHANNEL_MODELS) throw new Error(`合并后超过 ${MAX_CHANNEL_MODELS} 个模型，请先移除不需要的模型`)
  return [...merged.values()]
}

export interface SettingsEditingState {
  dirty: boolean
  busy: boolean
}

/** 保存中禁止离开；未保存时由调用者提供确认交互，便于测试。 */
export function canLeaveSettings(state: SettingsEditingState, confirm: () => boolean): boolean {
  return !state.busy && (!state.dirty || confirm())
}
