import { afterEach, describe, expect, test } from 'bun:test'
import { PassThrough } from 'node:stream'
import { APP_SERVER_HOST_METHODS as methods } from '@axon/shared'
import type { AppServerExecBootstrap, Channel } from '@axon/shared'
import { createExecHostPorts, JsonRpcPeer, registerExecHostBridge, RpcFault, toWireValue } from './index'

const cleanups: Array<() => void> = []
afterEach(() => { for (const cleanup of cleanups.splice(0).reverse()) cleanup() })
function pair() {
  const upstream = new PassThrough(), downstream = new PassThrough()
  const parent = new JsonRpcPeer(downstream, upstream, { requestTimeoutMs: 500 })
  const child = new JsonRpcPeer(upstream, downstream, { requestTimeoutMs: 500 })
  cleanups.push(() => { parent.close(); child.close(); upstream.destroy(); downstream.destroy() })
  return { parent, child }
}
function configuration(): AppServerExecBootstrap {
  return { channels: [{ id: 'fixture', name: '夹具渠道', provider: 'openai', baseUrl: 'https://EXAMPLE.test:443/v1/',
    models: [{ id: 'fixture-model', name: '夹具模型', enabled: true }], enabled: true }],
  agent: { systemPrompt: '本次提示词', generateTitle: false, features: { skills: false, mcp: false, memory: false, tasks: false } } }
}
function channel(): Channel {
  return { ...configuration().channels[0]!, baseUrl: 'https://example.test/v1', hasApiKey: false, createdAt: 1, updatedAt: 1 }
}

describe('非交互私有配置与运行凭据', () => {
  test('最终输出要求以独立瞬时字段传递，输入非法/超限拒绝且不回显正文', async () => {
    const { parent, child } = pair(), input = configuration()
    input.agent.finalOutputInstruction = '[最终输出要求]\n{"type":"object"}'
    registerExecHostBridge(parent, { bootstrap: input, resolveCredential: () => '' })
    input.agent.finalOutputInstruction = 'changed'
    expect((await createExecHostPorts(child, new AbortController().signal)).bootstrap.agent.finalOutputInstruction)
      .toBe('[最终输出要求]\n{"type":"object"}')
    for (const value of [1, '\0private', 'x'.repeat(1024 * 1024 + 2049)]) {
      const bad = configuration(); Object.assign(bad.agent, { finalOutputInstruction: value })
      expect(() => registerExecHostBridge(pair().parent, { bootstrap: bad, resolveCredential: () => '' })).toThrow('启动配置无效')
    }
  })

  test('配置响应无密钥，深复制并规范化目标；只有实际解析才取凭据', async () => {
    const { parent, child } = pair()
    const input = configuration()
    let reads = 0
    registerExecHostBridge(parent, { bootstrap: input, resolveCredential: () => { reads++; return 'fixture-secret' } })
    input.agent.features.skills = true
    input.channels[0]!.baseUrl = 'https://changed.test'
    const ports = await createExecHostPorts(child, new AbortController().signal)
    expect(reads).toBe(0)
    expect(JSON.stringify(ports.bootstrap)).not.toContain('fixture-secret')
    expect(ports.bootstrap.agent.features.skills).toBe(false)
    expect(ports.bootstrap.channels[0]!.baseUrl).toBe('https://example.test/v1')
    expect(await ports.resolveRuntimeCredential(channel())).toBe('fixture-secret')
    expect(reads).toBe(1)
  })

  test('拒绝陌生/禁用渠道、其他协议和地址，不能泄露目标拒绝前的密钥', async () => {
    const { parent, child } = pair()
    const input = configuration()
    input.channels.push({ ...input.channels[0]!, id: 'disabled', enabled: false })
    let reads = 0
    registerExecHostBridge(parent, { bootstrap: input, resolveCredential: () => { reads++; return 'fixture-secret' } })
    const ports = await createExecHostPorts(child, new AbortController().signal)
    for (const update of [{ id: 'missing' }, { id: 'disabled' }, { provider: 'custom' as const }, { baseUrl: 'https://elsewhere.test/v1' }]) {
      await expect(ports.resolveRuntimeCredential({ ...channel(), ...update })).rejects.toThrow('读取运行凭据失败')
    }
    expect(reads).toBe(0)
    for (const baseUrl of ['https://user:secret@example.test', 'https://example.test/v1?secret=x', 'file:///tmp']) {
      await expect(child.request(methods.RESOLVE_RUNTIME_CREDENTIAL, { channelId: 'fixture', provider: 'openai', baseUrl }))
        .rejects.toMatchObject({ code: -32602 })
    }
    await expect(child.request(methods.GET_EXEC_BOOTSTRAP, { apiKey: 'fixture-secret' })).rejects.toMatchObject({ code: -32602 })
  })

  test('父入口还需限制当前选定渠道；允许无密钥，错误不回显宿主异常', async () => {
    const { parent, child } = pair()
    const input = configuration()
    input.channels.push({ ...input.channels[0]!, id: 'unselected' })
    registerExecHostBridge(parent, { bootstrap: input, resolveCredential: (target) => {
      if (target.channelId !== 'fixture') throw new Error('fixture-secret host diagnostic')
      return ''
    } })
    const ports = await createExecHostPorts(child, new AbortController().signal)
    expect(await ports.resolveRuntimeCredential(channel())).toBe('')
    await expect(child.request(methods.RESOLVE_RUNTIME_CREDENTIAL,
      { channelId: 'unselected', provider: 'openai', baseUrl: channel().baseUrl }))
      .rejects.toMatchObject({ code: -32010, message: '读取运行凭据失败' })
  })

  test('缺桥、坏配置/响应与断开失败，不回退安全存储端口', async () => {
    const missing = pair()
    await expect(createExecHostPorts(missing.child, new AbortController().signal)).rejects.toThrow('无法读取非交互宿主启动配置')
    const bad = pair()
    bad.parent.handle(methods.GET_EXEC_BOOTSTRAP, () => ({ channels: [], agent: { apiKey: 'fixture-secret' } }))
    await expect(createExecHostPorts(bad.child, new AbortController().signal)).rejects.toThrow('无法读取非交互宿主启动配置')
    const invalid = configuration()
    Object.assign(invalid.channels[0]!, { apiKey: 'fixture-secret' })
    expect(() => registerExecHostBridge(pair().parent, { bootstrap: invalid, resolveCredential: () => '' })).toThrow('非交互宿主启动配置无效')
    const broken = pair()
    registerExecHostBridge(broken.parent, { bootstrap: configuration(), resolveCredential: () => 'fixture-secret' })
    const ports = await createExecHostPorts(broken.child, new AbortController().signal)
    broken.child.close()
    await expect(ports.resolveRuntimeCredential(channel())).rejects.toThrow('读取运行凭据失败')
  })

  test('请求取消不消费迟到凭据，之后合法请求仍可用', async () => {
    const { parent, child } = pair()
    const gate = Promise.withResolvers<string>(), started = Promise.withResolvers<void>()
    let reads = 0
    registerExecHostBridge(parent, { bootstrap: configuration(), resolveCredential: () => {
      if (++reads === 1) { started.resolve(); return gate.promise }
      return 'fixture-secret'
    } })
    const controller = new AbortController()
    const pending = child.request(methods.RESOLVE_RUNTIME_CREDENTIAL,
      { channelId: 'fixture', provider: 'openai', baseUrl: channel().baseUrl }, { signal: controller.signal })
    const rejected = pending.catch((error: unknown) => error)
    await started.promise
    controller.abort()
    expect(await rejected).toBeInstanceOf(Error)
    gate.resolve('late-secret')
    const ports = await createExecHostPorts(child, new AbortController().signal)
    expect(await ports.resolveRuntimeCredential(channel())).toBe('fixture-secret')
  })

  test('非法凭据响应脱敏，取消的初始化不交付启动配置', async () => {
    const { parent, child } = pair()
    registerExecHostBridge(parent, { bootstrap: configuration(), resolveCredential: () => 'fixture-secret\ninvalid' })
    const ports = await createExecHostPorts(child, new AbortController().signal)
    await expect(ports.resolveRuntimeCredential(channel())).rejects.toThrow('读取运行凭据失败')
    const failed = pair()
    failed.parent.handle(methods.GET_EXEC_BOOTSTRAP, () => toWireValue(configuration()))
    failed.parent.handle(methods.RESOLVE_RUNTIME_CREDENTIAL, () => { throw new RpcFault(-32603, 'fixture-secret') })
    const failedPorts = await createExecHostPorts(failed.child, new AbortController().signal)
    await expect(failedPorts.resolveRuntimeCredential(channel())).rejects.toThrow('读取运行凭据失败')
    const controller = new AbortController(); controller.abort()
    await expect(createExecHostPorts(child, controller.signal)).rejects.toThrow()
  })
})
