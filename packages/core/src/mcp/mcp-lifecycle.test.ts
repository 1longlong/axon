import { afterEach, expect, test } from 'bun:test'
import type { McpProjectConfig, McpServerConfig } from '@axon/shared'
import { McpToolProvider } from './mcp-tool-provider'
import type { McpClientSession } from './mcp-tool-provider'
import { McpProjectController } from './mcp-project-controller'

const gates: Array<() => void> = []
const providers: McpToolProvider[] = []
const controllers: McpProjectController[] = []
function deferred() {
  let resolve!: () => void
  const promise = new Promise<void>((done) => { resolve = done })
  gates.push(resolve)
  return { promise, resolve }
}
const server: McpServerConfig = { type: 'stdio', command: 'fixture', enabled: true, required: true,
  startupTimeoutMs: 1_000, requestTimeoutMs: 1_000 }
const config: McpProjectConfig = { version: 1, servers: { local: server } }
function provider(connectServer: (config: McpServerConfig) => { client: McpClientSession; ready: Promise<void> },
  getProjectConfig: () => Promise<McpProjectConfig> = async () => config) {
  const service = new McpToolProvider({ applicationVersion: 'test', getProjectConfig, connectServer })
  providers.push(service)
  return service
}
async function assertPending(work: Promise<void>) {
  expect(await Promise.race([work.then(() => '结束'), Bun.sleep(10).then(() => '等待')])).toBe('等待')
}
afterEach(async () => {
  for (const resolve of gates.splice(0)) resolve()
  for (const service of controllers.splice(0)) { service.dispose(); await service.drain() }
  for (const service of providers.splice(0)) {
    service.dispose()
    try { await service.drain() } catch { /* 关闭失败由对应测试断言，仍清理剩余服务。 */ }
  }
})

test('退出取消当前及过期租约，等待底层调用和每个真实关闭；旧工具不能重新连接', async () => {
  const callEntered = deferred(), finishCall = deferred(), finishClose = deferred()
  const closed: string[] = []
  let current = config
  const service = provider((candidate) => {
    const command = candidate.type === 'stdio' ? candidate.command : 'http'
    return { ready: Promise.resolve(), client: {
      listTools: async () => ({ tools: [{ name: 'work', inputSchema: { type: 'object' } }] }),
      callTool: async (_input, options) => {
        callEntered.resolve()
        await finishCall.promise // 故意忽略取消，证明外层拒绝不能代替真实完成。
        expect(options.signal?.aborted).toBe(true)
        return { content: [] }
      },
      close: async () => { closed.push(command); await finishClose.promise },
    } }
  }, async () => current)
  const [tool] = await service.getTools('project')
  const call = tool!.execute({}, { toolUseId: 'call' }).catch((error: unknown) => error)
  await callEntered.promise
  current = { version: 1, servers: { local: { ...server, command: 'new' } } }
  await service.getTools('project')
  expect(closed).toEqual([]) // 配置更新仍尊重旧调用租约。
  await expect(service.drain()).rejects.toThrow('必须先释放')
  service.dispose()
  expect(await call).toMatchObject({ name: 'AbortError' })
  expect(closed.sort()).toEqual(['fixture', 'new'])
  const drain = service.drain()
  expect(service.drain()).toBe(drain)
  await assertPending(drain)
  finishClose.resolve()
  await assertPending(drain)
  finishCall.resolve()
  await drain
  await expect(service.getTools('project')).rejects.toMatchObject({ name: 'AbortError' })
  await expect(service.testConnection(server)).rejects.toMatchObject({ name: 'AbortError' })
  await expect(tool!.execute({}, { toolUseId: 'late' })).rejects.toMatchObject({ name: 'AbortError' })
  service.dispose()
  expect(closed).toHaveLength(2)
})

test('临时与缓存握手迟到，关闭已完成也要等待原 ready；不继续发现工具', async () => {
  const finishReady = deferred(), entered = deferred()
  let connects = 0, lists = 0, closes = 0
  const service = provider(() => {
    if (++connects === 2) entered.resolve()
    return { ready: finishReady.promise, client: {
      listTools: async () => { lists += 1; return { tools: [] } },
      callTool: async () => ({ content: [] }), close: async () => { closes += 1 },
    } }
  })
  const testing = service.testConnection(server).catch((error: unknown) => error)
  const discovering = service.getTools('project').catch((error: unknown) => error)
  await entered.promise
  service.dispose()
  expect(await testing).toMatchObject({ name: 'AbortError' })
  expect(await discovering).toMatchObject({ name: 'AbortError' })
  const drain = service.drain()
  await assertPending(drain)
  expect(closes).toBe(2)
  finishReady.resolve()
  await drain
  expect(lists).toBe(0)
  expect(closes).toBe(2)
})

test('迟到解密或分页仍在等待集合，退出不创建连接或继续下一页', async () => {
  const decode = deferred(), finishPage = deferred(), pageEntered = deferred()
  let lists = 0, connects = 0
  const service = provider(() => {
    connects += 1
    return { ready: Promise.resolve(), client: {
      listTools: async () => { lists += 1; pageEntered.resolve(); await finishPage.promise; return { tools: [], nextCursor: 'late' } },
      callTool: async () => ({ content: [] }), close: async () => {},
    } }
  }, async () => { await decode.promise; return config })
  const discovering = service.getTools('project').catch((error: unknown) => error)
  const testing = service.testConnection(server).catch((error: unknown) => error)
  await pageEntered.promise
  service.dispose()
  expect(await discovering).toMatchObject({ name: 'AbortError' })
  expect(await testing).toMatchObject({ name: 'AbortError' })
  const drain = service.drain()
  await assertPending(drain)
  decode.resolve()
  await assertPending(drain)
  finishPage.resolve()
  await drain
  expect(connects).toBe(1)
  expect(lists).toBe(1)
})

test('重复退出复用正在关闭的连接，失败不跳过其他关闭且诊断不含 SDK 原因', async () => {
  const finishClose = deferred(), entered = deferred()
  let closes = 0
  const service = provider(() => ({ ready: Promise.resolve(), client: {
    listTools: async () => ({ tools: [] }), callTool: async () => ({ content: [] }),
    close: async () => { if (++closes === 2) entered.resolve(); await finishClose.promise; throw new Error('secret://private-token') },
  } }), async () => ({ version: 1, servers: { first: server, second: server } }))
  await service.getTools('project')
  service.disposeProject('project') // 先开始关闭，退出不能把 closing 误当作 completed。
  await entered.promise
  service.dispose(); service.dispose()
  const drain = service.drain()
  const outcome = drain.catch((error: unknown) => error)
  await assertPending(drain)
  finishClose.resolve()
  const error = await outcome
  expect(error).toBeInstanceOf(AggregateError)
  if (!(error instanceof AggregateError)) throw new Error('应报告关闭失败')
  expect(error.errors).toHaveLength(2)
  expect(String(error.errors)).not.toContain('private-token')
  expect(closes).toBe(2)
})

test('配置退出封住新入口，等待已接纳保存和解密；迟到读取不交付，保存不伪装回滚', async () => {
  const finishRead = deferred(), finishSave = deferred()
  let saves = 0, invalidations = 0
  const service = new McpProjectController({
    configs: {
      get: async () => { await finishRead.promise; return config },
      save: async () => { saves += 1; await finishSave.promise; return config },
    },
    projects: { resolveProjectCwd: () => '/trusted/project' },
    tools: { testConnection: async () => [], disposeProject: () => { invalidations += 1 } },
  })
  controllers.push(service)
  const reading = service.get('project').catch((error: unknown) => error)
  const saving = service.save('project', config)
  service.dispose()
  await expect(service.save('project', config)).rejects.toMatchObject({ name: 'AbortError' })
  await expect(service.get('project')).rejects.toMatchObject({ name: 'AbortError' })
  await expect(service.testConnection('project', 'local', server)).rejects.toMatchObject({ name: 'AbortError' })
  expect(() => service.listBuiltinPresets()).toThrow('已释放')
  const drain = service.drain()
  await assertPending(drain)
  finishRead.resolve()
  expect(await reading).toMatchObject({ name: 'AbortError' })
  await assertPending(drain)
  finishSave.resolve()
  expect(await saving).toEqual(config)
  await drain
  expect(saves).toBe(1)
  expect(invalidations).toBe(1)
})
