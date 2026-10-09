import { afterEach, expect, test } from 'bun:test'
import { createServer } from 'node:http'
import type { Socket } from 'node:net'
import type { ChannelNetworkInput, ResolvedChannel } from '@axon/shared'
import { BackendClientRegistry } from '../backend-client-registry'
import { ChannelNetworkService } from './channel-network-service'

const releases: Array<() => void> = []
const services: Array<{ network: ChannelNetworkService; clients: BackendClientRegistry }> = []
function deferred() {
  let resolve!: () => void
  const promise = new Promise<void>((done) => { resolve = done })
  releases.push(resolve)
  return { promise, resolve }
}
afterEach(async () => {
  for (const resolve of releases.splice(0)) resolve()
  for (const { network, clients } of services.splice(0)) { network.dispose(); await network.drain(); clients.dispose() }
})
const input: ChannelNetworkInput = { requestId: 'fixture-request', operation: 'models', provider: 'openai',
  baseUrl: 'https://api.openai.com/v1', apiKey: 'fixture-secret' }
const resolved: ResolvedChannel = { id: 'saved', name: '夹具', provider: 'openai', baseUrl: input.baseUrl,
  apiKey: 'fixture-secret', models: [], enabled: true, createdAt: 1, updatedAt: 1 }
async function assertPending(work: Promise<void>) {
  expect(await Promise.race([work.then(() => '结束'), Bun.sleep(10).then(() => '等待')])).toBe('等待')
}

for (const phase of ['confirm', 'decrypt', 'fetch', 'body'] as const) {
  test(`渠道退出在 ${phase} 阶段取消响应，但等待真实工作和迟到正文清理`, async () => {
    const entered = deferred(), finishWork = deferred(), closeEntered = deferred(), finishClose = deferred()
    const clients = new BackendClientRegistry()
    const owner = clients.register()
    let fetches = 0, closes = 0, decodes = 0
    const network = new ChannelNetworkService({ clients, timeoutMs: 10_000,
      confirmTarget: async () => { entered.resolve(); await finishWork.promise; return true },
      manager: { resolve: async () => { decodes += 1; entered.resolve(); await finishWork.promise; return resolved } },
      fetch: async () => {
        fetches += 1
        if (phase === 'fetch') { entered.resolve(); await finishWork.promise }
        return new Response(new ReadableStream<Uint8Array>({
          pull: () => { if (phase === 'body') entered.resolve() },
          cancel: async () => { closes += 1; closeEntered.resolve(); await finishClose.promise },
        }))
      },
    })
    services.push({ network, clients })
    const pending = network.request(owner, { ...input,
      ...(phase === 'confirm' ? { baseUrl: 'https://fixture.invalid/v1' } : {}),
      ...(phase === 'decrypt' ? { apiKey: '', channelId: 'saved' } : {}),
    })
    await entered.promise
    network.dispose()
    expect(await pending).toMatchObject({ success: false, code: 'cancelled' })
    expect(await network.request(owner, input)).toMatchObject({ code: 'invalid_input' })
    const drain = network.drain()
    await assertPending(drain)
    finishWork.resolve()
    if (phase === 'fetch' || phase === 'body') {
      await closeEntered.promise
      await assertPending(drain)
    }
    finishClose.resolve()
    await drain
    expect(fetches).toBe(phase === 'fetch' || phase === 'body' ? 1 : 0)
    expect(decodes).toBe(phase === 'decrypt' ? 1 : 0)
    expect(closes).toBe(phase === 'fetch' || phase === 'body' ? 1 : 0)
  })
}

test('真实本机 HTTP 目录正文挂起，退出取消 fetch/read 并实际断开 TCP，不读取其他页', async () => {
  const entered = deferred(), closed = deferred()
  const sockets = new Set<Socket>()
  let requests = 0
  const http = createServer((_request, response) => {
    requests += 1
    response.writeHead(200, { 'Content-Type': 'application/json' })
    response.flushHeaders()
    response.write('{"data":[') // 故意不结束正文，退出必须主动关闭流。
    entered.resolve()
  })
  http.on('connection', (socket) => {
    sockets.add(socket)
    socket.once('close', () => { sockets.delete(socket); closed.resolve() })
  })
  const clients = new BackendClientRegistry()
  const owner = clients.register()
  const network = new ChannelNetworkService({ clients, manager: { resolve: async () => resolved },
    confirmTarget: async () => true, timeoutMs: 5_000 })
  try {
    await new Promise<void>((resolve, reject) => { http.once('error', reject); http.listen(0, '127.0.0.1', resolve) })
    const address = http.address()
    if (!address || typeof address === 'string') throw new Error('夹具未监听')
    const pending = network.request(owner, { ...input, baseUrl: `http://127.0.0.1:${address.port}/v1` })
    await entered.promise
    network.dispose()
    expect(await pending).toMatchObject({ success: false, code: 'cancelled' })
    await network.drain()
    expect(await Promise.race([closed.promise.then(() => true), Bun.sleep(2_000).then(() => false)])).toBe(true)
    expect(requests).toBe(1)
  } finally {
    network.dispose()
    await network.drain()
    clients.dispose()
    for (const socket of sockets) socket.destroy()
    if (http.listening) await new Promise<void>((resolve) => http.close(() => resolve()))
  }
})
