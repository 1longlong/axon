import { afterEach, describe, expect, spyOn, test } from 'bun:test'
import { existsSync, mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { PassThrough } from 'node:stream'
import { createBackend, createBackendPaths, createCredentialCodec } from '@axon/core'
import type { AxonBackend } from '@axon/core'
import { APP_SERVER_METHODS as methods, APP_SERVER_PROTOCOL_VERSION } from '@axon/shared'
import type {
  AgentProviderAdapter, AgentQueryInput, AgentStreamPayload, AppServerClient,
  AppServerInitializeResult, RpcJsonObject,
} from '@axon/shared'
import { AppServerBootstrapCleanupError, AppServerConnection, JsonRpcPeer } from './index'
import type { AppServerBootstrap } from './index'

const cleanups: Array<() => void | Promise<void>> = []
afterEach(async () => { for (const cleanup of cleanups.splice(0).reverse()) await cleanup() })

class ScriptedAdapter implements AgentProviderAdapter {
  disposals = 0
  drains = 0
  drainGate?: Promise<void>
  readonly drainStarted = Promise.withResolvers<void>()
  handler: (input: AgentQueryInput) => AsyncIterable<AgentStreamPayload> = async function* () {
    yield { kind: 'sdk_message', message: { type: 'result', subtype: 'success' } }
  }
  query(input: AgentQueryInput) { return this.handler(input) }
  abort(): void {}
  dispose(): void { this.disposals += 1 }
  async drain(): Promise<void> {
    this.drains += 1
    this.drainStarted.resolve()
    await this.drainGate
  }
}

const initialize: RpcJsonObject = {
  protocolVersion: APP_SERVER_PROTOCOL_VERSION,
  client: { name: 'axon-fixture', version: '0.1.3' },
  hostCapabilities: { credentialStorage: 'unavailable', channelTargetConfirmation: false },
}

/** 使用真实 core 装配与协议双端；仅替换模型执行，不读取用户配置或加载 SDK。 */
function open(options: { maxClients?: number; gate?: Promise<void>; fail?: boolean; failure?: Error; afterBootstrap?: (backend: AxonBackend) => void } = {}) {
  const directory = mkdtempSync(join(tmpdir(), 'axon-app-connection-'))
  const paths = createBackendPaths({ dataDir: join(directory, 'data'), homeDir: directory })
  const upstream = new PassThrough()
  const downstream = new PassThrough()
  const parent = new JsonRpcPeer(downstream, upstream, { requestTimeoutMs: 2_000 })
  const child = new JsonRpcPeer(upstream, downstream, { requestTimeoutMs: 2_000 })
  const adapter = new ScriptedAdapter()
  const started = Promise.withResolvers<void>()
  const bootstrapped = Promise.withResolvers<void>()
  let calls = 0
  let backend: AxonBackend | undefined
  let signal: AbortSignal | undefined
  const connection = new AppServerConnection({ peer: child, maxClients: options.maxClients,
    bootstrap: async (_input, stop): Promise<AppServerBootstrap> => {
      calls += 1
      signal = stop
      started.resolve()
      await options.gate
      if (options.fail) throw options.failure ?? new Error('sk-secret /private/credential')
      backend = createBackend({ paths, applicationVersion: '0.1.3', credentialCodec: createCredentialCodec(),
        resolveAdapter: () => adapter,
        providerStream: async function* () {
          yield { type: 'text_delta', delta: '测试标题' }
          yield { type: 'finish', reason: 'stop' }
        },
      })
      options.afterBootstrap?.(backend)
      bootstrapped.resolve()
      return { backend, applicationVersion: '0.1.3', capabilities: {
        runtimes: [], credentialStorage: 'unavailable', channelTargetConfirmation: false,
      } }
    },
  })
  cleanups.push(async () => {
    connection.close(); parent.close(); child.close()
    upstream.destroy(); downstream.destroy()
    await connection.drain().catch(() => {}) // 失败诊断由对应测试断言，目录只在真实等待之后删除。
    rmSync(directory, { recursive: true, force: true })
  })
  return { parent, child, connection, paths, adapter, started: started.promise, bootstrapped: bootstrapped.promise,
    get calls() { return calls }, get signal() { return signal },
    get backend() { if (!backend) throw new Error('测试后端尚未装配'); return backend },
  }
}
async function register(parent: JsonRpcPeer, kind = 'main'): Promise<AppServerClient> {
  return await parent.request(methods.REGISTER_CLIENT, { kind }) as unknown as AppServerClient
}

describe('应用初始化和连接身份边界', () => {
  test('握手前拒绝业务；版本/未知字段失败不创建数据目录，成功返回实际装配信息', async () => {
    const fixture = open()
    await expect(fixture.parent.request(methods.GET_SETTINGS, { clientId: 'fake' })).rejects.toMatchObject({ code: -32002 })
    for (const method of [methods.GET_CAPABILITIES, methods.AGENT_CHECK_ENVIRONMENT, methods.AGENT_GET_REASONING_CAPABILITY,
      methods.HISTORY_READ, methods.HISTORY_CLOSE]) {
      await expect(fixture.parent.request(method, { clientId: 'fake' })).rejects.toMatchObject({ code: -32002 })
    }
    await expect(register(fixture.parent)).rejects.toMatchObject({ code: -32002 })
    await expect(fixture.parent.request(methods.INITIALIZE, { ...initialize, protocolVersion: 99 }))
      .rejects.toMatchObject({ code: -32006, data: { supportedVersion: APP_SERVER_PROTOCOL_VERSION } })
    await expect(fixture.parent.request(methods.INITIALIZE, { ...initialize, dataDirectory: '/private' }))
      .rejects.toMatchObject({ code: -32602 })
    expect(fixture.calls).toBe(0)
    expect(existsSync(fixture.paths.dataDir)).toBe(false)
    const result = await fixture.parent.request(methods.INITIALIZE, initialize) as unknown as AppServerInitializeResult
    expect(result).toMatchObject({ protocolVersion: APP_SERVER_PROTOCOL_VERSION, applicationVersion: '0.1.3',
      dataDirectory: fixture.paths.dataDir, capabilities: { credentialStorage: 'unavailable', runtimes: [] } })
    expect(result.connectionId).toMatch(/^[0-9a-f-]{36}$/)
    expect(existsSync(fixture.paths.dataDir)).toBe(true)
    await expect(fixture.parent.request(methods.INITIALIZE, initialize)).rejects.toMatchObject({ code: -32005 })
    expect(fixture.calls).toBe(1)
  })

  test('服务器生成多个身份；共享设置/资料，不接受自报身份、额外 owner 或外来登记 ID', async () => {
    const fixture = open()
    await fixture.parent.request(methods.INITIALIZE, initialize)
    const main = await register(fixture.parent)
    const quick = await register(fixture.parent, 'quick')
    expect(main.clientId).not.toBe(quick.clientId)
    expect(main).toMatchObject({ kind: 'main' })
    expect(quick).toMatchObject({ kind: 'quick' })
    const settings = fixture.backend.settings.get()
    expect(await fixture.parent.request(methods.GET_SETTINGS, { clientId: main.clientId }))
      .toEqual(JSON.parse(JSON.stringify(settings)))
    expect(await fixture.parent.request(methods.GET_SETTINGS, { clientId: quick.clientId }))
      .toEqual(JSON.parse(JSON.stringify(settings)))
    expect(await fixture.parent.request(methods.GET_USER_PROFILE, { clientId: quick.clientId }))
      .toEqual({ ...fixture.backend.userProfile.get() })
    await expect(fixture.parent.request(methods.REGISTER_CLIENT, { kind: 'main', clientId: main.clientId }))
      .rejects.toMatchObject({ code: -32602 })
    await expect(register(fixture.parent, 'arbitrary')).rejects.toMatchObject({ code: -32602 })
    for (const kind of [['main'], null, 1, { value: 'main' }]) {
      await expect(fixture.parent.request(methods.REGISTER_CLIENT, { kind })).rejects.toMatchObject({ code: -32602 })
    }
    await expect(fixture.parent.request(methods.GET_SETTINGS, { clientId: main.clientId, owner: quick.clientId }))
      .rejects.toMatchObject({ code: -32602 })
    const foreignId = fixture.backend.clients.register()
    await expect(fixture.parent.request(methods.GET_SETTINGS, { clientId: foreignId })).rejects.toMatchObject({ code: -32004 })
    await expect(fixture.parent.request(methods.DETACH_CLIENT, { clientId: foreignId })).rejects.toMatchObject({ code: -32004 })
    expect(fixture.backend.clients.has(foreignId)).toBe(true)
    expect(await fixture.parent.request(methods.DETACH_CLIENT, { clientId: main.clientId })).toBe(true)
    expect(fixture.child.closed).toBe(false)
    await expect(fixture.parent.request(methods.GET_SETTINGS, { clientId: main.clientId })).rejects.toMatchObject({ code: -32004 })
    expect(await fixture.parent.request(methods.GET_USER_PROFILE, { clientId: quick.clientId })).toBeDefined()
  })

  test('登记容量有界；core 注销会移除连接记录并释放容量', async () => {
    const fixture = open({ maxClients: 1 })
    await fixture.parent.request(methods.INITIALIZE, initialize)
    const first = await register(fixture.parent)
    await expect(register(fixture.parent, 'quick')).rejects.toMatchObject({ code: -32001 })
    fixture.backend.clients.detach(first.clientId)
    await expect(fixture.parent.request(methods.GET_SETTINGS, { clientId: first.clientId })).rejects.toMatchObject({ code: -32004 })
    const next = await register(fixture.parent, 'quick')
    expect(next.clientId).not.toBe(first.clientId)
  })

  test('注销一个入口取消其真实 core 运行，另一入口的运行不受影响', async () => {
    const fixture = open()
    await fixture.parent.request(methods.INITIALIZE, initialize)
    const main = await register(fixture.parent)
    const quick = await register(fixture.parent, 'quick')
    const backend = fixture.backend
    const channel = await backend.channels.create({ name: '隔离渠道', provider: 'openai', apiKey: '',
      baseUrl: 'https://example.test/v1', models: [{ id: 'fixture-model', name: '测试模型', enabled: true }] })
    const project = backend.projects.create({ name: '隔离项目' })
    const first = backend.sessions.create({ title: '主窗口', projectId: project.id, channelId: channel.id, modelId: 'fixture-model' })
    const second = backend.sessions.create({ title: '快捷窗口', projectId: project.id, channelId: channel.id, modelId: 'fixture-model' })
    const starts = new Map([first.id, second.id].map((id) => [id, Promise.withResolvers<AbortSignal>()]))
    fixture.adapter.handler = async function* (input) {
      const signal = input.abortSignal!
      starts.get(input.sessionId)!.resolve(signal)
      await new Promise<void>((resolve) => {
        if (signal.aborted) resolve()
        else signal.addEventListener('abort', () => resolve(), { once: true })
      })
      yield { kind: 'sdk_message', message: { type: 'result', subtype: 'success' } }
    }
    const firstRun = backend.agentRuns.send(main.clientId, { sessionId: first.id, text: '主入口运行' }, () => {})
    const secondRun = backend.agentRuns.send(quick.clientId, { sessionId: second.id, text: '快捷入口运行' }, () => {})
    const firstSignal = await starts.get(first.id)!.promise
    const secondSignal = await starts.get(second.id)!.promise
    expect(backend.agentRuns.getOwnedRun(main.clientId, first.id)).toBeDefined()
    expect(await fixture.parent.request(methods.DETACH_CLIENT, { clientId: main.clientId })).toBe(true)
    expect(firstSignal.aborted).toBe(true)
    expect(secondSignal.aborted).toBe(false)
    await firstRun
    const secondIdentity = backend.agentRuns.getOwnedRun(quick.clientId, second.id)!
    expect(backend.agentRuns.stopRun(quick.clientId, {
      sessionId: secondIdentity.sessionId, runId: secondIdentity.runId,
    })).toBe(true)
    await secondRun
    expect(backend.sessions.getMessages(first.id).some((message) => message.type === 'result' && message.subtype === 'success')).toBe(false)
  })

  test('异步装配中拒绝第二次握手和业务；只创建一个后端', async () => {
    const gate = Promise.withResolvers<void>()
    const fixture = open({ gate: gate.promise })
    const pending = fixture.parent.request(methods.INITIALIZE, initialize)
    await fixture.started
    await expect(fixture.parent.request(methods.INITIALIZE, initialize)).rejects.toMatchObject({ code: -32005 })
    await expect(register(fixture.parent)).rejects.toMatchObject({ code: -32002 })
    gate.resolve()
    expect(await pending).toBeDefined()
    expect(fixture.calls).toBe(1)
    expect(await register(fixture.parent)).toBeDefined()
  })

  test('初始化取消关闭连接，迟到的真实装配结果回收一次，不重新开放业务', async () => {
    const gate = Promise.withResolvers<void>()
    const fixture = open({ gate: gate.promise })
    const controller = new AbortController()
    const pending = fixture.parent.request(methods.INITIALIZE, initialize, { signal: controller.signal })
    const rejected = pending.catch((error: unknown) => error)
    await fixture.started
    controller.abort()
    expect(await rejected).toMatchObject({ code: 'canceled' })
    expect(fixture.signal?.aborted).toBe(true)
    expect(fixture.connection.closed).toBe(true)
    gate.resolve()
    await fixture.bootstrapped
    await Bun.sleep(0)
    expect(fixture.adapter.disposals).toBe(1)
    expect(() => fixture.backend.clients.register()).toThrow('客户端登记表已释放')
    fixture.connection.close()
    expect(fixture.adapter.disposals).toBe(1)
  })

  test('物理断开注销所有入口并幂等释放；失败握手脱敏且不能重装配', async () => {
    const fixture = open()
    await fixture.parent.request(methods.INITIALIZE, initialize)
    const main = await register(fixture.parent)
    const quick = await register(fixture.parent, 'quick')
    fixture.child.close()
    expect(fixture.connection.closed).toBe(true)
    expect(fixture.backend.clients.has(main.clientId)).toBe(false)
    expect(fixture.backend.clients.has(quick.clientId)).toBe(false)
    fixture.connection.close()
    expect(fixture.adapter.disposals).toBe(1)
    const failed = open({ fail: true })
    await expect(failed.parent.request(methods.INITIALIZE, initialize))
      .rejects.toMatchObject({ code: -32003, message: '后端初始化失败' })
    await expect(register(failed.parent)).rejects.toMatchObject({ code: -32002 })
    await expect(failed.parent.request(methods.INITIALIZE, initialize)).rejects.toMatchObject({ code: -32005 })
    expect(failed.calls).toBe(1)
  })

  test('装配中物理断开同样取消处理，迟到 backend 不获得可用客户端表', async () => {
    const gate = Promise.withResolvers<void>()
    const fixture = open({ gate: gate.promise })
    const pending = fixture.parent.request(methods.INITIALIZE, initialize)
    const rejected = pending.catch((error: unknown) => error)
    await fixture.started
    fixture.parent.close()
    fixture.child.close()
    expect(await rejected).toBeDefined()
    expect(fixture.signal?.aborted).toBe(true)
    gate.resolve()
    await fixture.bootstrapped
    await Bun.sleep(0)
    expect(fixture.connection.closed).toBe(true)
    expect(fixture.adapter.disposals).toBe(1)
    expect(() => fixture.backend.clients.register()).toThrow('客户端登记表已释放')
  })

  test('关闭先失效身份/协议，drain 等真实后端清理并共享同一个 Promise', async () => {
    const gate = Promise.withResolvers<void>()
    const fixture = open()
    fixture.adapter.drainGate = gate.promise
    try {
      await expect(fixture.connection.drain()).rejects.toThrow('必须先关闭连接')
      await fixture.parent.request(methods.INITIALIZE, initialize)
      const client = await register(fixture.parent)
      fixture.connection.close()
      expect(fixture.child.closed).toBe(true)
      expect(fixture.backend.clients.has(client.clientId)).toBe(false)
      fixture.parent.close()
      await expect(register(fixture.parent)).rejects.toBeDefined()
      const draining = fixture.connection.drain()
      expect(fixture.connection.drain()).toBe(draining)
      let finished = false
      void draining.then(() => { finished = true })
      await fixture.adapter.drainStarted.promise
      await Bun.sleep(0)
      expect(finished).toBe(false)
      fixture.connection.close()
      expect(fixture.adapter.disposals).toBe(1)
      gate.resolve()
      await draining
      expect(finished).toBe(true)
      expect(fixture.adapter.drains).toBe(1)
    } finally { gate.resolve() }
  })

  test('断开等待迟到初始化，并继续等待该初始化派生的后端 drain', async () => {
    const initialization = Promise.withResolvers<void>()
    const resource = Promise.withResolvers<void>()
    const fixture = open({ gate: initialization.promise })
    fixture.adapter.drainGate = resource.promise
    try {
      const response = fixture.parent.request(methods.INITIALIZE, initialize).catch((error: unknown) => error)
      await fixture.started
      fixture.connection.close()
      fixture.parent.close()
      expect(await response).toBeDefined()
      const draining = fixture.connection.drain()
      let finished = false
      void draining.then(() => { finished = true })
      await Bun.sleep(0)
      expect(finished).toBe(false)
      expect(fixture.adapter.disposals).toBe(0)
      initialization.resolve()
      await fixture.adapter.drainStarted.promise
      await Bun.sleep(0)
      expect(finished).toBe(false)
      expect(fixture.adapter.disposals).toBe(1)
      expect(() => fixture.backend.clients.register()).toThrow('客户端登记表已释放')
      resource.resolve()
      await draining
      expect(fixture.adapter.drains).toBe(1)
    } finally { initialization.resolve(); resource.resolve() }
  })

  test('迟到初始化拒绝也等真实 Promise，不把取消响应当作初始化结束', async () => {
    const gate = Promise.withResolvers<void>()
    const fixture = open({ gate: gate.promise, fail: true })
    try {
      const response = fixture.parent.request(methods.INITIALIZE, initialize).catch((error: unknown) => error)
      await fixture.started
      fixture.child.close()
      fixture.parent.close()
      expect(await response).toBeDefined()
      const draining = fixture.connection.drain()
      let finished = false
      void draining.then(() => { finished = true })
      await Bun.sleep(0)
      expect(finished).toBe(false)
      gate.resolve()
      await draining
      expect(finished).toBe(true)
      expect(fixture.calls).toBe(1)
      expect(fixture.adapter.disposals).toBe(0)
      expect(existsSync(fixture.paths.dataDir)).toBe(false)
    } finally { gate.resolve() }
  })

  test('装配已取消但资源清理失败，drain 仍报告错误而不冒充普通取消', async () => {
    const gate = Promise.withResolvers<void>()
    const fixture = open({ gate: gate.promise, fail: true, failure: new AppServerBootstrapCleanupError() })
    try {
      const response = fixture.parent.request(methods.INITIALIZE, initialize).catch((error: unknown) => error)
      await fixture.started
      fixture.connection.close(); fixture.parent.close()
      expect(await response).toBeDefined()
      const draining = fixture.connection.drain()
      const failure = draining.catch((error: unknown) => error)
      gate.resolve()
      const error = await failure
      expect(error).toBeInstanceOf(AggregateError)
      if (!(error instanceof AggregateError)) throw new Error('测试缺少装配清理错误')
      expect(error.errors.map((item: Error) => item.message)).toEqual(['连接装配资源清理失败'])
      expect(fixture.connection.drain()).toBe(draining)
    } finally { gate.resolve() }
  })

  test('装配返回后登记失败，已释放引用仍等待真实资源且不会二次释放', async () => {
    const gate = Promise.withResolvers<void>()
    const fixture = open({ afterBootstrap: (backend) => {
      const subscription = spyOn(backend.clients, 'subscribeDetached').mockImplementation(() => {
        throw new Error('sk-private /private/credentials')
      })
      cleanups.push(() => subscription.mockRestore())
    } })
    fixture.adapter.drainGate = gate.promise
    try {
      await expect(fixture.parent.request(methods.INITIALIZE, initialize))
        .rejects.toMatchObject({ code: -32003, message: '后端初始化失败' })
      await fixture.adapter.drainStarted.promise
      fixture.connection.close()
      const draining = fixture.connection.drain()
      let finished = false
      void draining.then(() => { finished = true })
      await Bun.sleep(0)
      expect(finished).toBe(false)
      gate.resolve()
      await draining
      expect(fixture.adapter.disposals).toBe(1)
      expect(fixture.adapter.drains).toBe(1)
    } finally { gate.resolve() }
  })

  test('同步和异步后端清理失败仍真实等待，固定聚合诊断不携带底层原因', async () => {
    const gate = Promise.withResolvers<void>()
    const fixture = open()
    fixture.adapter.drainGate = gate.promise
    try {
      await fixture.parent.request(methods.INITIALIZE, initialize)
      const backend = fixture.backend
      const dispose = backend.dispose.bind(backend)
      const originalDrain = fixture.adapter.drain.bind(fixture.adapter)
      const disposal = spyOn(backend, 'dispose').mockImplementation(() => {
        dispose()
        throw new Error('sk-secret /private/credentials')
      })
      const adapterDrain = spyOn(fixture.adapter, 'drain').mockImplementation(async () => {
        await originalDrain()
        throw new Error('sk-secret asynchronous credential failure')
      })
      cleanups.push(() => { disposal.mockRestore(); adapterDrain.mockRestore() })
      fixture.connection.close()
      expect(fixture.child.closed).toBe(true)
      const draining = fixture.connection.drain()
      const outcome = draining.catch((error: unknown) => error)
      let finished = false
      void outcome.then(() => { finished = true })
      await fixture.adapter.drainStarted.promise
      await Bun.sleep(0)
      expect(finished).toBe(false)
      gate.resolve()
      const error = await outcome
      expect(error).toBeInstanceOf(AggregateError)
      if (!(error instanceof AggregateError)) throw new Error('测试缺少聚合清理错误')
      expect(error.message).toBe('连接资源等待失败')
      expect(error.errors.map((failure: Error) => failure.message))
        .toEqual(['连接同步资源清理失败', '连接后端异步清理失败'])
      expect(JSON.stringify(error.errors)).not.toContain('sk-secret')
      expect(fixture.connection.drain()).toBe(draining)
      fixture.connection.close()
      expect(disposal).toHaveBeenCalledTimes(1)
      expect(adapterDrain).toHaveBeenCalledTimes(1)
    } finally { gate.resolve() }
  })

  test('解绑异常不跳过其他身份、后端释放和管道关闭', async () => {
    const fixture = open()
    await fixture.parent.request(methods.INITIALIZE, initialize)
    const main = await register(fixture.parent)
    const quick = await register(fixture.parent, 'quick')
    const detach = fixture.backend.clients.detach.bind(fixture.backend.clients)
    const detachment = spyOn(fixture.backend.clients, 'detach').mockImplementation((id) => {
      const result = detach(id)
      if (id === main.clientId) throw new Error('sk-secret broken detach')
      return result
    })
    cleanups.push(() => detachment.mockRestore())
    fixture.connection.close()
    expect(fixture.backend.clients.has(main.clientId)).toBe(false)
    expect(fixture.backend.clients.has(quick.clientId)).toBe(false)
    expect(fixture.child.closed).toBe(true)
    await expect(fixture.connection.drain()).rejects.toThrow('连接资源等待失败')
    expect(fixture.adapter.disposals).toBe(1)
    expect(fixture.adapter.drains).toBe(1)
  })
})
