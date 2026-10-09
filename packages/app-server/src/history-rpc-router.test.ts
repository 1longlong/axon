import { afterEach, describe, expect, spyOn, test } from 'bun:test'
import { mkdirSync, mkdtempSync, readFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { PassThrough } from 'node:stream'
import { createBackend, createBackendPaths, createCredentialCodec, MessageHistoryController, writeTextFileAtomic } from '@axon/core'
import type { AxonBackend } from '@axon/core'
import { APP_SERVER_METHODS as methods, APP_SERVER_RPC_OPTIONS } from '@axon/shared'
import type { AppServerClient, ChatMessage, MessageHistoryPage, MessageHistoryScope, RpcJsonValue, SDKMessage } from '@axon/shared'
import { AppServerConnection, AppServerHistoryClient, JsonRpcPeer } from './index'
import { toWireValue } from './wire-value'

const cleanups: Array<() => void> = []
afterEach(() => { for (const cleanup of cleanups.splice(0).reverse()) cleanup() })

/** 实际应用 JSONL 与双端协议；不加载 Runtime SDK，也不读取正式数据目录。 */
async function open() {
  const directory = mkdtempSync(join(tmpdir(), 'axon-history-rpc-'))
  const upstream = new PassThrough(), downstream = new PassThrough()
  const parent = new JsonRpcPeer(downstream, upstream, { ...APP_SERVER_RPC_OPTIONS, requestTimeoutMs: 2_000 })
  const child = new JsonRpcPeer(upstream, downstream, { ...APP_SERVER_RPC_OPTIONS, requestTimeoutMs: 2_000 })
  let backend: AxonBackend
  const connection = new AppServerConnection({ peer: child, bootstrap: () => {
    backend = createBackend({ paths: createBackendPaths({ dataDir: join(directory, 'data'), homeDir: directory }),
      applicationVersion: '0.1.3', credentialCodec: createCredentialCodec(),
      resolveAdapter: () => ({ async *query() { throw new Error('历史查询不应启动模型') }, abort() {}, dispose() {}, async drain() {} }) })
    return { backend, applicationVersion: '0.1.3', capabilities: { runtimes: [], credentialStorage: 'unavailable', channelTargetConfirmation: false } }
  } })
  cleanups.push(() => { connection.close(); parent.close(); upstream.destroy(); downstream.destroy(); rmSync(directory, { recursive: true, force: true }) })
  await parent.request(methods.INITIALIZE, { protocolVersion: 1, client: { name: 'axon-history-fixture', version: '0.1.3' },
    hostCapabilities: { credentialStorage: 'unavailable', channelTargetConfirmation: false } })
  const main = await parent.request(methods.REGISTER_CLIENT, { kind: 'main' }) as unknown as AppServerClient
  const quick = await parent.request(methods.REGISTER_CLIENT, { kind: 'quick' }) as unknown as AppServerClient
  const root = backend!.sessions.create({ title: '历史会话' }), otherRoot = backend!.sessions.create({ title: '其他根' })
  const childSession = backend!.sessions.create({ parentSessionId: root.id, rootSessionId: root.id, parentToolUseId: 'delegate', subagentType: 'coder' })
  const task = backend!.tasks.create({ rootSessionId: root.id, parentSessionId: root.id, childSessionId: childSession.id,
    parentToolUseId: 'delegate', title: '子任务', objective: '查询', subagentType: 'coder', runInBackground: false, depth: 1 })
  const chat = backend!.conversations.create()
  const request = (method: string, input?: RpcJsonValue, client = main, signal?: AbortSignal) => parent.request(method,
    { clientId: client.clientId, ...(input === undefined ? {} : { input }) }, { signal })
  const read = async (scope: MessageHistoryScope, previous?: MessageHistoryPage, client = main) =>
    await request(methods.HISTORY_READ, toWireValue({ scope, ...(previous ? { historyId: previous.historyId, cursor: previous.cursor } : {}) }), client) as unknown as MessageHistoryPage
  const seedAgent = (values: SDKMessage[], sessionId = root.id, rootId = root.id) => {
    const path = backend!.state.agentMessagesPath(rootId, sessionId === rootId ? 'main' : sessionId)
    mkdirSync(dirname(path), { recursive: true })
    writeTextFileAtomic(path, values.map((value) => JSON.stringify(value)).join('\n') + '\n')
    return path
  }
  const seedChat = (values: ChatMessage[]) => {
    const path = join(backend!.paths.conversationsDir, `${chat.id}.jsonl`)
    writeTextFileAtomic(path, values.map((value) => JSON.stringify(value)).join('\n') + '\n')
    return path
  }
  return { directory, parent, child, connection, backend: backend!, main, quick, root, otherRoot, childSession, task, chat,
    request, read, seedAgent, seedChat, history: new AppServerHistoryClient(parent, main.clientId),
    disconnect() { upstream.destroy(); downstream.destroy() } }
}
function agentMessages(count: number): SDKMessage[] {
  return Array.from({ length: count }, (_, i) => ({ type: 'extension', uuid: `message-${i}`, createdAt: i,
    payload: { number: i, text: `保留未知字段-${i}`, nested: ['text', { value: true }] } } as SDKMessage))
}
function chatMessages(count: number): ChatMessage[] {
  return Array.from({ length: count }, (_, i) => ({ id: `chat-${i}`, role: i % 2 ? 'assistant' : 'user',
    createdAt: i, status: 'complete', content: [{ type: 'text', text: `正文-${i}` }] }))
}

describe('应用中立历史分页和完整客户端汇聚', () => {
  test('Agent/Chat/Task 恢复全部应用历史，保留原文、摘要、未知字段与真实子范围', async () => {
    const f = await open(), values = agentMessages(237), chats = chatMessages(219)
    values[110] = { type: 'system', uuid: 'summary-1', subtype: 'compact_boundary', summary: '第一份摘要', compactMetadata: { retained: ['message-109'] } } as SDKMessage
    f.seedAgent(values)
    f.seedAgent(values, f.childSession.id)
    f.seedChat(chats)
    expect(await f.history.read({ kind: 'agent', sessionId: f.root.id })).toEqual(values)
    expect(await f.history.read({ kind: 'task', rootSessionId: f.root.id, taskId: f.task.id })).toEqual(values)
    expect(await f.history.read({ kind: 'chat', conversationId: f.chat.id })).toEqual(chats)
    expect(f.backend.sessions.getMessages(f.root.id)).toEqual(values)
    expect(await f.history.read({ kind: 'agent', sessionId: f.otherRoot.id })).toEqual([])
    for (const scope of [{ kind: 'agent', sessionId: 'missing' }, { kind: 'chat', conversationId: 'missing' },
      { kind: 'task', rootSessionId: f.otherRoot.id, taskId: f.task.id }, { kind: 'task', rootSessionId: f.root.id, taskId: 'missing' }]) {
      await expect(f.request(methods.HISTORY_READ, toWireValue({ scope }))).rejects.toMatchObject({ code: -32029, data: { code: 'not_found' } })
    }
  })

  test('首次打开后追加消息/Chat 全量替换不污染续页，新读取看到最新完整文件', async () => {
    const f = await open(), scope = { kind: 'agent', sessionId: f.root.id } as const, values = agentMessages(220)
    f.seedAgent(values)
    const first = await f.read(scope)
    expect(first.messages).toEqual(values.slice(0, 100))
    f.backend.sessions.appendMessage(f.root.id, { type: 'result', uuid: 'new-result', createdAt: 300, subtype: 'success' })
    const second = await f.read(scope, first), last = await f.read(scope, second)
    expect([...first.messages, ...second.messages, ...last.messages]).toEqual(values)
    expect(last.cursor).toBeNull()
    expect(await f.request(methods.HISTORY_CLOSE, first.historyId)).toBe(true)
    expect(await f.history.read(scope)).toHaveLength(221)
    const chats = chatMessages(210), chatScope = { kind: 'chat', conversationId: f.chat.id } as const
    f.seedChat(chats)
    const c1 = await f.read(chatScope)
    f.backend.conversations.replaceMessages(f.chat.id, [chats[0]!])
    const c2 = await f.read(chatScope, c1), c3 = await f.read(chatScope, c2)
    expect([...c1.messages, ...c2.messages, ...c3.messages]).toEqual(chats)
    await f.request(methods.HISTORY_CLOSE, c1.historyId)
    expect(await f.history.read(chatScope)).toEqual([chats[0]!])
  })

  test('同游标重读不漏/重复消费；过旧游标、跨入口、换范围不可推进或关闭别人的快照', async () => {
    const f = await open(), scope = { kind: 'agent', sessionId: f.root.id } as const
    f.seedAgent(agentMessages(430))
    const first = await f.read(scope), second = await f.read(scope, first)
    expect(await f.read(scope, first)).toEqual(second)
    expect(await f.request(methods.HISTORY_CLOSE, first.historyId, f.quick)).toBe(false)
    await expect(f.read(scope, second, f.quick)).rejects.toMatchObject({ code: -32029, data: { code: 'not_found' } })
    await expect(f.read({ kind: 'agent', sessionId: f.otherRoot.id }, second)).rejects.toMatchObject({ code: -32029 })
    const third = await f.read(scope, second)
    await expect(f.read(scope, first)).rejects.toMatchObject({ code: -32029, data: { code: 'stale_cursor' } })
    const fourth = await f.read(scope, third), last = await f.read(scope, fourth)
    expect(last.messages).toHaveLength(30)
    expect(await f.read(scope, fourth)).toEqual(last)
    expect(await f.request(methods.HISTORY_CLOSE, first.historyId)).toBe(true)
    expect(await f.request(methods.HISTORY_CLOSE, first.historyId)).toBe(false)
  })

  test('拒绝路径/owner/未登记身份与不完整游标；删除后不返回旧 inode 或缓存页', async () => {
    const f = await open(), scope = { kind: 'agent', sessionId: f.root.id } as const
    for (const input of [null, {}, { scope, path: '/private' }, { scope: { ...scope, cwd: '/private' } },
      { scope: { kind: 'agent', sessionId: '../escape' } }, { scope, historyId: 'only-id' }, { scope, cursor: 'only-cursor' },
      { scope, historyId: null, cursor: null }, { scope: { kind: 'unknown' } }]) {
      await expect(f.request(methods.HISTORY_READ, toWireValue(input))).rejects.toMatchObject({ code: -32602 })
    }
    const foreign = f.backend.clients.register()
    await expect(f.parent.request(methods.HISTORY_READ, { clientId: foreign, input: { scope } })).rejects.toMatchObject({ code: -32004 })
    await expect(f.parent.request(methods.HISTORY_READ, { clientId: f.main.clientId, input: { scope }, owner: f.quick.clientId })).rejects.toMatchObject({ code: -32602 })
    f.seedAgent(agentMessages(210))
    const reader = f.backend.sessions.openMessageHistory(f.root.id), closed = spyOn(reader, 'close')
    const opening = spyOn(f.backend.sessions, 'openMessageHistory').mockReturnValue(reader)
    try {
      const first = await f.read(scope)
      f.backend.sessions.delete(f.root.id)
      await expect(f.read(scope, first)).rejects.toMatchObject({ code: -32029, data: { code: 'not_found' } })
      expect(closed).toHaveBeenCalledTimes(1)
    } finally { opening.mockRestore(); closed.mockRestore(); reader.close() }
  })

  test('快照容量有界；主动关闭、注销、物理断开和工厂退出均关闭实际 reader', async () => {
    for (const mode of ['close', 'detach', 'disconnect', 'dispose']) {
      const f = await open(), scope = { kind: 'agent', sessionId: f.root.id } as const
      f.seedAgent(agentMessages(220))
      const reader = f.backend.sessions.openMessageHistory(f.root.id), closed = spyOn(reader, 'close')
      const opening = spyOn(f.backend.sessions, 'openMessageHistory').mockReturnValue(reader)
      try {
        const first = await f.read(scope)
        if (mode === 'close') await f.request(methods.HISTORY_CLOSE, first.historyId)
        else if (mode === 'detach') await f.parent.request(methods.DETACH_CLIENT, { clientId: f.main.clientId })
        else if (mode === 'disconnect') { f.disconnect(); await Bun.sleep(0) }
        else f.backend.dispose()
        expect(closed).toHaveBeenCalledTimes(1)
        expect(() => reader.readPage()).toThrow('历史快照已关闭')
      } finally { opening.mockRestore(); closed.mockRestore(); reader.close() }
    }
    const f = await open(), scope = { kind: 'agent', sessionId: f.root.id } as const, pages: MessageHistoryPage[] = []
    for (let i = 0; i < 4; i += 1) pages.push(await f.read(scope))
    await expect(f.read(scope)).rejects.toMatchObject({ code: -32029, data: { code: 'limit' } })
    await f.request(methods.HISTORY_CLOSE, pages[0]!.historyId)
    expect((await f.read(scope)).messages).toEqual([])
    expect((await f.read(scope, undefined, f.quick)).messages).toEqual([])
  })

  test('空闲期限回收遗留快照；直接 core 的预取消不打开文件，存储失败经协议脱敏', async () => {
    const f = await open(), scope = { kind: 'agent', sessionId: f.root.id } as const
    f.seedAgent(agentMessages(220))
    const controller = new MessageHistoryController({ clients: f.backend.clients, sessions: f.backend.sessions,
      conversations: f.backend.conversations, tasks: f.backend.taskController, idleTimeoutMs: 15 })
    const reader = f.backend.sessions.openMessageHistory(f.root.id), closed = spyOn(reader, 'close')
    const opening = spyOn(f.backend.sessions, 'openMessageHistory').mockReturnValue(reader)
    try {
      const aborted = new AbortController(); aborted.abort()
      expect(() => controller.read(f.main.clientId, { scope }, aborted.signal)).toThrow()
      expect(opening).toHaveBeenCalledTimes(0)
      const first = controller.read(f.main.clientId, { scope })
      await Bun.sleep(40)
      expect(closed).toHaveBeenCalledTimes(1)
      expect(() => controller.read(f.main.clientId, { scope, historyId: first.historyId, cursor: first.cursor })).toThrow('历史快照不存在')
    } finally { controller.dispose(); opening.mockRestore(); closed.mockRestore(); reader.close() }
    const failing = spyOn(f.backend.sessions, 'openMessageHistory').mockImplementation(() => { throw new Error('sk-secret /private/history') })
    try { await expect(f.read(scope)).rejects.toMatchObject({ code: -32603, message: 'RPC 请求处理失败' }) }
    finally { failing.mockRestore() }
  })

  test('正文预算与分段协议保留超过一行帧的完整工具结果和尾部消息', async () => {
    const f = await open(), values = agentMessages(3)
    values[1] = { type: 'tool_result', uuid: 'large-tool-result', content: '汉🙂'.repeat(210_000) } as SDKMessage
    const path = f.seedAgent(values), before = readFileSync(path, 'utf8')
    expect(await f.history.read({ kind: 'agent', sessionId: f.root.id })).toEqual(values)
    expect(readFileSync(path, 'utf8')).toBe(before)
  })

  test('分页只打开文件一次，不调用全文读取；全局快照限制及注销释放不影响其他入口', async () => {
    const f = await open(), scope = { kind: 'agent', sessionId: f.root.id } as const
    f.seedAgent(agentMessages(410))
    const opening = spyOn(f.backend.sessions, 'openMessageHistory')
    const full = spyOn(f.backend.sessions, 'getMessages').mockImplementation(() => { throw new Error('分页不得全文读取') })
    try {
      expect(await f.history.read(scope)).toHaveLength(410)
      expect(opening).toHaveBeenCalledTimes(1)
      expect(full).toHaveBeenCalledTimes(0)
    } finally { opening.mockRestore(); full.mockRestore() }
    const owners = [f.main, f.quick]
    for (let i = 0; i < 6; i += 1) owners.push(await f.parent.request(methods.REGISTER_CLIENT, { kind: 'external' }) as unknown as AppServerClient)
    const snapshots: MessageHistoryPage[] = []
    for (const owner of owners) for (let i = 0; i < 4; i += 1) snapshots.push(await f.read(scope, undefined, owner))
    const extra = await f.parent.request(methods.REGISTER_CLIENT, { kind: 'external' }) as unknown as AppServerClient
    await expect(f.read(scope, undefined, extra)).rejects.toMatchObject({ code: -32029, data: { code: 'limit' } })
    await f.parent.request(methods.DETACH_CLIENT, { clientId: f.main.clientId })
    expect((await f.read(scope, undefined, extra)).messages).toHaveLength(100)
    expect((await f.read(scope, snapshots[4], f.quick)).messages).toHaveLength(100)
  })
})
