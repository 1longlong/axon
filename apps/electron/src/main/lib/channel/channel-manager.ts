/**
 * 渠道领域管理器
 *
 * 负责渠道 CRUD、输入校验、凭据加密边界与 channels.json 原子持久化。
 * 网络连接测试和模型拉取属于下一阶段，不进入本文件。
 */

import { chmodSync, existsSync } from 'node:fs'
import { randomUUID } from 'node:crypto'
import {
  MAX_CHANNEL_MODELS,
  MAX_CHANNEL_NAME_LENGTH,
  PROVIDER_DEFAULT_URLS,
  isProviderType,
} from '@axon/shared'
import type {
  Channel,
  ChannelCreateInput,
  ChannelModel,
  ChannelUpdateInput,
  ProviderType,
  ResolvedChannel,
} from '@axon/shared'
import type { ChannelCredentialCodec } from './channel-credential-codec'
import { readJsonFileSafe, writeJsonFileAtomic } from '../core/safe-file'

const CHANNEL_CONFIG_VERSION = 1

interface StoredChannel {
  id: string
  name: string
  provider: ProviderType
  baseUrl: string
  encryptedCredential: string
  models: ChannelModel[]
  enabled: boolean
  createdAt: number
  updatedAt: number
}

interface ChannelsConfig {
  version: number
  channels: StoredChannel[]
}

export type ChannelManagerErrorCode = 'invalid_input' | 'not_found' | 'credential_error'

export class ChannelManagerError extends Error {
  constructor(
    public readonly code: ChannelManagerErrorCode,
    message: string,
  ) {
    super(message)
    this.name = 'ChannelManagerError'
  }
}

export interface ChannelManagerOptions {
  configPath: string
  credentialCodec: ChannelCredentialCodec
  createId?: () => string
  now?: () => number
}

function cloneModels(models: readonly ChannelModel[]): ChannelModel[] {
  return models.map((model) => ({ ...model }))
}

function toPublicChannel(channel: StoredChannel): Channel {
  return {
    id: channel.id,
    name: channel.name,
    provider: channel.provider,
    baseUrl: channel.baseUrl,
    models: cloneModels(channel.models),
    enabled: channel.enabled,
    hasApiKey: channel.encryptedCredential.length > 0,
    createdAt: channel.createdAt,
    updatedAt: channel.updatedAt,
  }
}

function normalizeName(value: unknown): string {
  if (typeof value !== 'string' || !value.trim()) {
    throw new ChannelManagerError('invalid_input', '渠道名称不能为空')
  }
  return value.trim().slice(0, MAX_CHANNEL_NAME_LENGTH)
}

function normalizeBaseUrl(provider: ProviderType, value: unknown): string {
  const explicit = typeof value === 'string' ? value.trim() : ''
  const resolved = explicit || PROVIDER_DEFAULT_URLS[provider]
  if (!resolved) {
    throw new ChannelManagerError('invalid_input', '该渠道必须填写 Base URL')
  }

  try {
    const url = new URL(resolved)
    if (url.protocol !== 'http:' && url.protocol !== 'https:') throw new Error('unsupported protocol')
    return resolved.replace(/\/+$/, '')
  } catch {
    throw new ChannelManagerError('invalid_input', 'Base URL 必须是有效的 HTTP(S) 地址')
  }
}

function normalizeModels(value: unknown): ChannelModel[] {
  if (value === undefined) return []
  if (!Array.isArray(value)) {
    throw new ChannelManagerError('invalid_input', '模型列表格式无效')
  }
  if (value.length > MAX_CHANNEL_MODELS) {
    throw new ChannelManagerError('invalid_input', `单个渠道最多配置 ${MAX_CHANNEL_MODELS} 个模型`)
  }

  const seenIds = new Set<string>()
  return value.map((item) => {
    if (!item || typeof item !== 'object') {
      throw new ChannelManagerError('invalid_input', '模型配置格式无效')
    }
    const model = item as Record<string, unknown>
    const id = typeof model.id === 'string' ? model.id.trim() : ''
    const name = typeof model.name === 'string' ? model.name.trim() : ''
    if (!id || !name || typeof model.enabled !== 'boolean') {
      throw new ChannelManagerError('invalid_input', '模型 ID、名称和启用状态不能为空')
    }
    if (seenIds.has(id)) {
      throw new ChannelManagerError('invalid_input', `模型 ID 重复: ${id}`)
    }
    seenIds.add(id)

    const source = model.source === 'manual' || model.source === 'fetched'
      ? model.source
      : undefined
    return { id, name, enabled: model.enabled, ...(source ? { source } : {}) }
  })
}

function sanitizeStoredChannel(value: unknown): StoredChannel | null {
  if (!value || typeof value !== 'object') return null
  const candidate = value as Record<string, unknown>
  if (
    typeof candidate.id !== 'string'
    || !candidate.id
    || !isProviderType(candidate.provider)
    || typeof candidate.encryptedCredential !== 'string'
    || typeof candidate.enabled !== 'boolean'
    || typeof candidate.createdAt !== 'number'
    || !Number.isFinite(candidate.createdAt)
    || typeof candidate.updatedAt !== 'number'
    || !Number.isFinite(candidate.updatedAt)
  ) return null

  try {
    return {
      id: candidate.id,
      name: normalizeName(candidate.name),
      provider: candidate.provider,
      baseUrl: normalizeBaseUrl(candidate.provider, candidate.baseUrl),
      encryptedCredential: candidate.encryptedCredential,
      models: normalizeModels(candidate.models),
      enabled: candidate.enabled,
      createdAt: candidate.createdAt,
      updatedAt: candidate.updatedAt,
    }
  } catch {
    return null
  }
}

export class ChannelManager {
  private readonly configPath: string
  private readonly credentialCodec: ChannelCredentialCodec
  private readonly createId: () => string
  private readonly now: () => number

  constructor(options: ChannelManagerOptions) {
    this.configPath = options.configPath
    this.credentialCodec = options.credentialCodec
    this.createId = options.createId ?? randomUUID
    this.now = options.now ?? Date.now
  }

  list(): Channel[] {
    return this.readConfig().channels.map(toPublicChannel)
  }

  get(id: string): Channel | undefined {
    const channel = this.readConfig().channels.find((item) => item.id === id)
    return channel ? toPublicChannel(channel) : undefined
  }

  create(input: ChannelCreateInput): Channel {
    if (!isProviderType(input.provider)) {
      throw new ChannelManagerError('invalid_input', '不支持的渠道供应商')
    }

    const config = this.readConfig()
    const timestamp = this.now()
    const id = this.createUniqueId(config.channels)
    const apiKey = input.apiKey.trim()
    const channel: StoredChannel = {
      id,
      name: normalizeName(input.name),
      provider: input.provider,
      baseUrl: normalizeBaseUrl(input.provider, input.baseUrl),
      encryptedCredential: this.credentialCodec.encrypt(apiKey),
      models: normalizeModels(input.models),
      enabled: input.enabled ?? true,
      createdAt: timestamp,
      updatedAt: timestamp,
    }

    config.channels.push(channel)
    this.writeConfig(config)
    console.log(`[渠道管理] 已创建渠道: ${channel.name} (${channel.id})`)
    return toPublicChannel(channel)
  }

  update(id: string, input: ChannelUpdateInput): Channel {
    const config = this.readConfig()
    const index = config.channels.findIndex((item) => item.id === id)
    if (index < 0) throw new ChannelManagerError('not_found', `渠道不存在: ${id}`)

    const existing = config.channels[index]!
    const provider = input.provider ?? existing.provider
    if (!isProviderType(provider)) {
      throw new ChannelManagerError('invalid_input', '不支持的渠道供应商')
    }
    const baseUrlInput = input.baseUrl ?? (input.provider && input.provider !== existing.provider ? '' : existing.baseUrl)
    const nextCredential = input.apiKey && input.apiKey.trim()
      ? this.credentialCodec.encrypt(input.apiKey.trim())
      : existing.encryptedCredential

    const updated: StoredChannel = {
      ...existing,
      name: input.name === undefined ? existing.name : normalizeName(input.name),
      provider,
      baseUrl: normalizeBaseUrl(provider, baseUrlInput),
      encryptedCredential: nextCredential,
      models: input.models === undefined ? cloneModels(existing.models) : normalizeModels(input.models),
      enabled: input.enabled ?? existing.enabled,
      updatedAt: this.now(),
    }

    config.channels[index] = updated
    this.writeConfig(config)
    console.log(`[渠道管理] 已更新渠道: ${updated.name} (${updated.id})`)
    return toPublicChannel(updated)
  }

  delete(id: string): Channel {
    const config = this.readConfig()
    const index = config.channels.findIndex((item) => item.id === id)
    if (index < 0) throw new ChannelManagerError('not_found', `渠道不存在: ${id}`)

    const [removed] = config.channels.splice(index, 1)
    this.writeConfig(config)
    console.log(`[渠道管理] 已删除渠道: ${removed!.name} (${removed!.id})`)
    return toPublicChannel(removed!)
  }

  /** 仅供主进程 Provider 调用，禁止把返回值发送给 renderer。 */
  resolve(id: string): ResolvedChannel {
    const stored = this.readConfig().channels.find((item) => item.id === id)
    if (!stored) throw new ChannelManagerError('not_found', `渠道不存在: ${id}`)

    try {
      const { hasApiKey: _hasApiKey, ...channel } = toPublicChannel(stored)
      return { ...channel, apiKey: this.credentialCodec.decrypt(stored.encryptedCredential) }
    } catch (error) {
      if (error instanceof ChannelManagerError) throw error
      throw new ChannelManagerError(
        'credential_error',
        error instanceof Error ? error.message : '读取渠道凭据失败',
      )
    }
  }

  private createUniqueId(channels: readonly StoredChannel[]): string {
    const existingIds = new Set(channels.map((channel) => channel.id))
    for (let attempt = 0; attempt < 10; attempt += 1) {
      const id = this.createId()
      if (id && !existingIds.has(id)) return id
    }
    throw new ChannelManagerError('invalid_input', '无法生成唯一渠道 ID')
  }

  private readConfig(): ChannelsConfig {
    if (!existsSync(this.configPath)) return { version: CHANNEL_CONFIG_VERSION, channels: [] }

    const raw = readJsonFileSafe<unknown>(this.configPath)
    if (!raw || typeof raw !== 'object') return { version: CHANNEL_CONFIG_VERSION, channels: [] }
    const candidate = raw as Record<string, unknown>
    const inputChannels = Array.isArray(candidate.channels) ? candidate.channels : []
    const seenIds = new Set<string>()
    const channels: StoredChannel[] = []
    for (const item of inputChannels) {
      const channel = sanitizeStoredChannel(item)
      if (!channel || seenIds.has(channel.id)) continue
      seenIds.add(channel.id)
      channels.push(channel)
    }

    const normalized = { version: CHANNEL_CONFIG_VERSION, channels }
    if (candidate.version !== CHANNEL_CONFIG_VERSION || channels.length !== inputChannels.length) {
      this.writeConfig(normalized)
      console.warn('[渠道管理] 已清理无效或旧版渠道配置')
    }
    return normalized
  }

  private writeConfig(config: ChannelsConfig): void {
    try {
      writeJsonFileAtomic(this.configPath, config)
      if (process.platform !== 'win32') chmodSync(this.configPath, 0o600)
    } catch (error) {
      console.error('[渠道管理] 写入配置失败:', error)
      throw new Error('写入渠道配置失败')
    }
  }
}
