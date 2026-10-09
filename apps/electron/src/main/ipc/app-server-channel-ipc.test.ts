import { afterEach, describe, expect, test } from 'bun:test'
import { EventEmitter } from 'node:events'
import { mkdtempSync, rmSync, readFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type { IpcMainInvokeEvent, WebContents } from 'electron'
import type { RpcRequestOptions } from '@axon/app-server'
import { CHANNEL_IPC_CHANNELS as channels, APP_SERVER_METHODS as methods } from '@axon/shared'
import type { Channel, RpcJsonValue } from '@axon/shared'
import { createFixtureCredentialCodec } from '../../../../../packages/core/test-support/credential-codec'
import { AppServerProcess } from '../lib/desktop/app-server-process'
import { AppServerEvents } from '../lib/desktop/app-server-events'
import { AppServerWindowClients } from '../lib/desktop/app-server-window-clients'
import { createAppServerChannelTargetConfirmation } from '../lib/desktop/app-server-channel-target'
import { registerAppServerChannelIpcHandlers } from './app-server-channel-ipc'
import type { AppServerChannelIpcRegistrar, AppServerChannelIpcOptions } from './app-server-channel-ipc'

type Handler = Parameters<AppServerChannelIpcRegistrar['handle']>[1]
type Method = Parameters<AppServerProcess['request']>[1]
interface Call { clientId: string; method: Method; input?: RpcJsonValue; options: RpcRequestOptions }
class Surface extends EventEmitter {
  readonly mainFrame = {}
  readonly deliveries: Array<{ channel: string; value: unknown }> = []
  isDestroyed(): boolean { return false }
  send(channel: string, value: unknown): void { this.deliveries.push({ channel, value }) }
  get sender(): WebContents { return this as unknown as WebContents }
  event(iframe = false): IpcMainInvokeEvent { return { sender: this.sender, senderFrame: iframe ? {} : this.mainFrame } as unknown as IpcMainInvokeEvent }
}
class Registrar implements AppServerChannelIpcRegistrar {
  readonly handlers = new Map<string, Handler>()
  handle(channel: string, handler: Handler): void {
    if (this.handlers.has(channel)) throw new Error('通道已注册')
    this.handlers.set(channel, handler)
  }
  removeHandler(channel: string): void { this.handlers.delete(channel) }
  async invoke(channel: string, event: IpcMainInvokeEvent, ...args: unknown[]): Promise<unknown> {
    const handler = this.handlers.get(channel)
    if (!handler) throw new Error('未注册')
    return await handler(event, ...args)
  }
}
const cleanups: Array<() => void | Promise<void>> = []
afterEach(async () => { for (const cleanup of cleanups.splice(0).reverse()) await cleanup() })

function open() {
  const main = new Surface(), unknown = new Surface(), ipc = new Registrar(), calls: Call[] = []
  let registrations = 0
  const owner = new AbortController()
  const clients = new AppServerWindowClients({ kindOf: (sender) => sender === main.sender ? 'main' : undefined, backend: {
    registerClient: async (kind) => { registrations += 1; return { clientId: 'owner', kind } },
    getClientSignal: () => owner.signal, detachClient: async () => { owner.abort(); return true },
  } })
  const backend: AppServerChannelIpcOptions['backend'] = { request: async (clientId, method, input, options = {}) => {
    calls.push({ clientId, method, input, options }); return { success: false, code: 'cancelled' }
  } }
  const dispose = registerAppServerChannelIpcHandlers(ipc, { backend, clients })
  cleanups.push(() => { dispose(); clients.dispose() })
  return { main, unknown, ipc, calls, backend, clients, dispose, registrations: () => registrations }
}

describe('渠道固定 IPC 代理', () => {
  test('只注册固定业务方法和安全 DTO，人工确认请求关闭短期限，取消保留原请求标识', async () => {
    const f = open()
    expect([...f.ipc.handlers.keys()].sort()).toEqual(Object.values(channels).filter((value) => value !== channels.CHANGED).sort())
    const request = { requestId: 'request-1', operation: 'models', provider: 'openai', baseUrl: 'https://example.test/v1' }
    const cases: Array<{ channel: string; args: unknown[]; method: Method; input?: RpcJsonValue; long?: boolean }> = [
      { channel: channels.LIST, args: [], method: methods.CHANNEL_LIST },
      { channel: channels.CREATE, args: [{ name: '渠道', provider: 'openai', apiKey: 'secret' }], method: methods.CHANNEL_CREATE, input: { name: '渠道', provider: 'openai', apiKey: 'secret' } },
      { channel: channels.UPDATE, args: [' channel ', { enabled: false }], method: methods.CHANNEL_UPDATE, input: { channelId: 'channel', update: { enabled: false } } },
      { channel: channels.DELETE, args: ['channel'], method: methods.CHANNEL_DELETE, input: 'channel' },
      { channel: channels.REQUEST, args: [request], method: methods.CHANNEL_REQUEST, input: request, long: true },
      { channel: channels.CANCEL, args: ['request-1'], method: methods.CHANNEL_CANCEL, input: 'request-1' },
    ]
    for (const item of cases) {
      expect(await f.ipc.invoke(item.channel, f.main.event(), ...item.args)).toEqual({ success: false, code: 'cancelled' })
      expect(f.calls.at(-1)).toMatchObject({ clientId: 'owner', method: item.method, input: item.input })
      expect(f.calls.at(-1)?.options.timeoutMs).toBe(item.long ? 0 : undefined)
      expect(f.calls.at(-1)?.options.signal?.aborted).toBe(false)
    }
    expect(f.registrations()).toBe(1)
    expect(f.ipc.handlers.has('axon/host/credential/decrypt')).toBe(false)
  })

  test('主 frame/数量/标识/JSON 校验先于登记，未知窗口不取得请求身份', async () => {
    const f = open()
    for (const channel of f.ipc.handlers.keys()) await expect(f.ipc.invoke(channel, f.main.event(true))).rejects.toThrow('子框架')
    await expect(f.ipc.invoke(channels.LIST, f.main.event(), 'owner')).rejects.toThrow('数量')
    await expect(f.ipc.invoke(channels.CANCEL, f.main.event(), ' ')).rejects.toThrow('标识')
    await expect(f.ipc.invoke(channels.CREATE, f.main.event(), { fn: () => {} })).rejects.toThrow('不能传输')
    await expect(f.ipc.invoke(channels.LIST, f.unknown.event())).rejects.toThrow('已登记')
    expect(f.registrations()).toBe(0)
    expect(f.calls).toEqual([])
  })

  test('释放取消在途目录等待，不重发或另发取消业务；迟到登记不得启动写入', async () => {
    const f = open(), entered = Promise.withResolvers<AbortSignal>()
    f.backend.request = (clientId, method, input, options = {}) => {
      f.calls.push({ clientId, method, input, options })
      const signal = options.signal!, waiting = Promise.withResolvers<RpcJsonValue>()
      entered.resolve(signal)
      signal.addEventListener('abort', () => waiting.reject(new DOMException('已取消', 'AbortError')), { once: true })
      return waiting.promise
    }
    const pending = f.ipc.invoke(channels.REQUEST, f.main.event(), { requestId: 'test' }).catch((error: unknown) => error)
    const signal = await entered.promise
    f.dispose(); f.dispose()
    expect(await pending).toMatchObject({ name: 'AbortError' })
    expect(signal.aborted).toBe(true)
    expect(f.calls.map((item) => item.method)).toEqual([methods.CHANNEL_REQUEST])
    expect(f.clients.find('owner')).toBe(f.main.sender)
    const gate = Promise.withResolvers<void>(), ipc = new Registrar()
    const dispose = registerAppServerChannelIpcHandlers(ipc, { backend: f.backend, clients: {
      get: async (sender) => { await gate.promise; return await f.clients.get(sender) }, getClientSignal: (id) => f.clients.getClientSignal(id),
    } })
    const late = ipc.invoke(channels.CREATE, f.main.event(), {}).catch((error: unknown) => error)
    dispose(); gate.resolve()
    expect(await late).toMatchObject({ name: 'AbortError' })
    expect(f.calls).toHaveLength(1)
  })

  test('半注册失败只删除本代理通道，保留原有注册；释放幂等', async () => {
    const f = open(), ipc = new Registrar()
    ipc.handle(channels.UPDATE, () => 'existing')
    expect(() => registerAppServerChannelIpcHandlers(ipc, { backend: f.backend, clients: f.clients })).toThrow('已注册')
    expect([...ipc.handlers.keys()]).toEqual([channels.UPDATE])
    expect(await ipc.invoke(channels.UPDATE, f.main.event())).toBe('existing')
  })

  test('真正完整子进程：安全渠道 CRUD/通知、私有凭据保存、原页面目录确认拒绝及重载', async () => {
    const directory = mkdtempSync(join(tmpdir(), 'axon-channel-ipc-'))
    const main = new Surface(), quick = new Surface(), ipc = new Registrar(), shown: WebContents[] = []
    let clients!: AppServerWindowClients, events!: AppServerEvents
    const backend = new AppServerProcess({ launch: {
      executable: process.execPath, entryArgs: [join(import.meta.dir, '../../../../app-server/src/main.ts')], dataDir: join(directory, 'data'),
      homeDir: directory, applicationVersion: '0.1.3', environment: { ...process.env, AXON_ZIMA_PYTHON: '' },
    }, credentialCodec: createFixtureCredentialCodec(), configurePeer: (peer) => { events = new AppServerEvents(peer, { clients }) },
      confirmChannelTarget: (owner, url, signal) => createAppServerChannelTargetConfirmation({ clients, show: async (sender, target) => {
        expect(target).toBe('https://example.test/v1/models'); shown.push(sender); return false
      } })(owner, url, signal), stopTimeoutMs: 100 })
    clients = new AppServerWindowClients({ backend, kindOf: (sender) => sender === main.sender ? 'main' : sender === quick.sender ? 'quick' : undefined })
    const dispose = registerAppServerChannelIpcHandlers(ipc, { backend, clients })
    cleanups.push(async () => { dispose(); events?.dispose(); clients.dispose(); await backend.stop(); rmSync(directory, { recursive: true, force: true }) })
    expect(await ipc.invoke(channels.LIST, main.event())).toEqual([])
    await ipc.invoke(channels.LIST, quick.event())
    expect(backend.pid).not.toBe(process.pid)
    const saved = await ipc.invoke(channels.CREATE, main.event(), { name: '隔离渠道', provider: 'openai', apiKey: 'fixture-secret', baseUrl: 'https://example.test/v1' }) as Channel
    expect(saved.hasApiKey).toBe(true)
    expect(JSON.stringify(saved)).not.toContain('fixture-secret')
    expect(JSON.stringify(main.deliveries)).not.toContain('fixture-secret')
    expect(quick.deliveries.at(-1)).toEqual({ channel: channels.CHANGED, value: [saved] })
    const stored = readFileSync(join(directory, 'data', 'channels.json'), 'utf8')
    expect(stored).toContain('secure:v1:')
    expect(stored).not.toContain('fixture-secret')
    expect(await ipc.invoke(channels.UPDATE, main.event(), saved.id, { name: '新标题' })).toMatchObject({ name: '新标题' })
    expect(await ipc.invoke(channels.REQUEST, main.event(), { requestId: 'test', operation: 'models', provider: 'openai', baseUrl: 'https://example.test/v1', channelId: saved.id }))
      .toMatchObject({ success: false, code: 'cancelled' })
    expect(shown).toEqual([main.sender])
    const owner = await clients.get(main.sender)
    main.emit('did-start-loading')
    await ipc.invoke(channels.LIST, main.event())
    expect((await clients.get(main.sender)).clientId).not.toBe(owner.clientId)
    expect(await ipc.invoke(channels.CREATE, main.event(), { name: '伪造', provider: 'openai', apiKey: '', owner: 'fake' }).catch((error: unknown) => error)).toMatchObject({ code: -32022 })
    await ipc.invoke(channels.DELETE, main.event(), saved.id)
    expect(await ipc.invoke(channels.LIST, quick.event())).toEqual([])
  })
})
