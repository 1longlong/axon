import { afterEach, describe, expect, test } from 'bun:test'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { PassThrough } from 'node:stream'
import { createBackend, createBackendPaths, createCredentialCodec } from '@axon/core'
import type { AxonBackend, BackendOptions } from '@axon/core'
import { APP_SERVER_METHODS as methods, APP_SERVER_RPC_OPTIONS } from '@axon/shared'
import type { AgentEnvironmentCheckResult, AgentProviderAdapter, AgentReasoningCapability, AgentReasoningCapabilityInput,
  AgentRuntimeId, AppServerCapabilities, AppServerClient, RpcJsonValue } from '@axon/shared'
import { AppServerConnection, JsonRpcPeer } from './index'
import { toWireValue } from './wire-value'

const cleanups: Array<() => void> = []
afterEach(() => { for (const cleanup of cleanups.splice(0).reverse()) cleanup() })
const report = (cwd: string): AgentEnvironmentCheckResult => ({ cwd, directory: { available: true, writable: true, message: '工作目录可用' },
  git: { available: true, version: 'fixture', message: '可用' }, node: { available: false, message: 'node 不可用' },
  bun: { available: true, message: '可用' } })

/** 真实 core/仓储与双端协议；SDK 目录、宿主版本命令使用注入端口，不打开生产目录。 */
async function open(options: { reasoning?: (runtime: AgentRuntimeId, input: AgentReasoningCapabilityInput) => Promise<AgentReasoningCapability | undefined>;
  probe?: BackendOptions['checkEnvironment'] } = {}) {
  const directory = mkdtempSync(join(tmpdir(), 'axon-capability-rpc-'))
  const upstream = new PassThrough(), downstream = new PassThrough()
  const parent = new JsonRpcPeer(downstream, upstream, { ...APP_SERVER_RPC_OPTIONS, requestTimeoutMs: 2_000 })
  const child = new JsonRpcPeer(upstream, downstream, { ...APP_SERVER_RPC_OPTIONS, requestTimeoutMs: 2_000 })
  const resolves: AgentRuntimeId[] = [], queries: Array<{ runtime: AgentRuntimeId; input: AgentReasoningCapabilityInput }> = []
  const capabilities: AppServerCapabilities = { credentialStorage: 'unavailable', channelTargetConfirmation: false, runtimes: [
    { runtimeId: 'pi', configured: true, capabilities: { thinkingLevel: true, nestedProjectInstructions: 'automatic', osSandbox: false },
      sandbox: { supported: false, modes: [], sandboxedTools: [], limitation: 'hostExecutorUnavailable' } },
    { runtimeId: 'zima', configured: true, capabilities: { thinkingLevel: true, nestedProjectInstructions: 'manual', osSandbox: false },
      sandbox: { supported: false, modes: [], sandboxedTools: [], limitation: 'runtimeToolDelegationUnavailable' } },
  ] }
  let backend: AxonBackend
  const connection = new AppServerConnection({ peer: child, bootstrap: () => {
    backend = createBackend({ paths: createBackendPaths({ dataDir: join(directory, 'data'), homeDir: directory }),
      applicationVersion: '0.1.3', credentialCodec: createCredentialCodec(), checkEnvironment: options.probe,
      resolveAdapter: (runtime): AgentProviderAdapter => {
        resolves.push(runtime)
        return { async *query() { throw new Error('能力查询不得生成消息') }, abort() {}, dispose() {}, async drain() {},
          getReasoningCapability: (input) => {
            queries.push({ runtime, input })
            return options.reasoning ? options.reasoning(runtime, input)
              : runtime === 'pi' ? { levels: ['off', 'low', 'high'], defaultLevel: 'high' } : { levels: ['off', 'medium'], defaultLevel: 'medium' }
          } }
      } })
    return { backend, capabilities, applicationVersion: '0.1.3' }
  } })
  cleanups.push(() => { connection.close(); parent.close(); upstream.destroy(); downstream.destroy(); rmSync(directory, { recursive: true, force: true }) })
  const initialized = await parent.request(methods.INITIALIZE, { protocolVersion: 1, client: { name: 'axon-capability-fixture', version: '0.1.3' },
    hostCapabilities: { credentialStorage: 'unavailable', channelTargetConfirmation: false } })
  const main = await parent.request(methods.REGISTER_CLIENT, { kind: 'main' }) as unknown as AppServerClient
  const quick = await parent.request(methods.REGISTER_CLIENT, { kind: 'quick' }) as unknown as AppServerClient
  const channel = await backend!.channels.create({ name: '隔离渠道', provider: 'openai', apiKey: '', baseUrl: 'https://example.test/v1',
    models: [{ id: 'first', name: '模型一', enabled: true }, { id: 'second', name: '模型二', enabled: true }] })
  const project = backend!.projects.create({ name: '隔离项目' })
  const pi = backend!.sessions.create({ runtimeId: 'pi', channelId: channel.id, modelId: 'first', projectId: project.id })
  const zima = backend!.sessions.create({ runtimeId: 'zima', channelId: channel.id, modelId: 'first', projectId: project.id })
  const request = (method: string, input?: RpcJsonValue, client = main, signal?: AbortSignal) => parent.request(method,
    { clientId: client.clientId, ...(input === undefined ? {} : { input }) }, { signal, timeoutMs: 0 })
  return { directory, parent, child, connection, backend: backend!, capabilities, initialized, resolves, queries, main, quick,
    channel, project, pi, zima, request, disconnect() { upstream.destroy(); downstream.destroy() } }
}

describe('Runtime/模型与宿主环境能力协议', () => {
  test('能力快照来自可信 bootstrap，不创建 Runtime；拒绝额外字段/外来身份，读操作不持久化', async () => {
    const f = await open()
    const before = [...f.resolves]
    expect(f.initialized).toMatchObject({ capabilities: f.capabilities })
    expect(await f.request(methods.GET_CAPABILITIES)).toEqual(toWireValue(f.capabilities))
    expect(await f.request(methods.GET_CAPABILITIES, undefined, f.quick)).toEqual(toWireValue(f.capabilities))
    expect(f.resolves).toEqual(before)
    expect(f.queries).toEqual([])
    await expect(f.request(methods.GET_CAPABILITIES, { runtimeId: 'pi' })).rejects.toMatchObject({ code: -32602 })
    const foreign = f.backend.clients.register()
    await expect(f.parent.request(methods.GET_CAPABILITIES, { clientId: foreign })).rejects.toMatchObject({ code: -32004 })
    await expect(f.parent.request(methods.AGENT_GET_REASONING_CAPABILITY, { clientId: f.main.clientId, input: f.pi.id, owner: f.quick.clientId }))
      .rejects.toMatchObject({ code: -32602 })
    expect(f.backend.sessions.getMessages(f.pi.id)).toEqual([])
  })

  test('思考等级按实际会话 runtime/provider/model 查询，复用执行路由缓存，不解密或猜测未知模型', async () => {
    const f = await open()
    expect(await f.request(methods.AGENT_GET_REASONING_CAPABILITY, ` ${f.pi.id} `)).toEqual({ levels: ['off', 'low', 'high'], defaultLevel: 'high' })
    expect(await f.request(methods.AGENT_GET_REASONING_CAPABILITY, f.zima.id, f.quick)).toEqual({ levels: ['off', 'medium'], defaultLevel: 'medium' })
    await f.request(methods.AGENT_GET_REASONING_CAPABILITY, f.pi.id)
    expect(f.resolves).toEqual(['pi', 'zima'])
    expect(f.backend.getAdapter('pi')).toBe(f.backend.getAdapter('pi'))
    expect(f.resolves).toEqual(['pi', 'zima'])
    expect(f.queries).toEqual([{ runtime: 'pi', input: { provider: 'openai', model: 'first' } },
      { runtime: 'zima', input: { provider: 'openai', model: 'first' } }, { runtime: 'pi', input: { provider: 'openai', model: 'first' } }])
    expect(await f.request(methods.AGENT_GET_REASONING_CAPABILITY, 'missing')).toBeNull()
    const incomplete = f.backend.sessions.create()
    expect(await f.request(methods.AGENT_GET_REASONING_CAPABILITY, incomplete.id)).toBeNull()
    f.backend.sessions.update(f.pi.id, { modelId: 'unknown' })
    expect(await f.request(methods.AGENT_GET_REASONING_CAPABILITY, f.pi.id)).toBeNull()
    expect(f.queries).toHaveLength(3)
    for (const input of [null, {}, '', 2]) await expect(f.request(methods.AGENT_GET_REASONING_CAPABILITY, input)).rejects.toMatchObject({ code: -32602 })
    const unknown = await open({ reasoning: async () => undefined })
    expect(await unknown.request(methods.AGENT_GET_REASONING_CAPABILITY, unknown.pi.id)).toBeNull()
    expect(f.backend.sessions.getMessages(f.pi.id)).toEqual([])
  })

  test('模型目录加载期间切换/删除/禁用选择，旧等级不交付；未知目录错误脱敏', async () => {
    for (const mode of ['switch', 'delete', 'disable']) {
      const gate = Promise.withResolvers<AgentReasoningCapability>(), started = Promise.withResolvers<void>()
      const f = await open({ reasoning: () => { started.resolve(); return gate.promise } })
      const pending = f.request(methods.AGENT_GET_REASONING_CAPABILITY, f.pi.id)
      await started.promise
      if (mode === 'switch') f.backend.sessions.update(f.pi.id, { modelId: 'second' })
      else if (mode === 'delete') f.backend.sessions.delete(f.pi.id)
      else await f.backend.channels.update(f.channel.id, { enabled: false })
      gate.resolve({ levels: ['high'], defaultLevel: 'high' })
      expect(await pending).toBeNull()
    }
    const failed = await open({ reasoning: async () => { throw new Error('sk-private /private/runtime') } })
    await expect(failed.request(methods.AGENT_GET_REASONING_CAPABILITY, failed.pi.id))
      .rejects.toMatchObject({ code: -32603, message: 'RPC 请求处理失败' })
  })

  test('RPC 取消/入口注销/管道断开撤销目录等待；迟到结果不重投、不停止共享 runtime', async () => {
    for (const mode of ['cancel', 'detach', 'disconnect']) {
      const started = Promise.withResolvers<void>(), gate = Promise.withResolvers<AgentReasoningCapability>()
      const f = await open({ reasoning: () => { started.resolve(); return gate.promise } })
      const abort = new AbortController()
      const outcome = f.request(methods.AGENT_GET_REASONING_CAPABILITY, f.pi.id, f.main, abort.signal).catch((error: unknown) => error)
      await started.promise
      if (mode === 'cancel') abort.abort()
      else if (mode === 'detach') await f.parent.request(methods.DETACH_CLIENT, { clientId: f.main.clientId })
      else f.disconnect()
      expect(await outcome).toBeInstanceOf(Error)
      gate.resolve({ levels: ['low'], defaultLevel: 'low' })
      if (mode !== 'disconnect') {
        expect(await f.request(methods.AGENT_GET_REASONING_CAPABILITY, f.pi.id, f.quick)).toEqual({ levels: ['low'], defaultLevel: 'low' })
        expect(f.resolves).toEqual(['pi'])
      }
      expect(f.backend.sessions.getMessages(f.pi.id)).toEqual([])
    }
  })

  test('环境检查只接受项目 ID，由后端解析托管目录；缺少宿主或错误项目明确失败', async () => {
    const calls: Array<{ cwd?: string }> = []
    const f = await open({ probe: async (input) => { calls.push(input); return report(input.cwd ?? 'trusted-host-cwd') } })
    expect(await f.request(methods.AGENT_CHECK_ENVIRONMENT)).toEqual(toWireValue(report('trusted-host-cwd')))
    const cwd = f.backend.projects.resolveProjectCwd(f.project.id)
    expect(await f.request(methods.AGENT_CHECK_ENVIRONMENT, { projectId: f.project.id }, f.quick)).toEqual(toWireValue(report(cwd)))
    expect(calls).toEqual([{}, { cwd }])
    const bad: RpcJsonValue[] = [null, '', [], { cwd: '/private' }, { command: 'evil' }, { projectId: 1 }, { projectId: '' }]
    for (const input of bad) {
      await expect(f.request(methods.AGENT_CHECK_ENVIRONMENT, input)).rejects.toMatchObject({ code: -32602 })
    }
    await expect(f.request(methods.AGENT_CHECK_ENVIRONMENT, { projectId: 'missing' })).rejects.toMatchObject({ code: -32023, data: { code: 'not_found' } })
    expect(calls).toHaveLength(2)
    const missing = await open()
    await expect(missing.request(methods.AGENT_CHECK_ENVIRONMENT)).rejects.toMatchObject({ code: -32028, data: { code: 'unavailable' } })
  })

  test('环境探测传入原入口取消信号，迟到结果/项目变化不交付，另一入口继续可用', async () => {
    for (const mode of ['cancel', 'detach', 'disconnect', 'workspace']) {
      const started = Promise.withResolvers<AbortSignal>(), gate = Promise.withResolvers<AgentEnvironmentCheckResult>()
      const f = await open({ probe: (_input, signal) => { started.resolve(signal); return gate.promise } })
      const abort = new AbortController(), cwd = f.backend.projects.resolveProjectCwd(f.project.id)
      const outcome = f.request(methods.AGENT_CHECK_ENVIRONMENT, { projectId: f.project.id }, f.main, abort.signal).catch((error: unknown) => error)
      const signal = await started.promise
      if (mode === 'cancel') abort.abort()
      else if (mode === 'detach') await f.parent.request(methods.DETACH_CLIENT, { clientId: f.main.clientId })
      else if (mode === 'disconnect') f.disconnect()
      else f.backend.projects.update(f.project.id, { workspace: { kind: 'local', path: f.directory } })
      if (mode !== 'workspace') expect(await outcome).toBeInstanceOf(Error)
      gate.resolve(report(cwd))
      if (mode === 'workspace') expect(await outcome).toMatchObject({ code: -32028, data: { code: 'unavailable' } })
      else expect(signal.aborted).toBe(true)
      if (mode !== 'disconnect') expect(await f.request(methods.GET_CAPABILITIES, undefined, f.quick)).toEqual(toWireValue(f.capabilities))
    }
    const failed = await open({ probe: async () => { throw new Error('sk-private /private/host') } })
    await expect(failed.request(methods.AGENT_CHECK_ENVIRONMENT)).rejects.toMatchObject({ code: -32603, message: 'RPC 请求处理失败' })
  })

  test('工厂释放撤销直接 core 能力等待，迟到共享结果不创建历史；释放后不启动宿主探测', async () => {
    const started = Promise.withResolvers<void>(), gate = Promise.withResolvers<AgentReasoningCapability>()
    const f = await open({ reasoning: () => { started.resolve(); return gate.promise } })
    const pending = f.backend.agentCapabilities.getReasoningCapability(f.pi.id).catch((error: unknown) => error)
    await started.promise
    f.backend.dispose()
    expect(await pending).toMatchObject({ name: 'AbortError' })
    gate.resolve({ levels: ['high'], defaultLevel: 'high' })
    await expect(f.backend.agentCapabilities.checkEnvironment({ projectId: f.project.id })).rejects.toMatchObject({ name: 'AbortError' })
    expect(f.queries).toHaveLength(1)
    expect(f.backend.sessions.getMessages(f.pi.id)).toEqual([])
  })
})
