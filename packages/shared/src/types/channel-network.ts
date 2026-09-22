import type { ChannelModel, ProviderType } from './channel'

export interface ChannelNetworkInput {
  requestId: string
  operation: 'test' | 'models'
  provider: ProviderType
  baseUrl: string
  /** 编辑时留空由主进程读取已保存凭据，不回传 renderer。 */
  apiKey?: string
  channelId?: string
}

export const CHANNEL_NETWORK_ERRORS = {
  invalid_input: '请求参数或地址无效；地址仅支持 HTTP(S)，不能包含用户名、密码、查询参数或片段。',
  credential_error: '无法读取已保存凭据，请重新填写 API Key。',
  cancelled: '请求已取消。',
  busy: '当前窗口已有渠道请求，请先取消或等待完成。',
  timeout: '请求超时，请检查地址与网络后重试。',
  network: '网络连接失败，请检查网络、证书或服务地址。',
  unauthorized: '鉴权失败，请检查 API Key。',
  forbidden: '服务拒绝访问，请检查账号权限或地区限制。',
  not_found: '模型目录端点不存在；该渠道可能不提供目录，请手动配置模型。',
  rate_limit: '请求受到限制，请稍后重试并检查服务配额。',
  server: '供应商服务暂时异常，请稍后重试。',
  http: '供应商拒绝请求，请检查接口配置。',
  redirect: '已阻止重定向，避免将凭据发送到未经确认的地址。',
  invalid_response: '模型目录响应格式无效，原有模型未改变。',
  too_large: '模型目录超过安全大小或数量上限，原有模型未改变。',
} as const
export type ChannelNetworkErrorCode = keyof typeof CHANNEL_NETWORK_ERRORS
export type ChannelNetworkResult = {
  success: true
  models: ChannelModel[]
  message: string
  elapsedMs: number
} | {
  success: false
  code: ChannelNetworkErrorCode
  message: string
}

/** 确定唯一目录端点，不探测其他地址、不跟随服务器提供的 URL。 */
export function resolveChannelModelsUrl(provider: ProviderType, baseUrl: string): string {
  const url = new URL(baseUrl.trim())
  if (!['https:', 'http:'].includes(url.protocol) || url.username || url.password || url.search || url.hash) throw new Error('无效地址')
  let path = url.pathname.replace(/\/+$/, '')
  if (provider === 'google') {
    if (!path) path = '/v1beta'
  } else {
    path = path.replace(/\/(chat\/completions|responses|messages)$/, '/models')
    if (!path) path = '/v1'
    if ((provider === 'anthropic' || provider === 'anthropic-compatible') && !path.endsWith('/v1') && !path.endsWith('/models')) path += '/v1'
  }
  url.pathname = path.endsWith('/models') ? path : `${path}/models`
  return url.toString()
}

export function isOfficialChannelModelsUrl(provider: ProviderType, url: string): boolean {
  if (provider === 'openai' || provider === 'openai-responses') return url === 'https://api.openai.com/v1/models'
  if (provider === 'anthropic') return url === 'https://api.anthropic.com/v1/models'
  if (provider === 'google') return ['https://generativelanguage.googleapis.com/v1beta/models', 'https://generativelanguage.googleapis.com/v1/models'].includes(url)
  return false
}
