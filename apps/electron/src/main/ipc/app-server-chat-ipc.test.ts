import { afterEach, describe, expect, test } from 'bun:test'
import { EventEmitter } from 'node:events'
import { mkdtempSync, rmSync, readFileSync, existsSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { PassThrough } from 'node:stream'
import type { IpcMainInvokeEvent, WebContents } from 'electron'
import { createCredentialCodec } from '@axon/core'
import { JsonRpcPeer, RpcFault } from '@axon/app-server'
import type { RpcRequestOptions } from '@axon/app-server'
import { CHAT_IPC_CHANNELS as channels, ATTACHMENTS_IPC_CHANNELS as attachments, APP_SERVER_METHODS as methods } from '@axon/shared'
import type { AppServerClientKind, RpcJsonObject, RpcJsonValue, AttachmentSaveResult } from '@axon/shared'
import { AppServerProcess } from '../lib/desktop/app-server-process'
import { AppServerEvents } from '../lib/desktop/app-server-events'
import { AppServerWindowClients } from '../lib/desktop/app-server-window-clients'
import { registerQuickChatWindowOwner, unregisterQuickChatWindowOwner } from '../lib/desktop/quick-chat-window-owner'
import { registerAppServerChatIpcHandlers } from './app-server-chat-ipc'
import type { AppServerChatIpcOptions, AppServerChatIpcRegistrar } from './app-server-chat-ipc'

type Handler = Parameters<AppServerChatIpcRegistrar['handle']>[1]
type Method = Parameters<AppServerProcess['request']>[1]
interface Call { clientId: string; method: Method; input?: RpcJsonValue; options: RpcRequestOptions }
let nextId = 11000
class Surface extends EventEmitter {
  readonly id = ++nextId
  readonly mainFrame = {}
  isDestroyed(): boolean { return false }
  send(): void {}
  get sender(): WebContents { return this as unknown as WebContents }
  event(iframe = false): IpcMainInvokeEvent {
    return { sender: this.sender, senderFrame: iframe ? {} : this.mainFrame } as unknown as IpcMainInvokeEvent
  }
}
class Registrar implements AppServerChatIpcRegistrar {
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
  const backend: AppServerChatIpcOptions['backend'] = {
    readyPeer: () => parent,
    request: async (clientId, method, input, options = {}) => { calls.push({ clientId, method, input, options }); return null },
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
      getClientSignal: (id) => signals.get(id)?.signal,
      detachClient: async (id) => { signals.get(id)?.abort(); return signals.delete(id) },
    },
  })
  const ipc = new Registrar(), dispose = registerAppServerChatIpcHandlers(ipc, { backend, clients })
  registerQuickChatWindowOwner(quick.id, { id: 'binding', accelerator: 'CommandOrControl+Shift+A', sessionType: 'chat', sessionId: 'bound' })
  cleanups.push(() => {
    dispose(); clients.dispose(); parent.close(); child.close(); upstream.destroy(); downstream.destroy(); unregisterQuickChatWindowOwner(quick.id)
  })
  return { ipc, main, quick, unknown, calls, kinds, clients, backend, child, dispose }
}

describe('独立后端 Chat/附件固定 IPC 代理', () => {
  test('仅注册固定 Chat 与附件保存方法；保留 DTO 和返回值，发送/附件不套通用短期限', async () => {
    const f = open()
    expect([...f.ipc.handlers.keys()].sort()).toEqual([...Object.values(channels).filter((item) => item !== channels.EVENT && item !== channels.GENERATION_EVENT), attachments.SAVE].sort())
    const cases: Array<{ channel: string; args: unknown[]; method: Method; input?: RpcJsonValue; long?: boolean }> = [
      { channel: channels.LIST_CONVERSATIONS, args: [], method: methods.CHAT_LIST_CONVERSATIONS },
      { channel: channels.GET_CONVERSATION, args: [' chat '], method: methods.CHAT_GET_CONVERSATION, input: 'chat' },
      { channel: channels.GET_OWNED_GENERATION, args: ['chat'], method: methods.CHAT_GET_GENERATION, input: 'chat' },
      { channel: channels.CREATE_CONVERSATION, args: [], method: methods.CHAT_CREATE_CONVERSATION, input: {} },
      { channel: channels.UPDATE_CONVERSATION, args: ['chat', { title: '新标题', channelId: null }], method: methods.CHAT_UPDATE_CONVERSATION, input: { conversationId: 'chat', update: { title: '新标题', channelId: null } } },
      { channel: channels.DELETE_CONVERSATION, args: ['chat'], method: methods.CHAT_DELETE_CONVERSATION, input: 'chat' },
      { channel: channels.SEND, args: [{ conversationId: 'chat', text: 'hi', temperature: 0.2 }], method: methods.CHAT_SEND, input: { conversationId: 'chat', text: 'hi', temperature: 0.2 }, long: true },
      { channel: channels.STOP, args: [{ conversationId: 'chat', generationId: 'actual' }], method: methods.CHAT_STOP, input: { conversationId: 'chat', generationId: 'actual' } },
      { channel: attachments.SAVE, args: [{ conversationId: 'chat', filename: '示例.txt', mediaType: 'text/plain', data: 'YWJj' }], method: methods.ATTACHMENT_SAVE, input: { conversationId: 'chat', filename: '示例.txt', mediaType: 'text/plain', data: 'YWJj' }, long: true },
    ]
    for (const item of cases) {
      expect(await f.ipc.invoke(item.channel, f.main.event(), ...item.args)).toBeNull()
      expect(f.calls.at(-1)).toMatchObject({ clientId: 'owner-1', method: item.method, input: item.input })
      expect(f.calls.at(-1)?.options.timeoutMs).toBe(item.long ? 0 : undefined)
      expect(f.calls.at(-1)?.options.signal?.aborted).toBe(false)
    }
    expect(f.kinds).toEqual(['main'])
    expect(f.ipc.handlers.has('axon/host/credential/decrypt')).toBe(false)
  })

  test('iframe、错参数和非 JSON 值在登记前拒绝；未知来源无请求权限', async () => {
    const f = open()
    for (const channel of f.ipc.handlers.keys()) await expect(f.ipc.invoke(channel, f.main.event(true))).rejects.toThrow('子框架')
    await expect(f.ipc.invoke(channels.LIST_CONVERSATIONS, f.main.event(), 'forged')).rejects.toThrow('数量')
    await expect(f.ipc.invoke(channels.GET_MESSAGES, f.main.event(), ' ')).rejects.toThrow('标识')
    await expect(f.ipc.invoke(attachments.SAVE, f.main.event(), { data: () => {} })).rejects.toThrow('不能传输')
    await expect(f.ipc.invoke(channels.LIST_CONVERSATIONS, f.unknown.event())).rejects.toThrow('已登记')
    expect(f.kinds).toEqual([])
    expect(f.calls).toEqual([])
  })

  test('浮窗只向原生绑定 Chat 发送；停止只提交捕获的完整目标，绝不查询最新轮次', async () => {
    const f = open()
    await expect(f.ipc.invoke(channels.SEND, f.quick.event(), { conversationId: 'other', text: 'hi' })).rejects.toThrow('其他会话')
    registerQuickChatWindowOwner(f.quick.id, { id: 'binding', accelerator: 'CommandOrControl+Shift+A', sessionType: 'agent', sessionId: 'bound' })
    await expect(f.ipc.invoke(channels.SEND, f.quick.event(), { conversationId: 'bound', text: 'hi' })).rejects.toThrow('其他会话')
    for (const input of ['chat', { conversationId: 'chat' }, { conversationId: 'chat', generationId: '' }, { conversationId: 'chat', generationId: 'old', owner: 'forged' }]) {
      await expect(f.ipc.invoke(channels.STOP, f.main.event(), input)).rejects.toThrow()
    }
    expect(f.kinds).toEqual([])
    registerQuickChatWindowOwner(f.quick.id, { id: 'binding', accelerator: 'CommandOrControl+Shift+A', sessionType: 'chat', sessionId: 'bound' })
    await f.ipc.invoke(channels.SEND, f.quick.event(), { conversationId: 'bound', text: 'hi' })
    await f.ipc.invoke(channels.STOP, f.main.event(), { conversationId: 'chat', generationId: 'captured-old' })
    expect(f.calls.map((item) => item.method)).toEqual([methods.CHAT_SEND, methods.CHAT_STOP])
    expect(f.calls[0]?.input).toEqual({ conversationId: 'bound', text: 'hi' })
    expect(f.calls[1]?.input).toEqual({ conversationId: 'chat', generationId: 'captured-old' })
    expect(f.kinds).toEqual(['quick', 'main'])
  })

  test('历史登记后读到末页并清理；正文/附件元数据完整保留，不传路径或 Runtime 标识', async () => {
    const f = open(), reads: RpcJsonObject[] = []
    let closed = 0
    const message = { id: 'user', role: 'user', content: [{ type: 'text', text: '原文' }], attachments: [{ localPath: 'chat/附件.txt', filename: '附件.txt' }] }
    f.child.handle(methods.HISTORY_READ, (params) => {
      expect(f.kinds).toEqual(['main'])
      const data = params as RpcJsonObject; reads.push(data)
      return (data.input as RpcJsonObject).cursor
        ? { historyId: 'snapshot', messages: [{ id: 'assistant', role: 'assistant', content: [{ type: 'text', text: '完整回复' }] }], cursor: null }
        : { historyId: 'snapshot', messages: [message], cursor: 'next' }
    })
    f.child.handle(methods.HISTORY_CLOSE, (params) => { expect(params).toEqual({ clientId: 'owner-1', input: 'snapshot' }); closed += 1; return true })
    const result = await f.ipc.invoke(channels.GET_MESSAGES, f.main.event(), 'chat')
    expect(result).toEqual([message, { id: 'assistant', role: 'assistant', content: [{ type: 'text', text: '完整回复' }] }])
    expect(reads).toEqual([
      { clientId: 'owner-1', input: { scope: { kind: 'chat', conversationId: 'chat' } } },
      { clientId: 'owner-1', input: { scope: { kind: 'chat', conversationId: 'chat' }, historyId: 'snapshot', cursor: 'next' } },
    ])
    expect(closed).toBe(1)
  })

  test('续页失败/页面重载/代理释放都不交付半份历史，不重投，并关闭已知快照', async () => {
    for (const mode of ['error', 'reload', 'dispose']) {
      const f = open(), entered = Promise.withResolvers<void>(), gate = Promise.withResolvers<RpcJsonValue>()
      let reads = 0, closes = 0
      f.child.handle(methods.HISTORY_READ, async () => {
        reads += 1
        if (reads === 1) return { historyId: 'snapshot', messages: [{ id: 'first', role: 'user' }], cursor: 'next' }
        entered.resolve()
        if (mode === 'error') throw new RpcFault(-32029, '读取失败')
        return await gate.promise
      })
      f.child.handle(methods.HISTORY_CLOSE, () => { closes += 1; return true })
      const pending = f.ipc.invoke(channels.GET_MESSAGES, f.main.event(), 'chat').catch((error: unknown) => error)
      await entered.promise
      if (mode === 'reload') f.main.emit('did-start-loading')
      if (mode === 'dispose') f.dispose()
      expect(await pending).toMatchObject(mode === 'error' ? { code: -32029 } : { code: 'canceled' })
      gate.resolve({ historyId: 'snapshot', messages: [{ id: 'late' }], cursor: null })
      expect(reads).toBe(2)
      expect(closes).toBe(1)
      expect(f.calls).toEqual([])
    }
  })

  test('释放取消长请求等待但不停止/重发；迟到登记不启动命令，部分注册失败不删除已有通道', async () => {
    const f = open(), entered = Promise.withResolvers<AbortSignal>()
    f.backend.request = (clientId, method, input, options = {}) => {
      f.calls.push({ clientId, method, input, options })
      const signal = options.signal!, waiting = Promise.withResolvers<RpcJsonValue>()
      entered.resolve(signal)
      signal.addEventListener('abort', () => waiting.reject(new DOMException('已取消', 'AbortError')), { once: true })
      return waiting.promise
    }
    const pending = f.ipc.invoke(channels.SEND, f.main.event(), { conversationId: 'chat', text: 'hi' }).catch((error: unknown) => error)
    const signal = await entered.promise
    f.dispose(); f.dispose()
    expect(await pending).toMatchObject({ name: 'AbortError' })
    expect(signal.aborted).toBe(true)
    expect(f.calls.map((item) => item.method)).toEqual([methods.CHAT_SEND])
    expect(f.clients.find('owner-1')).toBe(f.main.sender)
    const gate = Promise.withResolvers<void>(), ipc = new Registrar()
    const release = registerAppServerChatIpcHandlers(ipc, { backend: f.backend, clients: {
      get: async (sender) => { await gate.promise; return await f.clients.get(sender) },
      getClientSignal: (id) => f.clients.getClientSignal(id),
    } })
    const late = ipc.invoke(channels.LIST_CONVERSATIONS, f.main.event()).catch((error: unknown) => error)
    release(); gate.resolve()
    expect(await late).toMatchObject({ name: 'AbortError' })
    expect(ipc.handlers.size).toBe(0)
    expect(f.calls).toHaveLength(1)
    ipc.handle(channels.GET_CONVERSATION, () => 'existing')
    expect(() => registerAppServerChatIpcHandlers(ipc, { backend: f.backend, clients: f.clients })).toThrow('已注册')
    expect(ipc.handlers.size).toBe(1)
    expect(await ipc.invoke(channels.GET_CONVERSATION, f.main.event())).toBe('existing')
  })

  test('真正完整子进程：Chat CRUD、完整历史、附件落盘/级联清理与重载归属', async () => {
    const directory = mkdtempSync(join(tmpdir(), 'axon-chat-ipc-'))
    const main = new Surface(), quick = new Surface(), ipc = new Registrar()
    let clients!: AppServerWindowClients, bridge!: AppServerEvents
    const backend = new AppServerProcess({
      launch: { executable: process.execPath, entryArgs: [join(import.meta.dir, '../../../../app-server/src/main.ts')],
        dataDir: join(directory, 'data'), homeDir: directory, applicationVersion: '0.1.3', environment: { ...process.env, AXON_ZIMA_PYTHON: '' } },
      credentialCodec: createCredentialCodec(), configurePeer: (peer) => { bridge = new AppServerEvents(peer, { clients }) }, stopTimeoutMs: 100,
    })
    clients = new AppServerWindowClients({ backend, kindOf: (sender) => sender === main.sender ? 'main' : sender === quick.sender ? 'quick' : undefined })
    const dispose = registerAppServerChatIpcHandlers(ipc, { backend, clients })
    cleanups.push(async () => { dispose(); bridge?.dispose(); clients.dispose(); await backend.stop(); rmSync(directory, { recursive: true, force: true }) })
    expect(await ipc.invoke(channels.LIST_CONVERSATIONS, main.event())).toEqual([])
    expect(backend.pid).not.toBe(process.pid)
    const conversation = await ipc.invoke(channels.CREATE_CONVERSATION, main.event(), { title: '代理对话' }) as RpcJsonObject
    const owner = await clients.get(main.sender)
    expect(await ipc.invoke(channels.UPDATE_CONVERSATION, main.event(), conversation.id, { title: '新标题' })).toMatchObject({ title: '新标题' })
    expect(await ipc.invoke(channels.GET_CONVERSATION, quick.event(), conversation.id)).toMatchObject({ title: '新标题' })
    expect(await ipc.invoke(channels.GET_MESSAGES, main.event(), conversation.id)).toEqual([])
    const bytes = Buffer.from('附件正文\n特殊字符：中文与 Ω')
    const saved = await ipc.invoke(attachments.SAVE, main.event(), { conversationId: conversation.id, filename: '示例.txt', mediaType: 'text/plain', data: bytes.toString('base64') }) as AttachmentSaveResult
    expect(saved.success).toBe(true)
    if (!saved.success) throw new Error('夹具附件保存失败')
    const path = join(directory, 'data', 'attachments', saved.attachment.localPath)
    expect(readFileSync(path)).toEqual(bytes)
    expect(saved.attachment.size).toBe(bytes.length)
    expect(await ipc.invoke(attachments.SAVE, main.event(), { conversationId: '../escape', filename: 'x', mediaType: 'text/plain', data: 'YWJj' })).toMatchObject({ success: false, code: 'invalid_input' })
    expect(await ipc.invoke(channels.STOP, quick.event(), { conversationId: conversation.id, generationId: 'nonexistent' })).toBe(false)
    expect(await ipc.invoke(channels.SEND, main.event(), { conversationId: conversation.id, text: 'hi', owner: 'forged' })).toMatchObject({ success: false, code: 'invalid_input' })
    main.emit('did-start-loading')
    expect(await ipc.invoke(channels.GET_CONVERSATION, main.event(), conversation.id)).toMatchObject({ title: '新标题' })
    expect((await clients.get(main.sender)).clientId).not.toBe(owner.clientId)
    await ipc.invoke(channels.DELETE_CONVERSATION, main.event(), conversation.id)
    expect(await ipc.invoke(channels.GET_CONVERSATION, main.event(), conversation.id)).toBeNull()
    expect(existsSync(path)).toBe(false)
  })
})
