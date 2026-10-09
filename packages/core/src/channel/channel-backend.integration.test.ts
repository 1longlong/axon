import { afterEach, describe, expect, test } from 'bun:test'
import { mkdtempSync, readFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type { AgentProviderAdapter, BackendClientId, ChannelNetworkInput } from '@axon/shared'
import { createBackend, createBackendPaths } from '../index'
import type { AxonBackend, BackendOptions } from '../index'
import { createFixtureCredentialCodec } from '../../test-support/credential-codec'

const directories: string[] = []
const backends: AxonBackend[] = []
afterEach(() => {
  for (const backend of backends.splice(0)) backend.dispose()
  for (const directory of directories.splice(0)) rmSync(directory, { recursive: true, force: true })
})

function deferred<T>() {
  let resolve: (value: T) => void = () => {}
  let reject: (reason: unknown) => void = () => {}
  const promise = new Promise<T>((done, fail) => { resolve = done; reject = fail })
  return { promise, resolve, reject }
}

/** 实际工厂、加密配置与客户端表；只替换目录传输/宿主确认，不访问用户渠道或外网。 */
function open(options: Partial<BackendOptions> = {}) {
  const directory = mkdtempSync(join(tmpdir(), 'axon-channel-backend-'))
  directories.push(directory)
  const adapter: AgentProviderAdapter = { query: async function* () { throw new Error('渠道不能调用 Runtime') }, abort: () => {}, dispose: () => {}, drain: async () => {} }
  const backend = createBackend({ paths: createBackendPaths({ dataDir: join(directory, 'data'), homeDir: directory }),
    applicationVersion: '0.1.3', credentialCodec: createFixtureCredentialCodec(), resolveAdapter: () => adapter, ...options,
  })
  backends.push(backend)
  return { backend, owner: backend.clients.register(), other: backend.clients.register() }
}

const input: ChannelNetworkInput = { requestId: 'request-1', operation: 'models', provider: 'openai',
  baseUrl: 'https://example.test/proxy/v1', apiKey: 'fixture-secret' }

describe('工厂渠道协调与宿主确认', () => {
  test('缺少确认端口拒绝第三方目标；非法/自报入口在凭据和传输前拒绝', async () => {
    let fetches = 0
    const { backend, owner } = open({ channelFetch: async () => { fetches += 1; return Response.json({ data: [] }) } })
    expect(await backend.channelNetwork.request(owner, input)).toMatchObject({ code: 'cancelled' })
    expect(await backend.channelNetwork.request('未知入口', input)).toMatchObject({ code: 'invalid_input' })
    expect(await backend.channelNetwork.request(owner, { ...input, owner })).toMatchObject({ code: 'invalid_input' })
    expect(fetches).toBe(0)
  })

  test('确认绑定可信入口和实际目录，先确认再解密，同端点分页不再次批准且凭据不外泄', async () => {
    const codec = createFixtureCredentialCodec()
    let decrypts = 0
    const approvals: Array<{ owner: BackendClientId; url: string; decrypts: number }> = []
    const urls: string[] = []
    const { backend, owner, other } = open({ credentialCodec: { ...codec, decrypt: async (value) => { decrypts += 1; return codec.decrypt(value) } },
      confirmChannelTarget: async (client, url) => { approvals.push({ owner: client, url, decrypts }); return true },
      channelFetch: async (url, init) => {
        urls.push(url)
        expect(init.redirect).toBe('manual')
        expect(new Headers(init.headers).get('authorization')).toBe('Bearer fixture-secret')
        return urls.length === 1 ? Response.json({ data: [{ id: 'one' }], has_more: true, last_id: 'one' })
          : Response.json({ data: [{ id: 'two' }] })
      },
    })
    const channel = await backend.channelController.create({ name: '安全渠道', provider: 'openai', baseUrl: input.baseUrl, apiKey: input.apiKey })
    expect(JSON.stringify(backend.channelController.list())).not.toContain('fixture-secret')
    expect(readFileSync(backend.paths.channelsPath, 'utf8')).not.toContain('fixture-secret')
    expect(channel).not.toHaveProperty('apiKey')
    const result = await backend.channelNetwork.request(owner, { ...input, apiKey: '', channelId: channel.id })
    expect(result).toMatchObject({ success: true, models: [{ id: 'one' }, { id: 'two' }] })
    expect(approvals).toEqual([{ owner, url: 'https://example.test/proxy/v1/models', decrypts: 0 }])
    expect(decrypts).toBe(1)
    expect(new URL(urls[1]!).searchParams.get('after_id')).toBe('one')
    expect(JSON.stringify(result)).not.toContain('fixture-secret')
    await backend.channelNetwork.request(other, input)
    expect(approvals.at(-1)?.owner).toBe(other)
    expect(approvals).toHaveLength(2)
    expect(backend.channelController.list()).toEqual([channel])
  })

  test('确认永不返回也能断开取消；迟到批准/拒绝不启动请求，新入口不继承旧确认', async () => {
    const approval = deferred<boolean>()
    let fetches = 0
    let signal: AbortSignal | undefined
    let confirms = 0
    const { backend, owner, other } = open({
      confirmChannelTarget: async (_client, _url, current) => { signal = current; confirms += 1; return approval.promise },
      channelFetch: async () => { fetches += 1; return Response.json({ data: [] }) },
    })
    const pending = backend.channelNetwork.request(owner, input)
    expect(signal?.aborted).toBe(false)
    expect(backend.channelNetwork.cancel(other, input.requestId)).toBe(false)
    backend.clients.detach(owner)
    expect(await pending).toMatchObject({ code: 'cancelled' })
    expect(signal?.aborted).toBe(true)
    approval.resolve(true)
    await Promise.resolve()
    expect(fetches).toBe(0)
    expect(await backend.channelNetwork.request(owner, input)).toMatchObject({ code: 'invalid_input' })
    const reloaded = backend.clients.register()
    expect(await backend.channelNetwork.request(reloaded, input)).toMatchObject({ success: true })
    expect(confirms).toBe(2)
    expect(fetches).toBe(1)
  })

  test('取消不配合停止的 fetch 时立即释放 owner，旧结果只清理正文，不覆盖新请求', async () => {
    const response = deferred<Response>()
    let calls = 0
    const { backend, owner } = open({ confirmChannelTarget: async () => true, channelFetch: async () => {
      calls += 1
      return calls === 1 ? response.promise : Response.json({ data: [{ id: 'current' }] })
    } })
    const pending = backend.channelNetwork.request(owner, input)
    while (!calls) await Promise.resolve()
    expect(backend.channelNetwork.cancel(owner, input.requestId)).toBe(true)
    expect(await pending).toMatchObject({ code: 'cancelled' })
    expect(await backend.channelNetwork.request(owner, { ...input, requestId: 'request-2' })).toMatchObject({ success: true, models: [{ id: 'current' }] })
    let cancelled = false
    response.resolve(new Response(new ReadableStream({ cancel: () => { cancelled = true } })))
    for (let i = 0; i < 4; i += 1) await Promise.resolve()
    expect(cancelled).toBe(true)
    expect(backend.channelNetwork.cancel(owner, input.requestId)).toBe(false)
  })

  test('正文不返回仍能取消并释放 reader；后端释放取消确认且不接受新请求', async () => {
    let bodyCancelled = false
    const reading = deferred<void>()
    const { backend, owner } = open({ confirmChannelTarget: async () => true, channelFetch: async () => {
      return new Response(new ReadableStream({ pull: () => { reading.resolve() }, cancel: () => { bodyCancelled = true } }, { highWaterMark: 0 }))
    } })
    const pending = backend.channelNetwork.request(owner, input)
    await reading.promise
    expect(backend.channelNetwork.cancel(owner, input.requestId)).toBe(true)
    expect(await pending).toMatchObject({ code: 'cancelled' })
    expect(bodyCancelled).toBe(true)
    const approval = deferred<boolean>()
    const ready = open({ confirmChannelTarget: async () => approval.promise })
    const waiting = ready.backend.channelNetwork.request(ready.owner, input)
    ready.backend.dispose()
    expect(await waiting).toMatchObject({ code: 'cancelled' })
    approval.reject(new Error('迟到宿主拒绝'))
    await Promise.resolve()
    expect(await ready.backend.channelNetwork.request(ready.owner, input)).toMatchObject({ code: 'invalid_input' })
  })

  test('fetch 已返回但正文 reader 尚未开始时取消，也清理已接收的响应', async () => {
    let started = false
    let bodyCancelled = false
    const { backend, owner } = open({ confirmChannelTarget: async () => true, channelFetch: async () => {
      started = true
      return new Response(new ReadableStream({ cancel: () => { bodyCancelled = true } }))
    } })
    const pending = backend.channelNetwork.request(owner, input)
    while (!started) await Promise.resolve()
    await Promise.resolve()
    expect(backend.channelNetwork.cancel(owner, input.requestId)).toBe(true)
    expect(await pending).toMatchObject({ code: 'cancelled' })
    expect(bodyCancelled).toBe(true)
  })
})
