/**
 * AI 渠道共享契约
 *
 * 共享层只描述可跨 IPC 暴露的安全 DTO；加密凭据字段仅存在于主进程内部。
 */

export const PROVIDER_TYPES = [
  'openai',
  'openai-responses',
  'anthropic',
  'anthropic-compatible',
  'google',
  'custom',
] as const

export type ProviderType = typeof PROVIDER_TYPES[number]

export const PROVIDER_DEFAULT_URLS: Record<ProviderType, string> = {
  openai: 'https://api.openai.com/v1',
  'openai-responses': 'https://api.openai.com/v1',
  anthropic: 'https://api.anthropic.com',
  'anthropic-compatible': '',
  google: 'https://generativelanguage.googleapis.com',
  custom: '',
}

export const PROVIDER_LABELS: Record<ProviderType, string> = {
  openai: 'OpenAI',
  'openai-responses': 'OpenAI Responses',
  anthropic: 'Anthropic',
  'anthropic-compatible': 'Anthropic 兼容格式',
  google: 'Google',
  custom: 'OpenAI Chat Completions（自定义地址）',
}

export interface ChannelModel {
  id: string
  name: string
  enabled: boolean
  source?: 'manual' | 'fetched'
}

/** 可安全发送给 renderer 的渠道信息，不包含明文或密文凭据。 */
export interface Channel {
  id: string
  name: string
  provider: ProviderType
  baseUrl: string
  models: ChannelModel[]
  enabled: boolean
  hasApiKey: boolean
  createdAt: number
  updatedAt: number
}

export interface ChannelCreateInput {
  name: string
  provider: ProviderType
  baseUrl?: string
  /** 明文 API Key，只允许进入主进程。 */
  apiKey: string
  models?: ChannelModel[]
  enabled?: boolean
}

export interface ChannelUpdateInput {
  name?: string
  provider?: ProviderType
  baseUrl?: string
  /** 明文 API Key；空字符串表示保留已有凭据。 */
  apiKey?: string
  models?: ChannelModel[]
  enabled?: boolean
}

/** 仅供主进程 Provider adapter 消费的运行时渠道。 */
export interface ResolvedChannel extends Omit<Channel, 'hasApiKey'> {
  apiKey: string
}

export const MAX_CHANNEL_NAME_LENGTH = 80
export const MAX_CHANNEL_MODELS = 500

export const CHANNEL_IPC_CHANNELS = {
  LIST: 'axon:channels:list',
  CREATE: 'axon:channels:create',
  UPDATE: 'axon:channels:update',
  DELETE: 'axon:channels:delete',
  REQUEST: 'axon:channels:request',
  CANCEL: 'axon:channels:cancel',
} as const

export function isProviderType(value: unknown): value is ProviderType {
  return typeof value === 'string' && (PROVIDER_TYPES as readonly string[]).includes(value)
}
