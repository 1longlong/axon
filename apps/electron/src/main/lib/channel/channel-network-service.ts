/** 渠道目录诊断：凭据仅在主进程组装，错误不透传响应正文。 */
import { CHANNEL_NETWORK_ERRORS, MAX_CHANNEL_MODELS, isProviderType, isOfficialChannelModelsUrl, resolveChannelModelsUrl } from '@axon/shared'
import type { ChannelModel, ChannelNetworkErrorCode, ChannelNetworkInput, ChannelNetworkResult, ProviderType } from '@axon/shared'
import type { ChannelManager } from './channel-manager'

export type ChannelFetch = (url: string, init: RequestInit) => Promise<Response>
interface ChannelNetworkOptions {
  manager: Pick<ChannelManager, 'resolve'>
  confirmTarget: (owner: number, url: string, signal: AbortSignal) => Promise<boolean>
  fetch?: ChannelFetch
  timeoutMs?: number
}
interface ActiveRequest { id: string; controller: AbortController }
class NetworkFailure extends Error {
  constructor(readonly code: ChannelNetworkErrorCode) { super(CHANNEL_NETWORK_ERRORS[code]) }
}
function failure(code: ChannelNetworkErrorCode): ChannelNetworkResult {
  return { success: false, code, message: CHANNEL_NETWORK_ERRORS[code] }
}
function record(value: unknown): Record<string, unknown> {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new NetworkFailure('invalid_response')
  return value as Record<string, unknown>
}
function parseInput(value: unknown): ChannelNetworkInput {
  try {
    const input = record(value)
    if (Object.keys(input).some((key) => !['requestId', 'operation', 'provider', 'baseUrl', 'apiKey', 'channelId'].includes(key))
      || typeof input.requestId !== 'string' || !/^[a-zA-Z0-9_-]{1,100}$/.test(input.requestId)
      || (input.operation !== 'test' && input.operation !== 'models') || !isProviderType(input.provider)
      || typeof input.baseUrl !== 'string' || input.baseUrl.length > 2048
      || (input.apiKey !== undefined && (typeof input.apiKey !== 'string' || input.apiKey.length > 16384 || /[\r\n]/.test(input.apiKey)))
      || (input.channelId !== undefined && (typeof input.channelId !== 'string' || !input.channelId || input.channelId.length > 100))) throw new Error()
    resolveChannelModelsUrl(input.provider, input.baseUrl)
    return input as unknown as ChannelNetworkInput
  } catch { throw new NetworkFailure('invalid_input') }
}
function httpError(status: number): ChannelNetworkErrorCode {
  if (status >= 300 && status < 400) return 'redirect'
  if (status === 401) return 'unauthorized'
  if (status === 403) return 'forbidden'
  if (status === 404 || status === 405) return 'not_found'
  if (status === 429) return 'rate_limit'
  return status >= 500 ? 'server' : 'http'
}

/** 逐块限流，避免超大响应或无限响应占满内存；超时涵盖正文读取。 */
async function readBody(response: Response): Promise<unknown> {
  const reader = response.body?.getReader()
  if (!reader) throw new NetworkFailure('invalid_response')
  const decoder = new TextDecoder()
  let size = 0
  let text = ''
  try {
    while (true) {
      const { done, value } = await reader.read()
      if (done) break
      size += value.byteLength
      if (size > 2 * 1024 * 1024) throw new NetworkFailure('too_large')
      text += decoder.decode(value, { stream: true })
    }
    text += decoder.decode()
    try { return JSON.parse(text) as unknown } catch { throw new NetworkFailure('invalid_response') }
  } finally {
    void reader.cancel().catch(() => {})
    reader.releaseLock()
  }
}

function parsePage(value: unknown, provider: ProviderType): { models: ChannelModel[]; cursor: string } {
  const body = record(value)
  const items = provider === 'google' ? body.models : body.data
  if (body.has_more !== undefined && typeof body.has_more !== 'boolean') throw new NetworkFailure('invalid_response')
  if (!Array.isArray(items)) throw new NetworkFailure('invalid_response')
  if (items.length > MAX_CHANNEL_MODELS) throw new NetworkFailure('too_large')
  const models: ChannelModel[] = []
  for (const item of items) {
    const model = record(item)
    const rawId = provider === 'google' ? model.name : model.id
    if (typeof rawId !== 'string' || !rawId.trim() || rawId.length > 512) throw new NetworkFailure('invalid_response')
    if (provider === 'google' && (!Array.isArray(model.supportedGenerationMethods) || !model.supportedGenerationMethods.includes('generateContent'))) continue
    const id = provider === 'google' ? rawId.replace(/^models\//, '').trim() : rawId.trim()
    if (!id) throw new NetworkFailure('invalid_response')
    const rawName = provider === 'google' ? model.displayName : model.display_name
    models.push({ id, name: typeof rawName === 'string' && rawName.trim() ? rawName.trim().slice(0, 512) : id, enabled: false, source: 'fetched' })
  }
  const cursor = provider === 'google' ? body.nextPageToken : body.has_more === true ? body.last_id : undefined
  if ((cursor !== undefined && (typeof cursor !== 'string' || cursor.length > 2048)) || (body.has_more === true && !cursor)) throw new NetworkFailure('invalid_response')
  return { models, cursor: typeof cursor === 'string' ? cursor : '' }
}

export class ChannelNetworkService {
  private readonly active = new Map<number, ActiveRequest>()
  constructor(private readonly options: ChannelNetworkOptions) {}

  cancel(owner: number, requestId?: unknown): boolean {
    const active = this.active.get(owner)
    if (!active || (requestId !== undefined && requestId !== active.id)) return false
    active.controller.abort()
    return true
  }

  async request(owner: number, value: unknown): Promise<ChannelNetworkResult> {
    let input: ChannelNetworkInput
    try { input = parseInput(value) } catch { return failure('invalid_input') }
    if (this.active.has(owner)) return failure('busy')
    const controller = new AbortController()
    const { signal } = controller
    this.active.set(owner, { id: input.requestId, controller })
    let timer: ReturnType<typeof setTimeout> | undefined
    let timedOut = false
    try {
      const url = resolveChannelModelsUrl(input.provider, input.baseUrl)
      if (!isOfficialChannelModelsUrl(input.provider, url) && !(await this.options.confirmTarget(owner, url, signal))) throw new NetworkFailure('cancelled')
      signal.throwIfAborted()
      let apiKey = input.apiKey?.trim() ?? ''
      if (!apiKey && input.channelId) {
        try { apiKey = this.options.manager.resolve(input.channelId).apiKey }
        catch { throw new NetworkFailure('credential_error') }
      }
      signal.throwIfAborted()
      const headers: Record<string, string> = { Accept: 'application/json' }
      if (input.provider === 'anthropic' || input.provider === 'anthropic-compatible') {
        headers['anthropic-version'] = '2023-06-01'
        if (apiKey) headers['x-api-key'] = apiKey
      } else if (input.provider === 'google') {
        if (apiKey) headers['x-goog-api-key'] = apiKey
      } else if (apiKey) headers.Authorization = `Bearer ${apiKey}`
      const started = Date.now()
      timer = setTimeout(() => { timedOut = true; controller.abort() }, this.options.timeoutMs ?? 15000)
      const models = new Map<string, ChannelModel>()
      const cursors = new Set<string>()
      let cursor = ''
      for (let page = 0; page < 10; page += 1) {
        signal.throwIfAborted()
        const endpoint = new URL(url)
        if (input.provider === 'google') endpoint.searchParams.set('pageSize', '500')
        if (input.provider === 'anthropic' || input.provider === 'anthropic-compatible') endpoint.searchParams.set('limit', '500')
        if (cursor) endpoint.searchParams.set(input.provider === 'google' ? 'pageToken' : 'after_id', cursor)
        const response = await (this.options.fetch ?? fetch)(endpoint.toString(), { method: 'GET', headers, redirect: 'manual', signal })
        if (!response.ok) {
          void response.body?.cancel().catch(() => {})
          throw new NetworkFailure(httpError(response.status))
        }
        const parsed = parsePage(await readBody(response), input.provider)
        // 不接受把凭据回显到模型字段的异常服务响应。
        if (apiKey && parsed.models.some((model) => model.id === apiKey || model.name === apiKey)) throw new NetworkFailure('invalid_response')
        signal.throwIfAborted()
        for (const model of parsed.models) models.set(model.id, model)
        if (models.size > MAX_CHANNEL_MODELS) throw new NetworkFailure('too_large')
        if (input.operation === 'test' || !parsed.cursor) return {
          success: true,
          models: input.operation === 'models' ? [...models.values()] : [],
          message: input.operation === 'test' ? '模型目录连接正常；尚未验证模型生成能力。' : `已获取 ${models.size} 个模型；保存渠道后生效。`,
          elapsedMs: Date.now() - started,
        }
        if (cursors.has(parsed.cursor)) throw new NetworkFailure('invalid_response')
        cursors.add(parsed.cursor)
        cursor = parsed.cursor
      }
      throw new NetworkFailure('too_large')
    } catch (error: unknown) {
      if (signal.aborted) return failure(timedOut ? 'timeout' : 'cancelled')
      return failure(error instanceof NetworkFailure ? error.code : 'network')
    } finally {
      if (timer) clearTimeout(timer)
      this.active.delete(owner)
    }
  }
}
