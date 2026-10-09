import { afterEach, describe, expect, test } from 'bun:test'
import { existsSync, mkdtempSync, readFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { PassThrough } from 'node:stream'
import { createBackend, createBackendPaths, createCredentialCodec, getSettings } from '@axon/core'
import type { AxonBackend, BackendOptions, CredentialCodec } from '@axon/core'
import { APP_SERVER_METHODS as methods, APP_SERVER_NOTIFICATIONS as notices, APP_SERVER_RPC_OPTIONS,
  MAX_USER_AVATAR_LENGTH } from '@axon/shared'
import type { AppServerClient, Channel, RpcJsonObject, RpcJsonValue } from '@axon/shared'
import { createFixtureCredentialCodec } from '../../core/test-support/credential-codec'
import { AppServerConnection, JsonRpcPeer } from './index'
import { createPrivateHostPorts, registerPrivateHostBridge } from './private-host-bridge'
import { toWireValue } from './wire-value'

const cleanups: Array<() => void> = []
afterEach(() => { for (const cleanup of cleanups.splice(0).reverse()) cleanup() })

/** 真实 core 和私有宿主桥，只替换加密后端/HTTP；不会打开正式数据或外部模型。 */
async function open(options: {
  codec?: CredentialCodec
  confirm?: BackendOptions['confirmChannelTarget']
  fetch?: BackendOptions['channelFetch']
} = {}) {
  const directory = mkdtempSync(join(tmpdir(), 'axon-config-rpc-'))
  const paths = createBackendPaths({ dataDir: join(directory, 'data'), homeDir: directory })
  const upstream = new PassThrough()
  const downstream = new PassThrough()
  const parent = new JsonRpcPeer(downstream, upstream, { ...APP_SERVER_RPC_OPTIONS, requestTimeoutMs: 2_000 })
  const child = new JsonRpcPeer(upstream, downstream, { ...APP_SERVER_RPC_OPTIONS, requestTimeoutMs: 2_000 })
  let backend: AxonBackend | undefined
  const host = registerPrivateHostBridge(parent, { credentialCodec: options.codec ?? createFixtureCredentialCodec(),
    getClientSignal: (id) => backend?.clients.getSignal(id), confirmChannelTarget: options.confirm })
  const connection = new AppServerConnection({ peer: child, bootstrap: (input) => {
    const ports = createPrivateHostPorts(child, input.hostCapabilities)
    backend = createBackend({ paths, applicationVersion: '0.1.3', ...ports, channelFetch: options.fetch ?? (async () => {
      throw new Error('夹具未允许的网络请求')
    }), resolveAdapter: () => ({ async *query() { throw new Error('配置不调用 runtime') }, abort() {}, dispose() {}, async drain() {} }) })
    return { backend, applicationVersion: '0.1.3', capabilities: { runtimes: [], ...host } }
  } })
  cleanups.push(() => { connection.close(); parent.close(); upstream.destroy(); downstream.destroy(); rmSync(directory, { recursive: true, force: true }) })
  await parent.request(methods.INITIALIZE, { protocolVersion: 1, client: { name: 'axon-config-fixture', version: '0.1.3' }, hostCapabilities: host })
  const main = await parent.request(methods.REGISTER_CLIENT, { kind: 'main' }) as unknown as AppServerClient
  const quick = await parent.request(methods.REGISTER_CLIENT, { kind: 'quick' }) as unknown as AppServerClient
  const events: Array<{ method: string; packet: RpcJsonObject }> = []
  const persisted: boolean[] = []
  let onEvent = (_method: string, _packet: RpcJsonObject): void => {}
  for (const method of [notices.SETTINGS_UPDATED, notices.USER_PROFILE_UPDATED, notices.CHANNELS_CHANGED]) {
    parent.handleNotification(method, (params) => {
      const packet = params as RpcJsonObject
      events.push({ method, packet })
      const current = method === notices.SETTINGS_UPDATED ? backend!.settings.get()
        : method === notices.USER_PROFILE_UPDATED ? backend!.userProfile.get() : backend!.channelController.list()
      persisted.push(JSON.stringify(current) === JSON.stringify(packet.settings ?? packet.profile ?? packet.channels))
      onEvent(method, packet)
    })
  }
  const request = (method: string, input?: RpcJsonValue, client = main, signal?: AbortSignal) => parent.request(method,
    { clientId: client.clientId, ...(input === undefined ? {} : { input }) }, { timeoutMs: 0, signal })
  const create = async (input: RpcJsonObject = {}) => await request(methods.CHANNEL_CREATE,
    { name: '隔离渠道', provider: 'openai', apiKey: 'fixture-secret', ...input }) as unknown as Channel
  return { parent, child, connection, paths, backend: backend!, main, quick, events, persisted, request, create,
    listen(listener: typeof onEvent) { onEvent = listener } }
}

describe('配置应用协议', () => {
  test('原生预注册前只读校验全补丁和绑定会话；保存时复核删除，不部分写入或通知', async () => {
    const f = await open(), chat = f.backend.conversations.create({})
    f.backend.settings.update({ themeMode: 'light' })
    const before = readFileSync(f.paths.settingsPath, 'utf8')
    const patch = { themeMode: 'dark', quickChatShortcuts: [{ id: ' binding ', accelerator: ' Command+1 ', sessionType: 'chat', sessionId: chat.id }] }
    const validated = await f.request(methods.VALIDATE_SETTINGS, patch)
    expect(validated).toEqual({ ...patch, quickChatShortcuts: [{ ...patch.quickChatShortcuts[0], id: 'binding', accelerator: 'Command+1' }] })
    expect(f.events).toEqual([]); expect(readFileSync(f.paths.settingsPath, 'utf8')).toBe(before)
    await expect(f.request(methods.VALIDATE_SETTINGS, { ...patch, themeMode: 'invalid' })).rejects.toMatchObject({ code: -32602 })
    await expect(f.request(methods.VALIDATE_SETTINGS, { quickChatShortcuts: [{ ...patch.quickChatShortcuts[0], sessionType: 'agent', sessionId: 'missing' }] })).rejects.toMatchObject({ code: -32602 })
    f.backend.conversations.delete(chat.id)
    await expect(f.request(methods.UPDATE_SETTINGS, validated)).rejects.toMatchObject({ code: -32602 })
    expect(readFileSync(f.paths.settingsPath, 'utf8')).toBe(before); expect(f.events).toEqual([])
  })

  test('完整设置补丁/局部合并/重读；已保存快照通知 main 和 quick，不更换文件格式', async () => {
    const f = await open()
    f.backend.settings.update({ agentSkillCatalogIds: ['既有安装选择'] })
    const chat = f.backend.conversations.create({})
    const patch: RpcJsonObject = {
      themeMode: 'light', mainWindowState: { width: 1280, height: 800, x: -100, y: 0, isMaximized: false },
      tabState: { tabs: [{ id: 'tab-1', type: 'chat', sessionId: 'chat-1', title: '对话' }], activeTabId: 'tab-1' },
      sidebarCollapsed: false, leftSidebarWidth: 260, rightPanelCollapsed: true, rightPanelWidth: 320,
      markdownFontSize: 'large', agentSystemPrompt: 'Agent 规则',
      agentSystemPromptTemplates: [{ id: 'preset', name: '预设', content: '规则' }], gitAttributionEnabled: false,
      chatDrafts: { 'chat-1': '未发送草稿' }, quickChatShortcuts: [{ id: 'binding', accelerator: 'Command+1', sessionType: 'chat', sessionId: chat.id }],
    }
    expect(await f.request(methods.UPDATE_SETTINGS, patch)).toMatchObject(patch)
    expect(f.persisted).toEqual([true, true])
    expect(f.events.map((event) => event.packet.clientId)).toEqual([f.main.clientId, f.quick.clientId])
    expect(await f.request(methods.UPDATE_SETTINGS, { agentSystemPrompt: '' }, f.quick)).toMatchObject({
      themeMode: 'light', agentSystemPrompt: '', agentSkillCatalogIds: ['既有安装选择'],
    })
    expect(await f.request(methods.GET_SETTINGS, undefined, f.quick)).toEqual(toWireValue(getSettings(f.paths.settingsPath)))
    expect(JSON.parse(readFileSync(f.paths.settingsPath, 'utf8'))).toEqual(f.backend.settings.get())
  })

  test('设置逐字段和嵌套白名单；坏补丁不会部分写入、广播或绕过 Skills 安装', async () => {
    const f = await open()
    await f.request(methods.UPDATE_SETTINGS, { themeMode: 'dark' })
    const before = readFileSync(f.paths.settingsPath, 'utf8')
    const bad: RpcJsonValue[] = [null, [], { owner: 'fake' }, { agentSkillCatalogIds: [] },
      { themeMode: 'bright' }, { sidebarCollapsed: 1 }, { leftSidebarWidth: 0 }, { rightPanelWidth: '300' },
      { rightPanelCollapsed: null }, { markdownFontSize: 'huge' }, { agentSystemPrompt: {} }, { gitAttributionEnabled: 'yes' },
      { mainWindowState: { width: 1, height: 1, x: 0, y: 0, isMaximized: false, grant: true } },
      { mainWindowState: { width: -1, height: 1, x: 0, y: 0, isMaximized: false } },
      { tabState: { tabs: [], activeTabId: 'missing' } }, { tabState: { tabs: [{ id: 'tab', type: 'shell', sessionId: 'id', title: 'x' }], activeTabId: null } },
      { chatDrafts: { id: 1 } }, { chatDrafts: [] },
      { agentSystemPromptTemplates: [{ id: 'a', name: 'a', content: 'a', tool: 'Bash' }] },
      { agentSystemPromptTemplates: [{ id: 'a', name: 'a', content: 'a' }, { id: 'a', name: 'b', content: 'b' }] },
      { quickChatShortcuts: [{ id: 'a', accelerator: 'Command+1', sessionType: 'chat', sessionId: 'x', source: 'main' }] },
      { quickChatShortcuts: [{ id: 'a', accelerator: 'Command+1', sessionType: 'chat', sessionId: 'x' },
        { id: 'b', accelerator: 'command+1', sessionType: 'agent', sessionId: 'y' }] },
    ]
    for (const input of bad) {
      await expect(f.request(methods.UPDATE_SETTINGS, input)).rejects.toMatchObject({ code: -32602 })
      expect(readFileSync(f.paths.settingsPath, 'utf8')).toBe(before)
    }
    await expect(f.request(methods.UPDATE_SETTINGS, { themeMode: 'light', sidebarCollapsed: 123 })).rejects.toMatchObject({ code: -32602 })
    expect(f.events).toHaveLength(2)
    expect(readFileSync(f.paths.settingsPath, 'utf8')).toBe(before)
  })

  test('资料局部合并/空白默认与分段头像；保留截断规则，坏类型和未知字段不写盘', async () => {
    const f = await open()
    const avatar = `data:image/png;base64,${'A'.repeat(1_100_000)}`
    expect(await f.request(methods.UPDATE_USER_PROFILE, { userName: '  新用户  ', avatar })).toEqual({ userName: '新用户', avatar })
    expect(f.persisted).toEqual([true, true])
    expect(await f.request(methods.UPDATE_USER_PROFILE, { userName: '   ' }, f.quick)).toEqual({ userName: '用户', avatar })
    expect(await f.request(methods.GET_USER_PROFILE)).toEqual({ userName: '用户', avatar })
    const before = readFileSync(f.paths.userProfilePath, 'utf8')
    const bad: RpcJsonValue[] = [{ userName: null }, { avatar: false }, { userName: 'ok', apiKey: 'secret' }]
    for (const input of bad) {
      await expect(f.request(methods.UPDATE_USER_PROFILE, input)).rejects.toMatchObject({ code: -32602 })
      expect(readFileSync(f.paths.userProfilePath, 'utf8')).toBe(before)
    }
    expect(await f.request(methods.UPDATE_USER_PROFILE, { userName: 'x'.repeat(81), avatar: 'x'.repeat(MAX_USER_AVATAR_LENGTH + 1) }))
      .toEqual({ userName: 'x'.repeat(80), avatar: 'x'.repeat(MAX_USER_AVATAR_LENGTH) })
  })

  test('外来/注销身份与额外 owner 拒绝；注销后全局快照仅通知存活入口', async () => {
    const f = await open()
    const foreign = f.backend.clients.register()
    await expect(f.parent.request(methods.UPDATE_SETTINGS, { clientId: foreign, input: { themeMode: 'light' } })).rejects.toMatchObject({ code: -32004 })
    await expect(f.parent.request(methods.UPDATE_SETTINGS, { clientId: f.main.clientId, input: {}, owner: f.quick.clientId })).rejects.toMatchObject({ code: -32602 })
    expect(existsSync(f.paths.settingsPath)).toBe(false)
    await f.parent.request(methods.DETACH_CLIENT, { clientId: f.main.clientId })
    await expect(f.request(methods.UPDATE_SETTINGS, {})).rejects.toMatchObject({ code: -32004 })
    await f.request(methods.UPDATE_SETTINGS, { themeMode: 'light' }, f.quick)
    expect(f.events.map((event) => event.packet.clientId)).toEqual([f.quick.clientId])
  })

  test('渠道 CRUD 走私有加密桥；返回/通知只有安全 DTO，密钥不出现在 channels.json', async () => {
    const f = await open()
    const channel = await f.create({ models: [{ id: 'model', name: '模型', enabled: true }] })
    expect(channel.hasApiKey).toBe(true)
    expect(await f.request(methods.CHANNEL_LIST, undefined, f.quick)).toEqual(toWireValue([channel]))
    expect(f.persisted).toEqual([true, true])
    expect(readFileSync(f.paths.channelsPath, 'utf8')).toContain('secure:v1:')
    expect(readFileSync(f.paths.channelsPath, 'utf8')).not.toContain('fixture-secret')
    expect(JSON.stringify([channel, f.events])).not.toMatch(/fixture-secret|encryptedCredential|apiKey/)
    expect(await f.request(methods.CHANNEL_UPDATE, { channelId: channel.id, update: { name: '修改名称', apiKey: '', enabled: false } }, f.quick))
      .toMatchObject({ name: '修改名称', hasApiKey: true, enabled: false })
    expect(await f.backend.channels.resolve(channel.id)).toMatchObject({ apiKey: 'fixture-secret' })
    expect(await f.request(methods.CHANNEL_DELETE, channel.id)).toMatchObject({ id: channel.id })
    expect(await f.request(methods.CHANNEL_LIST)).toEqual([])
    await expect(f.request(methods.CHANNEL_DELETE, channel.id)).rejects.toMatchObject({ code: -32022, data: { code: 'not_found' } })
  })

  test('渠道坏字段/模型/地址和安全存储不可用：稳定错误、无半条配置或通知', async () => {
    const f = await open({ codec: createCredentialCodec() })
    await expect(f.create()).rejects.toMatchObject({ code: -32022, data: { code: 'credential_error' } })
    const bad: RpcJsonObject[] = [{ owner: 'fake' }, { provider: 'bad' }, { enabled: 1 }, { apiKey: 1 },
      { baseUrl: 'file:///tmp/test' }, { models: [{ id: 'model', name: '模型', enabled: 'yes' }] }]
    for (const patch of bad) {
      await expect(f.create(patch)).rejects.toMatchObject({ code: -32022, data: { code: 'invalid_input' } })
    }
    expect(f.events).toEqual([])
    expect(existsSync(f.paths.channelsPath)).toBe(false)
    const empty = await f.create({ apiKey: '' })
    expect(empty.hasApiKey).toBe(false)
  })

  test('第三方目录先经原入口确认再解密/请求；只请求目录且不自动保存模型', async () => {
    const order: string[] = []
    const codec = createFixtureCredentialCodec()
    let owner = ''
    const f = await open({ codec: { ...codec, decrypt: async (value) => { order.push('decrypt'); return codec.decrypt(value) } },
      confirm: async (client, url) => { owner = client; order.push('confirm'); expect(url).toBe('https://example.test/v1/models'); return true },
      fetch: async (url, init) => {
        order.push('fetch'); expect(url).toBe('https://example.test/v1/models')
        expect(init.method).toBe('GET'); expect(init.redirect).toBe('manual')
        expect(new Headers(init.headers).get('authorization')).toBe('Bearer fixture-secret')
        return Response.json({ data: [{ id: 'model', display_name: '模型' }] })
      } })
    const channel = await f.create({ baseUrl: 'https://example.test/v1' })
    expect(await f.request(methods.CHANNEL_REQUEST, { requestId: 'models-1', operation: 'models', provider: 'openai',
      baseUrl: channel.baseUrl, channelId: channel.id }, f.quick)).toMatchObject({ success: true, models: [{ id: 'model', enabled: false, source: 'fetched' }] })
    expect(owner).toBe(f.quick.clientId)
    expect(order).toEqual(['confirm', 'decrypt', 'fetch'])
    expect(f.backend.channels.get(channel.id)?.models).toEqual([])
    expect(f.events).toHaveLength(2)
  })

  test('拒绝确认和不可信 confirmed 字段不会解密/联网；官方目标不请求确认', async () => {
    let decrypts = 0
    let fetches = 0
    const codec = createFixtureCredentialCodec()
    const f = await open({ codec: { ...codec, decrypt: async (value) => { decrypts += 1; return codec.decrypt(value) } },
      confirm: async () => false, fetch: async () => { fetches += 1; return Response.json({ data: [] }) } })
    const channel = await f.create()
    const input = { requestId: 'test-1', operation: 'test', provider: 'openai', baseUrl: 'https://example.test/v1', channelId: channel.id }
    expect(await f.request(methods.CHANNEL_REQUEST, input)).toMatchObject({ code: 'cancelled' })
    expect(await f.request(methods.CHANNEL_REQUEST, { ...input, confirmed: true })).toMatchObject({ code: 'invalid_input' })
    expect([decrypts, fetches]).toEqual([0, 0])
    expect(await f.request(methods.CHANNEL_REQUEST, { ...input, baseUrl: channel.baseUrl })).toMatchObject({ success: true, models: [] })
    expect([decrypts, fetches]).toEqual([1, 1])
  })

  test('等待确认时 RPC 取消撤销反向请求；迟到批准不解密/联网，其他入口仍能操作', async () => {
    const started = Promise.withResolvers<AbortSignal>()
    const gate = Promise.withResolvers<boolean>()
    let fetches = 0
    const f = await open({ confirm: async (_owner, _url, signal) => { started.resolve(signal); return gate.promise },
      fetch: async () => { fetches += 1; return Response.json({ data: [] }) } })
    const controller = new AbortController()
    const pending = f.request(methods.CHANNEL_REQUEST, { requestId: 'test-1', operation: 'test', provider: 'openai',
      baseUrl: 'https://example.test/v1', apiKey: 'secret' }, f.main, controller.signal)
    const rejected = pending.catch((error: unknown) => error)
    const signal = await started.promise
    controller.abort()
    expect(await rejected).toMatchObject({ code: 'canceled' })
    gate.resolve(true)
    await f.request(methods.UPDATE_SETTINGS, { themeMode: 'dark' }, f.quick)
    expect(signal.aborted).toBe(true)
    expect(fetches).toBe(0)
  })

  test('网络等待精确取消/注销只命中 owner；busy 及旧请求 ID 不取消其他请求', async () => {
    const started = Promise.withResolvers<AbortSignal>()
    const f = await open({ fetch: async (_url, init) => {
      started.resolve(init.signal!)
      return new Promise<Response>((_resolve, reject) => init.signal!.addEventListener('abort', () => reject(new Error('secret')), { once: true }))
    } })
    const input = { requestId: 'test-1', operation: 'test', provider: 'openai', baseUrl: 'https://api.openai.com/v1' }
    const pending = f.request(methods.CHANNEL_REQUEST, input)
    const signal = await started.promise
    expect(await f.request(methods.CHANNEL_REQUEST, { ...input, requestId: 'next' })).toMatchObject({ code: 'busy' })
    expect(await f.request(methods.CHANNEL_CANCEL, 'test-1', f.quick)).toBe(false)
    expect(await f.request(methods.CHANNEL_CANCEL, 'old')).toBe(false)
    expect(signal.aborted).toBe(false)
    expect(await f.request(methods.CHANNEL_CANCEL, 'test-1')).toBe(true)
    expect(await pending).toMatchObject({ code: 'cancelled' })
    const again = f.request(methods.CHANNEL_REQUEST, { ...input, requestId: 'next' })
    await f.parent.request(methods.DETACH_CLIENT, { clientId: f.main.clientId })
    expect(await again).toMatchObject({ code: 'cancelled' })
    expect(await f.request(methods.GET_SETTINGS, undefined, f.quick)).toBeDefined()
  })

  test('RPC 取消真实网络等待并释放迟到正文；旧信号不能误取消下一条诊断', async () => {
    const started = Promise.withResolvers<AbortSignal>()
    const late = Promise.withResolvers<Response>()
    let calls = 0
    let released = 0
    const f = await open({ fetch: async (_url, init) => {
      calls += 1
      if (calls === 1) { started.resolve(init.signal!); return late.promise }
      return Response.json({ data: [{ id: 'next-model' }] })
    } })
    const controller = new AbortController()
    const input = { requestId: 'first', operation: 'models', provider: 'openai', baseUrl: 'https://api.openai.com/v1' }
    const pending = f.request(methods.CHANNEL_REQUEST, input, f.main, controller.signal)
    const rejected = pending.catch((error: unknown) => error)
    const signal = await started.promise
    controller.abort()
    expect(await rejected).toMatchObject({ code: 'canceled' })
    late.resolve(new Response(new ReadableStream({ cancel() { released += 1 } })))
    const result = await f.request(methods.CHANNEL_REQUEST, { ...input, requestId: 'next' })
    expect(signal.aborted).toBe(true)
    expect(released).toBe(1)
    expect(result).toMatchObject({ success: true, models: [{ id: 'next-model' }] })
    expect(calls).toBe(2)
  })

  test('已接纳配置写入取消不假装回滚或重发；加密等待期间仍合并最新字段', async () => {
    const codec = createFixtureCredentialCodec()
    const started = Promise.withResolvers<void>()
    const gate = Promise.withResolvers<void>()
    let blocked = false
    const f = await open({ codec: { ...codec, encrypt: async (value) => {
      if (blocked) { started.resolve(); await gate.promise }
      return codec.encrypt(value)
    } } })
    const channel = await f.create()
    blocked = true
    const controller = new AbortController()
    const pending = f.request(methods.CHANNEL_UPDATE, { channelId: channel.id, update: { apiKey: 'new-secret' } }, f.main, controller.signal)
    const rejected = pending.catch((error: unknown) => error)
    await started.promise
    controller.abort()
    expect(await rejected).toMatchObject({ code: 'canceled' })
    await f.request(methods.CHANNEL_UPDATE, { channelId: channel.id, update: { name: '等待期间修改', enabled: false } }, f.quick)
    const completed = Promise.withResolvers<void>()
    const before = f.events.length
    f.listen((method) => { if (method === notices.CHANNELS_CHANGED) completed.resolve() })
    gate.resolve()
    await completed.promise
    expect(await f.backend.channels.resolve(channel.id)).toMatchObject({ apiKey: 'new-secret', name: '等待期间修改', enabled: false })
    expect(f.backend.channels.list()).toHaveLength(1)
    expect(f.events).toHaveLength(before + 2)
  })
})
