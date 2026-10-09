import { afterEach, describe, expect, test } from 'bun:test'
import { existsSync, mkdtempSync, readFileSync, rmSync } from 'node:fs'
import { createServer } from 'node:net'
import type { Socket } from 'node:net'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { PassThrough } from 'node:stream'
import { createBackend, createBackendPaths } from '@axon/core'
import type { AxonBackend, BackendOptions } from '@axon/core'
import { APP_SERVER_METHODS as methods, APP_SERVER_RPC_OPTIONS } from '@axon/shared'
import type { AgentProject, AppServerClient, McpConnectionTestResult, RpcJsonValue } from '@axon/shared'
import { createFixtureCredentialCodec } from '../../core/test-support/credential-codec'
import { AppServerConnection, JsonRpcPeer } from './index'
import { createPrivateHostPorts, registerPrivateHostBridge } from './private-host-bridge'

const cleanups: Array<() => void> = []
afterEach(() => { for (const cleanup of cleanups.splice(0).reverse()) cleanup() })
const server = { type: 'stdio', command: 'fixture', enabled: false, startupTimeoutMs: 2_000, requestTimeoutMs: 2_000 }
const listed = { name: 'echo', description: '完整定义', inputSchema: { type: 'object', properties: { text: { type: 'string' } }, required: ['text'] },
  annotations: { readOnlyHint: true }, _meta: { custom: '保留附加字段' } }

/** 协议与私有加密桥使用真实 core；默认只替换 MCP 会话，原生项显式使用 SDK 子进程。 */
async function open(connectMcpServer?: BackendOptions['connectMcpServer']) {
  const directory = mkdtempSync(join(tmpdir(), 'axon-mcp-rpc-'))
  const upstream = new PassThrough(), downstream = new PassThrough()
  const parent = new JsonRpcPeer(downstream, upstream, { ...APP_SERVER_RPC_OPTIONS, requestTimeoutMs: 2_000 })
  const child = new JsonRpcPeer(upstream, downstream, { ...APP_SERVER_RPC_OPTIONS, requestTimeoutMs: 2_000 })
  let backend: AxonBackend | undefined
  const host = registerPrivateHostBridge(parent, { credentialCodec: createFixtureCredentialCodec(),
    getClientSignal: (id) => backend?.clients.getSignal(id) })
  const connection = new AppServerConnection({ peer: child, bootstrap: (input) => {
    backend = createBackend({ paths: createBackendPaths({ dataDir: join(directory, 'data'), homeDir: directory }),
      applicationVersion: '0.1.3', ...createPrivateHostPorts(child, input.hostCapabilities), connectMcpServer,
      resolveAdapter: () => ({ async *query() { throw new Error('MCP 配置不能运行 Agent') }, abort() {}, dispose() {}, async drain() {} }),
    })
    return { backend, applicationVersion: '0.1.3', capabilities: { runtimes: [], ...host } }
  } })
  cleanups.push(() => { connection.close(); parent.close(); upstream.destroy(); downstream.destroy(); rmSync(directory, { recursive: true, force: true }) })
  await parent.request(methods.INITIALIZE, { protocolVersion: 1, client: { name: 'axon-mcp-fixture', version: '0.1.3' }, hostCapabilities: host })
  const main = await parent.request(methods.REGISTER_CLIENT, { kind: 'main' }) as unknown as AppServerClient
  const quick = await parent.request(methods.REGISTER_CLIENT, { kind: 'quick' }) as unknown as AppServerClient
  const request = (method: string, input?: RpcJsonValue, client = main, signal?: AbortSignal) => parent.request(method,
    { clientId: client.clientId, ...(input === undefined ? {} : { input }) }, { timeoutMs: 0, signal })
  let projectNumber = 0
  const create = async () => await request(methods.PROJECT_CREATE, { name: `MCP 项目 ${++projectNumber}` }) as unknown as AgentProject
  return { directory, parent, connection, backend: backend!, main, quick, request, create,
    disconnect() { upstream.destroy(); downstream.destroy() } }
}

/** 等待具体阶段/关闭证据；不因观察超时重启测试连接。 */
async function until(predicate: () => boolean): Promise<void> {
  const deadline = Date.now() + 3_000
  while (!predicate() && Date.now() < deadline) await Bun.sleep(10)
  expect(predicate()).toBe(true)
}

describe('MCP 应用协议', () => {
  test('实际加密保存/读取/重建；成功后仅淘汰所属项目缓存，坏配置不覆盖或关闭连接', async () => {
    const probes: Array<{ command: string; closed: number }> = []
    const f = await open((config) => {
      const probe = { command: config.type === 'stdio' ? config.command : '', closed: 0 }; probes.push(probe)
      return { ready: Promise.resolve(), client: {
        listTools: async () => ({ tools: [listed] }), callTool: async () => ({ content: [] }),
        close: async () => { probe.closed += 1 },
      } }
    })
    const first = await f.create(), second = await f.create()
    expect(await f.request(methods.MCP_GET_CONFIG, first.id)).toEqual({ version: 1, servers: {} })
    const config = { version: 1, servers: { local: { ...server, enabled: true, env: { SECRET: 'fixture-secret' } } } }
    await f.request(methods.MCP_SAVE_CONFIG, { projectId: first.id, config })
    await f.request(methods.MCP_SAVE_CONFIG, { projectId: second.id, config })
    await f.backend.mcpTools.getTools(first.id); await f.backend.mcpTools.getTools(second.id)
    const path = join(f.backend.projects.resolveProjectDataDir(first.id), 'mcp.json')
    const before = readFileSync(path, 'utf8')
    expect(before).toContain('secure:v1:'); expect(before).not.toContain('fixture-secret')
    expect(await f.request(methods.MCP_GET_CONFIG, first.id, f.quick)).toMatchObject(config)
    const badConfigs: RpcJsonValue[] = [null, { version: 2, servers: {} }, { version: 1, servers: { local: { ...server, owner: 'bad' } } }]
    for (const bad of badConfigs) {
      await expect(f.request(methods.MCP_SAVE_CONFIG, { projectId: first.id, config: bad })).rejects.toMatchObject({ code: -32026, data: { code: 'invalid_input' } })
      expect(readFileSync(path, 'utf8')).toBe(before)
      expect(probes.map((probe) => probe.closed)).toEqual([0, 0])
    }
    await f.request(methods.MCP_SAVE_CONFIG, { projectId: first.id, config: { version: 1, servers: {} } })
    expect(probes.map((probe) => probe.closed)).toEqual([1, 0])
    expect(await f.request(methods.MCP_GET_CONFIG, first.id)).toEqual({ version: 1, servers: {} })
  })

  test('草稿测试包括完整分页 schema/annotations/meta；不落盘，不受 enabled 影响且关闭独立连接', async () => {
    let closes = 0, pages = 0
    const f = await open((config) => {
      expect(config.enabled).toBe(false)
      return { ready: Promise.resolve(), client: {
        listTools: async (params) => { pages += 1; return params?.cursor ? { tools: [{ name: 'second', inputSchema: { type: 'object' as const } }] }
          : { tools: [listed], nextCursor: 'next' } }, callTool: async () => ({ content: [] }),
        close: async () => { closes += 1 },
      } }
    })
    const project = await f.create()
    expect(await f.request(methods.MCP_TEST_CONNECTION, { projectId: project.id, serverName: 'local', server }))
      .toEqual({ ok: true, tools: [listed, { name: 'second', inputSchema: { type: 'object' } }] })
    expect(pages).toBe(2); expect(closes).toBe(1)
    expect(existsSync(join(f.backend.projects.resolveProjectDataDir(project.id), 'mcp.json'))).toBe(false)
    expect(await f.backend.mcpTools.getTools(project.id)).toEqual([])
    expect(closes).toBe(1)
  })

  test('可信项目物化预设仅返回草稿；固定负载、身份和项目存在性不能绕过', async () => {
    let connections = 0
    const f = await open(() => { connections += 1; throw new Error('不得连接') })
    const project = await f.create()
    expect(await f.request(methods.MCP_LIST_PRESETS)).toHaveLength(2)
    const draft = await f.request(methods.MCP_MATERIALIZE_PRESET, { projectId: project.id, presetId: 'filesystem' })
    expect(JSON.stringify(draft)).toContain(f.backend.projects.resolveProjectCwd(project.id))
    expect(existsSync(join(f.backend.projects.resolveProjectDataDir(project.id), 'mcp.json'))).toBe(false)
    const badInputs: RpcJsonValue[] = [{ projectId: project.id, serverName: 'local', server, cwd: '/tmp' },
      { projectId: project.id, serverName: 'local', server, owner: f.quick.clientId }]
    for (const input of badInputs) {
      await expect(f.request(methods.MCP_TEST_CONNECTION, input)).rejects.toMatchObject({ code: -32602 })
    }
    await expect(f.request(methods.MCP_TEST_CONNECTION, { projectId: 'missing', serverName: 'local', server })).rejects.toMatchObject({ code: -32023 })
    await expect(f.request(methods.MCP_GET_CONFIG, 'missing')).rejects.toMatchObject({ code: -32026, data: { code: 'project_unavailable' } })
    await expect(f.request(methods.MCP_TEST_CONNECTION, { projectId: project.id, serverName: 'Bad Name', server })).rejects.toMatchObject({ code: -32026 })
    const foreign = f.backend.clients.register()
    await expect(f.parent.request(methods.MCP_LIST_PRESETS, { clientId: foreign })).rejects.toMatchObject({ code: -32004 })
    await f.parent.request(methods.DETACH_CLIENT, { clientId: f.quick.clientId })
    await expect(f.request(methods.MCP_GET_CONFIG, project.id, f.quick)).rejects.toMatchObject({ code: -32004 })
    expect(connections).toBe(0)
  })

  test('取消挂起 tools/list 关闭本次连接，迟到分页无效；另一入口测试继续成功', async () => {
    let finish = (): void => {}
    const page = new Promise<{ tools: typeof listed[]; nextCursor: string }>((resolve) => {
      finish = () => resolve({ tools: [listed], nextCursor: 'late' })
    })
    const probes: Array<{ closed: number; lists: number; signal?: AbortSignal }> = []
    const f = await open((config) => {
      const probe = { closed: 0, lists: 0, signal: undefined as AbortSignal | undefined }; probes.push(probe)
      return { ready: Promise.resolve(), client: {
        listTools: async (_params, options) => { probe.lists += 1; probe.signal = options.signal
          return config.type === 'stdio' && config.command === 'pending' ? page : { tools: [listed] } },
        callTool: async () => ({ content: [] }), close: async () => { probe.closed += 1 },
      } }
    })
    const project = await f.create(), abort = new AbortController()
    const pending = f.request(methods.MCP_TEST_CONNECTION, { projectId: project.id, serverName: 'local', server: { ...server, command: 'pending' } }, f.main, abort.signal)
    const rejected = pending.catch((error: unknown) => error)
    await until(() => probes[0]?.lists === 1)
    expect(await f.request(methods.MCP_TEST_CONNECTION, { projectId: project.id, serverName: 'local', server }, f.quick)).toEqual({ ok: true, tools: [listed] })
    abort.abort(); expect(await rejected).toBeInstanceOf(Error)
    await until(() => probes[0]?.closed === 1)
    expect(probes[0]?.signal?.aborted).toBe(true)
    finish(); await Promise.resolve(); await Promise.resolve()
    expect(probes.map((probe) => [probe.lists, probe.closed])).toEqual([[1, 1], [1, 1]])
    expect(await f.request(methods.MCP_LIST_PRESETS)).toHaveLength(2)
  })

  test('逻辑入口注销取消挂起握手；物理断开取消剩余测试，迟到 ready 不再 list', async () => {
    let finish = (): void => {}
    const ready = new Promise<void>((resolve) => { finish = resolve })
    let lists = 0, closes = 0, connects = 0
    const f = await open(() => { connects += 1; return { ready, client: {
      listTools: async () => { lists += 1; return { tools: [listed] } }, callTool: async () => ({ content: [] }),
      close: async () => { closes += 1 },
    } } })
    const project = await f.create()
    const input = { projectId: project.id, serverName: 'local', server }
    const first = f.request(methods.MCP_TEST_CONNECTION, input)
    const firstRejected = first.catch((error: unknown) => error)
    await until(() => connects === 1)
    await f.parent.request(methods.DETACH_CLIENT, { clientId: f.main.clientId })
    expect(await firstRejected).toMatchObject({ code: -32800 })
    expect(closes).toBe(1)
    const second = f.request(methods.MCP_TEST_CONNECTION, input, f.quick)
    const secondRejected = second.catch((error: unknown) => error)
    await until(() => connects === 2)
    f.disconnect(); expect(await secondRejected).toBeInstanceOf(Error)
    await until(() => closes === 2)
    finish(); await Promise.resolve(); await Promise.resolve()
    expect(lists).toBe(0)
  })

  test('SDK 原因包含地址/凭据仍只返回稳定失败，分页错误不丢弃清理', async () => {
    let closes = 0
    const f = await open((config) => ({ ready: config.type === 'stdio' && config.command === 'unauthorized'
      ? Promise.reject(new Error('401 unauthorized https://private.invalid Authorization=fixture-secret')) : Promise.resolve(),
      client: { listTools: async () => ({ tools: [], nextCursor: 'loop' }), callTool: async () => ({ content: [] }),
        close: async () => { closes += 1 } } }))
    const project = await f.create()
    expect(await f.request(methods.MCP_TEST_CONNECTION, { projectId: project.id, serverName: 'local', server: { ...server, command: 'unauthorized' } }))
      .toEqual({ ok: false, message: '服务器拒绝认证，请检查请求头或凭据' })
    expect(await f.request(methods.MCP_TEST_CONNECTION, { projectId: project.id, serverName: 'local', server }))
      .toEqual({ ok: false, message: 'MCP 握手或工具发现失败，请检查服务配置和运行日志' })
    expect(closes).toBe(2)
  })

  test('真实 MCP SDK stdio 经应用协议握手/分页；握手和发现阶段取消后实际进程退出', async () => {
    const f = await open()
    const project = await f.create()
    const script = fileURLToPath(new URL('../../core/test-support/mcp-stdio-fixture.mjs', import.meta.url))
    const successMarker = join(f.directory, 'success')
    const tested = await f.request(methods.MCP_TEST_CONNECTION, { projectId: project.id, serverName: 'local',
      server: { ...server, command: process.execPath, args: [script, successMarker] } }) as unknown as McpConnectionTestResult
    expect(tested.ok).toBe(true)
    if (!tested.ok) throw new Error(tested.message)
    expect(tested.tools.map((tool) => tool.name)).toEqual(['echo', 'second'])
    expect(tested.tools[0]).toMatchObject({ description: 'client=0.1.3', annotations: { readOnlyHint: true }, inputSchema: { required: ['value'] } })
    await until(() => existsSync(successMarker))
    for (const phase of ['initialize', 'tools/list']) {
      const marker = join(f.directory, phase.replace('/', '-'))
      const abort = new AbortController()
      const pending = f.request(methods.MCP_TEST_CONNECTION, { projectId: project.id, serverName: 'local',
        server: { ...server, command: process.execPath, args: [script, marker, phase] } }, f.main, abort.signal)
      const rejected = pending.catch((error: unknown) => error)
      try {
        await until(() => existsSync(`${marker}.started`))
        const pid = Number(readFileSync(`${marker}.started`, 'utf8'))
        expect(Number.isSafeInteger(pid)).toBe(true)
        abort.abort(); expect(await rejected).toBeInstanceOf(Error)
        await until(() => existsSync(marker))
        await until(() => { try { process.kill(pid, 0); return false } catch (error) {
          return error instanceof Error && 'code' in error && error.code === 'ESRCH'
        } })
      } finally { abort.abort(); await rejected }
    }
    expect(existsSync(join(f.backend.projects.resolveProjectDataDir(project.id), 'mcp.json'))).toBe(false)
  }, 15_000)

  test('真实 SDK HTTP 请求保留工具定义与认证头；握手/发现取消实际断开连接且入口仍有效', async () => {
    const f = await open(), project = await f.create()
    const requests: Array<{ path: string; method: string; authorization?: string; closed: boolean }> = []
    const sockets = new Set<Socket>()
    // 直接观察 TCP 关闭，避免 HTTP 兼容层遗漏 close；只解析夹具实际使用的 JSON POST。
    const http = createServer((socket) => {
      sockets.add(socket)
      socket.once('close', () => sockets.delete(socket))
      let bytes = Buffer.alloc(0), handled = false
      socket.on('data', (chunk: Buffer) => {
        if (handled) return
        bytes = Buffer.concat([bytes, chunk])
        const split = bytes.indexOf('\r\n\r\n')
        if (split < 0) return
        const header = bytes.subarray(0, split).toString('utf8')
        const length = Number(header.match(/\r\ncontent-length:\s*(\d+)/i)?.[1])
        if (!Number.isSafeInteger(length) || length < 0) { socket.destroy(); return }
        if (bytes.length < split + 4 + length) return
        handled = true
        const message = JSON.parse(bytes.subarray(split + 4, split + 4 + length).toString('utf8')) as {
          id?: string | number; method: string; params?: { protocolVersion?: string }
        }
        const entry = { path: header.split(' ')[1] ?? '', method: message.method,
          authorization: header.match(/\r\nauthorization:\s*([^\r\n]+)/i)?.[1], closed: false }
        requests.push(entry); socket.once('close', () => { entry.closed = true })
        const hung = entry.path === '/initialize' && message.method === 'initialize'
          || entry.path === '/discovery' && message.method === 'tools/list'
        if (hung) return
        if (message.id === undefined) { socket.end('HTTP/1.1 204 No Content\r\nConnection: close\r\n\r\n'); return }
        const result = message.method === 'initialize'
          ? { protocolVersion: message.params?.protocolVersion, capabilities: { tools: {} }, serverInfo: { name: 'axon-http-fixture', version: '1.0.0' } }
          : { tools: [listed] }
        const body = JSON.stringify({ jsonrpc: '2.0', id: message.id, result })
        socket.end(`HTTP/1.1 200 OK\r\nContent-Type: application/json\r\nContent-Length: ${Buffer.byteLength(body)}\r\nConnection: close\r\n\r\n${body}`)
      })
    })
    try {
      await new Promise<void>((resolve, reject) => { http.once('error', reject); http.listen(0, '127.0.0.1', resolve) })
      const address = http.address()
      if (!address || typeof address === 'string') throw new Error('测试服务器未监听 TCP')
      const base = `http://127.0.0.1:${address.port}`
      const config = { type: 'http', enabled: false, headers: { Authorization: 'Bearer fixture-secret' }, startupTimeoutMs: 2_000, requestTimeoutMs: 2_000 }
      expect(await f.request(methods.MCP_TEST_CONNECTION, { projectId: project.id, serverName: 'local', server: { ...config, url: `${base}/success` } }))
        .toEqual({ ok: true, tools: [listed] })
      for (const [path, method] of [['/initialize', 'initialize'], ['/discovery', 'tools/list']]) {
        const abort = new AbortController()
        const pending = f.request(methods.MCP_TEST_CONNECTION, { projectId: project.id, serverName: 'local', server: { ...config, url: `${base}${path}` } }, f.main, abort.signal)
        const outcome = pending.catch((error: unknown) => error)
        try {
          await until(() => requests.some((entry) => entry.path === path && entry.method === method))
          abort.abort(); expect(await outcome).toBeInstanceOf(Error)
          await until(() => requests.some((entry) => entry.path === path && entry.method === method && entry.closed))
        } finally { abort.abort(); await outcome }
      }
      expect(requests.every((entry) => entry.authorization === 'Bearer fixture-secret')).toBe(true)
      expect(await f.request(methods.MCP_LIST_PRESETS, undefined, f.quick)).toHaveLength(2)
      expect(existsSync(join(f.backend.projects.resolveProjectDataDir(project.id), 'mcp.json'))).toBe(false)
    } finally {
      for (const socket of sockets) socket.destroy()
      await new Promise<void>((resolve) => http.close(() => resolve()))
    }
  }, 15_000)
})
