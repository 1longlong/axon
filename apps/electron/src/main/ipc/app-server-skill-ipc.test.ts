import { afterEach, describe, expect, test } from 'bun:test'
import { EventEmitter } from 'node:events'
import { createHash } from 'node:crypto'
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type { IpcMainInvokeEvent, WebContents } from 'electron'
import { createBackend, createBackendPaths, createCredentialCodec } from '@axon/core'
import type { RpcRequestOptions } from '@axon/app-server'
import { AGENT_SKILL_IPC_CHANNELS as channels, APP_SERVER_METHODS as methods, SETTINGS_IPC_CHANNELS } from '@axon/shared'
import type { AgentSkillSettingsSnapshot, AppSettings, InstallableSkillPackage, RpcJsonValue } from '@axon/shared'
import { createFixtureCredentialCodec } from '../../../../../packages/core/test-support/credential-codec'
import { RendererSkillSettings } from '../../renderer/lib/agent-skill-settings'
import { AppServerProcess } from '../lib/desktop/app-server-process'
import { AppServerWindowClients } from '../lib/desktop/app-server-window-clients'
import { AppServerEvents } from '../lib/desktop/app-server-events'
import { registerAppServerSkillIpcHandlers } from './app-server-skill-ipc'
import type { AppServerSkillIpcOptions, AppServerSkillIpcRegistrar } from './app-server-skill-ipc'

type Handler = Parameters<AppServerSkillIpcRegistrar['handle']>[1]
type Method = Parameters<AppServerProcess['request']>[1]
interface Call { clientId: string; method: Method; input?: RpcJsonValue; options: RpcRequestOptions }
class Surface extends EventEmitter {
  readonly mainFrame = {}
  readonly deliveries: Array<{ channel: string; value: unknown }> = []
  isDestroyed(): boolean { return false }
  send(channel: string, value: unknown): void { this.deliveries.push({ channel, value }); this.emit(channel, value) }
  get sender(): WebContents { return this as unknown as WebContents }
  event(iframe = false): IpcMainInvokeEvent { return { sender: this.sender, senderFrame: iframe ? {} : this.mainFrame } as unknown as IpcMainInvokeEvent }
}
class Registrar implements AppServerSkillIpcRegistrar {
  readonly handlers = new Map<string, Handler>()
  handle(channel: string, handler: Handler): void {
    if (this.handlers.has(channel)) throw new Error('通道已注册')
    this.handlers.set(channel, handler)
  }
  removeHandler(channel: string): void { this.handlers.delete(channel) }
  async invoke(channel: string, event: IpcMainInvokeEvent, ...args: unknown[]): Promise<unknown> {
    const handler = this.handlers.get(channel)
    if (!handler) throw new Error('未注册')
    return await handler(event, ...args)
  }
}
const cleanups: Array<() => void | Promise<void>> = []
afterEach(async () => { for (const cleanup of cleanups.splice(0).reverse()) await cleanup() })
function open() {
  const main = new Surface(), unknown = new Surface(), ipc = new Registrar(), calls: Call[] = [], page = new AbortController()
  let registrations = 0
  const clients = new AppServerWindowClients({ kindOf: (sender) => sender === main.sender ? 'main' : undefined, backend: {
    registerClient: async (kind) => { registrations += 1; return { clientId: 'owner', kind } },
    getClientSignal: () => page.signal, detachClient: async () => { page.abort(); return true },
  } })
  const backend: AppServerSkillIpcOptions['backend'] = { request: async (clientId, method, input, options = {}) => {
    calls.push({ clientId, method, input, options }); return { installed: [], desiredCatalogIds: input ?? [], failures: [] }
  } }
  const dispose = registerAppServerSkillIpcHandlers(ipc, { backend, clients })
  cleanups.push(() => { dispose(); clients.dispose() })
  return { main, unknown, ipc, clients, calls, backend, dispose, registrations: () => registrations }
}
async function until(check: () => boolean): Promise<void> {
  const deadline = Date.now() + 8000
  while (!check()) { if (Date.now() > deadline) throw new Error('等待实际状态超时'); await Bun.sleep(10) }
}
function skill(): InstallableSkillPackage {
  const bytes = Buffer.from('---\nname: fixture\ndescription: 隔离 Skill\n---\n\n不得返回的正文')
  const sha256 = createHash('sha256').update(bytes).digest('hex')
  return { catalogId: 'fixture/skill', name: 'fixture', version: '1', description: '隔离 Skill',
    contentHash: createHash('sha256').update(`SKILL.md\0${sha256}\n`).digest('hex'),
    files: [{ path: 'SKILL.md', contentBase64: bytes.toString('base64'), sha256 }] }
}

describe('Skills 固定 IPC 代理', () => {
  test('只提供两个固定命令，读取和应用关闭短期限；不把选择伪装成安装成功', async () => {
    const f = open()
    expect([...f.ipc.handlers.keys()].sort()).toEqual(Object.values(channels).sort())
    await f.ipc.invoke(channels.GET_SETTINGS, f.main.event())
    expect(await f.ipc.invoke(channels.APPLY_SETTINGS, f.main.event(), [' fixture/skill '])).toEqual({ installed: [], desiredCatalogIds: ['fixture/skill'], failures: [] })
    expect(f.calls.map(({ method, input }) => ({ method, input }))).toEqual([
      { method: methods.SKILLS_GET_SETTINGS, input: undefined }, { method: methods.SKILLS_APPLY_SETTINGS, input: ['fixture/skill'] },
    ])
    expect(f.calls.every((call) => call.clientId === 'owner' && call.options.timeoutMs === 0 && !call.options.signal?.aborted)).toBe(true)
    expect(f.registrations()).toBe(1)
  })

  test('主 frame/数量/ID 数组校验先于登记，不能提交包或路径；未知窗口拒绝', async () => {
    const f = open()
    for (const channel of f.ipc.handlers.keys()) await expect(f.ipc.invoke(channel, f.main.event(true))).rejects.toThrow('子框架')
    await expect(f.ipc.invoke(channels.GET_SETTINGS, f.main.event(), '/path')).rejects.toThrow('数量')
    for (const input of [null, 'id', [1], new Array(1), [''], ['x'.repeat(201)], Array.from({ length: 201 }, () => 'id'), { catalogId: 'id', files: [] }]) {
      await expect(f.ipc.invoke(channels.APPLY_SETTINGS, f.main.event(), input)).rejects.toThrow('参数')
    }
    await expect(f.ipc.invoke(channels.GET_SETTINGS, f.unknown.event())).rejects.toThrow('已登记')
    expect(f.registrations()).toBe(0); expect(f.calls).toEqual([])
  })

  test('页面重载/代理释放撤销等待，非配合后端迟到成功也不交付，不重发', async () => {
    const f = open(), entered = Promise.withResolvers<AbortSignal>(), gate = Promise.withResolvers<RpcJsonValue>()
    f.backend.request = async (_client, _method, _input, options = {}) => { entered.resolve(options.signal!); return await gate.promise }
    const outcome = f.ipc.invoke(channels.APPLY_SETTINGS, f.main.event(), []).catch((error: unknown) => error)
    const signal = await entered.promise
    f.main.emit('did-start-loading'); f.dispose(); f.dispose()
    expect(signal.aborted).toBe(true)
    gate.resolve({ installed: [] }); expect(await outcome).toBe(signal.reason)
    expect(f.ipc.handlers.size).toBe(0)
  })

  test('半注册失败只清理自有通道，异步登记期间释放不启动应用', async () => {
    const f = open(), ipc = new Registrar()
    ipc.handle(channels.APPLY_SETTINGS, () => 'existing')
    expect(() => registerAppServerSkillIpcHandlers(ipc, { backend: f.backend, clients: f.clients })).toThrow('已注册')
    expect([...ipc.handlers.keys()]).toEqual([channels.APPLY_SETTINGS])
    const gate = Promise.withResolvers<void>(), fresh = new Registrar()
    const dispose = registerAppServerSkillIpcHandlers(fresh, { backend: f.backend, clients: {
      get: async (sender) => { const client = await f.clients.get(sender); await gate.promise; return client }, getClientSignal: (id) => f.clients.getClientSignal(id),
    } })
    const outcome = fresh.invoke(channels.APPLY_SETTINGS, f.main.event(), []).catch((error: unknown) => error)
    dispose(); gate.resolve()
    expect(await outcome).toMatchObject({ name: 'AbortError' }); expect(f.calls).toEqual([])
  })

  test('真实独立后端→固定代理/事件→页面模型：空来源恢复清单、双入口卸载/通知/草稿与安全摘要', async () => {
    const directory = mkdtempSync(join(tmpdir(), 'axon-skill-ipc-')), paths = createBackendPaths({ dataDir: join(directory, 'data'), homeDir: directory })
    const setup = createBackend({ paths, applicationVersion: '0.1.3', credentialCodec: createCredentialCodec(), skillCatalog: { getCatalog: () => ({ packages: [skill()] }) },
      resolveAdapter: () => ({ async *query() { throw new Error('设置不得执行 Agent') }, abort() {}, dispose() {}, async drain() {} }) })
    try { await setup.skills.apply(['fixture/skill']); setup.settings.update({ themeMode: 'dark', agentSystemPrompt: '用户规则' }) }
    finally { setup.dispose() }
    // 预置结束后才启动独立后端，任何时刻没有两套业务写入者。
    const manual = join(paths.managedSkillsDir, 'manual'); mkdirSync(manual); writeFileSync(join(manual, 'SKILL.md'), '用户文件保留')
    const main = new Surface(), quick = new Surface(), ipc = new Registrar()
    let clients!: AppServerWindowClients, events!: AppServerEvents
    const backend = new AppServerProcess({ launch: {
      executable: process.execPath, entryArgs: [join(import.meta.dir, '../../../../app-server/src/main.ts')],
      dataDir: paths.dataDir, homeDir: directory, applicationVersion: '0.1.3', environment: { ...process.env, AXON_ZIMA_PYTHON: '' },
    }, credentialCodec: createFixtureCredentialCodec(), configurePeer: (peer) => { events = new AppServerEvents(peer, { clients }) }, stopTimeoutMs: 100 })
    clients = new AppServerWindowClients({ backend, kindOf: (sender) => sender === main.sender ? 'main' : sender === quick.sender ? 'quick' : undefined })
    const dispose = registerAppServerSkillIpcHandlers(ipc, { backend, clients }), models: RendererSkillSettings[] = []
    cleanups.push(async () => { for (const model of models) model.dispose(); dispose(); events?.dispose(); clients.dispose(); await backend.stop(); rmSync(directory, { recursive: true, force: true }) })
    for (const surface of [main, quick]) {
      const model = new RendererSkillSettings({ agentSkills: {
        getSettings: async () => await ipc.invoke(channels.GET_SETTINGS, surface.event()) as AgentSkillSettingsSnapshot,
        applySettings: async (ids) => await ipc.invoke(channels.APPLY_SETTINGS, surface.event(), ids) as AgentSkillSettingsSnapshot,
      }, settings: { onChanged: (callback) => { surface.on(SETTINGS_IPC_CHANNELS.CHANGED, callback); return () => { surface.off(SETTINGS_IPC_CHANNELS.CHANGED, callback) } } } }, () => {})
      models.push(model); model.start()
    }
    await until(() => models.every((model) => !model.getSnapshot().refreshing))
    expect(backend.pid).not.toBe(process.pid)
    expect(models[0]!.getSnapshot().snapshot).toMatchObject({ available: [], desiredCatalogIds: ['fixture/skill'], installed: [{ catalogId: 'fixture/skill' }] })
    expect(JSON.stringify(models[0]!.getSnapshot().snapshot)).not.toContain(directory)
    expect(JSON.stringify(models[0]!.getSnapshot().snapshot)).not.toContain('不得返回的正文')
    models[0]!.select('unsaved', true)
    models[1]!.select('fixture/skill', false)
    await models[1]!.apply()
    await until(() => models.every((model) => !model.getSnapshot().refreshing && model.getSnapshot().snapshot?.installed.length === 0))
    expect(models[0]!.getSnapshot().selected).toEqual(['fixture/skill', 'unsaved'])
    expect(models[1]!.getSnapshot().selected).toEqual([])
    expect(existsSync(join(paths.managedSkillsDir, 'fixture'))).toBe(false)
    expect(readFileSync(join(manual, 'SKILL.md'), 'utf8')).toBe('用户文件保留')
    expect(JSON.parse(readFileSync(paths.settingsPath, 'utf8'))).toMatchObject({ themeMode: 'dark', agentSystemPrompt: '用户规则', agentSkillCatalogIds: [] })
    for (const surface of [main, quick]) expect(surface.deliveries.filter((item) => item.channel === SETTINGS_IPC_CHANNELS.CHANGED).at(-1)?.value as AppSettings).toMatchObject({ agentSkillCatalogIds: [] })
    // 当前生产来源为空，不能通过 renderer 上传包或指定目录来恢复安装。
    await expect(ipc.invoke(channels.APPLY_SETTINGS, main.event(), ['fixture/skill'])).rejects.toMatchObject({ code: -32602 })
    expect(JSON.parse(readFileSync(paths.settingsPath, 'utf8')).agentSkillCatalogIds).toEqual([])
  }, 15_000)
})
