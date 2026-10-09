import { afterEach, describe, expect, test } from 'bun:test'
import { EventEmitter } from 'node:events'
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type { IpcMainInvokeEvent, WebContents } from 'electron'
import type { RpcRequestOptions } from '@axon/app-server'
import { AGENT_PROJECT_IPC_CHANNELS as projects, AGENT_MEMORY_IPC_CHANNELS as memory, APP_SERVER_METHODS as methods } from '@axon/shared'
import type { AgentProject, AgentProjectWatchClosedEvent, AgentProjectWatchSubscription, AgentProjectWatchTarget, AgentMemoryChangedEvent, AgentWorkspaceDirectorySelection, RpcJsonValue } from '@axon/shared'
import { createFixtureCredentialCodec } from '../../../../../packages/core/test-support/credential-codec'
import { AppServerProcess } from '../lib/desktop/app-server-process'
import { AppServerWindowClients } from '../lib/desktop/app-server-window-clients'
import { AppServerEvents } from '../lib/desktop/app-server-events'
import { registerAppServerProjectIpcHandlers } from './app-server-project-ipc'
import type { AppServerProjectIpcOptions, AppServerProjectIpcRegistrar } from './app-server-project-ipc'
import { observeProjectWatch } from '../../renderer/lib/project-watch'

type Handler = Parameters<AppServerProjectIpcRegistrar['handle']>[1]
type Method = Parameters<AppServerProcess['request']>[1]
class Surface extends EventEmitter {
  readonly mainFrame = {}
  readonly deliveries: Array<{ channel: string; value: unknown }> = []
  isDestroyed(): boolean { return false }
  send(channel: string, value: unknown): void { this.deliveries.push({ channel, value }); this.emit('delivery', channel, value) }
  get sender(): WebContents { return this as unknown as WebContents }
  event(iframe = false): IpcMainInvokeEvent { return { sender: this.sender, senderFrame: iframe ? {} : this.mainFrame } as unknown as IpcMainInvokeEvent }
}
class Registrar implements AppServerProjectIpcRegistrar {
  readonly handlers = new Map<string, Handler>()
  handle(channel: string, action: Handler): void { if (this.handlers.has(channel)) throw new Error('已注册'); this.handlers.set(channel, action) }
  removeHandler(channel: string): void { this.handlers.delete(channel) }
  async invoke(channel: string, sender: Surface, ...args: unknown[]): Promise<unknown> {
    const action = this.handlers.get(channel)
    if (!action) throw new Error('未注册')
    return await action(sender.event(), ...args)
  }
}
const cleanups: Array<() => void | Promise<void>> = []
afterEach(async () => { for (const cleanup of cleanups.splice(0).reverse()) await cleanup() })
function open() {
  const main = new Surface(), unknown = new Surface(), ipc = new Registrar(), signal = new AbortController()
  const calls: Array<{ clientId: string; method: Method; input?: RpcJsonValue; options: RpcRequestOptions }> = []
  let registrations = 0
  const clients = new AppServerWindowClients({ kindOf: (sender) => sender === main.sender ? 'main' : undefined, backend: {
    registerClient: async (kind) => { registrations++; return { clientId: `owner-${registrations}`, kind } },
    getClientSignal: () => signal.signal, detachClient: async () => true,
  } })
  const backend: AppServerProjectIpcOptions['backend'] = { request: async (clientId, method, input, options = {}) => {
    calls.push({ clientId, method, input, options }); return { id: 'project' }
  } }
  const options: AppServerProjectIpcOptions = { backend, clients, pickLocalWorkspace: async () => ({ canceled: true }) }
  const dispose = registerAppServerProjectIpcHandlers(ipc, options)
  cleanups.push(() => { dispose(); clients.dispose() })
  return { main, unknown, ipc, backend, clients, options, dispose, calls, get registrations() { return registrations } }
}

describe('项目/文件/记忆固定 IPC 代理', () => {
  test('真实独立子进程→固定事件→面板监听：原生变化、换目录重建、旧取消隔离及记忆关闭/项目删除终止', async () => {
    const directory = mkdtempSync(join(tmpdir(), 'axon-project-watch-ipc-'))
    const main = new Surface(), quick = new Surface(), ipc = new Registrar()
    let clients!: AppServerWindowClients, events!: AppServerEvents
    const backend = new AppServerProcess({ launch: {
      executable: process.execPath, entryArgs: [join(import.meta.dir, '../../../../app-server/src/main.ts')], dataDir: join(directory, 'data'),
      homeDir: directory, applicationVersion: '0.1.3', environment: { ...process.env, AXON_ZIMA_PYTHON: '' },
    }, credentialCodec: createFixtureCredentialCodec(), configurePeer: (peer) => { events = new AppServerEvents(peer, { clients }) }, stopTimeoutMs: 100 })
    clients = new AppServerWindowClients({ backend, kindOf: (sender) => sender === main.sender ? 'main' : sender === quick.sender ? 'quick' : undefined })
    const dispose = registerAppServerProjectIpcHandlers(ipc, { backend, clients, pickLocalWorkspace: async () => ({ canceled: true }) })
    const stops: Array<() => void> = [], pendingReleases: Promise<boolean>[] = []
    cleanups.push(async () => {
      stops.forEach((stop) => stop()); await Promise.allSettled(pendingReleases)
      dispose(); events?.dispose(); clients.dispose(); await backend.stop(); rmSync(directory, { recursive: true, force: true })
    })
    const project = await ipc.invoke(projects.CREATE, main, { name: '真实监听' }) as AgentProject
    await ipc.invoke(projects.UPDATE, main, project.id, { memoryEnabled: true })
    const root = join(directory, 'data', 'agent-projects', project.slug, 'workspace-files')
    mkdirSync(join(root, 'memory'))
    const observe = (sender: Surface, kind: 'workspace' | 'memory') => {
      const state = { subscriptions: [] as AgentProjectWatchSubscription[], changes: [] as AgentMemoryChangedEvent[],
        closed: [] as AgentProjectWatchClosedEvent[], reads: 0, failed: 0 }
      const listen = <T,>(channel: string, callback: (value: T) => void): (() => void) => {
        const listener = (received: string, value: T) => { if (received === channel) callback(value) }
        sender.on('delivery', listener); return () => { sender.removeListener('delivery', listener) }
      }
      const stop = observeProjectWatch({
        projectId: project.id, kind,
        watch: async (id) => {
          const subscription = await ipc.invoke(kind === 'workspace' ? projects.WATCH_DIRECTORY : memory.WATCH, sender, id) as AgentProjectWatchSubscription
          state.subscriptions.push(subscription); return subscription
        },
        unwatch: (target) => {
          const result = ipc.invoke(kind === 'workspace' ? projects.UNWATCH_DIRECTORY : memory.UNWATCH, sender, target) as Promise<boolean>
          pendingReleases.push(result); return result
        },
        onChanged: (callback) => listen(kind === 'workspace' ? projects.DIRECTORY_CHANGED : memory.CHANGED, callback),
        onClosed: (callback) => listen(projects.WATCH_CLOSED, callback),
        ready: () => { void ipc.invoke(kind === 'workspace' ? projects.LIST_DIRECTORY : memory.LIST, sender, project.id)
          .then(() => state.reads++).catch(() => state.failed++) },
        changed: (event) => { state.changes.push(event) }, closed: (event) => { state.closed.push(event) }, failed: () => { state.failed++ },
      })
      stops.push(stop); return { state, stop }
    }
    const workspace = observe(main, 'workspace'), memories = observe(main, 'memory'), quickWorkspace = observe(quick, 'workspace')
    const wait = async (condition: () => boolean): Promise<void> => {
      const deadline = Date.now() + 3_000
      while (!condition() && Date.now() < deadline) await Bun.sleep(20)
      expect(condition()).toBe(true)
    }
    await wait(() => [workspace, memories, quickWorkspace].every((value) => value.state.reads === 1))
    const receiveNative = async (path: string, observers: typeof workspace[]): Promise<void> => {
      const previous = observers.map((value) => value.state.changes.length), deadline = Date.now() + 3_000
      let attempt = 0
      const received = () => observers.every((value, index) => value.state.changes.length > previous[index]!)
      // 以实际 OS 事件同步就绪；不把 watch 响应当作 macOS 已开始投递。
      while (!received() && Date.now() < deadline) {
        writeFileSync(join(path, 'memory', 'ready.md'), `# 原生变更 ${attempt++}`)
        const next = Math.min(deadline, Date.now() + 500)
        while (!received() && Date.now() < next) await Bun.sleep(20)
      }
      expect(received()).toBe(true)
    }
    await receiveNative(root, [workspace, memories, quickWorkspace])
    const initial = [workspace.state.subscriptions[0]!, quickWorkspace.state.subscriptions[0]!]
    const nextRoot = join(directory, 'next'); mkdirSync(join(nextRoot, 'memory'), { recursive: true })
    await ipc.invoke(projects.UPDATE, main, project.id, { workspace: { kind: 'local', path: nextRoot }, memoryEnabled: false })
    await wait(() => workspace.state.reads === 2 && quickWorkspace.state.reads === 2 && memories.state.closed.length === 1)
    expect(memories.state.closed[0]?.reason).toBe('memory_disabled')
    expect(memories.state.subscriptions).toHaveLength(1)
    for (const [index, sender] of [main, quick].entries()) {
      const target: AgentProjectWatchTarget = { projectId: project.id, subscriptionId: initial[index]!.subscriptionId }
      expect(await ipc.invoke(projects.UNWATCH_DIRECTORY, sender, target)).toBe(false)
    }
    expect(workspace.state.subscriptions[1]?.subscriptionId).not.toBe(initial[0]!.subscriptionId)
    await receiveNative(nextRoot, [workspace, quickWorkspace])
    await ipc.invoke(projects.UPDATE, main, project.id, { memoryEnabled: true })
    const nextMemories = observe(main, 'memory'); await wait(() => nextMemories.state.reads === 1)
    await receiveNative(nextRoot, [workspace, quickWorkspace, nextMemories])
    const quickTarget = quickWorkspace.state.subscriptions[1]!
    expect(await ipc.invoke(projects.UNWATCH_DIRECTORY, main, { projectId: project.id, subscriptionId: quickTarget.subscriptionId })).toBe(false)
    quickWorkspace.stop()
    expect(await pendingReleases.at(-1)).toBe(true)
    expect(await ipc.invoke(projects.UNWATCH_DIRECTORY, quick, { projectId: project.id, subscriptionId: quickTarget.subscriptionId })).toBe(false)
    const finalQuick = observe(quick, 'workspace'); await wait(() => finalQuick.state.reads === 1)
    await receiveNative(nextRoot, [workspace, finalQuick, nextMemories])
    await ipc.invoke(projects.DELETE, main, project.id)
    await wait(() => [workspace, finalQuick, nextMemories].every((value) => value.state.closed.at(-1)?.reason === 'project_deleted'))
    expect(workspace.state.subscriptions).toHaveLength(2); expect(quickWorkspace.state.subscriptions).toHaveLength(2)
    expect(finalQuick.state.subscriptions).toHaveLength(1)
    expect(nextMemories.state.subscriptions).toHaveLength(1)
    expect([workspace, memories, quickWorkspace, nextMemories, finalQuick].every((value) => value.state.failed === 0)).toBe(true)
    expect(existsSync(nextRoot)).toBe(true)
  }, 15_000)

  test('固定方法/字段映射；不开放私有宿主、任意文件写入或临时监听回退', async () => {
    const f = open()
    const routes: Array<{ channel: string; args: unknown[]; method: Method; input?: RpcJsonValue }> = [
      { channel: projects.LIST, args: [], method: methods.PROJECT_LIST },
      { channel: projects.GET, args: [' project '], method: methods.PROJECT_GET, input: 'project' },
      { channel: projects.CREATE, args: [{ name: '项目' }], method: methods.PROJECT_CREATE, input: { name: '项目' } },
      { channel: projects.UPDATE, args: ['project', { memoryEnabled: true }], method: methods.PROJECT_UPDATE, input: { projectId: 'project', update: { memoryEnabled: true } } },
      { channel: projects.DELETE, args: ['project'], method: methods.PROJECT_DELETE, input: 'project' },
      { channel: projects.LIST_DIRECTORY, args: ['project'], method: methods.WORKSPACE_LIST_DIRECTORY, input: 'project' },
      { channel: projects.READ_FILE, args: ['project', 'a.md'], method: methods.WORKSPACE_READ_FILE, input: { projectId: 'project', relativePath: 'a.md' } },
      { channel: projects.READ_DIFF, args: ['project', 'a.md'], method: methods.WORKSPACE_READ_DIFF, input: { projectId: 'project', relativePath: 'a.md' } },
      { channel: memory.LIST, args: ['project'], method: methods.MEMORY_LIST, input: 'project' },
      { channel: memory.READ, args: ['project', 'MEMORY.md'], method: methods.MEMORY_READ, input: { projectId: 'project', relativePath: 'MEMORY.md' } },
      { channel: memory.WRITE, args: ['project', 'MEMORY.md', '索引'], method: methods.MEMORY_WRITE, input: { projectId: 'project', relativePath: 'MEMORY.md', content: '索引' } },
      { channel: projects.WATCH_DIRECTORY, args: [' project '], method: methods.WORKSPACE_WATCH, input: 'project' },
      { channel: projects.UNWATCH_DIRECTORY, args: [{ projectId: 'project', subscriptionId: 'workspace' }], method: methods.WORKSPACE_UNWATCH, input: { projectId: 'project', subscriptionId: 'workspace' } },
      { channel: memory.WATCH, args: ['project'], method: methods.MEMORY_WATCH, input: 'project' },
      { channel: memory.UNWATCH, args: [{ projectId: 'project', subscriptionId: 'memory' }], method: methods.MEMORY_UNWATCH, input: { projectId: 'project', subscriptionId: 'memory' } },
    ]
    for (const route of routes) {
      await f.ipc.invoke(route.channel, f.main, ...route.args)
      expect(f.calls.at(-1)).toMatchObject({ clientId: 'owner-1', method: route.method, input: route.input })
      expect(f.calls.at(-1)?.options.signal?.aborted).toBe(false)
    }
    expect([...f.ipc.handlers.keys()].sort()).toEqual([...routes.map((route) => route.channel), projects.PICK_LOCAL_WORKSPACE].sort())
    expect(f.registrations).toBe(1)
  })

  test('主 frame/参数/标识/JSON 校验先于登记，未知窗口不得打开目录选择器', async () => {
    const f = open(); let shown = 0
    f.options.pickLocalWorkspace = async () => { shown++; return { canceled: true } }
    for (const action of f.ipc.handlers.values()) expect(() => action(f.main.event(true))).toThrow('子框架')
    await expect(f.ipc.invoke(projects.LIST, f.main, 'owner')).rejects.toThrow('数量')
    await expect(f.ipc.invoke(projects.GET, f.main, ' ')).rejects.toThrow('标识')
    for (const channel of [projects.UNWATCH_DIRECTORY, memory.UNWATCH]) {
      for (const input of ['project', { projectId: 'project' }, { projectId: 'project', subscriptionId: '' },
        { projectId: 'project', subscriptionId: 's', kind: 'workspace' }, { projectId: 'project', subscriptionId: 's', owner: 'forged' }]) {
        await expect(f.ipc.invoke(channel, f.main, input)).rejects.toThrow()
      }
    }
    await expect(f.ipc.invoke(projects.CREATE, f.main, { fn: () => {} })).rejects.toThrow('不能传输')
    await expect(f.ipc.invoke(projects.PICK_LOCAL_WORKSPACE, f.unknown)).rejects.toThrow('已登记')
    expect(f.registrations).toBe(0); expect(shown).toBe(0); expect(f.calls).toEqual([])
  })

  test('原生选择取消是正常结果；重载或释放后的迟到路径不交付且不创建项目', async () => {
    const f = open()
    expect(await f.ipc.invoke(projects.PICK_LOCAL_WORKSPACE, f.main)).toEqual({ canceled: true })
    for (const mode of ['reload', 'dispose']) {
      const next = open(), entered = Promise.withResolvers<void>(), selected = Promise.withResolvers<AgentWorkspaceDirectorySelection>()
      next.options.pickLocalWorkspace = async (sender) => { expect(sender).toBe(next.main.sender); entered.resolve(); return await selected.promise }
      const pending = next.ipc.invoke(projects.PICK_LOCAL_WORKSPACE, next.main).catch((error: unknown) => error)
      await entered.promise
      if (mode === 'reload') { next.main.emit('did-start-loading'); await next.clients.get(next.main.sender) }
      else next.dispose()
      selected.resolve({ canceled: false, path: '/fixture/chosen', suggestedName: '选中项目' })
      if (mode === 'reload') expect(await pending).toBe('axon_page_invalidated')
      else expect(await pending).toMatchObject({ name: 'AbortError' })
      expect(next.calls).toEqual([])
    }
  })

  test('释放撤销等待但不假定保存回滚或重投；迟到登记不启动记忆写入', async () => {
    const f = open(), entered = Promise.withResolvers<void>()
    f.backend.request = (clientId, method, input, options = {}) => {
      f.calls.push({ clientId, method, input, options }); entered.resolve()
      return new Promise((_resolve, reject) => options.signal!.addEventListener('abort', () => reject(options.signal!.reason), { once: true }))
    }
    const pending = f.ipc.invoke(memory.WRITE, f.main, 'project', 'MEMORY.md', '内容').catch((error: unknown) => error)
    await entered.promise; f.dispose(); await pending
    expect(f.calls.map((call) => call.method)).toEqual([methods.MEMORY_WRITE])
    expect(f.calls[0]?.options.signal?.aborted).toBe(true)
    const ipc = new Registrar(), gate = Promise.withResolvers<void>()
    const dispose = registerAppServerProjectIpcHandlers(ipc, { ...f.options, clients: {
      get: async (sender) => { await gate.promise; return await f.clients.get(sender) },
      getClientSignal: (value) => f.clients.getClientSignal(value), matches: (sender, value) => f.clients.matches(sender, value),
    } })
    const late = ipc.invoke(memory.WRITE, f.main, 'project', 'MEMORY.md', 'late').catch((error: unknown) => error)
    dispose(); gate.resolve(); expect(await late).toMatchObject({ name: 'AbortError' })
    expect(f.calls).toHaveLength(1)
  })

  test('半注册失败只清理本代理通道，释放不注销共享原页面', async () => {
    const f = open(), ipc = new Registrar()
    ipc.handle(projects.DELETE, () => 'existing')
    expect(() => registerAppServerProjectIpcHandlers(ipc, f.options)).toThrow('已注册')
    expect([...ipc.handlers.keys()]).toEqual([projects.DELETE])
    await f.ipc.invoke(projects.LIST, f.main)
    f.dispose(); f.dispose()
    expect(f.clients.find('owner-1')).toBe(f.main.sender)
  })

  test('真实完整子进程：项目共享快照、受限文件/记忆读写、禁用边界与本地工作区删除保护', async () => {
    const directory = mkdtempSync(join(tmpdir(), 'axon-project-ipc-'))
    const main = new Surface(), quick = new Surface(), ipc = new Registrar()
    let clients!: AppServerWindowClients, events!: AppServerEvents
    const backend = new AppServerProcess({ launch: {
      executable: process.execPath, entryArgs: [join(import.meta.dir, '../../../../app-server/src/main.ts')], dataDir: join(directory, 'data'),
      homeDir: directory, applicationVersion: '0.1.3', environment: { ...process.env, AXON_ZIMA_PYTHON: '' },
    }, credentialCodec: createFixtureCredentialCodec(), configurePeer: (peer) => { events = new AppServerEvents(peer, { clients }) }, stopTimeoutMs: 100 })
    clients = new AppServerWindowClients({ backend, kindOf: (sender) => sender === main.sender ? 'main' : sender === quick.sender ? 'quick' : undefined })
    const dispose = registerAppServerProjectIpcHandlers(ipc, { backend, clients, pickLocalWorkspace: async () => ({ canceled: true }) })
    cleanups.push(async () => { dispose(); events?.dispose(); clients.dispose(); await backend.stop(); rmSync(directory, { recursive: true, force: true }) })
    expect(await ipc.invoke(projects.LIST, main)).toEqual([]); await ipc.invoke(projects.LIST, quick)
    expect(backend.pid).not.toBe(process.pid)
    const managed = await ipc.invoke(projects.CREATE, main, { name: '隔离项目' }) as AgentProject
    const root = join(directory, 'data', 'agent-projects', managed.slug, 'workspace-files')
    expect(existsSync(root)).toBe(true)
    expect(quick.deliveries.at(-1)).toEqual({ channel: projects.CHANGED, value: [managed] })
    expect(await ipc.invoke(projects.GET, quick, managed.id)).toEqual(managed)
    writeFileSync(join(root, 'a.md'), '# 原文')
    const outside = join(directory, 'outside.md'); writeFileSync(outside, '项目外内容'); symlinkSync(outside, join(root, 'linked.md'))
    expect(await ipc.invoke(projects.LIST_DIRECTORY, main, managed.id)).toMatchObject({ projectId: managed.id, entries: expect.any(Array) })
    expect(await ipc.invoke(projects.READ_FILE, quick, managed.id, 'a.md')).toMatchObject({ content: '# 原文' })
    expect(await ipc.invoke(projects.READ_DIFF, main, managed.id, 'a.md')).toMatchObject({ status: 'unavailable' })
    for (const path of ['../outside.md', outside, 'linked.md']) {
      await expect(ipc.invoke(projects.READ_FILE, main, managed.id, path)).rejects.toMatchObject({ code: -32024 })
    }
    await expect(ipc.invoke(memory.LIST, main, managed.id)).rejects.toMatchObject({ code: -32025, data: { code: 'disabled' } })
    await ipc.invoke(projects.UPDATE, main, managed.id, { memoryEnabled: true })
    expect(await ipc.invoke(memory.WRITE, main, managed.id, 'MEMORY.md', '# 记忆索引')).toMatchObject({ content: '# 记忆索引' })
    expect(await ipc.invoke(memory.READ, quick, managed.id, 'MEMORY.md')).toMatchObject({ content: '# 记忆索引' })
    expect(await ipc.invoke(memory.LIST, main, managed.id)).toMatchObject({ indexExists: true })
    await expect(ipc.invoke(memory.WRITE, main, managed.id, '../outside.md', '不可覆盖')).rejects.toMatchObject({ code: -32025 })
    expect(readFileSync(outside, 'utf8')).toBe('项目外内容')
    await ipc.invoke(projects.UPDATE, main, managed.id, { memoryEnabled: false })
    await expect(ipc.invoke(memory.WRITE, main, managed.id, 'MEMORY.md', '禁止')).rejects.toMatchObject({ code: -32025 })
    const local = join(directory, 'local'); mkdirSync(local); writeFileSync(join(local, 'kept.md'), '保留本地文件')
    const project = await ipc.invoke(projects.CREATE, main, { name: '本地项目', workspace: { kind: 'local', path: local } }) as AgentProject
    await ipc.invoke(projects.DELETE, main, project.id)
    expect(readFileSync(join(local, 'kept.md'), 'utf8')).toBe('保留本地文件')
    const owner = await clients.get(main.sender); main.emit('did-start-loading')
    expect(await ipc.invoke(projects.LIST, main)).toMatchObject([{ id: managed.id }])
    expect((await clients.get(main.sender)).clientId).not.toBe(owner.clientId)
    await ipc.invoke(projects.DELETE, main, managed.id)
    expect(existsSync(root)).toBe(false)
    expect(await ipc.invoke(projects.GET, quick, managed.id)).toBeNull()
  })
})
