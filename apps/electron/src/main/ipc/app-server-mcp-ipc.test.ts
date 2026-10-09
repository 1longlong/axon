import { afterEach, describe, expect, test } from 'bun:test'
import { EventEmitter } from 'node:events'
import { existsSync, mkdtempSync, readFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type { IpcMainInvokeEvent, WebContents } from 'electron'
import type { RpcRequestOptions } from '@axon/app-server'
import { APP_SERVER_METHODS as methods, MCP_IPC_CHANNELS as channels } from '@axon/shared'
import type { AgentProject, McpConnectionTestResult, RpcJsonValue } from '@axon/shared'
import { createFixtureCredentialCodec } from '../../../../../packages/core/test-support/credential-codec'
import { AppServerProcess } from '../lib/desktop/app-server-process'
import { AppServerWindowClients } from '../lib/desktop/app-server-window-clients'
import { AppServerEvents } from '../lib/desktop/app-server-events'
import { registerAppServerMcpIpcHandlers } from './app-server-mcp-ipc'
import type { AppServerMcpIpcOptions, AppServerMcpIpcRegistrar } from './app-server-mcp-ipc'

type Handler = Parameters<AppServerMcpIpcRegistrar['handle']>[1]
type Method = Parameters<AppServerProcess['request']>[1]
interface Call { clientId: string; method: Method; input?: RpcJsonValue; options: RpcRequestOptions }
class Surface extends EventEmitter {
  readonly mainFrame = {}
  readonly deliveries: unknown[] = []
  isDestroyed(): boolean { return false }
  send(...args: unknown[]): void { this.deliveries.push(args) }
  get sender(): WebContents { return this as unknown as WebContents }
  event(iframe = false): IpcMainInvokeEvent { return { sender: this.sender, senderFrame: iframe ? {} : this.mainFrame } as unknown as IpcMainInvokeEvent }
}
class Registrar implements AppServerMcpIpcRegistrar {
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
const server = { type: 'stdio', command: 'fixture', enabled: false, required: false, startupTimeoutMs: 3000, requestTimeoutMs: 3000 }
const testInput = { requestId: 'test-1', projectId: 'project', serverName: 'local', server }
function open() {
  const main = new Surface(), quick = new Surface(), unknown = new Surface(), ipc = new Registrar(), calls: Call[] = []
  const owners = new Map<string, AbortController>()
  let registrations = 0
  const clients = new AppServerWindowClients({ kindOf: (sender) => sender === main.sender ? 'main' : sender === quick.sender ? 'quick' : undefined, backend: {
    registerClient: async (kind) => { const clientId = `owner-${++registrations}`; owners.set(clientId, new AbortController()); return { clientId, kind } },
    getClientSignal: (id) => owners.get(id)?.signal,
    detachClient: async (id) => { owners.get(id)?.abort(); return true },
  } })
  const backend: AppServerMcpIpcOptions['backend'] = { request: async (clientId, method, input, options = {}) => {
    calls.push({ clientId, method, input, options }); return { ok: true, tools: [] }
  } }
  const dispose = registerAppServerMcpIpcHandlers(ipc, { backend, clients })
  cleanups.push(() => { dispose(); clients.dispose() })
  return { main, quick, unknown, ipc, backend, clients, calls, dispose, registrations: () => registrations }
}
async function until(check: () => boolean): Promise<void> {
  const deadline = Date.now() + 8000
  while (!check()) { if (Date.now() > deadline) throw new Error('等待实际事件超时'); await Bun.sleep(10) }
}

describe('MCP 固定 IPC 代理', () => {
  test('仅固定配置/诊断，测试关闭短期限，本地 requestId 不进入后端负载', async () => {
    const f = open()
    expect([...f.ipc.handlers.keys()].sort()).toEqual(Object.values(channels).sort())
    const cases: Array<{ channel: string; args: unknown[]; method: Method; input?: RpcJsonValue }> = [
      { channel: channels.GET_PROJECT_CONFIG, args: [' project '], method: methods.MCP_GET_CONFIG, input: 'project' },
      { channel: channels.SAVE_PROJECT_CONFIG, args: ['project', { version: 1, servers: { local: server } }], method: methods.MCP_SAVE_CONFIG, input: { projectId: 'project', config: { version: 1, servers: { local: server } } } },
      { channel: channels.LIST_BUILTIN_PRESETS, args: [], method: methods.MCP_LIST_PRESETS },
      { channel: channels.MATERIALIZE_BUILTIN_PRESET, args: ['project', 'preset'], method: methods.MCP_MATERIALIZE_PRESET, input: { projectId: 'project', presetId: 'preset' } },
      { channel: channels.TEST_SERVER_CONNECTION, args: [testInput], method: methods.MCP_TEST_CONNECTION, input: { projectId: 'project', serverName: 'local', server } },
    ]
    for (const item of cases) {
      expect(await f.ipc.invoke(item.channel, f.main.event(), ...item.args)).toEqual({ ok: true, tools: [] })
      expect(f.calls.at(-1)).toMatchObject({ clientId: 'owner-1', method: item.method, input: item.input })
      expect(f.calls.at(-1)?.options.timeoutMs).toBe(item.channel === channels.TEST_SERVER_CONNECTION ? 0 : undefined)
    }
    expect(await f.ipc.invoke(channels.CANCEL_CONNECTION_TEST, f.main.event(), 'test-1')).toBe(false)
    expect(f.calls).toHaveLength(5); expect(f.main.deliveries).toEqual([]); expect(f.quick.deliveries).toEqual([])
    expect(f.main.listenerCount('render-process-gone')).toBe(1)
  })

  test('frame/数量/固定字段/JSON 校验先于登记；取消未知请求不登记身份', async () => {
    const f = open()
    for (const channel of f.ipc.handlers.keys()) await expect(f.ipc.invoke(channel, f.main.event(true))).rejects.toThrow('子框架')
    await expect(f.ipc.invoke(channels.LIST_BUILTIN_PRESETS, f.main.event(), 'owner')).rejects.toThrow('数量')
    for (const input of [{ ...testInput, owner: 'fake' }, { ...testInput, requestId: '' }, { ...testInput, server: { fn: () => {} } }]) {
      await expect(f.ipc.invoke(channels.TEST_SERVER_CONNECTION, f.main.event(), input)).rejects.toThrow()
    }
    expect(await f.ipc.invoke(channels.CANCEL_CONNECTION_TEST, f.unknown.event(), 'test-1')).toBe(false)
    await expect(f.ipc.invoke(channels.GET_PROJECT_CONFIG, f.unknown.event(), 'project')).rejects.toThrow('已登记')
    expect(f.registrations()).toBe(0); expect(f.calls).toEqual([])
  })

  test('精确取消只有原页面有效，重复/跨窗口取消无效；重载撤销且迟到成功不得交付', async () => {
    const f = open(), gate = Promise.withResolvers<RpcJsonValue>(), entered = Promise.withResolvers<AbortSignal>()
    f.backend.request = async (_id, _method, _input, options = {}) => { entered.resolve(options.signal!); return await gate.promise }
    const pending = f.ipc.invoke(channels.TEST_SERVER_CONNECTION, f.main.event(), testInput).catch((error: unknown) => error)
    const signal = await entered.promise
    await expect(f.ipc.invoke(channels.TEST_SERVER_CONNECTION, f.main.event(), testInput)).rejects.toThrow('重复')
    expect(await f.ipc.invoke(channels.CANCEL_CONNECTION_TEST, f.quick.event(), 'test-1')).toBe(false)
    expect(signal.aborted).toBe(false)
    f.main.emit('did-start-loading')
    expect(await f.ipc.invoke(channels.CANCEL_CONNECTION_TEST, f.main.event(), 'test-1')).toBe(false)
    expect(signal.aborted).toBe(true)
    gate.resolve({ ok: true, tools: [] })
    expect(await pending).toMatchObject({ name: 'AbortError' })
    expect(f.main.listenerCount('did-start-loading')).toBe(1)
  })

  test('异步身份登记前已可取消，代理释放不消费迟到登记启动测试或重发', async () => {
    const f = open(), gate = Promise.withResolvers<void>(), ipc = new Registrar()
    const dispose = registerAppServerMcpIpcHandlers(ipc, { backend: f.backend, clients: {
      get: async (sender) => { const client = await f.clients.get(sender); await gate.promise; return client },
      getClientSignal: (id) => f.clients.getClientSignal(id),
    } })
    const pending = ipc.invoke(channels.TEST_SERVER_CONNECTION, f.main.event(), testInput).catch((error: unknown) => error)
    expect(await ipc.invoke(channels.CANCEL_CONNECTION_TEST, f.main.event(), 'test-1')).toBe(true)
    expect(await ipc.invoke(channels.CANCEL_CONNECTION_TEST, f.main.event(), 'test-1')).toBe(false)
    dispose(); dispose(); gate.resolve()
    expect(await pending).toMatchObject({ name: 'AbortError' })
    expect(f.calls).toEqual([]); expect(ipc.handlers.size).toBe(0)
  })

  test('半注册失败保留已有通道，不删除其他 registrar 的 handler', async () => {
    const f = open(), ipc = new Registrar()
    ipc.handle(channels.LIST_BUILTIN_PRESETS, () => 'existing')
    expect(() => registerAppServerMcpIpcHandlers(ipc, { backend: f.backend, clients: f.clients })).toThrow('已注册')
    expect([...ipc.handlers.keys()]).toEqual([channels.LIST_BUILTIN_PRESETS])
  })

  test('真实独立后端→MCP SDK：敏感配置只响应原请求，分页完整，精确取消和页面失效后实际进程退出', async () => {
    const directory = mkdtempSync(join(tmpdir(), 'axon-mcp-ipc-'))
    const main = new Surface(), quick = new Surface(), ipc = new Registrar()
    let clients!: AppServerWindowClients, events!: AppServerEvents
    const backend = new AppServerProcess({ launch: {
      executable: process.execPath, entryArgs: [join(import.meta.dir, '../../../../app-server/src/main.ts')],
      dataDir: join(directory, 'data'), homeDir: directory, applicationVersion: '0.1.3', environment: { ...process.env, AXON_ZIMA_PYTHON: '' },
    }, credentialCodec: createFixtureCredentialCodec(), configurePeer: (peer) => { events = new AppServerEvents(peer, { clients }) }, stopTimeoutMs: 100 })
    clients = new AppServerWindowClients({ backend, kindOf: (sender) => sender === main.sender ? 'main' : sender === quick.sender ? 'quick' : undefined })
    const dispose = registerAppServerMcpIpcHandlers(ipc, { backend, clients })
    cleanups.push(async () => { dispose(); events?.dispose(); clients.dispose(); await backend.stop(); rmSync(directory, { recursive: true, force: true }) })
    const owner = await clients.get(main.sender)
    const project = await backend.request(owner.clientId, methods.PROJECT_CREATE, { name: '隔离 MCP' }) as unknown as AgentProject
    await ipc.invoke(channels.LIST_BUILTIN_PRESETS, quick.event())
    main.deliveries.length = 0
    const config = { version: 1, servers: { local: { ...server, env: { TOKEN: 'fixture-secret' } } } }
    expect(await ipc.invoke(channels.SAVE_PROJECT_CONFIG, main.event(), project.id, config)).toEqual(config)
    expect(await ipc.invoke(channels.GET_PROJECT_CONFIG, main.event(), project.id)).toEqual(config)
    expect(main.deliveries).toEqual([]); expect(quick.deliveries).toEqual([])
    expect(backend.pid).not.toBe(process.pid)
    const script = join(import.meta.dir, '../../../../../packages/core/test-support/mcp-stdio-fixture.mjs')
    const success = join(directory, 'success')
    const result = await ipc.invoke(channels.TEST_SERVER_CONNECTION, main.event(), { ...testInput, projectId: project.id,
      server: { ...server, command: process.execPath, args: [script, success] } }) as McpConnectionTestResult
    expect(result.ok).toBe(true)
    if (!result.ok) throw new Error(result.message)
    expect(result.tools.map((tool) => tool.name)).toEqual(['echo', 'second'])
    expect(result.tools[0]).toMatchObject({ annotations: { readOnlyHint: true }, inputSchema: { required: ['value'] }, description: 'client=0.1.3' })
    await until(() => existsSync(success))
    for (const phase of ['initialize', 'tools/list']) {
      const marker = join(directory, phase.replace('/', '-')), requestId = `test-${phase}`
      const pending = ipc.invoke(channels.TEST_SERVER_CONNECTION, main.event(), { ...testInput, requestId, projectId: project.id,
        server: { ...server, command: process.execPath, args: [script, marker, phase] } }).catch((error: unknown) => error)
      try {
        await until(() => existsSync(`${marker}.started`))
        const pid = Number(readFileSync(`${marker}.started`, 'utf8'))
        expect(await ipc.invoke(channels.CANCEL_CONNECTION_TEST, quick.event(), requestId)).toBe(false)
        if (phase === 'initialize') {
          expect(await ipc.invoke(channels.CANCEL_CONNECTION_TEST, main.event(), requestId)).toBe(true)
          expect(await ipc.invoke(channels.CANCEL_CONNECTION_TEST, main.event(), requestId)).toBe(false)
        }
        else main.emit('did-start-loading')
        expect(await pending).toBeInstanceOf(Error)
        await until(() => existsSync(marker))
        await until(() => { try { process.kill(pid, 0); return false } catch (error) {
          return error instanceof Error && 'code' in error && error.code === 'ESRCH'
        } })
      } finally {
        await ipc.invoke(channels.CANCEL_CONNECTION_TEST, main.event(), requestId).catch(() => false)
        await pending
      }
    }
    // 草稿测试没有替换或保存服务器；两个入口仍读取原配置。
    expect(await ipc.invoke(channels.GET_PROJECT_CONFIG, main.event(), project.id)).toEqual(config)
    expect(await ipc.invoke(channels.GET_PROJECT_CONFIG, quick.event(), project.id)).toEqual(config)
    expect(main.deliveries).toEqual([]); expect(quick.deliveries).toEqual([])
  }, 25_000)
})
