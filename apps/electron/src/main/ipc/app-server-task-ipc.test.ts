import { afterEach, describe, expect, test } from 'bun:test'
import { EventEmitter } from 'node:events'
import { mkdirSync, mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { PassThrough } from 'node:stream'
import { JsonRpcPeer } from '@axon/app-server'
import type { IpcMainInvokeEvent, WebContents } from 'electron'
import { AgentDelegationManager, AgentRootStateStore, AgentSessionManager, createBackendPaths, writeTextFileAtomic } from '@axon/core'
import { AGENT_TASK_IPC_CHANNELS as channels, APP_SERVER_METHODS as methods } from '@axon/shared'
import type { AgentDelegation, AgentTaskSubscription, RpcJsonValue, SDKMessage } from '@axon/shared'
import { createFixtureCredentialCodec } from '../../../../../packages/core/test-support/credential-codec'
import { AgentTaskRendererController, agentTaskStateAtom } from '../../renderer/atoms/agent-task-state'
import { createStore } from 'jotai/vanilla'
import { AppServerProcess } from '../lib/desktop/app-server-process'
import { AppServerWindowClients } from '../lib/desktop/app-server-window-clients'
import { AppServerEvents } from '../lib/desktop/app-server-events'
import { registerAppServerTaskIpcHandlers } from './app-server-task-ipc'
import type { AppServerTaskIpcOptions, AppServerTaskIpcRegistrar } from './app-server-task-ipc'

type Handler = Parameters<AppServerTaskIpcRegistrar['handle']>[1]
class Registrar implements AppServerTaskIpcRegistrar {
  readonly handlers = new Map<string, Handler>()
  handle(channel: string, handler: Handler): void { if (this.handlers.has(channel)) throw new Error('通道已注册'); this.handlers.set(channel, handler) }
  removeHandler(channel: string): void { this.handlers.delete(channel) }
  async invoke(channel: string, event: IpcMainInvokeEvent, ...args: unknown[]): Promise<unknown> {
    const handler = this.handlers.get(channel)
    if (!handler) throw new Error('未注册')
    return await handler(event, ...args)
  }
}
class Surface extends EventEmitter {
  readonly mainFrame = {}
  isDestroyed(): boolean { return false }
  send(channel: string, value: unknown): void { this.emit(channel, value) }
  get sender(): WebContents { return this as unknown as WebContents }
  event(iframe = false): IpcMainInvokeEvent { return { sender: this.sender, senderFrame: iframe ? {} : this.mainFrame } as unknown as IpcMainInvokeEvent }
}
const cleanups: Array<() => void | Promise<void>> = []
afterEach(async () => { for (const cleanup of cleanups.splice(0).reverse()) await cleanup() })
function open() {
  const main = new Surface(), foreign = new Surface(), ipc = new Registrar(), page = new AbortController()
  let registrations = 0
  const calls: Array<{ method: string; input?: RpcJsonValue; signal?: AbortSignal }> = []
  const clients = new AppServerWindowClients({ kindOf: (sender) => sender === main.sender ? 'main' : undefined, backend: {
    registerClient: async (kind) => { registrations++; return { kind, clientId: 'owner' } },
    getClientSignal: () => page.signal, detachClient: async () => { page.abort(); return true },
  } })
  const backend: AppServerTaskIpcOptions['backend'] = { readyPeer: () => { throw new Error('夹具不能读历史') },
    request: async (_client, method, input, options = {}) => { calls.push({ method, input, signal: options.signal }); return null } }
  const dispose = registerAppServerTaskIpcHandlers(ipc, { backend, clients })
  cleanups.push(() => { dispose(); clients.dispose() })
  return { main, foreign, ipc, backend, clients, calls, dispose, registrations: () => registrations }
}
describe('Task 固定代理', () => {
  test('固定五个只读方法；订阅标识直接传递，不获得停止或任意 RPC 能力', async () => {
    const f = open()
    expect([...f.ipc.handlers.keys()].sort()).toEqual(Object.values(channels).filter((value) => value !== channels.EVENT).sort())
    await f.ipc.invoke(channels.LIST, f.main.event(), ' root ')
    await f.ipc.invoke(channels.GET, f.main.event(), 'root', 'task')
    await f.ipc.invoke(channels.SUBSCRIBE, f.main.event())
    await f.ipc.invoke(channels.UNSUBSCRIBE, f.main.event(), ' subscription ')
    expect(f.calls.map(({ method, input }) => ({ method, input }))).toEqual([
      { method: methods.TASK_LIST, input: 'root' }, { method: methods.TASK_GET, input: { rootSessionId: 'root', taskId: 'task' } },
      { method: methods.TASK_SUBSCRIBE, input: undefined }, { method: methods.TASK_UNSUBSCRIBE, input: 'subscription' },
    ])
    expect(f.registrations()).toBe(1)
  })
  test('主 frame/参数/范围校验先于登记；拒绝路径、owner、旧完整订阅 DTO 和未知窗口', async () => {
    const f = open()
    for (const channel of f.ipc.handlers.keys()) await expect(f.ipc.invoke(channel, f.main.event(true))).rejects.toThrow('子框架')
    await expect(f.ipc.invoke(channels.SUBSCRIBE, f.main.event(), 'owner')).rejects.toThrow('数量')
    for (const id of [null, {}, '../escape', '/private', '', 'a'.repeat(129)]) await expect(f.ipc.invoke(channels.LIST, f.main.event(), id)).rejects.toThrow('标识')
    await expect(f.ipc.invoke(channels.GET_MESSAGES, f.main.event(), 'root', '/file')).rejects.toThrow('标识')
    await expect(f.ipc.invoke(channels.UNSUBSCRIBE, f.main.event(), { subscriptionId: 'id' })).rejects.toThrow('标识')
    await expect(f.ipc.invoke(channels.SUBSCRIBE, f.foreign.event())).rejects.toThrow('已登记')
    expect(f.registrations()).toBe(0); expect(f.calls).toEqual([])
  })
  test('页面重载/代理释放不重建未知订阅，非配合后端迟到返回也不交付', async () => {
    const f = open(), entered = Promise.withResolvers<AbortSignal>(), gate = Promise.withResolvers<RpcJsonValue>()
    let requests = 0
    f.backend.request = async (_client, _method, _input, options = {}) => { requests++; entered.resolve(options.signal!); return await gate.promise }
    const result = f.ipc.invoke(channels.SUBSCRIBE, f.main.event()).catch((error: unknown) => error)
    const signal = await entered.promise
    f.main.emit('did-start-loading'); f.dispose(); f.dispose()
    gate.resolve({ subscriptionId: 'late' })
    expect(signal.aborted).toBe(true); expect(await result).toBe(signal.reason)
    expect(requests).toBe(1); expect(f.ipc.handlers.size).toBe(0)
  })
  test('部分注册失败只撤销自有通道；登记挂起时释放不启动后端请求', async () => {
    const f = open(), ipc = new Registrar()
    ipc.handle(channels.GET, () => 'existing')
    expect(() => registerAppServerTaskIpcHandlers(ipc, { backend: f.backend, clients: f.clients })).toThrow('已注册')
    expect([...ipc.handlers.keys()]).toEqual([channels.GET])
    const gate = Promise.withResolvers<void>(), fresh = new Registrar()
    const dispose = registerAppServerTaskIpcHandlers(fresh, { backend: f.backend, clients: {
      get: async (sender) => { const client = await f.clients.get(sender); await gate.promise; return client },
      getClientSignal: (client) => f.clients.getClientSignal(client),
    } })
    const result = fresh.invoke(channels.SUBSCRIBE, f.main.event()).catch((error: unknown) => error)
    dispose(); gate.resolve()
    expect(await result).toMatchObject({ name: 'AbortError' }); expect(f.calls).toEqual([])
  })
  test('真实双端协议的子历史续页被原页面取消，不交付首屏；关闭已知快照、不重发', async () => {
    const f = open(), up = new PassThrough(), down = new PassThrough()
    const parent = new JsonRpcPeer(down, up), child = new JsonRpcPeer(up, down)
    const entered = Promise.withResolvers<void>(), gate = Promise.withResolvers<RpcJsonValue>(), canceled = Promise.withResolvers<void>()
    const requests: RpcJsonValue[] = []
    let reads = 0, closes = 0
    child.handle(methods.HISTORY_READ, async (params, { signal }) => {
      requests.push(params as RpcJsonValue)
      if (++reads === 1) return { historyId: 'snapshot', messages: [{ type: 'result', uuid: 'first', subtype: 'success' }], cursor: 'next' }
      signal.addEventListener('abort', () => canceled.resolve(), { once: true })
      entered.resolve()
      return await gate.promise
    })
    child.handle(methods.HISTORY_CLOSE, () => { closes++; return true })
    f.backend.readyPeer = () => parent
    cleanups.push(() => { parent.close(); child.close(); up.destroy(); down.destroy() })
    const outcome = f.ipc.invoke(channels.GET_MESSAGES, f.main.event(), 'root', 'task').catch((error: unknown) => error)
    await entered.promise; f.main.emit('did-start-loading')
    expect(await outcome).toMatchObject({ code: 'canceled' }); await canceled.promise
    expect(reads).toBe(2); expect(closes).toBe(1)
    expect(requests[0]).toEqual({ clientId: 'owner', input: { scope: { kind: 'task', rootSessionId: 'root', taskId: 'task' } } })
    expect(requests[1]).toEqual({ clientId: 'owner', input: { scope: { kind: 'task', rootSessionId: 'root', taskId: 'task' }, historyId: 'snapshot', cursor: 'next' } })
    gate.resolve({ historyId: 'snapshot', messages: [], cursor: null })
    expect(f.calls).toEqual([])
  })
  test('真实独立后端→固定代理→renderer：恢复根任务及全部子历史，跨根拒绝、精确旧/跨窗口取消', async () => {
    const directory = mkdtempSync(join(tmpdir(), 'axon-task-ipc-')), paths = createBackendPaths({ dataDir: join(directory, 'data'), homeDir: directory })
    cleanups.push(() => { rmSync(directory, { recursive: true, force: true }) })
    // 只用中立仓储写入崩溃遗留记录；完整工厂正常 dispose 会将 queued 改为 canceled，不能冒充崩溃。
    const state = new AgentRootStateStore(paths.agentSessionsDir)
    const sessions = new AgentSessionManager({ indexPath: paths.agentSessionsIndexPath, sessionsDir: paths.agentSessionsDir, stateStore: state })
    const tasks = new AgentDelegationManager({ stateStore: state })
    const root = sessions.create(), other = sessions.create()
    const child = sessions.create({ parentSessionId: root.id, rootSessionId: root.id, parentToolUseId: 'tool', subagentType: 'coder' })
    const task = tasks.create({ rootSessionId: root.id, parentSessionId: root.id, childSessionId: child.id, parentToolUseId: 'tool', title: '读取夹具', objective: '读取全部历史', subagentType: 'coder', runInBackground: false, depth: 1 })
    const messages: SDKMessage[] = Array.from({ length: 215 }, (_, i) => ({ type: 'result', uuid: `message-${i}`, subtype: 'success' }))
    messages[110] = { type: 'system', uuid: 'summary', subtype: 'compact_boundary', summary: '完整摘要' } as SDKMessage
    const path = state.agentMessagesPath(root.id, child.id)
    mkdirSync(dirname(path), { recursive: true })
    writeTextFileAtomic(path, messages.map((message) => JSON.stringify(message)).join('\n') + '\n')
    expect(tasks.get(task.id)?.status).toBe('queued')
    // 静态夹具落盘后再启动实际独立后端；没有运行中的旧工厂或两个业务写入者。
    const main = new Surface(), quick = new Surface(), ipc = new Registrar(), store = createStore()
    let clients!: AppServerWindowClients, events!: AppServerEvents
    const backend = new AppServerProcess({ launch: { executable: process.execPath, entryArgs: [join(import.meta.dir, '../../../../app-server/src/main.ts')],
      dataDir: paths.dataDir, homeDir: directory, applicationVersion: '0.1.3', environment: { ...process.env, AXON_ZIMA_PYTHON: '' } },
      credentialCodec: createFixtureCredentialCodec(), configurePeer: (peer) => { events = new AppServerEvents(peer, { clients }) }, stopTimeoutMs: 100 })
    clients = new AppServerWindowClients({ backend, kindOf: (sender) => sender === main.sender ? 'main' : sender === quick.sender ? 'quick' : undefined })
    const dispose = registerAppServerTaskIpcHandlers(ipc, { backend, clients })
    const controller = new AgentTaskRendererController({
      subscribe: async () => await ipc.invoke(channels.SUBSCRIBE, main.event()) as AgentTaskSubscription,
      unsubscribe: async (id) => await ipc.invoke(channels.UNSUBSCRIBE, main.event(), id) as boolean,
      list: async (rootId) => await ipc.invoke(channels.LIST, main.event(), rootId) as AgentDelegation[],
      get: async (rootId, taskId) => await ipc.invoke(channels.GET, main.event(), rootId, taskId) as AgentDelegation | null,
      getMessages: async (rootId, taskId) => await ipc.invoke(channels.GET_MESSAGES, main.event(), rootId, taskId) as SDKMessage[],
      onEvent: (listener) => { main.on(channels.EVENT, listener); return () => { main.off(channels.EVENT, listener) } },
    }, store)
    const stop = controller.start()
    cleanups.push(async () => { stop(); dispose(); events?.dispose(); clients.dispose(); await backend.stop() })
    await controller.loadTasks(root.id); await controller.loadMessages(root.id, task.id)
    expect(backend.pid).not.toBe(process.pid)
    // 实际启动会把上次遗留的 queued/running 任务收束为 interrupted，历史正文仍完整恢复。
    const restored = store.get(agentTaskStateAtom).tasksByRootSession[root.id]
    expect(restored).toHaveLength(1)
    expect(restored?.[0]).toEqual({ ...task, status: 'interrupted', updatedAt: expect.any(Number), finishedAt: expect.any(Number) })
    expect(store.get(agentTaskStateAtom).messagesByTask[task.id]).toEqual(messages)
    expect(store.get(agentTaskStateAtom).messageStatusByTask[task.id]).toBe('ready')
    await expect(ipc.invoke(channels.GET_MESSAGES, main.event(), other.id, task.id)).rejects.toMatchObject({ code: -32029 })
    const a = await ipc.invoke(channels.SUBSCRIBE, main.event()) as AgentTaskSubscription
    const b = await ipc.invoke(channels.SUBSCRIBE, quick.event()) as AgentTaskSubscription
    const next = await ipc.invoke(channels.SUBSCRIBE, main.event()) as AgentTaskSubscription
    expect(await ipc.invoke(channels.UNSUBSCRIBE, main.event(), a.subscriptionId)).toBe(false)
    expect(await ipc.invoke(channels.UNSUBSCRIBE, quick.event(), next.subscriptionId)).toBe(false)
    expect(await ipc.invoke(channels.UNSUBSCRIBE, main.event(), next.subscriptionId)).toBe(true)
    expect(await ipc.invoke(channels.UNSUBSCRIBE, quick.event(), b.subscriptionId)).toBe(true)
  }, 15_000)
})
