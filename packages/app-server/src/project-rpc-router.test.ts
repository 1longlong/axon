import { afterEach, describe, expect, spyOn, test } from 'bun:test'
import { execFileSync } from 'node:child_process'
import { existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, symlinkSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { PassThrough } from 'node:stream'
import { AgentMemoryController, AgentMemoryService, AgentProjectController, createBackend, createBackendPaths, createCredentialCodec } from '@axon/core'
import type { AxonBackend } from '@axon/core'
import { APP_SERVER_METHODS as methods, APP_SERVER_NOTIFICATIONS as notices, APP_SERVER_RPC_OPTIONS } from '@axon/shared'
import type { AgentProject, AppServerClient, AppServerProjectChangeEvent, AgentProjectWatchSubscription,
  RpcJsonObject, RpcJsonValue } from '@axon/shared'
import { AppServerConnection, JsonRpcPeer } from './index'
import { toWireValue } from './wire-value'

const cleanups: Array<() => void> = []
afterEach(() => { for (const cleanup of cleanups.splice(0).reverse()) cleanup() })
interface WatchProbe {
  clientId: string
  projectId: string
  root: string
  kind: 'workspace' | 'memory'
  emit: (time: number, path?: string) => void
  closed: boolean
}

/** 默认使用真实工厂/磁盘/原生监听；竞态测试只替换句柄，仍走实际领域 controller。 */
async function open(fakeWatches = false) {
  const directory = mkdtempSync(join(tmpdir(), 'axon-project-rpc-'))
  const upstream = new PassThrough()
  const downstream = new PassThrough()
  const parent = new JsonRpcPeer(downstream, upstream, { ...APP_SERVER_RPC_OPTIONS, requestTimeoutMs: 2_000 })
  const child = new JsonRpcPeer(upstream, downstream, { ...APP_SERVER_RPC_OPTIONS, requestTimeoutMs: 2_000 })
  let backend: AxonBackend
  const probes: WatchProbe[] = []
  const controllers: Array<{ dispose(): void }> = []
  const watcher = (kind: WatchProbe['kind']) => ({
    watch(clientId: string, projectId: string, root: string, emit: WatchProbe['emit']) {
      this.unwatch(clientId, projectId)
      probes.push({ clientId, projectId, root, kind, emit, closed: false })
    },
    unwatch(clientId: string, projectId: string) {
      for (const probe of probes) if (probe.kind === kind && probe.clientId === clientId && probe.projectId === projectId) probe.closed = true
    },
    clearOwner(clientId: string) { for (const probe of probes) if (probe.kind === kind && probe.clientId === clientId) probe.closed = true },
  })
  const connection = new AppServerConnection({ peer: child, bootstrap: () => {
    backend = createBackend({ paths: createBackendPaths({ dataDir: join(directory, 'data'), homeDir: directory }),
      applicationVersion: '0.1.3', credentialCodec: createCredentialCodec(),
      resolveAdapter: () => ({ async *query() { throw new Error('项目请求不得调用 Runtime') }, abort() {}, dispose() {}, async drain() {} }),
    })
    if (fakeWatches) {
      backend.projectController = new AgentProjectController({ clients: backend.clients, projects: backend.projects,
        sessions: backend.sessions, watcher: watcher('workspace') })
      backend.memory = new AgentMemoryController({ clients: backend.clients, projects: backend.projects,
        memory: new AgentMemoryService({ projects: backend.projects }), watcher: watcher('memory') })
      controllers.push(backend.projectController, backend.memory)
    }
    return { backend, applicationVersion: '0.1.3', capabilities: { runtimes: [], credentialStorage: 'unavailable', channelTargetConfirmation: false } }
  } })
  cleanups.push(() => {
    connection.close(); parent.close(); upstream.destroy(); downstream.destroy()
    for (const controller of controllers) controller.dispose()
    rmSync(directory, { recursive: true, force: true })
  })
  await parent.request(methods.INITIALIZE, { protocolVersion: 1, client: { name: 'axon-fixture', version: '0.1.3' },
    hostCapabilities: { credentialStorage: 'unavailable', channelTargetConfirmation: false } })
  const main = await parent.request(methods.REGISTER_CLIENT, { kind: 'main' }) as unknown as AppServerClient
  const quick = await parent.request(methods.REGISTER_CLIENT, { kind: 'quick' }) as unknown as AppServerClient
  const events: Array<{ method: string; packet: RpcJsonObject }> = []
  const persisted: boolean[] = []
  let onEvent = (_method: string, _packet: RpcJsonObject): void => {}
  for (const method of [notices.PROJECTS_CHANGED, notices.WORKSPACE_CHANGED, notices.MEMORY_CHANGED, notices.PROJECT_WATCH_CLOSED]) {
    parent.handleNotification(method, (params) => {
      const packet = params as RpcJsonObject
      events.push({ method, packet })
      if (method === notices.PROJECTS_CHANGED) persisted.push(JSON.stringify(packet.projects) === JSON.stringify(toWireValue(backend!.projects.list())))
      onEvent(method, packet)
    })
  }
  const request = (method: string, input?: RpcJsonValue, client = main) => parent.request(method,
    { clientId: client.clientId, ...(input === undefined ? {} : { input }) }, { timeoutMs: 0 })
  const create = async (input: RpcJsonObject = {}) => await request(methods.PROJECT_CREATE, { name: '测试项目', ...input }) as unknown as AgentProject
  const watch = async (projectId: string, kind: WatchProbe['kind'] = 'workspace', client = main) => await request(
    kind === 'workspace' ? methods.WORKSPACE_WATCH : methods.MEMORY_WATCH, projectId, client,
  ) as unknown as AgentProjectWatchSubscription
  return { directory, parent, child, backend: backend!, connection, main, quick, events, persisted, probes, request, create, watch,
    disconnect() { upstream.destroy(); downstream.destroy() },
    listen(listener: typeof onEvent) { onEvent = listener } }
}

describe('项目/工作区/记忆应用协议', () => {
  test('文件树/预览/Diff 接收 RPC、入口注销与物理断开取消，不影响其他窗口', async () => {
    for (const mode of ['cancel', 'detach', 'disconnect']) {
      const f = await open(true), project = await f.create()
      const entered = Promise.withResolvers<void>(), abort = new AbortController()
      const signals: AbortSignal[] = []
      const pending = (signal?: AbortSignal): Promise<never> => {
        if (!signal) throw new Error('工作区请求缺少取消信号')
        signals.push(signal)
        if (signals.length === 3) entered.resolve()
        return new Promise((_done, fail) => {
          const cancel = () => fail(new DOMException('工作区读取已取消', 'AbortError'))
          if (signal.aborted) cancel()
          else signal.addEventListener('abort', cancel, { once: true })
        })
      }
      const spies = [
        spyOn(f.backend.projectController, 'listDirectory').mockImplementation((_project, signal) => pending(signal)),
        spyOn(f.backend.projectController, 'readFile').mockImplementation((_project, _path, signal) => pending(signal)),
        spyOn(f.backend.projectController, 'readDiff').mockImplementation((_project, _path, signal) => pending(signal)),
      ]
      try {
        const operations = [methods.WORKSPACE_LIST_DIRECTORY, methods.WORKSPACE_READ_FILE, methods.WORKSPACE_READ_DIFF]
          .map((method) => f.parent.request(method, { clientId: f.main.clientId,
            input: method === methods.WORKSPACE_LIST_DIRECTORY ? project.id : { projectId: project.id, relativePath: 'file.txt' } },
          { signal: abort.signal, timeoutMs: 0 }).catch((error: unknown) => error))
        await entered.promise
        if (mode === 'cancel') abort.abort()
        else if (mode === 'detach') await f.parent.request(methods.DETACH_CLIENT, { clientId: f.main.clientId })
        else f.disconnect()
        for (const result of await Promise.all(operations)) {
          expect(result).toBeInstanceOf(Error)
          if (mode === 'detach') expect(result).toMatchObject({ code: -32800 })
        }
        const deadline = Date.now() + 1_000
        while (signals.some((signal) => !signal.aborted) && Date.now() < deadline) await Bun.sleep(5)
        expect(signals.every((signal) => signal.aborted)).toBe(true)
        if (mode !== 'disconnect') expect(await f.request(methods.PROJECT_LIST, undefined, f.quick)).toHaveLength(1)
      } finally {
        abort.abort()
        spies.forEach((spy) => spy.mockRestore())
      }
    }
  })

  test('默认托管与本地项目 CRUD，通知先保存；删除不触碰用户目录，被会话引用时拒绝', async () => {
    const f = await open()
    const managed = await f.create()
    const managedRoot = f.backend.projects.resolveProjectCwd(managed.id)
    expect(managed.workspace).toEqual({ kind: 'managed' })
    expect(existsSync(managedRoot)).toBe(true)
    expect(await f.request(methods.PROJECT_GET, managed.id, f.quick)).toEqual(toWireValue(managed))
    expect(await f.request(methods.PROJECT_LIST)).toEqual(toWireValue([managed]))
    expect(f.persisted).toEqual([true, true])
    const local = join(f.directory, 'local')
    mkdirSync(local); writeFileSync(join(local, 'kept.txt'), '保留文件')
    expect(await f.request(methods.PROJECT_UPDATE, { projectId: managed.id, update: { name: '本地项目', workspace: { kind: 'local', path: local } } }))
      .toMatchObject({ name: '本地项目', workspace: { kind: 'local', path: realpathSync(local), status: 'available' } })
    f.backend.sessions.create({ title: '关联会话', projectId: managed.id })
    await expect(f.request(methods.PROJECT_DELETE, managed.id)).rejects.toMatchObject({ code: -32023, data: { code: 'invalid_input' } })
    expect(readFileSync(join(local, 'kept.txt'), 'utf8')).toBe('保留文件')
    const empty = await f.create({ name: '可删除', workspace: { kind: 'local', path: local } })
    await f.request(methods.PROJECT_DELETE, empty.id)
    expect(await f.request(methods.PROJECT_GET, empty.id)).toBeNull()
    expect(readFileSync(join(local, 'kept.txt'), 'utf8')).toBe('保留文件')
    expect(f.persisted.every(Boolean)).toBe(true)
  })

  test('项目负载和连接身份边界；坏输入不保存、不通知或接受自报 cwd/owner', async () => {
    const f = await open()
    const project = await f.create()
    const before = readFileSync(f.backend.paths.agentProjectsIndexPath, 'utf8')
    const count = f.events.length
    for (const input of [null, [], { name: '不允许', owner: 'fake' }, { name: 1 },
      { name: '错误', workspace: { kind: 'local', path: '不存在' } }, { name: '错误', workspace: { kind: 'managed', path: '/tmp' } }]) {
      await expect(f.request(methods.PROJECT_CREATE, toWireValue(input))).rejects.toMatchObject({ code: -32023 })
    }
    await expect(f.request(methods.PROJECT_UPDATE, { projectId: project.id, update: { memoryEnabled: 'yes' } })).rejects.toMatchObject({ code: -32023 })
    await expect(f.request(methods.WORKSPACE_READ_FILE, { projectId: project.id, relativePath: 'x', cwd: '/tmp' })).rejects.toMatchObject({ code: -32602 })
    const foreign = f.backend.clients.register()
    await expect(f.parent.request(methods.PROJECT_LIST, { clientId: foreign })).rejects.toMatchObject({ code: -32004 })
    await expect(f.parent.request(methods.PROJECT_LIST, { clientId: f.main.clientId, owner: f.quick.clientId })).rejects.toMatchObject({ code: -32602 })
    expect(readFileSync(f.backend.paths.agentProjectsIndexPath, 'utf8')).toBe(before)
    expect(f.events).toHaveLength(count)
  })

  test('实际树/文本/二进制/超限预览，拒绝绝对路径、穿越、符号链接和目录', async () => {
    const f = await open()
    const project = await f.create()
    const root = f.backend.projects.resolveProjectCwd(project.id)
    writeFileSync(join(root, 'hello.md'), '# 内容')
    writeFileSync(join(root, 'binary.bin'), Buffer.from([0, 1, 2]))
    writeFileSync(join(root, 'large.txt'), 'x'.repeat(513 * 1024))
    mkdirSync(join(root, 'folder'))
    mkdirSync(join(root, 'node_modules')); writeFileSync(join(root, 'node_modules', 'ignored'), '不显示')
    const outside = join(f.directory, 'outside.txt'); writeFileSync(outside, '项目外内容')
    symlinkSync(outside, join(root, 'linked.txt'))
    const listing = await f.request(methods.WORKSPACE_LIST_DIRECTORY, project.id)
    expect(JSON.stringify(listing)).not.toContain(root)
    expect(JSON.stringify(listing)).not.toContain('node_modules')
    expect(JSON.stringify(listing)).toContain('symlink')
    expect(await f.request(methods.WORKSPACE_READ_FILE, { projectId: project.id, relativePath: 'hello.md' }))
      .toMatchObject({ kind: 'text', content: '# 内容', relativePath: 'hello.md' })
    expect(await f.request(methods.WORKSPACE_READ_FILE, { projectId: project.id, relativePath: 'binary.bin' })).toMatchObject({ kind: 'binary' })
    expect(await f.request(methods.WORKSPACE_READ_FILE, { projectId: project.id, relativePath: 'large.txt' })).toMatchObject({ kind: 'too_large' })
    for (const [relativePath, code] of [[outside, 'invalid_path'], ['../outside.txt', 'outside_workspace'],
      ['linked.txt', 'outside_workspace'], ['folder', 'not_file'], ['missing.txt', 'not_found']] as const) {
      await expect(f.request(methods.WORKSPACE_READ_FILE, { projectId: project.id, relativePath })).rejects.toMatchObject({ code: -32024, data: { code } })
    }
  })

  test('真实临时 Git 仓库读取 Diff，只读不改变文件/索引；非仓库返回稳定不可用状态', async () => {
    const f = await open()
    const project = await f.create()
    const root = f.backend.projects.resolveProjectCwd(project.id)
    const git = (...args: string[]) => execFileSync('git', args, { cwd: root, stdio: 'ignore' })
    git('init', '--quiet')
    writeFileSync(join(root, 'tracked.txt'), 'before\n')
    git('add', 'tracked.txt')
    git('-c', 'user.name=Axon Test', '-c', 'user.email=axon@example.invalid', 'commit', '--quiet', '-m', 'initial')
    writeFileSync(join(root, 'tracked.txt'), 'after\n')
    const indexBefore = readFileSync(join(root, '.git', 'index'))
    const result = await f.request(methods.WORKSPACE_READ_DIFF, { projectId: project.id, relativePath: 'tracked.txt' })
    expect(result).toMatchObject({ status: 'changed' })
    expect(JSON.stringify(result)).toContain('+after')
    expect(readFileSync(join(root, '.git', 'index'))).toEqual(indexBefore)
    expect(readFileSync(join(root, 'tracked.txt'), 'utf8')).toBe('after\n')
    await expect(f.request(methods.WORKSPACE_READ_DIFF, { projectId: project.id, relativePath: '../outside' })).rejects.toMatchObject({ code: -32024 })
    const plain = await f.create({ name: '非仓库' })
    expect(await f.request(methods.WORKSPACE_READ_DIFF, { projectId: plain.id, relativePath: 'new.txt' })).toMatchObject({ status: 'unavailable' })
  })

  test('记忆开关贯穿列表/读写/监听；实际原子文件保留内容，路径和符号链接不能逃逸', async () => {
    const f = await open(true)
    const project = await f.create()
    for (const method of [methods.MEMORY_LIST, methods.MEMORY_WATCH]) {
      await expect(f.request(method, project.id)).rejects.toMatchObject({ code: -32025, data: { code: 'disabled' } })
    }
    await expect(f.request(methods.MEMORY_WRITE, { projectId: project.id, relativePath: 'MEMORY.md', content: '不应保存' }))
      .rejects.toMatchObject({ code: -32025, data: { code: 'disabled' } })
    const root = f.backend.projects.resolveProjectCwd(project.id)
    expect(existsSync(join(root, 'memory'))).toBe(false)
    await f.request(methods.PROJECT_UPDATE, { projectId: project.id, update: { memoryEnabled: true } })
    expect(await f.request(methods.MEMORY_LIST, project.id)).toMatchObject({ files: [], indexExists: false })
    await f.request(methods.MEMORY_WRITE, { projectId: project.id, relativePath: 'MEMORY.md', content: '# 索引' })
    await f.request(methods.MEMORY_WRITE, { projectId: project.id, relativePath: 'topics/rules.md', content: '项目规则' }, f.quick)
    expect(await f.request(methods.MEMORY_READ, { projectId: project.id, relativePath: 'topics/rules.md' })).toMatchObject({ content: '项目规则' })
    expect(await f.request(methods.MEMORY_LIST, project.id)).toMatchObject({ indexExists: true })
    expect(readFileSync(join(root, 'memory', 'MEMORY.md'), 'utf8')).toBe('# 索引')
    const outside = join(f.directory, 'outside.md'); writeFileSync(outside, '原文')
    symlinkSync(outside, join(root, 'memory', 'linked.md'))
    for (const relativePath of ['../outside.md', outside, 'linked.md', 'not-markdown.txt']) {
      await expect(f.request(methods.MEMORY_WRITE, { projectId: project.id, relativePath, content: '不能写' })).rejects.toMatchObject({ code: -32025 })
    }
    expect(readFileSync(outside, 'utf8')).toBe('原文')
    await f.request(methods.PROJECT_UPDATE, { projectId: project.id, update: { memoryEnabled: false } })
    await expect(f.request(methods.MEMORY_READ, { projectId: project.id, relativePath: 'MEMORY.md' })).rejects.toMatchObject({ code: -32025, data: { code: 'disabled' } })
    expect(readFileSync(join(root, 'memory', 'MEMORY.md'), 'utf8')).toBe('# 索引')
  })

  test('订阅代次隔离重订阅/旧取消/迟到回调；其他入口不可取消，关闭后不投递', async () => {
    const f = await open(true)
    const project = await f.create()
    const old = await f.watch(project.id)
    const oldProbe = f.probes.at(-1)!
    const current = await f.watch(project.id)
    const currentProbe = f.probes.at(-1)!
    expect(current.subscriptionId).not.toBe(old.subscriptionId)
    expect(oldProbe.closed).toBe(true)
    await expect(f.request(methods.WORKSPACE_UNWATCH, toWireValue(old))).rejects.toMatchObject({ code: -32602 })
    expect(await f.request(methods.WORKSPACE_UNWATCH, { projectId: project.id, subscriptionId: old.subscriptionId })).toBe(false)
    expect(await f.request(methods.WORKSPACE_UNWATCH, { projectId: project.id, subscriptionId: current.subscriptionId }, f.quick)).toBe(false)
    const before = f.events.length
    oldProbe.emit(1); currentProbe.emit(2)
    expect(f.events.slice(before)).toEqual([{ method: notices.WORKSPACE_CHANGED,
      packet: { clientId: f.main.clientId, projectId: project.id, subscriptionId: current.subscriptionId, changedAt: 2 } }])
    expect(await f.request(methods.WORKSPACE_UNWATCH, { projectId: project.id, subscriptionId: current.subscriptionId })).toBe(true)
    currentProbe.emit(3)
    expect(f.events).toHaveLength(before + 1)
    await f.watch(project.id, 'workspace', f.quick)
    const quickProbe = f.probes.at(-1)!
    await f.parent.request(methods.DETACH_CLIENT, { clientId: f.quick.clientId })
    quickProbe.emit(4)
    expect(quickProbe.closed).toBe(true)
    expect(f.events).toHaveLength(before + 1)
    f.connection.close()
    oldProbe.emit(5)
    expect(f.events).toHaveLength(before + 1)
  })

  test('目录切换使全部入口旧监听失效；关闭记忆只取消 memory，旧请求不影响新工作区', async () => {
    const f = await open(true)
    const project = await f.create()
    await f.request(methods.PROJECT_UPDATE, { projectId: project.id, update: { memoryEnabled: true } })
    const workspace = await f.watch(project.id)
    const memory = await f.watch(project.id, 'memory', f.quick)
    const before = f.probes.slice()
    await f.request(methods.PROJECT_UPDATE, { projectId: project.id, update: { memoryEnabled: false } })
    expect(before.map((probe) => probe.closed)).toEqual([false, true])
    expect(f.events.some((event) => event.method === notices.PROJECT_WATCH_CLOSED && event.packet.reason === 'memory_disabled'
      && event.packet.subscriptionId === memory.subscriptionId)).toBe(true)
    await f.request(methods.PROJECT_UPDATE, { projectId: project.id, update: { memoryEnabled: true } })
    await f.watch(project.id, 'memory', f.quick)
    const local = join(f.directory, 'new-local'); mkdirSync(local)
    await f.request(methods.PROJECT_UPDATE, { projectId: project.id, update: { workspace: { kind: 'local', path: local } } })
    expect(f.probes.every((probe) => probe.closed)).toBe(true)
    const latest = await f.watch(project.id)
    expect(f.probes.at(-1)?.root).toBe(realpathSync(local))
    expect(await f.request(methods.WORKSPACE_UNWATCH, { projectId: project.id, subscriptionId: workspace.subscriptionId })).toBe(false)
    expect(f.probes.at(-1)?.closed).toBe(false)
    const count = f.events.length
    before.forEach((probe) => probe.emit(10, 'rules.md'))
    expect(f.events).toHaveLength(count)
    f.probes.at(-1)!.emit(11)
    expect(f.events.at(-1)?.packet.subscriptionId).toBe(latest.subscriptionId)
    await f.request(methods.PROJECT_DELETE, project.id)
    expect(f.probes.at(-1)?.closed).toBe(true)
    expect(f.events.some((event) => event.method === notices.PROJECT_WATCH_CLOSED && event.packet.reason === 'project_deleted')).toBe(true)
    expect(existsSync(local)).toBe(true)
  })

  test('项目保存失败不取消现有监听；core 主动注销也会清除协议代次', async () => {
    const f = await open(true)
    const project = await f.create()
    await f.watch(project.id)
    const probe = f.probes.at(-1)!
    await expect(f.request(methods.PROJECT_UPDATE, { projectId: project.id, update: { workspace: { kind: 'local', path: join(f.directory, 'missing') } } }))
      .rejects.toMatchObject({ code: -32023 })
    expect(probe.closed).toBe(false)
    f.backend.clients.detach(f.main.clientId)
    const count = f.events.length
    probe.emit(1)
    expect(probe.closed).toBe(true)
    expect(f.events).toHaveLength(count)
  })

  test('同时换工作区和关闭记忆：workspace 可重订阅，memory 终止而不误报目录变化', async () => {
    const f = await open(true), project = await f.create()
    await f.request(methods.PROJECT_UPDATE, { projectId: project.id, update: { memoryEnabled: true } })
    const workspace = await f.watch(project.id), memory = await f.watch(project.id, 'memory')
    const local = join(f.directory, 'next'); mkdirSync(local)
    await f.request(methods.PROJECT_UPDATE, { projectId: project.id,
      update: { workspace: { kind: 'local', path: local }, memoryEnabled: false } })
    expect(f.events.filter((event) => event.method === notices.PROJECT_WATCH_CLOSED).map((event) => [event.packet.subscriptionId, event.packet.reason]))
      .toEqual([[workspace.subscriptionId, 'project_changed'], [memory.subscriptionId, 'memory_disabled']])
    expect(f.probes.every((probe) => probe.closed)).toBe(true)
    const next = await f.watch(project.id)
    expect(next.subscriptionId).not.toBe(workspace.subscriptionId)
    await expect(f.watch(project.id, 'memory')).rejects.toMatchObject({ code: -32025, data: { code: 'disabled' } })
  })

  test('订阅数量有界；替换不消耗新名额，取消可释放，其他入口独立登记', async () => {
    const f = await open(true)
    const subscriptions: AgentProjectWatchSubscription[] = []
    for (let index = 0; index < 64; index += 1) {
      const project = await f.create({ name: `资源项目 ${index}` })
      await f.request(methods.PROJECT_UPDATE, { projectId: project.id, update: { memoryEnabled: true } })
      subscriptions.push(await f.watch(project.id), await f.watch(project.id, 'memory'))
    }
    const extra = await f.create({ name: '额外项目' })
    await expect(f.watch(extra.id)).rejects.toMatchObject({ code: -32001 })
    const replaced = await f.watch(subscriptions[0]!.projectId)
    expect(replaced.subscriptionId).not.toBe(subscriptions[0]!.subscriptionId)
    expect(f.probes.filter((probe) => !probe.closed)).toHaveLength(128)
    await f.request(methods.WORKSPACE_UNWATCH, { projectId: replaced.projectId, subscriptionId: replaced.subscriptionId })
    await f.watch(extra.id)
    await f.watch(extra.id, 'workspace', f.quick)
    expect(f.probes.filter((probe) => !probe.closed)).toHaveLength(129)
    f.connection.close()
    expect(f.probes.every((probe) => probe.closed)).toBe(true)
  })

  test('订阅启动失败撤销代次及已建立句柄，未知错误脱敏，之后能正常重订阅', async () => {
    const f = await open(true)
    const project = await f.create()
    const watch = f.backend.projectController.watchDirectory.bind(f.backend.projectController)
    f.backend.projectController.watchDirectory = (...args) => {
      watch(...args)
      throw new Error('private-secret /outside/path')
    }
    const error = await f.watch(project.id).catch((cause: unknown) => cause)
    expect(error).toMatchObject({ code: -32603, message: 'RPC 请求处理失败' })
    expect(f.probes.every((probe) => probe.closed)).toBe(true)
    expect(f.events.filter((event) => event.method === notices.WORKSPACE_CHANGED)).toEqual([])
    f.backend.projectController.watchDirectory = watch
    await f.watch(project.id)
    expect(f.probes.at(-1)?.closed).toBe(false)
  })
})

test('真实原生监听经过双端协议投递 workspace/memory；注销只关闭所属入口', async () => {
  const f = await open()
  const project = await f.create()
  await f.request(methods.PROJECT_UPDATE, { projectId: project.id, update: { memoryEnabled: true } })
  const root = f.backend.projects.resolveProjectCwd(project.id)
  mkdirSync(join(root, 'memory'))
  const subscriptions = await Promise.all([f.watch(project.id), f.watch(project.id, 'memory'),
    f.watch(project.id, 'workspace', f.quick), f.watch(project.id, 'memory', f.quick)])
  const observed = new Set<string>()
  f.listen((method, packet) => {
    if (method === notices.WORKSPACE_CHANGED || method === notices.MEMORY_CHANGED) {
      const event = packet as unknown as AppServerProjectChangeEvent
      expect(event.projectId).toBe(project.id)
      expect(typeof event.changedAt).toBe('number')
      observed.add(event.subscriptionId)
    }
  })
  // 原生句柄返回不等于 OS 已投递；以真实准备事件同步，不靠固定启动延时。
  const deadline = Date.now() + 3_000
  let attempt = 0
  while (observed.size < 4 && Date.now() < deadline) {
    writeFileSync(join(root, 'memory', 'ready.md'), `# 准备 ${attempt++}`)
    const next = Math.min(deadline, Date.now() + 500)
    while (observed.size < 4 && Date.now() < next) await Bun.sleep(20)
  }
  expect([...observed].sort()).toEqual(subscriptions.map((value) => value.subscriptionId).sort())
  observed.clear()
  writeFileSync(join(root, 'memory', 'changed.md'), '# 真实变更')
  const until = Date.now() + 3_000
  while (observed.size < 4 && Date.now() < until) await Bun.sleep(20)
  expect(observed.size).toBe(4)
  await f.parent.request(methods.DETACH_CLIENT, { clientId: f.main.clientId })
  const before = f.events.length
  observed.clear()
  writeFileSync(join(root, 'memory', 'after-detach.md'), '# 只通知 quick')
  const detachedDeadline = Date.now() + 3_000
  while (observed.size < 2 && Date.now() < detachedDeadline) await Bun.sleep(20)
  expect([...observed].sort()).toEqual(subscriptions.slice(2).map((value) => value.subscriptionId).sort())
  expect(f.events.slice(before).every((event) => event.packet.clientId === f.quick.clientId)).toBe(true)
})
