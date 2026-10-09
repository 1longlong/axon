import { afterEach, describe, expect, test } from 'bun:test'
import { EventEmitter } from 'node:events'
import { mkdtempSync, readFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type { IpcMainInvokeEvent, WebContents } from 'electron'
import { RpcFault, toWireValue } from '@axon/app-server'
import type { RpcRequestOptions } from '@axon/app-server'
import { SETTINGS_IPC_CHANNELS as channels, USER_PROFILE_IPC_CHANNELS as profileChannels, APP_SERVER_METHODS as methods } from '@axon/shared'
import type { AppSettings, RpcJsonValue } from '@axon/shared'
import { createFixtureCredentialCodec } from '../../../../../packages/core/test-support/credential-codec'
import { AppServerProcess } from '../lib/desktop/app-server-process'
import { AppServerWindowClients } from '../lib/desktop/app-server-window-clients'
import { AppServerEvents } from '../lib/desktop/app-server-events'
import { AppServerSettingsTransaction } from '../lib/desktop/app-server-settings-transaction'
import { AppServerDesktopSettings } from '../lib/desktop/app-server-desktop-settings'
import { QuickChatShortcutService } from '../lib/desktop/quick-chat-shortcut-service'
import { registerAppServerSettingsIpcHandlers } from './app-server-settings-ipc'
import type { AppServerSettingsIpcRegistrar, AppServerSettingsIpcOptions } from './app-server-settings-ipc'

type Handler = Parameters<AppServerSettingsIpcRegistrar['handle']>[1]
type Method = Parameters<AppServerProcess['request']>[1]
class Surface extends EventEmitter {
  readonly mainFrame = {}
  readonly deliveries: Array<{ channel: string; value: unknown }> = []
  isDestroyed(): boolean { return false }
  send(channel: string, value: unknown): void { this.deliveries.push({ channel, value }) }
  get sender(): WebContents { return this as unknown as WebContents }
  event(iframe = false): IpcMainInvokeEvent { return { sender: this.sender, senderFrame: iframe ? {} : this.mainFrame } as unknown as IpcMainInvokeEvent }
}
class Registrar implements AppServerSettingsIpcRegistrar {
  readonly handlers = new Map<string, Handler>()
  handle(channel: string, action: Handler): void { if (this.handlers.has(channel)) throw new Error('已注册'); this.handlers.set(channel, action) }
  removeHandler(channel: string): void { this.handlers.delete(channel) }
  async invoke(channel: string, sender: Surface, ...args: unknown[]): Promise<unknown> {
    const action = this.handlers.get(channel)
    if (!action) throw new Error('未注册')
    return await action(sender.event(), ...args)
  }
}
const cleanups: Array<() => void | Promise<void>> = []
afterEach(async () => { for (const cleanup of cleanups.splice(0).reverse()) await cleanup() })
function open() {
  const main = new Surface(), unknown = new Surface(), ipc = new Registrar(), signal = new AbortController()
  const calls: Array<{ id: string; method: Method; input?: RpcJsonValue; options: RpcRequestOptions }> = []
  let registrations = 0, applies = 0
  const clients = new AppServerWindowClients({ kindOf: (sender) => sender === main.sender ? 'main' : undefined, backend: {
    registerClient: async (kind) => { registrations++; return { clientId: 'owner', kind } },
    getClientSignal: () => signal.signal, detachClient: async () => { signal.abort(); return true },
  } })
  const backend: AppServerSettingsIpcOptions['backend'] = { request: async (id, method, input, options = {}) => {
    calls.push({ id, method, input, options }); return method === methods.VALIDATE_SETTINGS ? input! : { themeMode: 'light' }
  } }
  const transaction: AppServerSettingsIpcOptions['transaction'] = { apply: async (_patch, save) => { applies++; return await save() } }
  const dispose = registerAppServerSettingsIpcHandlers(ipc, { backend, clients, transaction })
  cleanups.push(() => { dispose(); clients.dispose() })
  return { main, unknown, ipc, backend, clients, transaction, dispose, calls, get registrations() { return registrations }, get applies() { return applies } }
}

describe('独立后端设置固定代理', () => {
  test('只注册四个固定命令；设置先校验再事务保存，资料不进入快捷键事务', async () => {
    const f = open()
    expect([...f.ipc.handlers.keys()].sort()).toEqual([channels.GET, channels.UPDATE, profileChannels.GET, profileChannels.UPDATE].sort())
    for (const [channel, method, args] of [
      [channels.GET, methods.GET_SETTINGS, []], [profileChannels.GET, methods.GET_USER_PROFILE, []],
      [profileChannels.UPDATE, methods.UPDATE_USER_PROFILE, [{ userName: '用户' }]],
    ] as const) {
      await f.ipc.invoke(channel, f.main, ...args)
      expect(f.calls.at(-1)).toMatchObject({ id: 'owner', method, input: args[0] })
    }
    await f.ipc.invoke(channels.UPDATE, f.main, { themeMode: 'light' })
    expect(f.calls.slice(-2).map((call) => call.method)).toEqual([methods.VALIDATE_SETTINGS, methods.UPDATE_SETTINGS])
    expect(f.applies).toBe(1); expect(f.registrations).toBe(1)
    expect(f.calls.at(-1)?.options.signal?.aborted).toBe(false)
  })

  test('主 frame/参数/JSON 校验先于登记；后端校验拒绝或页面取消不会预注册及保存', async () => {
    const f = open()
    for (const action of f.ipc.handlers.values()) expect(() => action(f.main.event(true))).toThrow('子框架')
    await expect(f.ipc.invoke(channels.GET, f.main, 'owner')).rejects.toThrow('数量')
    await expect(f.ipc.invoke(channels.UPDATE, f.main, { fn: () => {} })).rejects.toThrow('不能传输')
    await expect(f.ipc.invoke(channels.GET, f.unknown)).rejects.toThrow('已登记')
    expect(f.registrations).toBe(0)
    f.backend.request = async () => { throw new RpcFault(-32602, '校验失败') }
    await expect(f.ipc.invoke(channels.UPDATE, f.main, {})).rejects.toMatchObject({ code: -32602 })
    expect(f.applies).toBe(0)
    const gate = Promise.withResolvers<RpcJsonValue>()
    f.backend.request = () => gate.promise
    const pending = f.ipc.invoke(channels.UPDATE, f.main, {}).catch((error: unknown) => error)
    await Promise.resolve(); await Promise.resolve()
    f.dispose(); gate.resolve({})
    expect(await pending).toMatchObject({ name: 'AbortError' })
    expect(f.applies).toBe(0)
  })

  test('半注册只清理本代理，释放幂等且不注销其他共享页面', async () => {
    const f = open(), ipc = new Registrar()
    ipc.handle(channels.UPDATE, () => 'existing')
    expect(() => registerAppServerSettingsIpcHandlers(ipc, { backend: f.backend, clients: f.clients, transaction: f.transaction })).toThrow('已注册')
    expect([...ipc.handlers.keys()]).toEqual([channels.UPDATE])
    await f.ipc.invoke(channels.GET, f.main)
    f.dispose(); f.dispose()
    expect(f.clients.find('owner')).toBe(f.main.sender)
    expect(f.ipc.handlers.size).toBe(0)
  })

  test('真实完整子进程：预注册/保存/通知；页面重载丢失响应后由独立宿主重读，不重发', async () => {
    const directory = mkdtempSync(join(tmpdir(), 'axon-settings-ipc-'))
    const main = new Surface(), quick = new Surface(), ipc = new Registrar(), keys = new Set<string>()
    let clients!: AppServerWindowClients, events!: AppServerEvents, desktopSettings!: AppServerDesktopSettings
    const backend = new AppServerProcess({ launch: {
      executable: process.execPath, entryArgs: [join(import.meta.dir, '../../../../app-server/src/main.ts')], dataDir: join(directory, 'data'),
      homeDir: directory, applicationVersion: '0.1.3', environment: { ...process.env, AXON_ZIMA_PYTHON: '' },
    }, credentialCodec: createFixtureCredentialCodec(), configurePeer: (peer) => { events = new AppServerEvents(peer, { clients, desktopSettings }) }, stopTimeoutMs: 100 })
    clients = new AppServerWindowClients({ backend, kindOf: (sender) => sender === main.sender ? 'main' : sender === quick.sender ? 'quick' : undefined })
    desktopSettings = new AppServerDesktopSettings({ backend })
    cleanups.push(async () => { events?.dispose(); clients.dispose(); await desktopSettings.dispose(); await backend.stop(); rmSync(directory, { recursive: true, force: true }) })
    await backend.start()
    const host = await backend.registerClient('external')
    const readSettings = () => desktopSettings.readSettings()
    expect(await readSettings()).toMatchObject({ quickChatShortcuts: [] })
    const shortcuts = new QuickChatShortcutService({ register: (key) => { if (keys.has(key)) return false; keys.add(key); return true },
      unregister: (key) => { keys.delete(key) } }, () => true, () => {})
    const transaction = new AppServerSettingsTransaction({ shortcuts, readSettings })
    let loseResponse = false, writes = 0
    const proxy: AppServerSettingsIpcOptions['backend'] = { request: async (id, method, input, options) => {
      const value = await backend.request(id, method, input, options)
      if (method === methods.UPDATE_SETTINGS) {
        writes++
        if (loseResponse) { loseResponse = false; main.emit('did-start-loading'); throw new Error('模拟丢失响应') }
      }
      return value
    } }
    const dispose = registerAppServerSettingsIpcHandlers(ipc, { backend: proxy, clients, transaction })
    cleanups.push(() => { dispose(); transaction.dispose(); shortcuts.dispose() })
    await ipc.invoke(channels.GET, main); await ipc.invoke(channels.GET, quick)
    expect(backend.pid).not.toBe(process.pid)
    const chat = await backend.request(host.clientId, methods.CHAT_CREATE_CONVERSATION, {}) as { id: string }
    const binding = { id: 'binding', accelerator: 'Command+1', sessionType: 'chat', sessionId: chat.id }
    expect(await ipc.invoke(channels.UPDATE, main, { themeMode: 'dark', quickChatShortcuts: [binding] })).toMatchObject({ themeMode: 'dark' })
    expect(keys.has('Command+1')).toBe(true)
    expect(quick.deliveries.some((event) => event.channel === channels.CHANGED)).toBe(true)
    expect(desktopSettings.settings.themeMode).toBe('dark')
    await expect(ipc.invoke(channels.UPDATE, main, { themeMode: 'invalid', quickChatShortcuts: [] })).rejects.toMatchObject({ code: -32602 })
    expect(writes).toBe(1); expect(keys.has('Command+1')).toBe(true)
    loseResponse = true
    const previousPage = await clients.get(main.sender), pageSignal = clients.getClientSignal(previousPage.clientId)!
    const canceled = await ipc.invoke(channels.UPDATE, main, { quickChatShortcuts: [{ ...binding, accelerator: 'Command+2' }] }).catch((error: unknown) => error)
    expect(pageSignal.aborted).toBe(true)
    expect(canceled).toBe(pageSignal.reason)
    expect(writes).toBe(2); expect([...keys]).toEqual(['Command+2'])
    expect((await readSettings()).quickChatShortcuts[0]?.accelerator).toBe('Command+2')
    const mainWindowState = { width: 1400, height: 900, x: 10, y: 20, isMaximized: false }
    await desktopSettings.saveWindowState(mainWindowState)
    expect(await readSettings()).toMatchObject({ mainWindowState, themeMode: 'dark', quickChatShortcuts: [{ accelerator: 'Command+2' }] })
    expect(desktopSettings.settings.mainWindowState).toEqual(mainWindowState)
    expect(JSON.parse(readFileSync(join(directory, 'data', 'settings.json'), 'utf8')).quickChatShortcuts[0].accelerator).toBe('Command+2')
    expect(await ipc.invoke(profileChannels.UPDATE, main, { userName: '新资料' })).toMatchObject({ userName: '新资料' })
    expect(quick.deliveries.at(-1)?.channel).toBe(profileChannels.CHANGED)
    expect(await ipc.invoke(channels.GET, main)).toEqual(toWireValue(await readSettings()))
  })
})
