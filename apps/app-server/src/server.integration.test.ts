import { describe, expect, test } from 'bun:test'
import { execFileSync, spawn } from 'node:child_process'
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, realpathSync, rmSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { createServer } from 'node:net'
import type { Socket } from 'node:net'
import { AppServerHistoryClient, JsonRpcPeer, registerPrivateHostBridge } from '@axon/app-server'
import type { PrivateHostBridgeOptions } from '@axon/app-server'
import { createCredentialCodec } from '@axon/core'
import { detectSeatbeltCapability } from '@axon/host-node'
import { APP_SERVER_METHODS as methods, APP_SERVER_NOTIFICATIONS as notices, APP_SERVER_CLIENT_METHODS as reverse, APP_SERVER_RPC_OPTIONS, DEFAULT_AGENT_SESSION_TITLE, DEFAULT_CONVERSATION_TITLE } from '@axon/shared'
import type { AgentDelegation, AgentProject, AgentProjectWatchSubscription, AgentSessionMeta, AppServerAgentRunEvent, AppServerClient, AppServerInitializeResult, Channel, ConversationMeta, RpcJsonValue, SDKUserMessage } from '@axon/shared'
import { createFixtureCredentialCodec } from '../../../packages/core/test-support/credential-codec'
import type { CredentialCodec } from '@axon/core'
import { createBlockingGitHelper, waitForGitHelperExit } from '../../../packages/core/test-support/blocking-git-helper'

interface ProcessTrace { method: string; pid: number; answers?: Array<{ id: string; answer: string }> }

/** 观察仍在追加的测试 trace 时只读完整行；已完成的坏行仍失败，不能忽略协议夹具损坏。 */
function readRuntimeTrace(filename: string): ProcessTrace[] {
  if (!existsSync(filename)) return []
  const lines = readFileSync(filename, 'utf8').split('\n')
  lines.pop()
  return lines.map((line) => JSON.parse(line) as ProcessTrace)
}

test('测试 trace 只消费完整 JSONL 行，未完成尾行等待，已完成坏行不被隐藏', () => {
  const directory = mkdtempSync(join(tmpdir(), 'axon-runtime-trace-reader-')), trace = join(directory, 'trace.jsonl')
  try {
    writeFileSync(trace, '{"method":"started","pid":2}\n{"method":"helper"')
    expect(readRuntimeTrace(trace)).toEqual([{ method: 'started', pid: 2 }])
    writeFileSync(trace, '{"method":"helper","pid":3}')
    expect(readRuntimeTrace(trace)).toEqual([])
    writeFileSync(trace, '{"method":"helper","pid":3}\n')
    expect(readRuntimeTrace(trace)).toEqual([{ method: 'helper', pid: 3 }])
    writeFileSync(trace, '{invalid}\n')
    expect(() => readRuntimeTrace(trace)).toThrow()
  } finally { rmSync(directory, { recursive: true, force: true }) }
})

/** 实际 main/装配/仓储/宿主与 Runtime 构造；父端只持有协议和隔离凭据后端。 */
function open(directory: string, options: { codec?: CredentialCodec; args?: string[]; python?: string;
  fatal?: 'uncaughtException' | 'unhandledRejection'; marker?: string; environment?: NodeJS.ProcessEnv;
  confirmTarget?: PrivateHostBridgeOptions['confirmChannelTarget'] } = {}) {
  const data = join(directory, 'data')
  const child = spawn(process.execPath, [join(import.meta.dir, options.fatal ? '../test-support/server-fatal-fixture.ts' : 'main.ts'), ...(options.args ?? [
    '--data-dir', data, '--home-dir', directory, '--application-version', '0.1.3',
  ])], { stdio: ['pipe', 'pipe', 'pipe'], env: { ...process.env, ...options.environment, AXON_ZIMA_PYTHON: options.python ?? '',
    AXON_SERVER_TEST_FATAL: options.fatal ?? '', AXON_SERVER_TEST_MARKER: options.marker ?? '',
    HTTP_PROXY: '', HTTPS_PROXY: '', ALL_PROXY: '', http_proxy: '', https_proxy: '', all_proxy: '', NO_PROXY: '127.0.0.1,localhost' } })
  let stderr = ''
  child.stderr.on('data', (chunk: Buffer) => { stderr += chunk.toString() })
  const exited = new Promise<number | null>((resolve, reject) => { child.once('close', resolve); child.once('error', reject) })
  const peer = new JsonRpcPeer(child.stdout, child.stdin, { ...APP_SERVER_RPC_OPTIONS, requestTimeoutMs: 8_000 })
  const signals = new Map<string, AbortController>()
  const capabilities = registerPrivateHostBridge(peer, { credentialCodec: options.codec ?? createCredentialCodec(),
    getClientSignal: (id) => signals.get(id)?.signal, confirmChannelTarget: options.confirmTarget })
  const initialize = async () => await peer.request(methods.INITIALIZE, { protocolVersion: 1,
    client: { name: 'axon-independent-fixture', version: '0.1.3' }, hostCapabilities: capabilities }) as unknown as AppServerInitializeResult
  const register = async (kind = 'main') => {
    const client = await peer.request(methods.REGISTER_CLIENT, { kind }) as unknown as AppServerClient
    signals.set(client.clientId, new AbortController())
    return client
  }
  const request = (client: AppServerClient, method: string, input?: RpcJsonValue) => peer.request(method,
    { clientId: client.clientId, ...(input === undefined ? {} : { input }) })
  return { child, peer, data, initialize, register, request, exited, get stderr() { return stderr },
    async eof() { child.stdin.end(); return await exited },
    async close() {
      peer.close()
      for (const signal of signals.values()) signal.abort()
      if (child.exitCode === null && child.signalCode === null) child.kill()
      child.stdin.destroy(); child.stdout.destroy()
      await exited
      child.stderr.destroy()
    } }
}

/** 保持真实 HTTP 流未结束；close 记录 TCP 收束，不以模型取消信号代替连接释放。 */
async function openHeldModel(hold: 'all' | 'titles' | 'background-result') {
  const pending: Array<{ kind: 'agent' | 'chat' | 'title' | 'notification' }> = []
  const sockets = new Set<Socket>()
  let closedConnections = 0
  let requests = 0
  const server = createServer((socket) => {
    sockets.add(socket)
    socket.once('close', () => { sockets.delete(socket); closedConnections += 1 })
    socket.on('error', () => {})
    let input = Buffer.alloc(0), handled = false
    socket.on('data', (chunk: Buffer) => {
      if (handled) return
      input = Buffer.concat([input, chunk])
      // 仅处理本机 SDK 发来的有 Content-Length 的 JSON；不实现通用 HTTP 服务。
      if (input.length > 16 * 1024 * 1024) { socket.destroy(); return }
      const headerEnd = input.indexOf('\r\n\r\n')
      if (headerEnd < 0) return
      const length = Number(input.subarray(0, headerEnd).toString().match(/\r\ncontent-length:\s*(\d+)/i)?.[1])
      if (!Number.isSafeInteger(length) || length < 1) { socket.destroy(); return }
      if (input.length < headerEnd + 4 + length) return
      handled = true
      try {
        const body = JSON.parse(input.subarray(headerEnd + 4, headerEnd + 4 + length).toString()) as {
          messages: Array<{ role: string; content: unknown }>; tools?: Array<{ function: { name: string } }>
        }
        requests += 1
        const title = body.messages.some((message) => message.role === 'system'
          && JSON.stringify(message.content).includes('请为这段对话生成'))
        const notification = hold === 'background-result' && body.messages.some((message) => message.role === 'user'
          && JSON.stringify(message.content).includes('一个后台子 Agent 任务已经结束'))
        const kind = notification ? 'notification' : title ? 'title' : body.tools?.length ? 'agent' : 'chat'
        const text = notification ? '后台结果续跑局部内容' : title ? '不得保存的迟到标题' : `${kind} 局部内容`
        let delta: object = { role: 'assistant', content: text }, reason = 'stop'
        if (hold === 'background-result' && !notification && body.tools?.some((tool) => tool.function.name === 'Agent')
          && !body.messages.some((message) => message.role === 'tool')) {
          delta = { role: 'assistant', tool_calls: [{ index: 0, id: 'completed-background', type: 'function', function: {
            name: 'Agent', arguments: JSON.stringify({ description: '隔离已完成子任务', prompt: '返回简短完成结论',
              subagent_type: 'coder', run_in_background: true }),
          } }] }
          reason = 'tool_calls'
        }
        const frame = (delta: object, finish: string | null) => `data: ${JSON.stringify({
          id: 'drain-fixture', object: 'chat.completion.chunk', model: 'axon-drain-fixture',
          choices: [{ index: 0, delta, finish_reason: finish }],
        })}\n\n`
        const send = (value: string) => socket.write(`${Buffer.byteLength(value).toString(16)}\r\n${value}\r\n`)
        // 直接观察真实 TCP，而不是 HTTP 兼容层的 response.close 事件。
        socket.write('HTTP/1.1 200 OK\r\nContent-Type: text/event-stream\r\nTransfer-Encoding: chunked\r\nConnection: close\r\n\r\n')
        send(frame(delta, null))
        if (hold === 'all' || title || notification) pending.push({ kind })
        else { send(frame({}, reason) + 'data: [DONE]\n\n'); socket.end('0\r\n\r\n') }
      } catch { socket.destroy() }
    })
  })
  await new Promise<void>((resolve, reject) => {
    server.once('error', reject)
    server.listen(0, '127.0.0.1', resolve)
  })
  const address = server.address()
  if (!address || typeof address === 'string') throw new Error('本机模型没有端口')
  return { pending, get requests() { return requests }, get connections() { return sockets.size },
    get closedConnections() { return closedConnections }, baseUrl: `http://127.0.0.1:${address.port}/v1`,
    async close() {
      const closed = new Promise<void>((resolve) => server.close(() => resolve()))
      for (const socket of sockets) socket.destroy()
      await closed
    } }
}

describe('真正独立 app-server 启动与装配', () => {
  test('真实子进程握手/多入口 CRUD/完整历史/EOF；目录和能力来自实际入口，日志不污染协议', async () => {
    const directory = mkdtempSync(join(tmpdir(), 'axon-independent-server-')), f = open(directory)
    try {
      await expect(f.peer.request(methods.GET_SETTINGS, { clientId: 'unknown' })).rejects.toMatchObject({ code: -32002 })
      expect(existsSync(f.data)).toBe(false)
      const initialized = await f.initialize(), main = await f.register(), quick = await f.register('quick')
      expect(f.child.pid).not.toBe(process.pid)
      expect(initialized).toMatchObject({ applicationVersion: '0.1.3', dataDirectory: f.data })
      expect(initialized.capabilities.runtimes.find((runtime) => runtime.runtimeId === 'pi')?.sandbox.supported).toBe(detectSeatbeltCapability().available)
      expect(initialized.capabilities.runtimes.find((runtime) => runtime.runtimeId === 'zima')).toMatchObject({ configured: false,
        sandbox: { supported: false, limitation: 'runtimeToolDelegationUnavailable' } })
      const project = await f.request(main, methods.PROJECT_CREATE, { name: '隔离项目' }) as unknown as AgentProject
      const session = await f.request(main, methods.AGENT_CREATE_SESSION, { projectId: project.id, title: 'sk-fixture-secret-title' }) as unknown as AgentSessionMeta
      expect(session.runtimeId).toBe('pi')
      expect(await new AppServerHistoryClient(f.peer, main.clientId).read({ kind: 'agent', sessionId: session.id })).toEqual([])
      expect(await f.request(quick, methods.AGENT_GET_SESSION, session.id)).toMatchObject({ id: session.id })
      expect(await f.request(main, methods.AGENT_CHECK_ENVIRONMENT, { projectId: project.id })).toMatchObject({ cwd: join(f.data, 'agent-projects', project.slug, 'workspace-files'),
        directory: { available: true } })
      await f.request(main, methods.UPDATE_SETTINGS, { agentSystemPrompt: '隔离系统提示词' })
      expect(await f.request(quick, methods.GET_SETTINGS)).toMatchObject({ agentSystemPrompt: '隔离系统提示词' })
      expect(readFileSync(join(f.data, 'settings.json'), 'utf8')).toContain('隔离系统提示词')
      expect(await f.eof()).toBe(0)
      expect(f.stderr).toContain('协议入口已准备')
      expect(f.stderr).toContain('运行诊断已脱敏')
      expect(f.stderr).not.toContain('sk-fixture-secret-title')
      expect(f.stderr).not.toContain(directory)
    } finally { await f.close(); rmSync(directory, { recursive: true, force: true }) }
  }, 15_000)

  test('实际私有凭据反向桥加密渠道并重启恢复；无桥拒绝非空密钥，不降级明文', async () => {
    const directory = mkdtempSync(join(tmpdir(), 'axon-independent-credentials-'))
    const codec = createFixtureCredentialCodec(), f = open(directory, { codec })
    let restarted: ReturnType<typeof open> | undefined
    try {
      await f.initialize()
      const main = await f.register(), secret = 'sk-independent-fixture-secret'
      const channel = await f.request(main, methods.CHANNEL_CREATE, { name: '隔离渠道', provider: 'openai', apiKey: secret,
        baseUrl: 'https://example.test/v1', models: [{ id: 'fixture', name: '夹具', enabled: true }] }) as unknown as Channel
      const stored = readFileSync(join(f.data, 'channels.json'), 'utf8')
      expect(stored).toContain('secure:v1:')
      expect(stored).not.toContain(secret)
      expect(JSON.stringify(channel)).not.toContain(secret)
      expect(await f.eof()).toBe(0)
      restarted = open(directory, { codec })
      await restarted.initialize()
      const quick = await restarted.register('quick')
      expect(await restarted.request(quick, methods.CHANNEL_LIST)).toMatchObject([{ id: channel.id, hasApiKey: true }])
      expect(await restarted.eof()).toBe(0)
      expect(f.stderr + restarted.stderr).not.toContain(secret)
      const unavailable = open(directory)
      try {
        await unavailable.initialize()
        const external = await unavailable.register('external')
        await expect(unavailable.request(external, methods.CHANNEL_CREATE, { name: '禁止明文', provider: 'openai', apiKey: secret, models: [] }))
          .rejects.toMatchObject({ code: -32022, data: { code: 'credential_error' } })
      } finally { await unavailable.close() }
    } finally { await f.close(); await restarted?.close(); rmSync(directory, { recursive: true, force: true }) }
  }, 20_000)

  for (const mode of ['EOF', 'SIGTERM'] as const) {
    test(`生产 ${mode} 撤销在途宿主凭据和地址确认，迟到值不写配置或开启网络`, async () => {
      const requests: Array<{ url: string; authorization: string | null }> = []
      const model = Bun.serve({ hostname: '127.0.0.1', port: 0, fetch(request) {
        requests.push({ url: request.url, authorization: request.headers.get('authorization') })
        return Response.json({ data: [{ id: 'host-bridge-fixture' }] })
      } })
      const directory = mkdtempSync(join(tmpdir(), 'axon-server-drain-host-'))
      const originalSecret = 'sk-host-before-fixture', changedSecret = 'sk-host-late-fixture'
      const base = createFixtureCredentialCodec(), encryption = Promise.withResolvers<void>(), confirmation = Promise.withResolvers<void>()
      const encryptedReturned = Promise.withResolvers<void>(), confirmedReturned = Promise.withResolvers<void>()
      let held = false, encryptStarted = false, decrypts = 0, confirms = 0
      let target: { owner: string; url: string; signal: AbortSignal } | undefined
      const codec: CredentialCodec = { isSecure: true, storageKind: 'safe-storage',
        async encrypt(value) {
          if (!held) return base.encrypt(value)
          encryptStarted = true
          try { await encryption.promise; return await base.encrypt(value) }
          finally { encryptedReturned.resolve() }
        },
        async decrypt(value) { decrypts += 1; return base.decrypt(value) },
      }
      const f = open(directory, { codec, async confirmTarget(owner, url, signal) {
        confirms += 1
        if (!held) return true
        target = { owner, url, signal }
        // 故意忽略取消直到服务退出；真实桥必须撤销等待并拒绝迟到批准。
        try { await confirmation.promise; return true }
        finally { confirmedReturned.resolve() }
      } })
      let restarted: ReturnType<typeof open> | undefined
      const events: RpcJsonValue[] = []
      f.peer.handleNotification(notices.CHANNELS_CHANGED, (event) => { events.push(event) })
      try {
        await f.initialize()
        const main = await f.register(), quick = await f.register('quick')
        const channel = await f.request(main, methods.CHANNEL_CREATE, { name: '原渠道', provider: 'custom', apiKey: originalSecret,
          baseUrl: `http://127.0.0.1:${model.port}/v1`, models: [] }) as unknown as Channel
        const input = { requestId: 'host-normal', operation: 'models', provider: 'custom', channelId: channel.id,
          baseUrl: channel.baseUrl! }
        // 正向对照确认实际目标批准 → 私有解密 → 带凭据 GET；取消测试不能靠“从未可用”通过。
        expect(await f.request(main, methods.CHANNEL_REQUEST, input)).toMatchObject({ success: true,
          models: [{ id: 'host-bridge-fixture', enabled: false, source: 'fetched' }] })
        expect(requests).toEqual([{ url: `${channel.baseUrl}/models`, authorization: `Bearer ${originalSecret}` }])
        expect(confirms).toBe(1)
        expect(decrypts).toBe(1)
        const delivered = Date.now() + 3_000
        while (events.length < 2 && Date.now() < delivered) await Bun.sleep(10)
        expect(events).toHaveLength(2)
        expect(JSON.stringify(events)).toContain(main.clientId)
        expect(JSON.stringify(events)).toContain(quick.clientId)
        const filename = join(f.data, 'channels.json'), before = readFileSync(filename, 'utf8'), notified = events.length
        expect(before).toContain('secure:v1:')
        expect(before).not.toContain(originalSecret)
        held = true
        const saving = f.request(main, methods.CHANNEL_UPDATE, { channelId: channel.id,
          update: { name: '迟到更新不得保存', apiKey: changedSecret } }).catch((error: unknown) => error)
        const querying = f.request(main, methods.CHANNEL_REQUEST, { ...input, requestId: 'host-held' }).catch((error: unknown) => error)
        const deadline = Date.now() + 5_000
        while ((!encryptStarted || !target) && Date.now() < deadline) await Bun.sleep(10)
        expect(encryptStarted).toBe(true)
        expect(target).toBeDefined()
        expect(target?.owner).toBe(main.clientId)
        expect(target?.owner).not.toBe(quick.clientId)
        expect(target?.url).toBe(`${channel.baseUrl}/models`)
        expect(target?.signal.aborted).toBe(false)
        expect(confirms).toBe(2)
        expect(decrypts).toBe(1)
        expect(requests).toHaveLength(1)
        expect(readFileSync(filename, 'utf8')).toBe(before)
        if (mode === 'EOF') f.child.stdin.end()
        else f.child.kill('SIGTERM')
        expect(await f.exited).toBe(0)
        expect(await saving).toBeInstanceOf(Error)
        expect(await querying).toBeInstanceOf(Error)
        expect(target?.signal.aborted).toBe(true)
        // 子端取消的是跨进程等待；父端迟到完成只释放自身工作，不让旧子端获得结果。
        encryption.resolve(); confirmation.resolve()
        await encryptedReturned.promise; await confirmedReturned.promise
        expect(readFileSync(filename, 'utf8')).toBe(before)
        expect(events).toHaveLength(notified)
        expect(requests).toHaveLength(1)
        expect(decrypts).toBe(1)
        expect(f.stderr).not.toContain('退出异常')
        expect(f.stderr).not.toContain(originalSecret)
        expect(f.stderr).not.toContain(changedSecret)
        // 加密未完成的保存没有提交；新进程读取原配置，不重投保存或旧目标确认。
        let restoredConfirmations = 0
        restarted = open(directory, { codec: base, confirmTarget: async () => { restoredConfirmations += 1; return false } })
        await restarted.initialize()
        const observer = await restarted.register('quick')
        const restored = await restarted.request(observer, methods.CHANNEL_LIST) as unknown as Channel[]
        expect(restored).toEqual([channel])
        expect(readFileSync(filename, 'utf8')).toBe(before)
        expect(await restarted.eof()).toBe(0)
        expect(restoredConfirmations).toBe(0)
        expect(requests).toHaveLength(1)
      } finally {
        encryption.resolve(); confirmation.resolve()
        await f.close(); await restarted?.close(); model.stop(true)
        rmSync(directory, { recursive: true, force: true })
      }
    }, 20_000)
  }

  test('错误启动参数/握手版本/污染行不创建数据目录；EOF 和显式 SIGTERM 均退出，不内嵌回退', async () => {
    const directory = mkdtempSync(join(tmpdir(), 'axon-independent-invalid-'))
    try {
      const invalid = open(directory, { args: ['--data-dir', join(directory, 'data')] })
      try { expect(await invalid.exited).toBe(1); expect(invalid.stderr).toContain('启动失败'); expect(existsSync(invalid.data)).toBe(false) }
      finally { await invalid.close() }
      const version = open(directory)
      try {
        await expect(version.peer.request(methods.INITIALIZE, { protocolVersion: 99, client: { name: 'fixture', version: '1' },
          hostCapabilities: { credentialStorage: 'unavailable', channelTargetConfirmation: false } })).rejects.toMatchObject({ code: -32006 })
        expect(existsSync(version.data)).toBe(false)
        expect(await version.eof()).toBe(0)
      } finally { await version.close() }
      const polluted = open(directory)
      try { polluted.child.stdin.write('not-json\n'); expect(await polluted.exited).toBe(1); expect(existsSync(polluted.data)).toBe(false) }
      finally { await polluted.close() }
      const signaled = open(directory)
      try { await signaled.initialize(); signaled.child.kill('SIGTERM'); expect(await signaled.exited).toBe(0) }
      finally { await signaled.close() }
    } finally { rmSync(directory, { recursive: true, force: true }) }
  }, 20_000)

  test('Zima 未配置/无效解释器不能创建会话，但 Pi 仍可用且不写失败索引', async () => {
    const directory = mkdtempSync(join(tmpdir(), 'axon-independent-zima-')), f = open(directory, { python: join(directory, 'missing-python') })
    try {
      expect((await f.initialize()).capabilities.runtimes.find((runtime) => runtime.runtimeId === 'zima')?.configured).toBe(false)
      const main = await f.register(), project = await f.request(main, methods.PROJECT_CREATE, { name: '解释器边界' }) as unknown as AgentProject
      await expect(f.request(main, methods.AGENT_CREATE_SESSION, { runtimeId: 'zima', projectId: project.id })).rejects.toMatchObject({ code: -32603 })
      expect(await f.request(main, methods.AGENT_LIST_SESSIONS)).toEqual([])
      expect(await f.request(main, methods.AGENT_CREATE_SESSION, { runtimeId: 'pi', projectId: project.id })).toMatchObject({ runtimeId: 'pi' })
    } finally { await f.close(); rmSync(directory, { recursive: true, force: true }) }
  }, 15_000)

  for (const mode of ['EOF', 'SIGINT', 'SIGTERM', 'uncaughtException', 'unhandledRejection'] as const) {
    test(`退出入口 ${mode} 等待真实在途 MCP 关闭，服务退出时忽略 EOF/TERM 的工具进程已消失`, async () => {
      const directory = mkdtempSync(join(tmpdir(), 'axon-server-drain-mcp-'))
      const marker = join(directory, 'mcp-shutdown')
      const fatal = mode === 'uncaughtException' || mode === 'unhandledRejection' ? mode : undefined
      const f = open(directory, { fatal, marker })
      let pid: number | undefined
      try {
        await f.initialize()
        const main = await f.register(), project = await f.request(main, methods.PROJECT_CREATE, { name: '退出资源' }) as unknown as AgentProject
        const result = f.request(main, methods.MCP_TEST_CONNECTION, { projectId: project.id, serverName: 'fixture',
          server: { type: 'stdio', command: process.execPath,
            args: [join(import.meta.dir, '../../../packages/core/test-support/mcp-stubborn-stdio-fixture.mjs'), marker],
            enabled: true, required: true, startupTimeoutMs: 2_000, requestTimeoutMs: 2_000 } })
          .catch((error: unknown) => error)
        const deadline = Date.now() + 5_000
        while (!existsSync(`${marker}.eof`) && Date.now() < deadline) await Bun.sleep(10)
        expect(existsSync(`${marker}.eof`)).toBe(true)
        pid = Number(readFileSync(`${marker}.pid`, 'utf8'))
        expect(Number.isSafeInteger(pid) && pid > 0).toBe(true)
        if (!fatal) expect(() => process.kill(pid!, 0)).not.toThrow()
        if (mode === 'EOF') f.child.stdin.end()
        else if (mode === 'SIGINT' || mode === 'SIGTERM') f.child.kill(mode)
        expect(await f.exited).toBe(fatal ? 1 : 0)
        expect(await result).not.toMatchObject({ ok: true })
        expect(existsSync(`${marker}.term`)).toBe(true)
        let alive = true
        try { process.kill(pid, 0) }
        catch (error) { expect(error).toMatchObject({ code: 'ESRCH' }); alive = false }
        expect(alive).toBe(false)
        expect(f.stderr.split('退出异常').length - 1).toBe(fatal ? 1 : 0)
        expect(f.stderr).not.toContain(directory)
        expect(f.stderr).not.toContain('sk-fatal-fixture-secret')
      } finally {
        await f.close()
        // 只兜底本测试通过 PID 文件确认的进程；正常路径必须已由服务回收。
        if (pid) { try { process.kill(pid, 'SIGKILL') } catch { /* 已退出。 */ } }
        rmSync(directory, { recursive: true, force: true })
      }
    }, 15_000)
  }

  for (const mode of ['EOF', 'SIGTERM'] as const) {
    test(`生产 ${mode} 关闭在途工作区 Git/helper 及原入口监听，重启恢复项目/记忆并可重新订阅`, async () => {
      const directory = realpathSync(mkdtempSync(join(tmpdir(), 'axon-server-drain-workspace-'))), workspace = join(directory, 'workspace')
      const environment = { HOME: directory, ZDOTDIR: directory, PATH: '/usr/bin:/bin:/usr/sbin:/sbin',
        GIT_CONFIG_GLOBAL: '/dev/null', GIT_CONFIG_NOSYSTEM: '1' }
      mkdirSync(workspace)
      const git = (...args: string[]) => execFileSync('/usr/bin/git', args, { cwd: workspace, env: { ...process.env, ...environment }, stdio: 'ignore' })
      git('init', '--quiet')
      writeFileSync(join(workspace, 'tracked.txt'), 'before\n')
      git('add', 'tracked.txt')
      git('-c', 'user.name=Axon Test', '-c', 'user.email=axon@example.invalid', '-c', 'commit.gpgsign=false',
        '-c', 'core.hooksPath=/dev/null', 'commit', '--quiet', '-m', 'initial')
      const helper = await createBlockingGitHelper()
      // 真实 Git 调用 helper；就绪通知在 TERM 处理安装后发出，不轮询工作区标记文件。
      git('config', 'core.fsmonitor', helper.command)
      const f = open(directory, { environment }), events: RpcJsonValue[] = []
      let restarted: ReturnType<typeof open> | undefined
      const pids: number[] = []
      f.peer.handleNotification(notices.WORKSPACE_CHANGED, (event) => { events.push(event) })
      f.peer.handleNotification(notices.MEMORY_CHANGED, (event) => { events.push(event) })
      try {
        await f.initialize()
        const main = await f.register(), quick = await f.register('quick')
        const project = await f.request(main, methods.PROJECT_CREATE, { name: '实际工作区退出', workspace: { kind: 'local', path: workspace } }) as unknown as AgentProject
        await f.request(main, methods.PROJECT_UPDATE, { projectId: project.id, update: { memoryEnabled: true } })
        await f.request(main, methods.MEMORY_WRITE, { projectId: project.id, relativePath: 'MEMORY.md', content: '退出前的记忆索引' })
        const subscriptions: AgentProjectWatchSubscription[] = []
        for (const client of [main, quick]) for (const method of [methods.WORKSPACE_WATCH, methods.MEMORY_WATCH]) {
          subscriptions.push(await f.request(client, method, project.id) as unknown as AgentProjectWatchSubscription)
        }
        writeFileSync(join(workspace, 'tracked.txt'), 'after\n')
        await f.request(main, methods.MEMORY_WRITE, { projectId: project.id, relativePath: 'MEMORY.md', content: '退出后仍需保留的记忆索引' })
        const deadline = Date.now() + 3_000
        while (subscriptions.some((subscription) => !JSON.stringify(events).includes(subscription.subscriptionId))
          && Date.now() < deadline) await Bun.sleep(10)
        for (const subscription of subscriptions) expect(JSON.stringify(events)).toContain(subscription.subscriptionId)
        expect(JSON.stringify(events)).toContain(main.clientId)
        expect(JSON.stringify(events)).toContain(quick.clientId)
        let earlyResult: unknown
        const pending = f.request(main, methods.WORKSPACE_READ_DIFF, { projectId: project.id, relativePath: 'tracked.txt' })
          .then((result) => { earlyResult = result; return result }, (error: unknown) => { earlyResult = error; return error })
        const ready = await Promise.race([
          helper.waitReady(),
          pending.then(() => { throw new Error('Diff 在 Git helper 就绪前结束') }),
        ])
        // 正常返回/拒绝不能当作“在途退出”样本，保留实际响应以诊断未进入 hook 的原因。
        expect(earlyResult).toBeUndefined()
        pids.push(ready.gitPid, ready.helperPid)
        expect(pids).toHaveLength(2)
        for (const pid of pids) {
          expect(Number.isSafeInteger(pid) && pid > 1 && pid !== process.pid).toBe(true)
          expect(() => process.kill(pid, 0)).not.toThrow()
        }
        if (mode === 'EOF') f.child.stdin.end()
        else f.child.kill('SIGTERM')
        expect(await f.exited).toBe(0)
        expect(await pending).toBeInstanceOf(Error)
        for (const pid of pids) await waitForGitHelperExit(pid)
        expect(f.stderr).not.toContain('退出异常')
        // 只撤掉测试仓库的阻塞 hook；恢复链继续走实际 Git 和原本工作区，不迁移用户数据。
        git('config', '--unset', 'core.fsmonitor')
        const before = events.length
        restarted = open(directory, { environment })
        const newEvents: RpcJsonValue[] = []
        restarted.peer.handleNotification(notices.WORKSPACE_CHANGED, (event) => { newEvents.push(event) })
        restarted.peer.handleNotification(notices.MEMORY_CHANGED, (event) => { newEvents.push(event) })
        await restarted.initialize()
        const observer = await restarted.register('quick')
        expect(await restarted.request(observer, methods.PROJECT_GET, project.id)).toMatchObject({ memoryEnabled: true,
          workspace: { kind: 'local', path: workspace, status: 'available' } })
        expect(await restarted.request(observer, methods.WORKSPACE_READ_FILE, { projectId: project.id, relativePath: 'tracked.txt' }))
          .toMatchObject({ kind: 'text', content: 'after\n' })
        expect(await restarted.request(observer, methods.WORKSPACE_READ_DIFF, { projectId: project.id, relativePath: 'tracked.txt' }))
          .toMatchObject({ status: 'changed' })
        expect(JSON.stringify(await restarted.request(observer, methods.MEMORY_READ, { projectId: project.id, relativePath: 'MEMORY.md' })))
          .toContain('退出后仍需保留的记忆索引')
        for (const subscription of subscriptions) {
          expect(await restarted.request(observer, subscription.kind === 'workspace' ? methods.WORKSPACE_UNWATCH : methods.MEMORY_UNWATCH,
            { projectId: project.id, subscriptionId: subscription.subscriptionId })).toBe(false)
        }
        const watch = await restarted.request(observer, methods.WORKSPACE_WATCH, project.id) as unknown as AgentProjectWatchSubscription
        const memory = await restarted.request(observer, methods.MEMORY_WATCH, project.id) as unknown as AgentProjectWatchSubscription
        writeFileSync(join(workspace, 'tracked.txt'), 'new process\n')
        await restarted.request(observer, methods.MEMORY_WRITE, { projectId: project.id, relativePath: 'MEMORY.md', content: '新进程记忆索引' })
        const changed = Date.now() + 3_000
        while ((!JSON.stringify(newEvents).includes(watch.subscriptionId) || !JSON.stringify(newEvents).includes(memory.subscriptionId))
          && Date.now() < changed) await Bun.sleep(10)
        expect(JSON.stringify(newEvents)).toContain(watch.subscriptionId)
        expect(JSON.stringify(newEvents)).toContain(memory.subscriptionId)
        expect(JSON.stringify(newEvents)).not.toContain(main.clientId)
        expect(JSON.stringify(newEvents)).not.toContain(quick.clientId)
        expect(events).toHaveLength(before)
        expect(await restarted.eof()).toBe(0)
      } finally {
        await f.close(); await restarted?.close()
        for (const pid of pids) {
          if (!Number.isSafeInteger(pid) || pid <= 1 || pid === process.pid) continue
          try { process.kill(pid, 'SIGKILL') } catch { /* 已退出。 */ }
        }
        await helper.close()
        rmSync(directory, { recursive: true, force: true })
      }
    }, 20_000)
  }

  for (const mode of ['EOF', 'SIGTERM'] as const) {
    test(`生产 ${mode} 等待 Pi 会话未完成的 Shell 预热，回收进程组并不发布半份快照`, async () => {
      const model = await openHeldModel('all')
      const directory = mkdtempSync(join(tmpdir(), 'axon-server-drain-prewarm-'))
      const environment = { HOME: directory, ZDOTDIR: directory, PATH: '/usr/bin:/bin:/usr/sbin:/sbin',
        BASH_ENV: '', ENV: '', GIT_CONFIG_GLOBAL: '/dev/null', GIT_CONFIG_NOSYSTEM: '1' }
      const startup = 'trap "" TERM\nprintf "%s\\n" "$$" > "$HOME/prewarm.pid"\n/bin/sleep 60 &\nprintf "%s\\n" "$!" > "$HOME/prewarm-helper.pid"\nwait\n'
      writeFileSync(join(directory, '.zshrc'), startup)
      writeFileSync(join(directory, '.bashrc'), startup)
      const f = open(directory, { environment }), events: RpcJsonValue[] = [], pids: number[] = []
      let restarted: ReturnType<typeof open> | undefined
      f.peer.handleNotification(notices.AGENT_RUN, (event) => { events.push(event) })
      try {
        const initialized = await f.initialize(), main = await f.register()
        expect(initialized.capabilities.runtimes.find((runtime) => runtime.runtimeId === 'pi')?.sandbox.supported).toBe(true)
        const project = await f.request(main, methods.PROJECT_CREATE, { name: '预热退出' }) as unknown as AgentProject
        const channel = await f.request(main, methods.CHANNEL_CREATE, { name: '预热本机模型', provider: 'custom', apiKey: '',
          baseUrl: model.baseUrl, models: [{ id: 'axon-prewarm-fixture', name: '夹具', enabled: true }] }) as unknown as Channel
        const session = await f.request(main, methods.AGENT_CREATE_SESSION, { projectId: project.id, channelId: channel.id,
          modelId: 'axon-prewarm-fixture', title: '不生成标题' }) as unknown as AgentSessionMeta
        const running = f.request(main, methods.AGENT_SEND, { sessionId: session.id, text: '预热期间关闭' }).catch((error: unknown) => error)
        const deadline = Date.now() + 5_000
        while ((!existsSync(join(directory, 'prewarm-helper.pid')) || !JSON.stringify(events).includes('agent 局部内容'))
          && Date.now() < deadline) await Bun.sleep(10)
        expect(existsSync(join(directory, 'prewarm-helper.pid'))).toBe(true)
        expect(JSON.stringify(events)).toContain('agent 局部内容')
        for (const name of ['prewarm.pid', 'prewarm-helper.pid']) {
          const pid = Number(readFileSync(join(directory, name), 'utf8').trim())
          pids.push(pid)
          expect(Number.isSafeInteger(pid) && pid > 1 && pid !== process.pid).toBe(true)
          expect(() => process.kill(pid, 0)).not.toThrow()
        }
        expect(model.requests).toBe(1)
        if (mode === 'EOF') f.child.stdin.end()
        else f.child.kill('SIGTERM')
        expect(await f.exited).toBe(0)
        await running
        for (const pid of pids) {
          let gone: unknown
          try { process.kill(pid, 0) } catch (error) { gone = error }
          expect(gone).toMatchObject({ code: 'ESRCH' })
        }
        const snapshots = join(f.data, 'shell_snapshots')
        expect(existsSync(snapshots) ? readdirSync(snapshots) : []).toEqual([])
        const closed = Date.now() + 1_000
        while (model.connections && Date.now() < closed) await Bun.sleep(10)
        expect(model.connections).toBe(0)
        expect(model.requests).toBe(1)
        expect(f.stderr).not.toContain('退出异常')
        // 恢复只读应用历史，不运行模型、不重新预热；原始缓存不是会话恢复凭据。
        restarted = open(directory, { environment })
        await restarted.initialize()
        const observer = await restarted.register('quick')
        const history = await new AppServerHistoryClient(restarted.peer, observer.clientId).read({ kind: 'agent', sessionId: session.id })
        expect(history.filter((message) => message.type === 'result')).toHaveLength(1)
        expect(history.filter((message) => message.type === 'result')).toMatchObject([{ terminal_reason: 'stopped', stopped_by_user: true }])
        expect(await restarted.request(observer, methods.AGENT_LIST_ACTIVE_RUNS)).toEqual([])
        expect(await restarted.eof()).toBe(0)
        expect(model.requests).toBe(1)
        expect(existsSync(snapshots) ? readdirSync(snapshots) : []).toEqual([])
      } finally {
        await f.close(); await restarted?.close(); await model.close()
        for (const pid of pids) {
          if (!Number.isSafeInteger(pid) || pid <= 1 || pid === process.pid) continue
          try { process.kill(pid, 'SIGKILL') } catch { /* 已退出。 */ }
        }
        rmSync(directory, { recursive: true, force: true })
      }
    }, 20_000)
  }

  for (const [runtime, state] of [['pi', 'leased'], ['pi', 'evicted'], ['zima', 'evicted']] as const) {
    test(`生产 EOF 收束 ${runtime} 实际 MCP 工具的 ${state} 连接，租约不丢失且重启不重投工具`, async () => {
      interface ModelRequest { tools?: Array<{ function: { name: string; parameters: unknown } }> }
      const requests: ModelRequest[] = []
      const toolName = 'mcp__fixture__hold'
      const model = Bun.serve({ hostname: '127.0.0.1', port: 0, async fetch(request) {
        requests.push(await request.json() as ModelRequest)
        const frames = [{ delta: { role: 'assistant', tool_calls: [{ index: 0, id: 'held-mcp-tool', type: 'function',
          function: { name: toolName, arguments: JSON.stringify({ value: '隔离 MCP 输入' }) } }] }, finish_reason: null },
        { delta: {}, finish_reason: 'tool_calls' }]
        return new Response(frames.map((choice) => `data: ${JSON.stringify({ id: 'mcp-drain-fixture', object: 'chat.completion.chunk',
          model: 'axon-mcp-fixture', choices: [{ index: 0, ...choice }] })}\n\n`).join('') + 'data: [DONE]\n\n',
        { headers: { 'content-type': 'text/event-stream' } })
      } })
      const directory = mkdtempSync(join(tmpdir(), 'axon-server-drain-mcp-agent-')), marker = join(directory, 'mcp-call')
      const python = runtime === 'zima' ? join(directory, 'controlled-python') : undefined
      const runtimeTrace = join(directory, 'runtime-trace.jsonl')
      if (python) {
        const quote = (value: string) => `'${value.replaceAll("'", "'\\''")}'`
        writeFileSync(python, `#!/bin/sh\nexport AXON_ZIMA_TEST_TRACE=${quote(runtimeTrace)}\nexec ${quote(process.execPath)} ${quote(join(import.meta.dir, '../../../packages/runtime-adapters/src/fixtures/fake-zima-runtime.mjs'))}\n`)
        chmodSync(python, 0o700)
      }
      const codec = createFixtureCredentialCodec(), f = open(directory, { codec, python }), approvals: AppServerAgentRunEvent[] = []
      let restarted: ReturnType<typeof open> | undefined, pid: number | undefined
      let runtimePid: number | undefined
      f.peer.handle(reverse.AGENT_PERMISSION, (params) => {
        const packet = params as unknown as AppServerAgentRunEvent, event = packet.event.event
        if (event.type !== 'permission_request') throw new Error('MCP 夹具收到错误审批')
        approvals.push(packet)
        return { requestId: event.request.requestId, behavior: 'allow' }
      })
      try {
        const initialized = await f.initialize(), main = await f.register()
        if (runtime === 'pi') expect(initialized.capabilities.runtimes.find((item) => item.runtimeId === 'pi')?.sandbox.supported).toBe(true)
        else expect(initialized.capabilities.runtimes.find((item) => item.runtimeId === 'zima'))
          .toMatchObject({ configured: true, sandbox: { supported: false } })
        const project = await f.request(main, methods.PROJECT_CREATE, { name: 'MCP 工具在途' }) as unknown as AgentProject
        const config = { version: 1, servers: { fixture: { type: 'stdio', command: process.execPath,
          args: [join(import.meta.dir, '../../../packages/core/test-support/mcp-stubborn-stdio-fixture.mjs'), marker, 'held-tool'],
          enabled: true, required: true, startupTimeoutMs: 2_000, requestTimeoutMs: 30_000 } } }
        await f.request(main, methods.MCP_SAVE_CONFIG, { projectId: project.id, config })
        const channel = await f.request(main, methods.CHANNEL_CREATE, { name: 'MCP 本机模型', provider: 'custom', apiKey: runtime === 'zima' ? 'sk-zima-mcp-fixture' : '',
          baseUrl: `http://127.0.0.1:${model.port}/v1`, models: [{ id: 'axon-mcp-fixture', name: '夹具', enabled: true }] }) as unknown as Channel
        const session = await f.request(main, methods.AGENT_CREATE_SESSION, { runtimeId: runtime, projectId: project.id, channelId: channel.id,
          modelId: 'axon-mcp-fixture', title: '不生成标题' }) as unknown as AgentSessionMeta
        const running = f.request(main, methods.AGENT_SEND, { sessionId: session.id, text: runtime === 'zima' ? 'mcp' : '执行隔离 MCP 工具' }).catch((error: unknown) => error)
        const deadline = Date.now() + 5_000
        while (!existsSync(`${marker}.calls.jsonl`) && Date.now() < deadline) await Bun.sleep(10)
        expect(existsSync(`${marker}.calls.jsonl`)).toBe(true)
        pid = Number(readFileSync(`${marker}.pid`, 'utf8'))
        expect(Number.isSafeInteger(pid) && pid > 1 && pid !== process.pid).toBe(true)
        expect(() => process.kill(pid!, 0)).not.toThrow()
        expect(requests).toHaveLength(runtime === 'pi' ? 1 : 0)
        if (runtime === 'pi') expect(requests[0]?.tools?.find((tool) => tool.function.name === toolName)?.function.parameters)
          .toMatchObject({ type: 'object', required: ['value'], properties: { value: { type: 'string' } } })
        else {
          const entries = readRuntimeTrace(runtimeTrace)
          runtimePid = entries.find((entry) => entry.method === 'started')?.pid
          expect(Number.isSafeInteger(runtimePid) && runtimePid! > 1 && runtimePid !== process.pid).toBe(true)
          expect(() => process.kill(runtimePid!, 0)).not.toThrow()
          expect(entries.some((entry) => entry.method === 'host_tool.resolve')).toBe(false)
        }
        expect(approvals).toHaveLength(1)
        expect(approvals[0]).toMatchObject({ clientId: main.clientId, event: { run: { sessionId: session.id },
          event: { type: 'permission_request', request: { toolName } } } })
        const calls = readFileSync(`${marker}.calls.jsonl`, 'utf8')
        expect(calls.trim().split('\n').map((line) => JSON.parse(line) as unknown))
          .toEqual([{ pid, params: { name: 'hold', arguments: { value: '隔离 MCP 输入' } } }])
        if (state === 'evicted') {
          // 配置保存使旧连接离开缓存；在途租约仍需保留，不能立即中断或从退出清单消失。
          await f.request(main, methods.MCP_SAVE_CONFIG, { projectId: project.id, config: { version: 1, servers: {} } })
          expect(await f.request(main, methods.MCP_GET_CONFIG, project.id)).toEqual({ version: 1, servers: {} })
          expect(() => process.kill(pid!, 0)).not.toThrow()
          expect(existsSync(`${marker}.eof`)).toBe(false)
          expect(existsSync(`${marker}.term`)).toBe(false)
        }
        expect(await f.request(main, methods.AGENT_GET_RUN, session.id)).toMatchObject({ sessionId: session.id })

        // 服务退出主动关闭包括已淘汰但仍被占用的连接，等真实 SDK/stdio close 后才完成。
        expect(await f.eof()).toBe(0)
        await running
        expect(existsSync(`${marker}.eof`)).toBe(true)
        expect(existsSync(`${marker}.term`)).toBe(true)
        let gone: unknown
        try { process.kill(pid, 0) } catch (error) { gone = error }
        expect(gone).toMatchObject({ code: 'ESRCH' })
        expect(readFileSync(`${marker}.calls.jsonl`, 'utf8')).toBe(calls)
        expect(requests).toHaveLength(runtime === 'pi' ? 1 : 0)
        expect(f.stderr).not.toContain('退出异常')
        if (runtimePid) {
          let gone: unknown
          try { process.kill(runtimePid, 0) } catch (error) { gone = error }
          expect(gone).toMatchObject({ code: 'ESRCH' })
          expect(readFileSync(runtimeTrace, 'utf8')).not.toContain('host_tool.resolve')
        }

        restarted = open(directory, { codec, python })
        await restarted.initialize()
        const observer = await restarted.register('quick')
        const history = await new AppServerHistoryClient(restarted.peer, observer.clientId).read({ kind: 'agent', sessionId: session.id })
        expect(history.filter((message) => message.type === 'user')).toHaveLength(1)
        expect(history.filter((message) => message.type === 'result')).toHaveLength(1)
        expect(history.filter((message) => message.type === 'result')).toMatchObject([{ terminal_reason: 'stopped', stopped_by_user: true }])
        if (runtime === 'pi') expect(JSON.stringify(history)).toContain('held-mcp-tool')
        expect(JSON.stringify(history)).toContain(toolName)
        expect(JSON.stringify(history)).toContain('隔离 MCP 输入')
        expect(await restarted.request(observer, methods.AGENT_LIST_ACTIVE_RUNS)).toEqual([])
        expect(await restarted.request(observer, methods.MCP_GET_CONFIG, project.id)).toMatchObject(state === 'evicted'
          ? { version: 1, servers: {} } : config)
        expect(await restarted.eof()).toBe(0)
        expect(readFileSync(`${marker}.calls.jsonl`, 'utf8')).toBe(calls)
        expect(Number(readFileSync(`${marker}.pid`, 'utf8'))).toBe(pid)
        expect(requests).toHaveLength(runtime === 'pi' ? 1 : 0)
      } finally {
        await f.close(); await restarted?.close(); model.stop(true)
        for (const candidate of [pid, runtimePid]) {
          if (!candidate || !Number.isSafeInteger(candidate) || candidate <= 1 || candidate === process.pid) continue
          try { process.kill(candidate, 'SIGKILL') } catch { /* 已退出。 */ }
        }
        rmSync(directory, { recursive: true, force: true })
      }
    }, 25_000)
  }

  for (const mode of ['EOF', 'SIGTERM'] as const) {
    test(`生产 ${mode} 收束在途 Chat/Pi 与未执行队列：真实模型连接关闭，重启保留唯一停止终态`, async () => {
      // 监听成功后才创建数据，受限监听不能遗留测试目录或伪造通过。
      const model = await openHeldModel('all')
      const directory = mkdtempSync(join(tmpdir(), 'axon-server-drain-runs-')), f = open(directory)
      let restarted: ReturnType<typeof open> | undefined
      const events: RpcJsonValue[] = []
      f.peer.handleNotification(notices.CHAT_GENERATION, (event) => { events.push(event) })
      f.peer.handleNotification(notices.AGENT_RUN, (event) => { events.push(event) })
      try {
        const initialized = await f.initialize(), main = await f.register()
        expect(initialized.capabilities.runtimes.find((runtime) => runtime.runtimeId === 'pi')?.sandbox.supported).toBe(true)
        const channel = await f.request(main, methods.CHANNEL_CREATE, { name: '退出本机模型', provider: 'custom', apiKey: '',
          baseUrl: model.baseUrl, models: [{ id: 'axon-drain-fixture', name: '夹具', enabled: true }] }) as unknown as Channel
        const project = await f.request(main, methods.PROJECT_CREATE, { name: '在途模型' }) as unknown as AgentProject
        const agent = await f.request(main, methods.AGENT_CREATE_SESSION, { projectId: project.id, channelId: channel.id,
          modelId: 'axon-drain-fixture', title: '不生成标题' }) as unknown as AgentSessionMeta
        const chat = await f.request(main, methods.CHAT_CREATE_CONVERSATION, { channelId: channel.id,
          modelId: 'axon-drain-fixture', title: '不生成标题' }) as unknown as ConversationMeta
        const agentRun = f.request(main, methods.AGENT_SEND, { sessionId: agent.id, text: '在途 Agent' }).catch((error: unknown) => error)
        const chatRun = f.request(main, methods.CHAT_SEND, { conversationId: chat.id, text: '在途 Chat' }).catch((error: unknown) => error)
        const deadline = Date.now() + 5_000
        while ((!JSON.stringify(events).includes('agent 局部内容') || !JSON.stringify(events).includes('chat 局部内容'))
          && Date.now() < deadline) await Bun.sleep(10)
        expect(model.pending.map((entry) => entry.kind).sort()).toEqual(['agent', 'chat'])
        expect(JSON.stringify(events)).toContain('agent 局部内容')
        expect(JSON.stringify(events)).toContain('chat 局部内容')
        expect(model.connections).toBeGreaterThanOrEqual(2)
        expect(await f.request(main, methods.AGENT_SEND, { sessionId: agent.id, text: '退出时不能执行的队列' }))
          .toMatchObject({ disposition: 'queued' })
        if (mode === 'EOF') f.child.stdin.end()
        else f.child.kill('SIGTERM')
        expect(await f.exited).toBe(0)
        await Promise.all([agentRun, chatRun])
        const closing = Date.now() + 1_000
        while (model.connections > 0 && Date.now() < closing) await Bun.sleep(10)
        expect(model.connections).toBe(0)
        expect(model.closedConnections).toBeGreaterThanOrEqual(2)
        expect(model.requests).toBe(2)
        expect(f.stderr).not.toContain('退出异常')

        // 新进程只读取持久化结果，不靠退出时已失效的页面事件判断保存成功。
        restarted = open(directory)
        await restarted.initialize()
        const observer = await restarted.register('quick'), histories = new AppServerHistoryClient(restarted.peer, observer.clientId)
        const chatHistory = await histories.read({ kind: 'chat', conversationId: chat.id })
        expect(chatHistory.map((message) => message.status)).toEqual(['complete', 'stopped'])
        expect(JSON.stringify(chatHistory)).toContain('chat 局部内容')
        const agentHistory = await histories.read({ kind: 'agent', sessionId: agent.id })
        expect(agentHistory.filter((message) => message.type === 'result')).toMatchObject([{ terminal_reason: 'stopped', stopped_by_user: true }])
        expect(agentHistory.filter((message) => message.type === 'user')).toHaveLength(1)
        expect(JSON.stringify(agentHistory)).not.toContain('退出时不能执行的队列')
        expect(await restarted.request(observer, methods.AGENT_LIST_ACTIVE_RUNS)).toEqual([])
        expect(await restarted.eof()).toBe(0)
      } finally { await f.close(); await restarted?.close(); await model.close(); rmSync(directory, { recursive: true, force: true }) }
    }, 30_000)
  }

  test('生产 EOF 也取消已完成轮次的两个后台标题，实际连接关闭且重启不保存未完成标题', async () => {
    const model = await openHeldModel('titles')
    const directory = mkdtempSync(join(tmpdir(), 'axon-server-drain-titles-')), f = open(directory)
    let restarted: ReturnType<typeof open> | undefined
    try {
      const initialized = await f.initialize(), main = await f.register()
      expect(initialized.capabilities.runtimes.find((runtime) => runtime.runtimeId === 'pi')?.sandbox.supported).toBe(true)
      const channel = await f.request(main, methods.CHANNEL_CREATE, { name: '后台标题模型', provider: 'custom', apiKey: '',
        baseUrl: model.baseUrl, models: [{ id: 'axon-drain-fixture', name: '夹具', enabled: true }] }) as unknown as Channel
      const project = await f.request(main, methods.PROJECT_CREATE, { name: '后台标题' }) as unknown as AgentProject
      const agent = await f.request(main, methods.AGENT_CREATE_SESSION, { projectId: project.id, channelId: channel.id,
        modelId: 'axon-drain-fixture' }) as unknown as AgentSessionMeta
      const chat = await f.request(main, methods.CHAT_CREATE_CONVERSATION, { channelId: channel.id,
        modelId: 'axon-drain-fixture' }) as unknown as ConversationMeta
      await Promise.all([
        f.request(main, methods.AGENT_SEND, { sessionId: agent.id, text: '生成标题 Agent' }),
        f.request(main, methods.CHAT_SEND, { conversationId: chat.id, text: '生成标题 Chat' }),
      ])
      const deadline = Date.now() + 5_000
      while (model.pending.length < 2 && Date.now() < deadline) await Bun.sleep(10)
      expect(model.pending.map((entry) => entry.kind)).toEqual(['title', 'title'])
      expect(model.connections).toBeGreaterThanOrEqual(2)
      expect(await f.request(main, methods.AGENT_LIST_ACTIVE_RUNS)).toEqual([])
      expect(await f.eof()).toBe(0)
      const closing = Date.now() + 1_000
      while (model.connections > 0 && Date.now() < closing) await Bun.sleep(10)
      expect(model.connections).toBe(0)
      expect(model.closedConnections).toBeGreaterThanOrEqual(2)
      expect(model.requests).toBe(4)
      expect(f.stderr).not.toContain('退出异常')
      restarted = open(directory)
      await restarted.initialize()
      const observer = await restarted.register()
      expect(await restarted.request(observer, methods.AGENT_GET_SESSION, agent.id)).toMatchObject({ title: DEFAULT_AGENT_SESSION_TITLE })
      expect(await restarted.request(observer, methods.CHAT_GET_CONVERSATION, chat.id)).toMatchObject({ title: DEFAULT_CONVERSATION_TITLE })
      const histories = new AppServerHistoryClient(restarted.peer, observer.clientId)
      expect((await histories.read({ kind: 'agent', sessionId: agent.id })).filter((message) => message.type === 'result'))
        .toMatchObject([{ subtype: 'success' }])
      expect((await histories.read({ kind: 'chat', conversationId: chat.id })).map((message) => message.status)).toEqual(['complete', 'complete'])
      expect(await restarted.eof()).toBe(0)
    } finally { await f.close(); await restarted?.close(); await model.close(); rmSync(directory, { recursive: true, force: true }) }
  }, 30_000)

  for (const target of ['main', 'background'] as const) {
    test(`生产 EOF 收束 ${target} Agent 的真实 Seatbelt Bash 进程组，重启保留工具轨迹与停止状态`, async () => {
      interface ModelRequest { messages: Array<{ role: string; content: unknown }>; tools?: Array<{ function: { name: string } }> }
      const requests: ModelRequest[] = []
      const command = '/bin/sh -c \'trap "" TERM; echo $$ > tool-shell.pid; /bin/sleep 60 & echo $! > tool-helper.pid; wait\''
      const model = Bun.serve({ hostname: '127.0.0.1', port: 0, async fetch(request) {
        const body = await request.json() as ModelRequest
        requests.push(body)
        const root = target === 'background' && body.tools?.some((tool) => tool.function.name === 'Agent')
        const hasResult = body.messages.some((message) => message.role === 'tool')
        const toolName = root ? 'Agent' : 'bash'
        const arguments_ = root ? { description: '隔离后台工具', prompt: '执行隔离 Bash 并保持运行',
          subagent_type: 'coder', run_in_background: true } : { command }
        const delta = hasResult ? { role: 'assistant', content: '后台工具已启动' } : {
          role: 'assistant', tool_calls: [{ index: 0, id: root ? 'background-delegate' : 'stubborn-bash', type: 'function',
            function: { name: toolName, arguments: JSON.stringify(arguments_) } }],
        }
        const frames = [{ delta, finish_reason: null }, { delta: {}, finish_reason: hasResult ? 'stop' : 'tool_calls' }]
        return new Response(frames.map((choice) => `data: ${JSON.stringify({ id: 'tool-drain-fixture', object: 'chat.completion.chunk',
          model: 'axon-tool-fixture', choices: [{ index: 0, ...choice }] })}\n\n`).join('') + 'data: [DONE]\n\n',
        { headers: { 'content-type': 'text/event-stream' } })
      } })
      const directory = mkdtempSync(join(tmpdir(), 'axon-server-drain-tools-')), f = open(directory)
      let restarted: ReturnType<typeof open> | undefined, task: AgentDelegation | undefined
      const pids: number[] = [], taskEvents: RpcJsonValue[] = []
      f.peer.handleNotification(notices.TASK_EVENT, (event) => { taskEvents.push(event) })
      try {
        const initialized = await f.initialize(), main = await f.register()
        expect(initialized.capabilities.runtimes.find((runtime) => runtime.runtimeId === 'pi')?.sandbox.supported).toBe(true)
        const channel = await f.request(main, methods.CHANNEL_CREATE, { name: '真实工具本机模型', provider: 'custom', apiKey: '',
          baseUrl: `http://127.0.0.1:${model.port}/v1`, models: [{ id: 'axon-tool-fixture', name: '夹具', enabled: true }] }) as unknown as Channel
        const project = await f.request(main, methods.PROJECT_CREATE, { name: '工具进程组' }) as unknown as AgentProject
        const workspace = join(f.data, 'agent-projects', project.slug, 'workspace-files')
        const root = await f.request(main, methods.AGENT_CREATE_SESSION, { projectId: project.id, channelId: channel.id,
          modelId: 'axon-tool-fixture', title: '不生成标题' }) as unknown as AgentSessionMeta
        if (target === 'background') await f.request(main, methods.TASK_SUBSCRIBE)
        const running = f.request(main, methods.AGENT_SEND, { sessionId: root.id, text: '启动隔离工具' }).catch((error: unknown) => error)
        const marker = join(workspace, 'tool-helper.pid'), deadline = Date.now() + 5_000
        while (!existsSync(marker) && Date.now() < deadline) await Bun.sleep(10)
        expect(existsSync(marker)).toBe(true)
        for (const filename of ['tool-shell.pid', 'tool-helper.pid']) {
          const pid = Number(readFileSync(join(workspace, filename), 'utf8'))
          expect(Number.isSafeInteger(pid) && pid > 0).toBe(true)
          pids.push(pid)
          expect(() => process.kill(pid, 0)).not.toThrow()
        }
        if (target === 'background') {
          // 父轮已成功结束，子任务仍执行：退出不能只等待主运行表。
          expect(await running).toEqual({ success: true, disposition: 'started' })
          const tasks = await f.request(main, methods.TASK_LIST, root.id) as unknown as AgentDelegation[]
          expect(tasks).toHaveLength(1)
          task = tasks[0]!
          expect(task).toMatchObject({ status: 'running', runInBackground: true })
          expect(JSON.stringify(taskEvents)).toContain('stubborn-bash')
        }
        const countBeforeExit = requests.length
        expect(countBeforeExit).toBe(target === 'background' ? 3 : 1)
        expect(await f.eof()).toBe(0)
        await running
        for (const pid of pids) {
          let error: unknown
          try { process.kill(pid, 0) } catch (caught) { error = caught }
          expect(error).toMatchObject({ code: 'ESRCH' })
        }
        expect(requests.length).toBe(countBeforeExit)
        expect(f.stderr).not.toContain('退出异常')

        restarted = open(directory)
        await restarted.initialize()
        const observer = await restarted.register('quick'), histories = new AppServerHistoryClient(restarted.peer, observer.clientId)
        const rootHistory = await histories.read({ kind: 'agent', sessionId: root.id })
        expect(rootHistory.filter((message) => message.type === 'result')).toHaveLength(1)
        expect(rootHistory.filter((message) => message.type === 'result')).toMatchObject([
          target === 'background' ? { subtype: 'success' } : { terminal_reason: 'stopped', stopped_by_user: true },
        ])
        const toolHistory = task ? await histories.read({ kind: 'task', rootSessionId: root.id, taskId: task.id }) : rootHistory
        expect(JSON.stringify(toolHistory)).toContain('stubborn-bash')
        expect(JSON.stringify(toolHistory)).toContain('tool-helper.pid')
        expect(toolHistory.filter((message) => message.type === 'result')).toHaveLength(1)
        expect(toolHistory.filter((message) => message.type === 'result')).toMatchObject([{ terminal_reason: 'stopped', stopped_by_user: true }])
        if (task) expect(await restarted.request(observer, methods.TASK_GET, { rootSessionId: root.id, taskId: task.id }))
          .toMatchObject({ status: 'canceled', childSessionId: task.childSessionId })
        expect(await restarted.request(observer, methods.AGENT_LIST_ACTIVE_RUNS)).toEqual([])
        expect(await restarted.eof()).toBe(0)
      } finally {
        await f.close(); await restarted?.close(); model.stop(true)
        // 仅兜底由隔离工具写入并验证过的 PID；正常路径必须由生产退出回收。
        for (const pid of pids) { try { process.kill(pid, 'SIGKILL') } catch { /* 已退出。 */ } }
        rmSync(directory, { recursive: true, force: true })
      }
    }, 30_000)
  }

  test('后台子任务已完成并自动续跑父轮时 EOF，等待完成回调与模型取消，重启不重复交付结果', async () => {
    const model = await openHeldModel('background-result')
    const directory = mkdtempSync(join(tmpdir(), 'axon-server-drain-background-result-')), f = open(directory)
    let restarted: ReturnType<typeof open> | undefined
    const events: RpcJsonValue[] = []
    f.peer.handleNotification(notices.AGENT_RUN, (event) => { events.push(event) })
    try {
      const initialized = await f.initialize(), main = await f.register()
      expect(initialized.capabilities.runtimes.find((runtime) => runtime.runtimeId === 'pi')?.sandbox.supported).toBe(true)
      const channel = await f.request(main, methods.CHANNEL_CREATE, { name: '后台结果本机模型', provider: 'custom', apiKey: '',
        baseUrl: model.baseUrl, models: [{ id: 'axon-drain-fixture', name: '夹具', enabled: true }] }) as unknown as Channel
      const project = await f.request(main, methods.PROJECT_CREATE, { name: '后台结果续跑' }) as unknown as AgentProject
      const root = await f.request(main, methods.AGENT_CREATE_SESSION, { projectId: project.id, channelId: channel.id,
        modelId: 'axon-drain-fixture', title: '不生成标题' }) as unknown as AgentSessionMeta
      expect(await f.request(main, methods.AGENT_SEND, { sessionId: root.id, text: '创建后台任务' }))
        .toEqual({ success: true, disposition: 'started' })
      const deadline = Date.now() + 5_000
      while (!JSON.stringify(events).includes('后台结果续跑局部内容') && Date.now() < deadline) await Bun.sleep(10)
      expect(model.pending.map((entry) => entry.kind)).toEqual(['notification'])
      expect(JSON.stringify(events)).toContain('后台结果续跑局部内容')
      expect(model.connections).toBeGreaterThanOrEqual(1)
      const tasks = await f.request(main, methods.TASK_LIST, root.id) as unknown as AgentDelegation[]
      expect(tasks).toHaveLength(1)
      const task = tasks[0]!
      expect(task).toMatchObject({ status: 'completed', runInBackground: true })
      expect(model.requests).toBe(4)
      expect(await f.eof()).toBe(0)
      const closing = Date.now() + 1_000
      while (model.connections > 0 && Date.now() < closing) await Bun.sleep(10)
      expect(model.connections).toBe(0)
      expect(model.closedConnections).toBeGreaterThanOrEqual(4)
      expect(f.stderr).not.toContain('退出异常')
      restarted = open(directory)
      await restarted.initialize()
      const observer = await restarted.register('quick'), histories = new AppServerHistoryClient(restarted.peer, observer.clientId)
      const history = await histories.read({ kind: 'agent', sessionId: root.id })
      const results = history.filter((message) => message.type === 'result')
      expect(results).toHaveLength(2)
      expect(results).toMatchObject([{ subtype: 'success' }, { terminal_reason: 'stopped', stopped_by_user: true }])
      expect(history.filter((message) => message.type === 'user' && message.isSynthetic)).toHaveLength(1)
      // Pi 停止时不保存半截 aborted assistant；已交付的合成结果和唯一终态才是恢复边界。
      expect(JSON.stringify(history.filter((message) => message.type === 'user' && message.isSynthetic))).toContain(task.id)
      expect(await restarted.request(observer, methods.TASK_GET, { rootSessionId: root.id, taskId: task.id }))
        .toMatchObject({ status: 'completed', resultSummary: task.resultSummary })
      expect((await histories.read({ kind: 'task', rootSessionId: root.id, taskId: task.id }))
        .filter((message) => message.type === 'result')).toMatchObject([{ subtype: 'success' }])
      expect(await restarted.request(observer, methods.AGENT_LIST_ACTIVE_RUNS)).toEqual([])
      expect(model.requests).toBe(4)
      expect(await restarted.eof()).toBe(0)
    } finally { await f.close(); await restarted?.close(); await model.close(); rmSync(directory, { recursive: true, force: true }) }
  }, 30_000)

  test('完整后端 Chat 请求本机模型、保存原文并重启恢复；父端不装配业务服务', async () => {
    const requests: unknown[] = []
    const model = Bun.serve({ hostname: '127.0.0.1', port: 0, async fetch(request) {
      requests.push(await request.json())
      return new Response('data: {"object":"chat.completion.chunk","choices":[{"index":0,"delta":{"content":"独立进程回复"},"finish_reason":null}]}\n\ndata: {"object":"chat.completion.chunk","choices":[{"index":0,"delta":{},"finish_reason":"stop"}]}\n\ndata: [DONE]\n\n',
        { headers: { 'content-type': 'text/event-stream' } })
    } })
    const directory = mkdtempSync(join(tmpdir(), 'axon-independent-chat-'))
    const f = open(directory), events: RpcJsonValue[] = []
    let restarted: ReturnType<typeof open> | undefined
    f.peer.handleNotification(notices.CHAT_GENERATION, (params) => { events.push(params) })
    try {
      await f.initialize()
      const main = await f.register()
      const channel = await f.request(main, methods.CHANNEL_CREATE, { name: '本机模型', provider: 'custom', apiKey: '',
        baseUrl: `http://127.0.0.1:${model.port}/v1`, models: [{ id: 'axon-fixture', name: '夹具', enabled: true }] }) as unknown as Channel
      const conversation = await f.request(main, methods.CHAT_CREATE_CONVERSATION, { channelId: channel.id, modelId: 'axon-fixture' }) as unknown as ConversationMeta
      expect(await f.request(main, methods.CHAT_SEND, { conversationId: conversation.id, text: '真实子进程输入' })).toMatchObject({ success: true })
      const messages = await new AppServerHistoryClient(f.peer, main.clientId).read({ kind: 'chat', conversationId: conversation.id })
      expect(messages.map((message) => message.content)).toEqual([[{ type: 'text', text: '真实子进程输入' }], [{ type: 'text', text: '独立进程回复' }]])
      expect(requests.length).toBeGreaterThanOrEqual(1)
      expect(JSON.stringify(events)).toContain('独立进程回复')
      expect(await f.eof()).toBe(0)
      restarted = open(directory)
      await restarted.initialize()
      const quick = await restarted.register('quick')
      expect(await new AppServerHistoryClient(restarted.peer, quick.clientId).read({ kind: 'chat', conversationId: conversation.id })).toEqual(messages)
    } finally { await f.close(); await restarted?.close(); model.stop(true); rmSync(directory, { recursive: true, force: true }) }
  }, 20_000)

  test('完整后端 Pi 使用真实 SDK/宿主 Read 工具循环、定向事件及 artifact 重启续跑', async () => {
    interface ModelRequest { messages: Array<{ role: string; content?: unknown }>; tools?: Array<{ function: { name: string } }> }
    const requests: ModelRequest[] = []
    const model = Bun.serve({ hostname: '127.0.0.1', port: 0, async fetch(request) {
      const body = await request.json() as ModelRequest
      requests.push(body)
      const useRead = body.tools?.some((tool) => tool.function.name === 'read') && !body.messages.some((message) => message.role === 'tool')
      const delta = useRead ? { role: 'assistant', tool_calls: [{ index: 0, id: 'read-probe', type: 'function',
        function: { name: 'read', arguments: '{"path":"probe.txt"}' } }] } : { role: 'assistant', content: '宿主文件已读取' }
      const frames = [{ choices: [{ index: 0, delta, finish_reason: null }] }, { choices: [{ index: 0, delta: {}, finish_reason: useRead ? 'tool_calls' : 'stop' }] }]
      return new Response(frames.map((frame) => `data: ${JSON.stringify({ id: 'fixture', object: 'chat.completion.chunk', model: 'axon-fixture', ...frame })}\n\n`).join('') + 'data: [DONE]\n\n',
        { headers: { 'content-type': 'text/event-stream' } })
    } })
    const directory = mkdtempSync(join(tmpdir(), 'axon-independent-pi-'))
    const f = open(directory), events: AppServerAgentRunEvent[] = []
    let restarted: ReturnType<typeof open> | undefined
    f.peer.handleNotification(notices.AGENT_RUN, (params) => { events.push(params as unknown as AppServerAgentRunEvent) })
    try {
      const initialized = await f.initialize(), main = await f.register()
      const project = await f.request(main, methods.PROJECT_CREATE, { name: '宿主读取' }) as unknown as AgentProject
      writeFileSync(join(f.data, 'agent-projects', project.slug, 'workspace-files/probe.txt'), '来自实际宿主文件')
      const channel = await f.request(main, methods.CHANNEL_CREATE, { name: 'Pi 本机模型', provider: 'custom', apiKey: '',
        baseUrl: `http://127.0.0.1:${model.port}/v1`, models: [{ id: 'axon-fixture', name: '夹具', enabled: true }] }) as unknown as Channel
      const session = await f.request(main, methods.AGENT_CREATE_SESSION, { projectId: project.id, channelId: channel.id, modelId: 'axon-fixture' }) as unknown as AgentSessionMeta
      expect(await f.request(main, methods.AGENT_SEND, { sessionId: session.id, text: '读取 probe.txt' })).toEqual({ success: true, disposition: 'started' })
      const history = await new AppServerHistoryClient(f.peer, main.clientId).read({ kind: 'agent', sessionId: session.id })
      if (!initialized.capabilities.runtimes.find((runtime) => runtime.runtimeId === 'pi')?.sandbox.supported) {
        expect(requests).toEqual([])
        expect(JSON.stringify(history)).toContain('sandbox_unavailable')
        return
      }
      expect(JSON.stringify(requests)).toContain('来自实际宿主文件')
      expect(JSON.stringify(history)).toContain('宿主文件已读取')
      expect(events.every((event) => event.clientId === main.clientId && event.event.run.sessionId === session.id)).toBe(true)
      expect(events.length).toBeGreaterThan(2)
      const metadata = await f.request(main, methods.AGENT_GET_SESSION, session.id) as unknown as AgentSessionMeta
      expect(metadata.runtimeSessionFile).toBeDefined()
      expect(existsSync(metadata.runtimeSessionFile!)).toBe(true)
      expect(await f.eof()).toBe(0)
      restarted = open(directory)
      await restarted.initialize()
      const quick = await restarted.register('quick')
      expect(await restarted.request(quick, methods.AGENT_SEND, { sessionId: session.id, text: '继续回答' })).toEqual({ success: true, disposition: 'started' })
      expect(JSON.stringify(requests.at(-1)?.messages)).toContain('继续回答')
      expect(JSON.stringify(requests.at(-1)?.messages)).toContain('读取 probe.txt')
      const restored = await new AppServerHistoryClient(restarted.peer, quick.clientId).read({ kind: 'agent', sessionId: session.id })
      expect(restored.slice(0, history.length)).toEqual(history)
      expect(restored.slice(history.length).map((message) => message.type)).toEqual(['user', 'system', 'assistant', 'result'])
    } finally { await f.close(); await restarted?.close(); model.stop(true); rmSync(directory, { recursive: true, force: true }) }
  }, 30_000)

  for (const stage of ['handshake', 'accept', 'group', 'approval'] as const) {
    test(`生产 EOF 收束 Zima ${stage} 在途进程：重启保留唯一停止终态，不发布未接受的 artifact`, async () => {
      const directory = mkdtempSync(join(tmpdir(), 'axon-server-drain-zima-'))
      const executable = join(directory, 'controlled-python'), trace = join(directory, 'runtime-trace.jsonl')
      const runtimeFixture = join(import.meta.dir, '../../../packages/runtime-adapters/src/fixtures/fake-zima-runtime.mjs')
      const quote = (value: string) => `'${value.replaceAll("'", "'\\''")}'`
      const accepted = stage === 'group' || stage === 'approval'
      // 只用受控离线进程制造等待；生产入口、adapter、运行协调与仓储均不替换。
      writeFileSync(executable, `#!/bin/sh\nexport AXON_ZIMA_TEST_MODE=${quote(accepted ? 'group' : stage)}\nexport AXON_ZIMA_TEST_TRACE=${quote(trace)}\nexec ${quote(process.execPath)} ${quote(runtimeFixture)}\n`)
      chmodSync(executable, 0o700)
      const readTrace = () => readRuntimeTrace(trace)
      const codec = createFixtureCredentialCodec(), f = open(directory, { python: executable, codec })
      let restarted: ReturnType<typeof open> | undefined
      let pids: number[] = []
      let permission: { packet: AppServerAgentRunEvent; signal: AbortSignal } | undefined
      const lateApproval = Promise.withResolvers<void>(), approvalReturned = Promise.withResolvers<void>()
      const events: RpcJsonValue[] = []
      f.peer.handleNotification(notices.AGENT_RUN, (event) => { events.push(event) })
      f.peer.handle(reverse.AGENT_PERMISSION, async (params, { signal }) => {
        const packet = params as unknown as AppServerAgentRunEvent, event = packet.event.event
        if (event.type !== 'permission_request') throw new Error('审批夹具收到错误请求')
        permission = { packet, signal }
        // 故意忽略取消直到服务已退出，证明迟到批准不能恢复旧运行或执行工具。
        try { await lateApproval.promise; return { requestId: event.request.requestId, behavior: 'allow' } }
        finally { approvalReturned.resolve() }
      })
      try {
        expect((await f.initialize()).capabilities.runtimes.find((runtime) => runtime.runtimeId === 'zima'))
          .toMatchObject({ configured: true, sandbox: { supported: false } })
        const main = await f.register(), project = await f.request(main, methods.PROJECT_CREATE, { name: 'Zima 在途退出' }) as unknown as AgentProject
        const channel = await f.request(main, methods.CHANNEL_CREATE, { name: 'Zima 离线渠道', provider: 'custom',
          apiKey: 'sk-zima-drain-fixture', baseUrl: 'http://127.0.0.1:1/v1',
          models: [{ id: 'fake-model', name: '夹具', enabled: true }] }) as unknown as Channel
        const session = await f.request(main, methods.AGENT_CREATE_SESSION, { runtimeId: 'zima', projectId: project.id,
          channelId: channel.id, modelId: 'fake-model', title: '避免标题网络请求' }) as unknown as AgentSessionMeta
        const running = f.request(main, methods.AGENT_SEND, { sessionId: session.id, text: stage === 'approval' ? 'approval' : 'abort' }).catch((error: unknown) => error)
        const readyMethod = stage === 'handshake' ? 'runtime.handshake' : 'session.run'
        const deadline = Date.now() + 5_000
        while ((!readTrace().some((entry) => entry.method === readyMethod)
          || accepted && (!readTrace().some((entry) => entry.method === 'helper')
            || !JSON.stringify(events).includes('"subtype":"init"'))
          || stage === 'approval' && !permission) && Date.now() < deadline) await Bun.sleep(10)
        const before = readTrace()
        expect(before.some((entry) => entry.method === readyMethod)).toBe(true)
        expect(before.filter((entry) => entry.method === 'session.run')).toHaveLength(stage === 'handshake' ? 0 : 1)
        pids = before.filter((entry) => entry.method === 'started' || entry.method === 'helper').map((entry) => entry.pid)
        expect(pids).toHaveLength(accepted ? 2 : 1)
        for (const pid of pids) {
          expect(Number.isSafeInteger(pid) && pid > 1 && pid !== process.pid).toBe(true)
          expect(() => process.kill(pid, 0)).not.toThrow()
        }
        const metadata = await f.request(main, methods.AGENT_GET_SESSION, session.id) as unknown as AgentSessionMeta
        if (accepted) {
          expect(metadata.sdkSessionId).toBe(session.id)
          expect(metadata.runtimeSessionFile?.startsWith(f.data + '/')).toBe(true)
          expect(existsSync(metadata.runtimeSessionFile!)).toBe(true)
        } else {
          expect(metadata.sdkSessionId).toBeUndefined()
          expect(metadata.runtimeSessionFile).toBeUndefined()
        }
        if (stage === 'approval') {
          expect(permission?.packet.clientId).toBe(main.clientId)
          expect(permission?.packet.event.run.sessionId).toBe(session.id)
          expect(permission?.signal.aborted).toBe(false)
          expect(before.some((entry) => entry.method === 'approval.resolve')).toBe(false)
        }

        // 忽略 TERM 的父进程/helper 必须实际退出；EOF 响应取消不能代替资源收束。
        expect(await f.eof()).toBe(0)
        await running
        if (stage === 'approval') {
          expect(permission?.signal.aborted).toBe(true)
          lateApproval.resolve()
          await approvalReturned.promise
        }
        for (const pid of pids) {
          let alive = true
          try { process.kill(pid, 0) }
          catch (error) { expect(error).toMatchObject({ code: 'ESRCH' }); alive = false }
          expect(alive).toBe(false)
        }
        const after = readTrace()
        expect(after.filter((entry) => entry.method === 'session.run')).toHaveLength(stage === 'handshake' ? 0 : 1)
        if (stage === 'approval') {
          expect(after.some((entry) => entry.method === 'approval.resolve')).toBe(false)
          expect(existsSync(join(f.data, 'agent-projects', project.slug, 'workspace-files/demo.txt'))).toBe(false)
        }
        expect(f.stderr).not.toContain('退出异常')
        expect(f.stderr).not.toContain(directory)
        expect(f.stderr).not.toContain('sk-zima-drain-fixture')

        // 新入口只恢复应用历史；不执行新查询，也不能复活已取消的初始化或自动重投。
        restarted = open(directory, { python: executable, codec })
        await restarted.initialize()
        const observer = await restarted.register('quick')
        const restored = await new AppServerHistoryClient(restarted.peer, observer.clientId).read({ kind: 'agent', sessionId: session.id })
        expect(restored.filter((message) => message.type === 'user')).toHaveLength(1)
        expect(restored.filter((message) => message.type === 'result'))
          .toMatchObject([{ terminal_reason: 'stopped', stopped_by_user: true }])
        expect(restored.filter((message) => message.type === 'system' && message.subtype === 'init')).toHaveLength(accepted ? 1 : 0)
        expect(await restarted.request(observer, methods.AGENT_GET_SESSION, session.id)).toMatchObject({
          runtimeId: 'zima', ...(accepted ? { sdkSessionId: session.id, runtimeSessionFile: metadata.runtimeSessionFile } : {}),
        })
        const restoredMeta = await restarted.request(observer, methods.AGENT_GET_SESSION, session.id) as unknown as AgentSessionMeta
        if (!accepted) {
          expect(restoredMeta.sdkSessionId).toBeUndefined()
          expect(restoredMeta.runtimeSessionFile).toBeUndefined()
        }
        expect(await restarted.request(observer, methods.AGENT_LIST_ACTIVE_RUNS)).toEqual([])
        expect(await restarted.eof()).toBe(0)
        expect(readTrace()).toEqual(after)
      } finally {
        lateApproval.resolve()
        await f.close(); await restarted?.close()
        // 仅兜底已从本测试 trace 核对的 PID；正常路径必须先证明生产链已回收。
        for (const pid of pids) {
          if (!Number.isSafeInteger(pid) || pid <= 1 || pid === process.pid) continue
          try { process.kill(pid, 'SIGKILL') } catch { /* 已退出。 */ }
        }
        rmSync(directory, { recursive: true, force: true })
      }
    }, 20_000)
  }

  for (const mode of ['EOF', 'SIGTERM'] as const) {
    test(`生产 ${mode} 撤销 Zima 追问，正常答案能回传但迟到答案不能恢复旧运行`, async () => {
      const directory = mkdtempSync(join(tmpdir(), 'axon-server-drain-zima-ask-'))
      const executable = join(directory, 'controlled-python'), trace = join(directory, 'runtime-trace.jsonl')
      const runtimeFixture = join(import.meta.dir, '../../../packages/runtime-adapters/src/fixtures/fake-zima-runtime.mjs')
      const quote = (value: string) => `'${value.replaceAll("'", "'\\''")}'`
      writeFileSync(executable, `#!/bin/sh\nexport AXON_ZIMA_TEST_MODE=group\nexport AXON_ZIMA_TEST_TRACE=${quote(trace)}\nexec ${quote(process.execPath)} ${quote(runtimeFixture)}\n`)
      chmodSync(executable, 0o700)
      const readTrace = () => readRuntimeTrace(trace)
      const codec = createFixtureCredentialCodec(), f = open(directory, { python: executable, codec })
      let restarted: ReturnType<typeof open> | undefined
      const asks: Array<{ packet: AppServerAgentRunEvent; signal: AbortSignal }> = [], pids: number[] = []
      const lateAnswer = Promise.withResolvers<void>(), answerReturned = Promise.withResolvers<void>()
      f.peer.handle(reverse.AGENT_ASK_USER, async (params, { signal }) => {
        const packet = params as unknown as AppServerAgentRunEvent, event = packet.event.event
        if (event.type !== 'ask_user_request') throw new Error('追问夹具收到错误请求')
        asks.push({ packet, signal })
        if (asks.length > 1) await lateAnswer.promise
        try { return { requestId: event.request.requestId, behavior: 'answer', answers: { '选择测试输出格式': '简洁' } } }
        finally { if (asks.length > 1) answerReturned.resolve() }
      })
      f.peer.handle(reverse.AGENT_PERMISSION, () => { throw new Error('受管追问不应要求普通工具审批') })
      try {
        expect((await f.initialize()).capabilities.runtimes.find((runtime) => runtime.runtimeId === 'zima'))
          .toMatchObject({ configured: true, sandbox: { supported: false } })
        const main = await f.register(), project = await f.request(main, methods.PROJECT_CREATE, { name: 'Zima 追问退出' }) as unknown as AgentProject
        const channel = await f.request(main, methods.CHANNEL_CREATE, { name: '追问离线渠道', provider: 'custom', apiKey: 'sk-zima-ask-fixture',
          baseUrl: 'http://127.0.0.1:1/v1', models: [{ id: 'fake-model', name: '夹具', enabled: true }] }) as unknown as Channel
        const session = await f.request(main, methods.AGENT_CREATE_SESSION, { runtimeId: 'zima', projectId: project.id,
          channelId: channel.id, modelId: 'fake-model', title: '避免标题网络请求' }) as unknown as AgentSessionMeta
        // 正向对照先证明实际工具参数、反向答复和 adapter 的答案转换，而不是仅制造无法解析的请求。
        expect(await f.request(main, methods.AGENT_SEND, { sessionId: session.id, text: 'ask-user' }))
          .toEqual({ success: true, disposition: 'started' })
        expect(asks).toHaveLength(1)
        const resolved = readTrace().filter((entry) => entry.method === 'interaction.resolve')
        expect(resolved).toHaveLength(1)
        expect(resolved[0]?.answers).toEqual([{ id: '选择测试输出格式', answer: '简洁' }])
        const successful = await new AppServerHistoryClient(f.peer, main.clientId).read({ kind: 'agent', sessionId: session.id })
        expect(successful.filter((message) => message.type === 'result')).toHaveLength(1)
        expect(successful.filter((message) => message.type === 'result')).toMatchObject([{ subtype: 'success', terminal_reason: 'completed' }])
        const previous = readTrace().length
        const running = f.request(main, methods.AGENT_SEND, { sessionId: session.id, text: 'ask-user' }).catch((error: unknown) => error)
        const deadline = Date.now() + 5_000
        while ((asks.length < 2 || !readTrace().slice(previous).some((entry) => entry.method === 'helper'))
          && Date.now() < deadline) await Bun.sleep(10)
        expect(asks).toHaveLength(2)
        const held = asks[1]!
        expect(held.packet.clientId).toBe(main.clientId)
        expect(held.packet.event.run.sessionId).toBe(session.id)
        expect(held.packet.event.run.runId).not.toBe(asks[0]!.packet.event.run.runId)
        expect(held.signal.aborted).toBe(false)
        expect(held.packet.event.event).toMatchObject({ type: 'ask_user_request', request: { questions: [
          { question: '选择测试输出格式', options: [{ label: '简洁' }, { label: '详细' }] },
        ] } })
        pids.push(...readTrace().slice(previous).filter((entry) => entry.method === 'started' || entry.method === 'helper').map((entry) => entry.pid))
        expect(pids).toHaveLength(2)
        for (const pid of pids) {
          expect(Number.isSafeInteger(pid) && pid > 1 && pid !== process.pid).toBe(true)
          expect(() => process.kill(pid, 0)).not.toThrow()
        }
        if (mode === 'EOF') f.child.stdin.end()
        else f.child.kill('SIGTERM')
        expect(await f.exited).toBe(0)
        await running
        expect(held.signal.aborted).toBe(true)
        lateAnswer.resolve()
        await answerReturned.promise
        for (const pid of pids) {
          let gone: unknown
          try { process.kill(pid, 0) } catch (error) { gone = error }
          expect(gone).toMatchObject({ code: 'ESRCH' })
        }
        const after = readTrace()
        expect(after.filter((entry) => entry.method === 'interaction.resolve')).toEqual(resolved)
        expect(after.filter((entry) => entry.method === 'session.run')).toHaveLength(2)
        expect(f.stderr).not.toContain('退出异常')
        // 完成轮保留，取消轮只有一个停止终态；新入口不重建问题、不回传旧答案、不自动重投。
        restarted = open(directory, { python: executable, codec })
        let restoredAsks = 0
        restarted.peer.handle(reverse.AGENT_ASK_USER, () => { restoredAsks += 1; throw new Error('不应恢复旧追问') })
        await restarted.initialize()
        const observer = await restarted.register('quick')
        const history = await new AppServerHistoryClient(restarted.peer, observer.clientId).read({ kind: 'agent', sessionId: session.id })
        expect(history.slice(0, successful.length)).toEqual(successful)
        expect(history.filter((message) => message.type === 'user'
          && (message as SDKUserMessage).message?.content?.some((block) => block.type === 'text' && block.text === 'ask-user'))).toHaveLength(2)
        expect(history.filter((message) => message.type === 'result')).toHaveLength(2)
        expect(history.filter((message) => message.type === 'result')).toMatchObject([
          { subtype: 'success', terminal_reason: 'completed' }, { terminal_reason: 'stopped', stopped_by_user: true },
        ])
        expect(JSON.stringify(history)).toContain('AskUserQuestion')
        expect(await restarted.request(observer, methods.AGENT_LIST_ACTIVE_RUNS)).toEqual([])
        expect(await restarted.eof()).toBe(0)
        expect(restoredAsks).toBe(0)
        expect(readTrace()).toEqual(after)
      } finally {
        lateAnswer.resolve()
        await f.close(); await restarted?.close()
        for (const pid of pids) {
          if (!Number.isSafeInteger(pid) || pid <= 1 || pid === process.pid) continue
          try { process.kill(pid, 'SIGKILL') } catch { /* 已退出。 */ }
        }
        rmSync(directory, { recursive: true, force: true })
      }
    }, 20_000)
  }

  test('完整后端 Zima 使用受控离线协议进程，保存摘要/思考并恢复应用历史', async () => {
    const directory = mkdtempSync(join(tmpdir(), 'axon-independent-zima-protocol-'))
    const executable = join(directory, 'controlled-python'), runtimeFixture = join(import.meta.dir, '../../../packages/runtime-adapters/src/fixtures/fake-zima-runtime.mjs')
    const quote = (value: string) => `'${value.replaceAll("'", "'\\''")}'`
    writeFileSync(executable, `#!/bin/sh\nexec ${quote(process.execPath)} ${quote(runtimeFixture)}\n`)
    chmodSync(executable, 0o700)
    const codec = createFixtureCredentialCodec(), f = open(directory, { python: executable, codec })
    let restarted: ReturnType<typeof open> | undefined
    try {
      expect((await f.initialize()).capabilities.runtimes.find((runtime) => runtime.runtimeId === 'zima')).toMatchObject({ configured: true, sandbox: { supported: false } })
      const main = await f.register(), project = await f.request(main, methods.PROJECT_CREATE, { name: '离线协议项目' }) as unknown as AgentProject
      const channel = await f.request(main, methods.CHANNEL_CREATE, { name: 'Zima 隔离渠道', provider: 'custom', apiKey: 'sk-zima-independent-fixture', baseUrl: 'http://127.0.0.1:1/v1',
        models: [{ id: 'fake-model', name: '夹具', enabled: true }] }) as unknown as Channel
      const session = await f.request(main, methods.AGENT_CREATE_SESSION, { runtimeId: 'zima', projectId: project.id, channelId: channel.id, modelId: 'fake-model', title: '避免标题网络请求' }) as unknown as AgentSessionMeta
      expect(await f.request(main, methods.AGENT_SEND, { sessionId: session.id, text: 'compact' })).toEqual({ success: true, disposition: 'started' })
      const history = await new AppServerHistoryClient(f.peer, main.clientId).read({ kind: 'agent', sessionId: session.id })
      expect(JSON.stringify(history)).toContain('summary-contract-test')
      expect(await f.eof()).toBe(0)
      restarted = open(directory, { python: executable, codec })
      await restarted.initialize()
      const quick = await restarted.register('quick')
      expect(await new AppServerHistoryClient(restarted.peer, quick.clientId).read({ kind: 'agent', sessionId: session.id })).toEqual(history)
      expect(await restarted.request(quick, methods.AGENT_SEND, { sessionId: session.id, text: 'interleaved' })).toEqual({ success: true, disposition: 'started' })
      const restored = await new AppServerHistoryClient(restarted.peer, quick.clientId).read({ kind: 'agent', sessionId: session.id })
      expect(restored.slice(0, history.length)).toEqual(history)
      expect(restored.filter((message) => message.type === 'assistant').at(-1)).toMatchObject({ message: { content: [
        { type: 'thinking', thinking: '先思考' },
        { type: 'text', text: '先回答' },
        { type: 'tool_use', name: 'Read', input: { path: 'a.txt' } },
        { type: 'thinking', thinking: '再思考' },
        { type: 'text', text: '再回答' },
      ] } })
    } finally { await f.close(); await restarted?.close(); rmSync(directory, { recursive: true, force: true }) }
  }, 20_000)
})
