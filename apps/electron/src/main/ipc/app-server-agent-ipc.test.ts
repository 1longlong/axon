import { afterEach, describe, expect, test } from 'bun:test'
import { EventEmitter } from 'node:events'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { PassThrough } from 'node:stream'
import type { IpcMainInvokeEvent, WebContents } from 'electron'
import { createCredentialCodec } from '@axon/core'
import { JsonRpcPeer, RpcFault } from '@axon/app-server'
import type { RpcRequestOptions } from '@axon/app-server'
import { AGENT_IPC_CHANNELS as channels, APP_SERVER_METHODS as methods } from '@axon/shared'
import type { AppServerClientKind, RpcJsonObject, RpcJsonValue } from '@axon/shared'
import { AppServerProcess } from '../lib/desktop/app-server-process'
import { AppServerEvents } from '../lib/desktop/app-server-events'
import { AppServerWindowClients } from '../lib/desktop/app-server-window-clients'
import { registerQuickChatWindowOwner, unregisterQuickChatWindowOwner } from '../lib/desktop/quick-chat-window-owner'
import { registerAppServerAgentIpcHandlers } from './app-server-agent-ipc'
import type { AppServerAgentIpcOptions, AppServerAgentIpcRegistrar } from './app-server-agent-ipc'

type Handler = Parameters<AppServerAgentIpcRegistrar['handle']>[1]
type Method = Parameters<AppServerProcess['request']>[1]
interface Call { clientId: string; method: Method; input?: RpcJsonValue; options: RpcRequestOptions }
let nextSurface = 9000
class Surface extends EventEmitter {
  readonly id = ++nextSurface
  readonly mainFrame = {}
  readonly events: Array<{ channel: string; value: unknown }> = []
  isDestroyed(): boolean { return false }
  send(channel: string, value: unknown): void { this.events.push({ channel, value }) }
  get sender(): WebContents { return this as unknown as WebContents }
  event(iframe = false): IpcMainInvokeEvent {
    return { sender: this.sender, senderFrame: iframe ? {} : this.mainFrame } as unknown as IpcMainInvokeEvent
  }
}
class Registrar implements AppServerAgentIpcRegistrar {
  readonly handlers = new Map<string, Handler>()
  handle(channel: string, listener: Handler): void {
    if (this.handlers.has(channel)) throw new Error('夹具通道已注册')
    this.handlers.set(channel, listener)
  }
  removeHandler(channel: string): void { this.handlers.delete(channel) }
  async invoke(channel: string, event: IpcMainInvokeEvent, ...args: unknown[]): Promise<unknown> {
    const handler = this.handlers.get(channel)
    if (!handler) throw new Error('夹具无此通道')
    return await handler(event, ...args)
  }
}
const cleanups: Array<() => void | Promise<void>> = []
afterEach(async () => { for (const cleanup of cleanups.splice(0).reverse()) await cleanup() })

function open() {
  const upstream = new PassThrough(), downstream = new PassThrough()
  const parent = new JsonRpcPeer(downstream, upstream), child = new JsonRpcPeer(upstream, downstream)
  const main = new Surface(), quick = new Surface(), unknown = new Surface(), calls: Call[] = []
  const signals = new Map<string, AbortController>(), kinds: AppServerClientKind[] = []
  const backend: AppServerAgentIpcOptions['backend'] = {
    readyPeer: () => parent,
    request: async (clientId, method, input, options = {}) => {
      calls.push({ clientId, method, input, options })
      return null
    },
  }
  const clients = new AppServerWindowClients({
    kindOf: (sender) => sender === main.sender ? 'main' : sender === quick.sender ? 'quick' : undefined,
    backend: {
      registerClient: async (kind) => {
        kinds.push(kind)
        const clientId = `owner-${kinds.length}`
        signals.set(clientId, new AbortController())
        return { kind, clientId }
      },
      getClientSignal: (clientId) => signals.get(clientId)?.signal,
      detachClient: async (clientId) => { signals.get(clientId)?.abort(); return signals.delete(clientId) },
    },
  })
  const replies: Array<{ sender: WebContents; kind: string; response: unknown }> = []
  const interactions = {
    respondPermission: (sender: WebContents, response: unknown) => { replies.push({ sender, kind: 'permission', response }); return false },
    respondAskUser: (sender: WebContents, response: unknown) => { replies.push({ sender, kind: 'ask', response }); return true },
  }
  const ipc = new Registrar(), dispose = registerAppServerAgentIpcHandlers(ipc, { backend, clients, interactions })
  registerQuickChatWindowOwner(quick.id, { id: 'binding', accelerator: 'CommandOrControl+Shift+A', sessionType: 'agent', sessionId: 'bound-session' })
  cleanups.push(() => {
    dispose(); clients.dispose(); parent.close(); child.close(); upstream.destroy(); downstream.destroy(); unregisterQuickChatWindowOwner(quick.id)
  })
  return { ipc, main, quick, unknown, calls, clients, backend, child, parent, dispose, kinds, replies, interactions }
}

describe('独立后端 Agent IPC 固定代理', () => {
  test('只注册现行 Agent 命令；逐项固定编码方法、参数和长请求期限，不开放通用/私有 RPC', async () => {
    const f = open()
    expect([...f.ipc.handlers.keys()].sort()).toEqual(Object.values(channels).filter((channel) => channel !== channels.EVENT && channel !== channels.QUEUE_EVENT && channel !== channels.RUN_EVENT).sort())
    expect(f.ipc.handlers.has('axon/host/credential/decrypt')).toBe(false)
    const cases: Array<{ channel: string; args: unknown[]; method: Method; input?: RpcJsonValue; long?: boolean }> = [
      { channel: channels.LIST_SESSIONS, args: [], method: methods.AGENT_LIST_SESSIONS },
      { channel: channels.LIST_ACTIVE_RUNS, args: [], method: methods.AGENT_LIST_ACTIVE_RUNS },
      { channel: channels.GET_OWNED_RUN, args: ['session'], method: methods.AGENT_GET_RUN, input: 'session' },
      { channel: channels.GET_SESSION, args: ['session'], method: methods.AGENT_GET_SESSION, input: 'session' },
      { channel: channels.CREATE_SESSION, args: [], method: methods.AGENT_CREATE_SESSION, input: {}, long: true },
      { channel: channels.UPDATE_SESSION, args: ['session', { title: '标题' }], method: methods.AGENT_UPDATE_SESSION, input: { sessionId: 'session', update: { title: '标题' } } },
      { channel: channels.DELETE_SESSION, args: ['session'], method: methods.AGENT_DELETE_SESSION, input: 'session' },
      { channel: channels.GET_REASONING_CAPABILITY, args: ['session'], method: methods.AGENT_GET_REASONING_CAPABILITY, input: 'session', long: true },
      { channel: channels.CHECK_ENVIRONMENT, args: [], method: methods.AGENT_CHECK_ENVIRONMENT, input: {}, long: true },
      { channel: channels.IS_ACTIVE, args: ['session'], method: methods.AGENT_IS_ACTIVE, input: 'session' },
      { channel: channels.SEND, args: [{ sessionId: 'session', text: 'hi' }], method: methods.AGENT_SEND, input: { sessionId: 'session', text: 'hi' }, long: true },
      { channel: channels.STOP, args: [{ sessionId: 'session', runId: 'actual-run' }], method: methods.AGENT_STOP, input: { sessionId: 'session', runId: 'actual-run' } },
      { channel: channels.LIST_QUEUED_MESSAGES, args: ['session'], method: methods.AGENT_LIST_QUEUE, input: 'session' },
      { channel: channels.CANCEL_QUEUED_MESSAGE, args: [{ sessionId: 'session', messageId: 'message' }], method: methods.AGENT_CANCEL_QUEUE, input: { sessionId: 'session', messageId: 'message' } },
      { channel: channels.MOVE_QUEUED_MESSAGE, args: [{ sessionId: 'session', sourceId: 'a', targetId: 'b', placement: 'before' }], method: methods.AGENT_MOVE_QUEUE, input: { sessionId: 'session', sourceId: 'a', targetId: 'b', placement: 'before' } },
    ]
    for (const item of cases) {
      const result = await f.ipc.invoke(item.channel, f.main.event(), ...item.args)
      expect(f.calls.at(-1)).toMatchObject({ clientId: 'owner-1', method: item.method, input: item.input })
      expect(f.calls.at(-1)?.options.signal?.aborted).toBe(false)
      expect(f.calls.at(-1)?.options.timeoutMs).toBe(item.long ? 0 : undefined)
      expect(result).toBe(item.channel === channels.GET_REASONING_CAPABILITY ? undefined : null)
    }
    expect(f.kinds).toEqual(['main'])
  })

  test('所有通道先检查主 frame；参数/非 JSON 错误不登记，未知窗口无请求权限', async () => {
    const f = open()
    for (const channel of f.ipc.handlers.keys()) await expect(f.ipc.invoke(channel, f.main.event(true))).rejects.toThrow('子框架')
    await expect(f.ipc.invoke(channels.LIST_SESSIONS, f.main.event(), { method: 'private', clientId: 'forged' })).rejects.toThrow('数量')
    await expect(f.ipc.invoke(channels.GET_SESSION, f.main.event(), ' ')).rejects.toThrow('标识')
    await expect(f.ipc.invoke(channels.CREATE_SESSION, f.main.event(), { fn: () => {} })).rejects.toThrow('不能传输')
    await expect(f.ipc.invoke(channels.LIST_SESSIONS, f.unknown.event())).rejects.toThrow('已登记')
    expect(f.kinds).toEqual([])
    expect(f.calls).toEqual([])
  })

  test('浮窗只向真实绑定 Agent 会话发送，来源用服务登记 ID，不接受输入自报身份', async () => {
    const f = open()
    await expect(f.ipc.invoke(channels.SEND, f.quick.event(), { sessionId: 'other', text: 'hi' })).rejects.toThrow('其他会话')
    expect(f.kinds).toEqual([])
    await f.ipc.invoke(channels.SEND, f.quick.event(), { sessionId: 'bound-session', text: 'hi' })
    await f.ipc.invoke(channels.SEND, f.main.event(), { sessionId: 'session', text: 'hi' })
    expect(f.kinds).toEqual(['quick', 'main'])
    expect(f.calls.map((call) => call.clientId)).toEqual(['owner-1', 'owner-2'])
    expect(f.calls[0]?.input).toEqual({ sessionId: 'bound-session', text: 'hi' })
    registerQuickChatWindowOwner(f.quick.id, { id: 'binding', accelerator: 'CommandOrControl+Shift+A', sessionType: 'chat', sessionId: 'bound-session' })
    await expect(f.ipc.invoke(channels.SEND, f.quick.event(), { sessionId: 'bound-session', text: 'hi' })).rejects.toThrow('其他会话')
    expect(f.calls).toHaveLength(2)
  })

  test('停止只转交完整真实目标，不查询最新运行或把旧会话标识升级为新轮次', async () => {
    const f = open()
    for (const invalid of ['session', { sessionId: 'session' }, { sessionId: 'session', runId: ' ' },
      { sessionId: 'session', runId: 'actual', clientId: 'forged' }]) {
      await expect(f.ipc.invoke(channels.STOP, f.main.event(), invalid)).rejects.toThrow()
    }
    expect(f.calls).toEqual([])
    expect(f.kinds).toEqual([])
    await f.ipc.invoke(channels.STOP, f.main.event(), { sessionId: 'session', runId: 'captured-old-run' })
    expect(f.calls.map((call) => call.method)).toEqual([methods.AGENT_STOP])
    expect(f.calls[0]?.input).toEqual({ sessionId: 'session', runId: 'captured-old-run' })
  })

  test('审批/追问答复仅进反向桥，不临时登记 owner 或走通用业务请求', async () => {
    const f = open(), permission = { requestId: 'permission', behavior: 'allow' }, ask = { requestId: 'ask', behavior: 'cancel' }
    expect(await f.ipc.invoke(channels.PERMISSION_RESPOND, f.main.event(), permission)).toBe(false)
    expect(await f.ipc.invoke(channels.ASK_USER_RESPOND, f.quick.event(), ask)).toBe(true)
    expect(f.replies).toEqual([{ sender: f.main.sender, kind: 'permission', response: permission }, { sender: f.quick.sender, kind: 'ask', response: ask }])
    expect(f.calls).toEqual([])
    expect(f.kinds).toEqual([])
  })

  test('历史先登记后分页完整汇聚，保留摘要/附加字段，不传文件路径；完成有界释放快照', async () => {
    const f = open(), reads: RpcJsonObject[] = [], closes: RpcJsonObject[] = []
    f.child.handle(methods.HISTORY_READ, (params) => {
      const data = params as RpcJsonObject; reads.push(data)
      expect(f.kinds).toEqual(['main'])
      const input = data.input as RpcJsonObject
      return input.cursor ? { historyId: 'snapshot', messages: [{ type: 'system', uuid: 'summary', subtype: 'compact_boundary', summary: '压缩摘要', extra: { keep: true } }], cursor: null }
        : { historyId: 'snapshot', messages: [{ type: 'user', uuid: 'user', message: { content: '原文' } }], cursor: 'next' }
    })
    f.child.handle(methods.HISTORY_CLOSE, (params) => { closes.push(params as RpcJsonObject); return true })
    expect(await f.ipc.invoke(channels.GET_MESSAGES, f.main.event(), 'session')).toEqual([
      { type: 'user', uuid: 'user', message: { content: '原文' } },
      { type: 'system', uuid: 'summary', subtype: 'compact_boundary', summary: '压缩摘要', extra: { keep: true } },
    ])
    expect(reads).toEqual([{ clientId: 'owner-1', input: { scope: { kind: 'agent', sessionId: 'session' } } },
      { clientId: 'owner-1', input: { scope: { kind: 'agent', sessionId: 'session' }, historyId: 'snapshot', cursor: 'next' } }])
    expect(closes).toEqual([{ clientId: 'owner-1', input: 'snapshot' }])
    expect(f.calls).toEqual([])
  })

  test('第二页失败或读取中页面重载不返回半份历史，不重投，仍尝试清理原快照', async () => {
    for (const canceled of [false, true]) {
      const f = open(), entered = Promise.withResolvers<void>(), gate = Promise.withResolvers<RpcJsonValue>()
      let reads = 0, closes = 0
      f.child.handle(methods.HISTORY_READ, async (params) => {
        reads += 1
        if ((params as RpcJsonObject).clientId !== 'owner-1') throw new Error('错误 owner')
        if (reads === 1) return { historyId: 'snapshot', messages: [{ type: 'user', uuid: 'first' }], cursor: 'next' }
        entered.resolve()
        if (!canceled) throw new RpcFault(-32029, '读取失败')
        return await gate.promise
      })
      f.child.handle(methods.HISTORY_CLOSE, () => { closes += 1; return true })
      const result = f.ipc.invoke(channels.GET_MESSAGES, f.main.event(), 'session').then(() => null, (error: unknown) => error)
      await entered.promise
      if (canceled) f.main.emit('did-start-loading')
      expect(await result).toMatchObject(canceled ? { code: 'canceled' } : { code: -32029 })
      gate.resolve({ historyId: 'snapshot', messages: [{ type: 'assistant', uuid: 'late' }], cursor: null })
      expect(reads).toBe(2)
      expect(closes).toBe(1)
    }
  })

  test('释放取消代理等待，迟到登记不启动命令；半注册失败只清理自身通道，重复释放幂等', async () => {
    const f = open(), gate = Promise.withResolvers<void>(), ipc = new Registrar()
    const dispose = registerAppServerAgentIpcHandlers(ipc, { backend: f.backend, clients: {
      get: async (sender) => { await gate.promise; return await f.clients.get(sender) },
      getClientSignal: (clientId) => f.clients.getClientSignal(clientId),
    }, interactions: f.interactions })
    const handler = ipc.handlers.get(channels.LIST_SESSIONS)!
    const pending = ipc.invoke(channels.LIST_SESSIONS, f.main.event()).catch((error: unknown) => error)
    dispose(); dispose(); gate.resolve()
    expect(await pending).toMatchObject({ name: 'AbortError' })
    expect(ipc.handlers.size).toBe(0)
    expect(f.calls).toEqual([])
    expect(() => handler(f.main.event())).toThrow()
    const original = ipc.handlers.size
    ipc.handle(channels.GET_SESSION, () => 'existing')
    expect(() => registerAppServerAgentIpcHandlers(ipc, { backend: f.backend, clients: f.clients, interactions: f.interactions })).toThrow('已注册')
    expect(ipc.handlers.size).toBe(original + 1)
    expect(await ipc.invoke(channels.GET_SESSION, f.main.event())).toBe('existing')
  })

  test('在途长请求合并代理生命周期信号；释放只撤销等待，不猜测执行状态或自动重发/停止', async () => {
    const f = open(), entered = Promise.withResolvers<AbortSignal>()
    f.backend.request = (clientId, method, input, options = {}) => {
      f.calls.push({ clientId, method, input, options })
      const signal = options.signal!
      entered.resolve(signal)
      const waiting = Promise.withResolvers<RpcJsonValue>()
      signal.addEventListener('abort', () => waiting.reject(new DOMException('请求等待已取消', 'AbortError')), { once: true })
      return waiting.promise
    }
    const pending = f.ipc.invoke(channels.SEND, f.main.event(), { sessionId: 'session', text: 'hi' }).catch((error: unknown) => error)
    const signal = await entered.promise
    expect(signal.aborted).toBe(false)
    f.dispose()
    expect(await pending).toMatchObject({ name: 'AbortError' })
    expect(signal.aborted).toBe(true)
    expect(f.calls.map((call) => call.method)).toEqual([methods.AGENT_SEND])
    expect(f.clients.find('owner-1')).toBe(f.main.sender)
  })

  test('真正完整 app-server 子进程：代理 CRUD、能力、历史与入口重载，不使用正式数据', async () => {
    const directory = mkdtempSync(join(tmpdir(), 'axon-agent-ipc-'))
    const main = new Surface(), quick = new Surface(), ipc = new Registrar()
    let clients!: AppServerWindowClients, bridge!: AppServerEvents
    const backend = new AppServerProcess({
      launch: { executable: process.execPath, entryArgs: [join(import.meta.dir, '../../../../app-server/src/main.ts')],
        dataDir: join(directory, 'data'), homeDir: directory, applicationVersion: '0.1.3', environment: { ...process.env, AXON_ZIMA_PYTHON: '' } },
      credentialCodec: createCredentialCodec(), configurePeer: (peer) => { bridge = new AppServerEvents(peer, { clients }) }, stopTimeoutMs: 100,
    })
    clients = new AppServerWindowClients({ backend, kindOf: (sender) => sender === main.sender ? 'main' : sender === quick.sender ? 'quick' : undefined })
    const dispose = registerAppServerAgentIpcHandlers(ipc, { backend, clients, interactions: {
      respondPermission: (sender, response) => bridge.respondPermission(sender, response),
      respondAskUser: (sender, response) => bridge.respondAskUser(sender, response),
    } })
    cleanups.push(async () => { dispose(); bridge?.dispose(); clients.dispose(); await backend.stop(); rmSync(directory, { recursive: true, force: true }) })
    expect(await ipc.invoke(channels.LIST_SESSIONS, main.event())).toEqual([])
    expect(backend.pid).not.toBe(process.pid)
    const owner = await clients.get(main.sender)
    const project = await backend.request(owner.clientId, methods.PROJECT_CREATE, { name: '隔离项目' }) as RpcJsonObject
    const session = await ipc.invoke(channels.CREATE_SESSION, main.event(), { projectId: project.id, title: '代理会话' }) as RpcJsonObject
    expect(await ipc.invoke(channels.UPDATE_SESSION, main.event(), session.id, { title: '新标题' })).toMatchObject({ title: '新标题' })
    expect(await ipc.invoke(channels.GET_SESSION, quick.event(), session.id)).toMatchObject({ title: '新标题' })
    expect(await ipc.invoke(channels.GET_MESSAGES, main.event(), session.id)).toEqual([])
    expect(await ipc.invoke(channels.LIST_ACTIVE_RUNS, quick.event())).toEqual([])
    expect(await ipc.invoke(channels.IS_ACTIVE, quick.event(), session.id)).toBe(false)
    expect(await ipc.invoke(channels.GET_REASONING_CAPABILITY, main.event(), session.id)).toBeUndefined()
    expect(await ipc.invoke(channels.STOP, quick.event(), { sessionId: session.id, runId: 'nonexistent' })).toBe(false)
    main.emit('did-start-loading')
    expect(await ipc.invoke(channels.GET_SESSION, main.event(), session.id)).toMatchObject({ title: '新标题' })
    expect((await clients.get(main.sender)).clientId).not.toBe(owner.clientId)
    expect(await ipc.invoke(channels.DELETE_SESSION, main.event(), session.id)).toMatchObject({ id: session.id })
    expect(await ipc.invoke(channels.GET_SESSION, main.event(), session.id)).toBeNull()
  })
})
