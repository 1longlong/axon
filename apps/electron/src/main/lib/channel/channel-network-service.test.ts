import { describe, expect, test } from 'bun:test'
import { CHANNEL_NETWORK_ERRORS, isOfficialChannelModelsUrl, resolveChannelModelsUrl } from '@axon/shared'
import type { ChannelNetworkInput, ResolvedChannel } from '@axon/shared'
import { ChannelNetworkService } from './channel-network-service'
import type { ChannelFetch } from './channel-network-service'

const input: ChannelNetworkInput = { requestId: 'test-1', operation: 'models', provider: 'openai', baseUrl: 'https://api.openai.com/v1', apiKey: 'synthetic-secret' }
const manager = { resolve: (): ResolvedChannel => ({ id: 'saved', name: '渠道', provider: 'openai', baseUrl: input.baseUrl, apiKey: 'saved-secret', models: [], enabled: true, createdAt: 1, updatedAt: 1 }) }
const json = (value: unknown): Response => Response.json(value)
const service = (fetch: ChannelFetch, timeoutMs = 1000): ChannelNetworkService => new ChannelNetworkService({ manager, fetch, timeoutMs, confirmTarget: async () => true })

describe('渠道目录 URL 与请求边界', () => {
  test('目录端点保留前缀并消除重复版本，完整对话端点可解析为同级目录', () => {
    expect(resolveChannelModelsUrl('openai', 'https://api.openai.com/')).toBe('https://api.openai.com/v1/models')
    expect(resolveChannelModelsUrl('openai-responses', 'https://api.openai.com/v1/responses')).toBe('https://api.openai.com/v1/models')
    expect(resolveChannelModelsUrl('custom', 'https://example.test/proxy/v1/chat/completions')).toBe('https://example.test/proxy/v1/models')
    expect(resolveChannelModelsUrl('custom', 'https://example.test/chat/completions')).toBe('https://example.test/models')
    expect(resolveChannelModelsUrl('anthropic', 'https://api.anthropic.com/v1')).toBe('https://api.anthropic.com/v1/models')
    expect(resolveChannelModelsUrl('anthropic-compatible', 'https://example.test/proxy/v1/messages')).toBe('https://example.test/proxy/v1/models')
    expect(resolveChannelModelsUrl('google', 'https://generativelanguage.googleapis.com')).toBe('https://generativelanguage.googleapis.com/v1beta/models')
    expect(resolveChannelModelsUrl('google', 'https://example.test/v1beta/models/')).toBe('https://example.test/v1beta/models')
    for (const url of ['file:///tmp/x', 'https://user:secret@example.test', 'https://example.test/?key=secret', 'https://example.test/#secret']) expect(() => resolveChannelModelsUrl('openai', url)).toThrow()
    expect(isOfficialChannelModelsUrl('openai', 'https://api.openai.com/v1/models')).toBe(true)
    for (const url of ['http://api.openai.com/v1/models', 'https://api.openai.com.evil.test/v1/models', 'https://api.openai.com/other/models']) expect(isOfficialChannelModelsUrl('openai', url)).toBe(false)
    expect(isOfficialChannelModelsUrl('anthropic', 'https://api.openai.com/v1/models')).toBe(false)
  })

  test('拒绝不可信 IPC 负载，验证之前不发送网络请求', async () => {
    let calls = 0
    const network = service(async () => { calls += 1; return json({ data: [] }) })
    for (const value of [null, [], {}, { ...input, apiKey: 1 }, { ...input, apiKey: 'a\nb' }, { ...input, operation: {} }, { ...input, channelId: 1 }, { ...input, requestId: '' }, { ...input, confirmed: true }, { ...input, provider: 'bad' }, { ...input, baseUrl: 'file:///tmp' }]) {
      expect(await network.request(1, value)).toMatchObject({ success: false, code: 'invalid_input' })
    }
    expect(calls).toBe(0)
  })

  test('非官方地址拒绝确认时不解密、不发送；确认绑定实际目录地址', async () => {
    let calls = 0
    let target = ''
    const network = new ChannelNetworkService({
      manager: { resolve: () => { calls += 1; return manager.resolve() } },
      confirmTarget: async (_owner, url) => { target = url; return false },
      fetch: async () => { calls += 1; return json({ data: [] }) },
    })
    expect(await network.request(1, { ...input, apiKey: '', channelId: 'saved', baseUrl: 'http://localhost:8080/v1' })).toMatchObject({ code: 'cancelled' })
    expect(target).toBe('http://localhost:8080/v1/models')
    expect(calls).toBe(0)
  })

  test('已保存密钥仅用于主进程请求，新输入优先；凭据错误不回显', async () => {
    const keys: string[] = []
    const network = service(async (_url, init) => { keys.push(new Headers(init.headers).get('authorization') ?? ''); return json({ data: [{ id: 'model-a' }] }) })
    const result = await network.request(1, { ...input, apiKey: '', channelId: 'saved' })
    expect(keys[0]).toBe('Bearer saved-secret')
    expect(result).toMatchObject({ success: true, models: [{ id: 'model-a', enabled: false, source: 'fetched' }] })
    expect(JSON.stringify(result)).not.toContain('saved-secret')
    await network.request(1, { ...input, channelId: 'saved' })
    expect(keys[1]).toBe('Bearer synthetic-secret')
    const broken = new ChannelNetworkService({ manager: { resolve: () => { throw new Error('secret') } }, fetch: async () => { throw new Error('不能调用') }, confirmTarget: async () => true })
    expect(await broken.request(1, { ...input, apiKey: '', channelId: 'bad' })).toEqual({ success: false, code: 'credential_error', message: CHANNEL_NETWORK_ERRORS.credential_error })
  })
})

describe('模型目录协议与分页', () => {
  test('Anthropic 分页使用同一端点和鉴权，解析显示名并去重', async () => {
    const urls: string[] = []
    const network = service(async (url, init) => {
      urls.push(url)
      expect(init.redirect).toBe('manual')
      const headers = new Headers(init.headers)
      expect(headers.get('x-api-key')).toBe(input.apiKey!)
      expect(headers.get('anthropic-version')).toBe('2023-06-01')
      return urls.length === 1 ? json({ data: [{ id: 'a', display_name: '模型 A' }], has_more: true, last_id: 'a' }) : json({ data: [{ id: 'a', display_name: '模型 A' }, { id: 'b' }], has_more: false })
    })
    const result = await network.request(1, { ...input, provider: 'anthropic', baseUrl: 'https://api.anthropic.com' })
    expect(result.success && result.models.map((model) => model.id)).toEqual(['a', 'b'])
    expect(result.success && result.models[0]?.name).toBe('模型 A')
    expect(new URL(urls[1]!).searchParams.get('after_id')).toBe('a')
  })

  test('Google 仅保留 generateContent 模型，API Key 放 header 而非 URL', async () => {
    let calls = 0
    const network = service(async (url, init) => {
      calls += 1
      expect(url).not.toContain(input.apiKey!)
      expect(new Headers(init.headers).get('x-goog-api-key')).toBe(input.apiKey!)
      if (calls === 2) expect(new URL(url).searchParams.get('pageToken')).toBe('page-next')
      return calls === 1 ? json({ models: [{ name: 'models/chat', displayName: '对话', supportedGenerationMethods: ['generateContent'] }, { name: 'models/embed', supportedGenerationMethods: ['embedContent'] }], nextPageToken: 'page-next' }) : json({ models: [] })
    })
    const result = await network.request(1, { ...input, provider: 'google', baseUrl: 'https://generativelanguage.googleapis.com' })
    expect(result.success && result.models).toEqual([{ id: 'chat', name: '对话', enabled: false, source: 'fetched' }])
    expect(calls).toBe(2)
  })

  test('目录测试只检查第一页，不把模型合并到草稿', async () => {
    let calls = 0
    const network = service(async () => { calls += 1; return json({ data: [], has_more: true, last_id: 'next' }) })
    const result = await network.request(1, { ...input, operation: 'test' })
    expect(result).toMatchObject({ success: true, models: [] })
    expect(result.success && result.message).toContain('尚未验证模型生成能力')
    expect(calls).toBe(1)
  })

  test('错误结构、重复游标和超限目录失败，不返回部分列表', async () => {
    for (const body of [{}, { data: [null] }, { data: [{ id: '' }] }, { data: [], has_more: true }, { data: [], has_more: 'true' }, { data: [{ id: input.apiKey }] }, { data: Array.from({ length: 501 }, (_, i) => ({ id: `model-${i}` })) }]) {
      const result = await service(async () => json(body)).request(1, input)
      expect(result.success).toBe(false)
      expect(result).not.toHaveProperty('models')
    }
    expect(await service(async () => json({ data: [], has_more: true, last_id: 'same' })).request(1, input)).toMatchObject({ code: 'invalid_response' })
    expect(await service(async () => new Response('x'.repeat(2 * 1024 * 1024 + 1))).request(1, input)).toMatchObject({ code: 'too_large' })
    expect(await service(async () => new Response('<html>secret</html>')).request(1, input)).toMatchObject({ code: 'invalid_response' })
  })
})

describe('错误分类、取消和超时', () => {
  test('确认等待期间取消，不会在确认回调迟到后发送请求', async () => {
    let finishConfirmation: (value: boolean) => void = () => {}
    let calls = 0
    const network = new ChannelNetworkService({ manager,
      confirmTarget: async () => new Promise<boolean>((resolve) => { finishConfirmation = resolve }),
      fetch: async () => { calls += 1; return json({ data: [] }) },
    })
    const pending = network.request(1, { ...input, baseUrl: 'https://example.test/v1' })
    network.cancel(1, input.requestId)
    finishConfirmation(true)
    expect(await pending).toMatchObject({ code: 'cancelled' })
    expect(calls).toBe(0)
  })

  test('后续页失败不返回前面页的部分模型，十页上限不会无限请求', async () => {
    let calls = 0
    const partial = service(async () => {
      calls += 1
      return calls === 1 ? json({ data: [{ id: 'first' }], has_more: true, last_id: 'next' }) : new Response('secret', { status: 500 })
    })
    const result = await partial.request(1, input)
    expect(result).toMatchObject({ code: 'server' })
    expect(result).not.toHaveProperty('models')
    calls = 0
    const endless = service(async () => json({ data: [], has_more: true, last_id: `cursor-${++calls}` }))
    expect(await endless.request(1, input)).toMatchObject({ code: 'too_large' })
    expect(calls).toBe(10)
  })

  test('无鉴权服务不添加 Authorization，空目录仍是合法结果', async () => {
    const network = service(async (_url, init) => {
      expect(new Headers(init.headers).has('authorization')).toBe(false)
      return json({ data: [] })
    })
    expect(await network.request(1, { ...input, apiKey: '' })).toMatchObject({ success: true, models: [] })
  })
  test('HTTP 错误和重定向不回显正文，也不重试或追踪新地址', async () => {
    for (const [status, code] of [[302, 'redirect'], [401, 'unauthorized'], [403, 'forbidden'], [404, 'not_found'], [405, 'not_found'], [429, 'rate_limit'], [500, 'server'], [400, 'http']] as const) {
      let calls = 0
      const result = await service(async (_url, init) => {
        calls += 1
        expect(init.redirect).toBe('manual')
        return new Response('synthetic-secret', { status, headers: { Location: 'https://unapproved.test' } })
      }).request(1, input)
      expect(result).toEqual({ success: false, code, message: CHANNEL_NETWORK_ERRORS[code] })
      expect(calls).toBe(1)
    }
    expect(await service(async () => { throw new Error('secret: certificate') }).request(1, input)).toMatchObject({ code: 'network' })
  })

  test('取消仅命中所属窗口和请求 ID，重复请求被阻止，完成后可重试', async () => {
    const network = service(async (_url, init) => new Promise((_resolve, reject) => init.signal!.addEventListener('abort', () => reject(new Error('已中止')), { once: true })))
    const pending = network.request(1, input)
    expect(await network.request(1, { ...input, requestId: 'other' })).toMatchObject({ code: 'busy' })
    expect(network.cancel(2, input.requestId)).toBe(false)
    expect(network.cancel(1, 'other')).toBe(false)
    expect(network.cancel(1, input.requestId)).toBe(true)
    expect(await pending).toMatchObject({ code: 'cancelled' })
    const retry = network.request(1, input)
    network.cancel(1)
    expect(await retry).toMatchObject({ code: 'cancelled' })
  })

  test('超时涵盖尚未返回的请求以及收到 header 后卡住的正文', async () => {
    const stuckFetch: ChannelFetch = async (_url, init) => new Promise((_resolve, reject) => init.signal!.addEventListener('abort', () => reject(new Error('已中止')), { once: true }))
    expect(await service(stuckFetch, 10).request(1, input)).toMatchObject({ code: 'timeout' })
    const stuckBody: ChannelFetch = async (_url, init) => new Response(new ReadableStream({
      start(controller) { init.signal!.addEventListener('abort', () => controller.error(new Error('已中止')), { once: true }) },
    }))
    expect(await service(stuckBody, 10).request(1, input)).toMatchObject({ code: 'timeout' })
  })
})
