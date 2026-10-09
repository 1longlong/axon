import { describe, expect, test } from 'bun:test'
import { EventEmitter } from 'node:events'
import type { WebContents } from 'electron'
import { AppServerWindowClients } from './app-server-window-clients'
import { createAppServerChannelTargetConfirmation } from './app-server-channel-target'

function open() {
  const main = new EventEmitter() as EventEmitter & { isDestroyed(): boolean }
  main.isDestroyed = () => false
  const sender = main as unknown as WebContents
  const signals = new Map<string, AbortController>()
  let counter = 0
  const clients = new AppServerWindowClients({ kindOf: (value) => value === sender ? 'main' : undefined, backend: {
    registerClient: async (kind) => { const clientId = `client-${++counter}`; signals.set(clientId, new AbortController()); return { clientId, kind } },
    getClientSignal: (id) => signals.get(id)?.signal,
    detachClient: async (id) => { signals.get(id)?.abort(); return signals.delete(id) },
  } })
  return { main, sender, clients }
}

describe('独立后端渠道目标原生确认', () => {
  test('未知/已取消入口不展示；只确认已登记原窗口，不临时创建身份', async () => {
    const f = open(), shown: WebContents[] = []
    const confirm = createAppServerChannelTargetConfirmation({ clients: f.clients, show: async (sender) => { shown.push(sender); return true } })
    const request = new AbortController()
    expect(await confirm('unknown', 'https://example.test/v1/models', request.signal)).toBe(false)
    const client = await f.clients.get(f.sender)
    expect(await confirm(client.clientId, 'https://example.test/v1/models', request.signal)).toBe(true)
    request.abort()
    expect(await confirm(client.clientId, 'https://example.test/v1/models', request.signal)).toBe(false)
    expect(shown).toEqual([f.sender])
    f.clients.dispose()
  })

  test('请求取消、页面重载与释放及时拒绝，忽略不配合取消的迟到批准', async () => {
    for (const mode of ['request', 'reload', 'dispose']) {
      const f = open(), client = await f.clients.get(f.sender), gate = Promise.withResolvers<boolean>()
      let nativeSignal: AbortSignal | undefined
      const request = new AbortController()
      const confirm = createAppServerChannelTargetConfirmation({ clients: f.clients,
        show: async (_sender, _url, signal) => { nativeSignal = signal; return await gate.promise } })
      const pending = confirm(client.clientId, 'https://example.test/v1/models', request.signal)
      if (mode === 'request') request.abort()
      if (mode === 'reload') { f.main.emit('did-start-loading'); await f.clients.get(f.sender) }
      if (mode === 'dispose') f.clients.dispose()
      expect(await pending).toBe(false)
      expect(nativeSignal?.aborted).toBe(true)
      gate.resolve(true)
      expect(await confirm(client.clientId, 'https://example.test/v1/models', request.signal)).toBe(false)
      f.clients.dispose()
    }
  })

  test('原生窗口拒绝、抛错或登记来源变化均不放行，不向新页面重试', async () => {
    const f = open(), client = await f.clients.get(f.sender)
    const signal = new AbortController().signal
    expect(await createAppServerChannelTargetConfirmation({ clients: f.clients, show: async () => false })(client.clientId, 'https://example.test', signal)).toBe(false)
    expect(await createAppServerChannelTargetConfirmation({ clients: f.clients, show: async () => { throw new Error('secret native detail') } })(client.clientId, 'https://example.test', signal)).toBe(false)
    expect(await createAppServerChannelTargetConfirmation({ clients: {
      find: (id) => f.clients.find(id), getClientSignal: (id) => f.clients.getClientSignal(id), matches: () => false },
      show: async () => true })(client.clientId, 'https://example.test', signal)).toBe(false)
    f.clients.dispose()
  })
})
