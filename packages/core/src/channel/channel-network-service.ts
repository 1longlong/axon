/** 渠道目录诊断：凭据仅在后端组装，错误不透传响应正文。 */
import { CHANNEL_NETWORK_ERRORS, MAX_CHANNEL_MODELS, isProviderType, isOfficialChannelModelsUrl, resolveChannelModelsUrl } from '@axon/shared'
import { waitWithSignal } from '../async/wait-with-signal'
import { AsyncWorkTracker } from '../async/async-work-tracker'
import type { BackendClientId, ChannelModel, ChannelNetworkErrorCode, ChannelNetworkInput, ChannelNetworkResult, ProviderType } from '@axon/shared'
import type { ChannelManager } from './channel-manager'
import type { BackendClientRegistry } from '../backend-client-registry'

export type ChannelFetch = (url: string, init: RequestInit) => Promise<Response>
export interface ChannelNetworkOptions {
  clients: Pick<BackendClientRegistry, 'has' | 'subscribeDetached'>
  manager: Pick<ChannelManager, 'resolve'>
  /** 原生确认或宿主反向请求由入口注入；不提供端口时拒绝非官方目标。 */
  confirmTarget?: (owner: BackendClientId, url: string, signal: AbortSignal) => Promise<boolean>
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
async function readBody(response: Response, signal: AbortSignal, work: AsyncWorkTracker): Promise<unknown> {
  const reader = response.body?.getReader()
  if (!reader) throw new NetworkFailure('invalid_response')
  const decoder = new TextDecoder()
  let size = 0
  let text = ''
  let cancelling: Promise<void> | undefined
  const cancel = (): void => {
    // reader.cancel 可能先关闭读队列、后等待底层流清理；这段 Promise 也须登记。
    cancelling ??= work.run(() => reader.cancel()).catch(() => {})
  }
  signal.addEventListener('abort', cancel, { once: true })
  try {
    while (true) {
      signal.throwIfAborted()
      const { done, value } = await waitWithSignal(work.run(() => reader.read()), signal)
      signal.throwIfAborted()
      if (done) break
      size += value.byteLength
      if (size > 2 * 1024 * 1024) throw new NetworkFailure('too_large')
      text += decoder.decode(value, { stream: true })
    }
    text += decoder.decode()
    try { return JSON.parse(text) as unknown } catch { throw new NetworkFailure('invalid_response') }
  } finally {
    signal.removeEventListener('abort', cancel)
    cancel()
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
  private readonly active = new Map<BackendClientId, ActiveRequest>()
  private readonly unsubscribeClients: () => void
  private disposed = false
  private readonly work = new AsyncWorkTracker()

  /** 客户端注销时取消确认、解密和网络等待；旧入口不能把请求交给新窗口。 */
  constructor(private readonly options: ChannelNetworkOptions) {
    this.unsubscribeClients = options.clients.subscribeDetached((id) => this.abortOwner(id))
  }

  cancel(owner: BackendClientId, requestId?: unknown): boolean {
    if (this.disposed || !this.options.clients.has(owner)) return false
    return this.abortOwner(owner, requestId)
  }

  private abortOwner(owner: BackendClientId, requestId?: unknown): boolean {
    const active = this.active.get(owner)
    if (!active || active.controller.signal.aborted || (requestId !== undefined && requestId !== active.id)) return false
    active.controller.abort()
    return true
  }

  /** 先确认目标再解密请求目录；绑定本次外层取消/入口 owner，失败不回显服务端正文。 */
  request(owner: BackendClientId, value: unknown, requestSignal?: AbortSignal): Promise<ChannelNetworkResult> {
    return this.work.run(() => this.executeRequest(owner, value, requestSignal))
  }

  /** 登记确认/凭据/fetch/正文清理的真实 Promise；取消等待仍保持原安全顺序。 */
  private async executeRequest(owner: BackendClientId, value: unknown, requestSignal?: AbortSignal): Promise<ChannelNetworkResult> {
    let input: ChannelNetworkInput
    try { input = parseInput(value) } catch { return failure('invalid_input') }
    if (this.disposed || !this.options.clients.has(owner)) return failure('invalid_input')
    if (this.active.has(owner)) return failure('busy')
    if (requestSignal?.aborted) return failure('cancelled')
    const controller = new AbortController()
    const { signal } = controller
    // 协议取消只绑定这一次已接纳的请求，不按 owner 猜测并误取消相邻诊断。
    const cancelRequest = (): void => controller.abort()
    requestSignal?.addEventListener('abort', cancelRequest, { once: true })
    const request: ActiveRequest = { id: input.requestId, controller }
    this.active.set(owner, request)
    let timer: ReturnType<typeof setTimeout> | undefined
    let timedOut = false
    let currentResponse: Response | undefined
    // 覆盖收到响应但尚未取得 reader 的间隙；取消必须释放此时已经返回的正文。
    const cancelResponse = (): void => { if (currentResponse) this.cancelBody(currentResponse) }
    signal.addEventListener('abort', cancelResponse, { once: true })
    try {
      const url = resolveChannelModelsUrl(input.provider, input.baseUrl)
      if (!isOfficialChannelModelsUrl(input.provider, url)) {
        const confirm = this.options.confirmTarget
        if (!confirm || !(await waitWithSignal(this.work.run(() => confirm(owner, url, signal)), signal))) throw new NetworkFailure('cancelled')
      }
      signal.throwIfAborted()
      let apiKey = input.apiKey?.trim() ?? ''
      if (!apiKey && input.channelId) {
        try { apiKey = (await waitWithSignal(this.work.run(() => this.options.manager.resolve(input.channelId!)), signal)).apiKey }
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
        const pendingResponse = this.work.run(async () => {
          const response = await (this.options.fetch ?? fetch)(endpoint.toString(), { method: 'GET', headers, redirect: 'manual', signal })
          currentResponse = response
          // 这段回调留在被登记的 fetch 链内；迟到正文关闭不能脱离 drain 集合。
          if (signal.aborted) this.cancelBody(response)
          return response
        })
        // 取消后返回的响应只释放正文，不能沿用旧确认或把结果交给新请求。
        const response = await waitWithSignal(pendingResponse, signal)
        signal.throwIfAborted()
        if (!response.ok) {
          this.cancelBody(response)
          throw new NetworkFailure(httpError(response.status))
        }
        const parsed = parsePage(await readBody(response, signal, this.work), input.provider)
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
      requestSignal?.removeEventListener('abort', cancelRequest)
      signal.removeEventListener('abort', cancelResponse)
      cancelResponse()
      if (timer) clearTimeout(timer)
      if (this.active.get(owner) === request) this.active.delete(owner)
    }
  }

  /** 退出先拒绝新请求，再取消全部等待；取消本身不代表宿主/fetch/正文已结束。 */
  dispose(): void {
    if (this.disposed) return
    this.disposed = true
    try { this.unsubscribeClients() }
    finally { for (const owner of this.active.keys()) this.abortOwner(owner) }
  }

  /** 等待真实确认/解密/网络和流清理；未配合取消的端口由上层退出期限兜底。 */
  drain(): Promise<void> { return this.work.drain() }

  private cancelBody(response: Response): void {
    if (response.body) void this.work.run(() => response.body!.cancel()).catch(() => {})
  }
}
