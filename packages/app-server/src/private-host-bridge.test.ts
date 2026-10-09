import { afterEach, describe, expect, test } from 'bun:test'
import { existsSync, mkdtempSync, readFileSync, rmSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { PassThrough } from 'node:stream'
import { createHash } from 'node:crypto'
import { createBackend, createBackendPaths, createCredentialCodec, McpProjectConfigManager } from '@axon/core'
import type { AxonBackend, CredentialCodec } from '@axon/core'
import { APP_SERVER_HOST_METHODS as methods, APP_SERVER_RPC_OPTIONS } from '@axon/shared'
import type { AgentProviderAdapter, AgentStreamPayload, RpcJsonObject } from '@axon/shared'
import { createFixtureCredentialCodec } from '../../core/test-support/credential-codec'
import { createPrivateHostPorts, JsonRpcPeer, registerPrivateHostBridge, RpcFault } from './index'
import type { JsonRpcPeerOptions } from './index'

const cleanups: Array<() => void> = []
afterEach(() => { for (const cleanup of cleanups.splice(0).reverse()) cleanup() })
function pair(timeoutMs = 2_000, options: JsonRpcPeerOptions = {}) {
  const upstream = new PassThrough()
  const downstream = new PassThrough()
  const parent = new JsonRpcPeer(downstream, upstream, { ...options, requestTimeoutMs: timeoutMs })
  const child = new JsonRpcPeer(upstream, downstream, { ...options, requestTimeoutMs: timeoutMs })
  cleanups.push(() => { parent.close(); child.close(); upstream.destroy(); downstream.destroy() })
  return { parent, child }
}
const capability = { credentialStorage: 'safe-storage' as const, channelTargetConfirmation: true }
const target = 'https://example.test/v1/models'

describe('父子私有宿主反向桥', () => {
  test('委托实际 codec，保留 secure:v1: envelope；空凭据不发请求', async () => {
    const { parent, child } = pair()
    const codec = createFixtureCredentialCodec()
    let encrypts = 0
    let decrypts = 0
    const report = registerPrivateHostBridge(parent, {
      credentialCodec: { ...codec,
        encrypt: async (value) => { encrypts += 1; return codec.encrypt(value) },
        decrypt: async (value) => { decrypts += 1; return codec.decrypt(value) },
      }, getClientSignal: () => undefined,
    })
    expect(report).toEqual({ credentialStorage: 'safe-storage', channelTargetConfirmation: false })
    const { credentialCodec: bridge } = createPrivateHostPorts(child, report)
    expect(bridge.isSecure).toBe(true)
    expect(await bridge.encrypt('')).toBe('')
    expect(await bridge.decrypt('')).toBe('')
    expect(encrypts + decrypts).toBe(0)
    const encrypted = await bridge.encrypt('fixture-secret-中文')
    expect(encrypted).toStartWith('secure:v1:')
    expect(encrypted).not.toContain('fixture-secret')
    expect(await bridge.decrypt(encrypted)).toBe('fixture-secret-中文')
    expect(await codec.decrypt(encrypted)).toBe('fixture-secret-中文')
    expect(encrypts).toBe(1)
    expect(decrypts).toBe(1)
  })

  test('无安全存储/未协商端口不发送非空凭据，不降级明文或自动确认', async () => {
    const { parent, child } = pair()
    const report = registerPrivateHostBridge(parent, { credentialCodec: createCredentialCodec(), getClientSignal: () => undefined })
    expect(report.credentialStorage).toBe('unavailable')
    const ports = createPrivateHostPorts(child, report)
    expect(ports.credentialCodec.isSecure).toBe(false)
    expect(await ports.credentialCodec.encrypt('')).toBe('')
    await expect(ports.credentialCodec.encrypt('fixture-secret')).rejects.toThrow('安全存储不可用')
    await expect(ports.credentialCodec.decrypt('secure:v1:fixture')).rejects.toThrow('安全存储不可用')
    expect(await ports.confirmChannelTarget('missing', target, new AbortController().signal)).toBe(false)
    await expect(child.request(methods.ENCRYPT_CREDENTIAL, { value: 'fixture-secret' })).rejects.toMatchObject({ code: -32010 })
  })

  test('声明有桥但方法不存在/响应错误/宿主异常仍明确失败且不回显凭据', async () => {
    const missing = pair()
    const missingPorts = createPrivateHostPorts(missing.child, capability)
    await expect(missingPorts.credentialCodec.encrypt('fixture-secret')).rejects.toThrow('宿主凭据操作失败')
    expect(await missingPorts.confirmChannelTarget('client', target, new AbortController().signal)).toBe(false)
    const bad = pair()
    bad.parent.handle(methods.ENCRYPT_CREDENTIAL, () => null)
    bad.parent.handle(methods.DECRYPT_CREDENTIAL, () => { throw new RpcFault(-32603, 'fixture-secret') })
    bad.parent.handle(methods.CONFIRM_CHANNEL_TARGET, () => 'yes')
    const badPorts = createPrivateHostPorts(bad.child, capability)
    await expect(badPorts.credentialCodec.encrypt('fixture-secret')).rejects.toThrow('宿主凭据操作失败')
    await expect(badPorts.credentialCodec.decrypt('secure:v1:fixture')).rejects.toThrow('宿主凭据操作失败')
    expect(await badPorts.confirmChannelTarget('client', target, new AbortController().signal)).toBe(false)
    const failed = pair()
    const codec: CredentialCodec = { isSecure: true, storageKind: 'safe-storage',
      encrypt: async () => { throw new Error('fixture-secret native diagnostic') }, decrypt: async () => 'invalid',
    }
    registerPrivateHostBridge(failed.parent, { credentialCodec: codec, getClientSignal: () => undefined })
    await expect(failed.child.request(methods.ENCRYPT_CREDENTIAL, { value: 'fixture-secret' }))
      .rejects.toMatchObject({ code: -32010, message: '宿主凭据操作失败' })
  })

  test('私有参数严格校验，不能携带执行字段或把密钥作为目标 URL 认证参数', async () => {
    const { parent, child } = pair()
    registerPrivateHostBridge(parent, { credentialCodec: createFixtureCredentialCodec(), getClientSignal: () => undefined })
    const invalidParams: Array<RpcJsonObject | []> = [{ value: 1 }, { value: 'fixture-secret', command: 'run' }, []]
    for (const params of invalidParams) {
      await expect(child.request(methods.ENCRYPT_CREDENTIAL, params)).rejects.toMatchObject({ code: -32602 })
    }
    for (const url of ['file:///private', 'https://user:secret@example.test/v1/models',
      'https://example.test/v1/models?api_key=secret', 'invalid']) {
      await expect(child.request(methods.CONFIRM_CHANNEL_TARGET, { clientId: 'client', url }))
        .rejects.toMatchObject({ code: -32602 })
    }
    await expect(child.request(methods.CONFIRM_CHANNEL_TARGET, { clientId: 'client', url: target, owner: 'other' }))
      .rejects.toMatchObject({ code: -32602 })
  })

  test('只确认已登记原入口和原目标，未知/断开入口拒绝；身份替换使旧批准失效', async () => {
    const { parent, child } = pair()
    const clients = new Map<string, AbortSignal>([['client', new AbortController().signal]])
    const gate = Promise.withResolvers<boolean>()
    const arrived = Promise.withResolvers<void>()
    const confirmed: Array<{ clientId: string; url: string }> = []
    const report = registerPrivateHostBridge(parent, {
      credentialCodec: createFixtureCredentialCodec(), getClientSignal: (id) => clients.get(id),
      confirmChannelTarget: async (clientId, url) => { confirmed.push({ clientId, url }); arrived.resolve(); return gate.promise },
    })
    const ports = createPrivateHostPorts(child, report)
    expect(await ports.confirmChannelTarget('missing', target, new AbortController().signal)).toBe(false)
    expect(confirmed).toHaveLength(0)
    const pending = ports.confirmChannelTarget('client', target, new AbortController().signal)
    await arrived.promise
    expect(confirmed).toEqual([{ clientId: 'client', url: target }])
    clients.set('client', new AbortController().signal)
    gate.resolve(true)
    expect(await pending).toBe(false)
  })

  test('取消/断开原入口及时结束宿主等待；迟到批准不影响其他 RPC', async () => {
    const { parent, child } = pair()
    const owner = new AbortController()
    const gate = Promise.withResolvers<boolean>()
    const arrived = Promise.withResolvers<AbortSignal>()
    const report = registerPrivateHostBridge(parent, {
      credentialCodec: createFixtureCredentialCodec(), getClientSignal: (id) => id === 'client' ? owner.signal : undefined,
      confirmChannelTarget: async (_id, _url, signal) => { arrived.resolve(signal); return gate.promise },
    })
    const ports = createPrivateHostPorts(child, report)
    const pending = ports.confirmChannelTarget('client', target, new AbortController().signal)
    const combined = await arrived.promise
    owner.abort()
    expect(await pending).toBe(false)
    expect(combined.aborted).toBe(true)
    gate.resolve(true)
    expect(await ports.credentialCodec.decrypt(await ports.credentialCodec.encrypt('fixture-secret'))).toBe('fixture-secret')
    expect(await ports.confirmChannelTarget('client', target, new AbortController().signal)).toBe(false)
  })

  test('后端信号取消/确认超时传给父进程，普通请求不被等待堵塞', async () => {
    const { parent, child } = pair()
    const signals: AbortSignal[] = []
    const gates: Array<ReturnType<typeof Promise.withResolvers<boolean>>> = []
    const arrived = Promise.withResolvers<void>()
    const owner = new AbortController()
    const report = registerPrivateHostBridge(parent, {
      credentialCodec: createFixtureCredentialCodec(), getClientSignal: () => owner.signal,
      confirmChannelTarget: async (_id, _url, signal) => {
        const gate = Promise.withResolvers<boolean>()
        gates.push(gate); signals.push(signal); arrived.resolve()
        return gate.promise
      },
    })
    const ports = createPrivateHostPorts(child, report, { confirmationTimeoutMs: 20 })
    const stop = new AbortController()
    const pending = ports.confirmChannelTarget('client', target, stop.signal)
    await arrived.promise
    expect(await ports.credentialCodec.encrypt('fixture-secret')).toStartWith('secure:v1:')
    stop.abort()
    expect(await pending).toBe(false)
    expect(signals[0]?.aborted).toBe(true)
    expect(await ports.confirmChannelTarget('client', target, owner.signal)).toBe(false)
    expect(signals[1]?.aborted).toBe(true)
    for (const gate of gates) gate.resolve(true)
    expect(await ports.credentialCodec.encrypt('fixture-secret')).toStartWith('secure:v1:')
  })

  test('管道关闭拒绝在途凭据与确认，返回后不接纳迟到值', async () => {
    const { parent, child } = pair()
    const encrypted = Promise.withResolvers<string>()
    const confirmed = Promise.withResolvers<boolean>()
    const started = Promise.withResolvers<void>()
    const owner = new AbortController()
    const codec: CredentialCodec = { isSecure: true, storageKind: 'safe-storage',
      encrypt: async () => { started.resolve(); return encrypted.promise }, decrypt: async () => '',
    }
    registerPrivateHostBridge(parent, { credentialCodec: codec, getClientSignal: () => owner.signal,
      confirmChannelTarget: async () => confirmed.promise })
    const ports = createPrivateHostPorts(child, capability)
    const encoding = ports.credentialCodec.encrypt('fixture-secret')
    const rejected = encoding.catch((error: unknown) => error)
    const confirm = ports.confirmChannelTarget('client', target, owner.signal)
    await started.promise
    child.close(); parent.close()
    expect(await rejected).toMatchObject({ message: '宿主凭据操作失败' })
    expect(await confirm).toBe(false)
    encrypted.resolve('secure:v1:late'); confirmed.resolve(true)
    await expect(ports.credentialCodec.encrypt('fixture-secret')).rejects.toThrow('宿主安全存储不可用')
  })
})

test('分段私有桥：超过 8 MiB 的合法 MCP 配置完整加密、落盘和重建恢复', async () => {
  const { parent, child } = pair(15_000, APP_SERVER_RPC_OPTIONS)
  const report = registerPrivateHostBridge(parent, { credentialCodec: createFixtureCredentialCodec(), getClientSignal: () => undefined })
  const ports = createPrivateHostPorts(child, report)
  const directory = mkdtempSync(join(tmpdir(), 'axon-large-mcp-'))
  cleanups.push(() => rmSync(directory, { recursive: true, force: true }))
  const open = () => new McpProjectConfigManager({ credentialCodec: ports.credentialCodec, resolveProjectDataDir: () => directory })
  const env = Object.fromEntries(Array.from({ length: 128 }, (_, index) => [`KEY_${index}`, 'x'.repeat(8192)]))
  const config = { version: 1, servers: Object.fromEntries(Array.from({ length: 10 }, (_, index) =>
    [`fixture-${index}`, { type: 'stdio', command: 'fixture', enabled: false, env }])) }
  expect(Buffer.byteLength(JSON.stringify(config))).toBeGreaterThan(8 * 1024 * 1024)
  const saved = await open().save('project', config)
  const stored = readFileSync(join(directory, 'mcp.json'), 'utf8')
  expect(stored).toContain('secure:v1:')
  expect(stored).not.toContain('KEY_127')
  const recovered = await open().get('project')
  expect(createHash('sha256').update(JSON.stringify(recovered)).digest('hex'))
    .toBe(createHash('sha256').update(JSON.stringify(saved)).digest('hex'))
}, 30_000)

class FixtureAdapter implements AgentProviderAdapter {
  async *query(): AsyncIterable<AgentStreamPayload> { yield { kind: 'sdk_message', message: { type: 'result', subtype: 'success' } } }
  abort(): void {}
  dispose(): void {}
  async drain(): Promise<void> {}
}

/** 实际渠道/MCP 仓储经私有 RPC 等待加解密；模型/网络为夹具，不接触用户数据。 */
test('真实 core：桥接加密保存/重建恢复，目标确认先于解密/网络且绑定原 owner', async () => {
  const { parent, child } = pair()
  const directory = mkdtempSync(join(tmpdir(), 'axon-host-bridge-'))
  const paths = createBackendPaths({ dataDir: join(directory, 'data'), homeDir: directory })
  const fixtureCodec = createFixtureCredentialCodec()
  let backend: AxonBackend | undefined
  let confirmation: boolean = true
  let decrypts = 0
  const order: string[] = []
  const report = registerPrivateHostBridge(parent, {
    credentialCodec: { ...fixtureCodec, decrypt: async (value) => { order.push('decrypt'); decrypts += 1; return fixtureCodec.decrypt(value) } },
    getClientSignal: (id) => backend?.clients.getSignal(id),
    confirmChannelTarget: async (_id, url) => { expect(url).toBe(target); order.push('confirm'); return confirmation },
  })
  const ports = createPrivateHostPorts(child, report)
  const open = () => createBackend({ paths, applicationVersion: '0.1.3', ...ports, resolveAdapter: () => new FixtureAdapter(),
    channelFetch: async (url, init) => {
      expect(url).toBe(target)
      expect(new Headers(init.headers).get('Authorization')).toBe('Bearer fixture-secret')
      expect(init.redirect).toBe('manual')
      order.push('fetch')
      return new Response(JSON.stringify({ data: [{ id: 'model', name: 'Model' }] }))
    },
  })
  backend = open()
  cleanups.push(() => { backend?.dispose(); rmSync(directory, { recursive: true, force: true }) })
  const channel = await backend.channelController.create({ name: '隔离渠道', provider: 'openai',
    baseUrl: 'https://example.test/v1', apiKey: 'fixture-secret', models: [] })
  const stored = readFileSync(paths.channelsPath, 'utf8')
  expect(stored).toContain('secure:v1:')
  expect(stored).not.toContain('fixture-secret')
  const project = backend.projects.create({ name: '隔离项目' })
  const mcp = { version: 1, servers: { fixture: { type: 'http', url: 'https://mcp.example.test/mcp',
    headers: { Authorization: 'Bearer mcp-secret' }, enabled: false } } }
  await backend.mcp.save(project.id, mcp)
  const mcpPath = join(backend.projects.resolveProjectDataDir(project.id), 'mcp.json')
  expect(readFileSync(mcpPath, 'utf8')).not.toContain('mcp-secret')
  expect(await backend.mcp.get(project.id)).toMatchObject(mcp)
  backend.dispose()
  backend = open()
  expect((await backend.channels.resolve(channel.id)).apiKey).toBe('fixture-secret')
  expect(await backend.mcp.get(project.id)).toMatchObject(mcp)
  const owner = backend.clients.register()
  order.length = 0
  const input = { requestId: 'first', operation: 'models', provider: 'openai', baseUrl: 'https://example.test/v1', channelId: channel.id }
  expect(await backend.channelNetwork.request(owner, input)).toMatchObject({ success: true, models: [{ id: 'model' }] })
  expect(order).toEqual(['confirm', 'decrypt', 'fetch'])
  confirmation = false
  const before = decrypts
  order.length = 0
  expect(await backend.channelNetwork.request(owner, { ...input, requestId: 'denied' })).toMatchObject({ success: false, code: 'cancelled' })
  expect(decrypts).toBe(before)
  expect(order).toEqual(['confirm'])
  backend.clients.detach(owner)
  order.length = 0
  expect(await backend.channelNetwork.request(owner, { ...input, requestId: 'detached' })).toMatchObject({ success: false, code: 'invalid_input' })
  expect(order).toEqual([])
  // 丢失桥时不能发布候选渠道；保留上一份有效密文。
  child.close(); parent.close()
  await expect(backend.channelController.create({ name: '失败渠道', provider: 'openai', apiKey: 'new-secret' }))
    .rejects.toMatchObject({ code: 'credential_error' })
  expect(readFileSync(paths.channelsPath, 'utf8')).toBe(stored)
  expect(existsSync(paths.channelsPath)).toBe(true)
})
