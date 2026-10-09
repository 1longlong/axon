import { afterEach, describe, expect, test } from 'bun:test'
import { randomUUID } from 'node:crypto'
import { EventEmitter } from 'node:events'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type { WebContents } from 'electron'
import { createCredentialCodec } from '@axon/core'
import { APP_SERVER_METHODS as methods } from '@axon/shared'
import type { AppServerClient, AppServerClientKind } from '@axon/shared'
import { AppServerProcess } from './app-server-process'
import { AppServerWindowClients } from './app-server-window-clients'

const stores: AppServerWindowClients[] = [], servers: AppServerProcess[] = [], directories: string[] = []
class Surface extends EventEmitter {
  destroyed = false
  isDestroyed(): boolean { return this.destroyed }
  get sender(): WebContents { return this as unknown as WebContents }
}
interface Registration {
  client: AppServerClient
  pageSignal?: AbortSignal
  accept: () => void
  reject: (error: Error) => void
}
class Backend {
  readonly calls: Registration[] = []
  readonly detached: string[] = []
  readonly controllers = new Map<string, AbortController>()
  deferred = false
  detachFails = false
  registerClient(kind: AppServerClientKind, pageSignal?: AbortSignal): Promise<AppServerClient> {
    const client: AppServerClient = { clientId: randomUUID(), kind }
    this.controllers.set(client.clientId, new AbortController())
    let accept!: () => void, reject!: (error: Error) => void
    const waiting = new Promise<AppServerClient>((resolve, fail) => { accept = () => resolve(client); reject = fail })
    this.calls.push({ client, pageSignal, accept, reject })
    if (!this.deferred) accept()
    return waiting
  }
  async detachClient(clientId: string): Promise<boolean> {
    this.detached.push(clientId)
    if (this.detachFails) throw new Error('不会回显的夹具原因')
    this.controllers.get(clientId)?.abort()
    return this.controllers.delete(clientId)
  }
  getClientSignal(clientId: string): AbortSignal | undefined { return this.controllers.get(clientId)?.signal }
}
function open(backend = new Backend(), onDetached?: (clientId: string) => void) {
  const main = new Surface(), quick = new Surface(), unknown = new Surface()
  const kinds = new Map<WebContents, 'main' | 'quick'>([[main.sender, 'main'], [quick.sender, 'quick']])
  const store = new AppServerWindowClients({ backend, kindOf: (sender) => kinds.get(sender), onDetached })
  stores.push(store)
  return { store, backend, main, quick, unknown, kinds }
}
afterEach(async () => {
  for (const store of stores.splice(0)) store.dispose()
  for (const server of servers.splice(0)) await server.stop()
  for (const directory of directories.splice(0)) rmSync(directory, { recursive: true, force: true })
})

describe('独立后端的可信窗口身份映射', () => {
  test('重载同步清理原生投影且仅调用一次，投影异常不阻止页面撤销和其他入口释放', async () => {
    const detached: string[] = []
    const f = open(new Backend(), (id) => { detached.push(id); throw new Error('原生投影夹具故障') })
    const main = await f.store.get(f.main.sender), quick = await f.store.get(f.quick.sender)
    const signal = f.store.getClientSignal(main.clientId)!, other = f.store.getClientSignal(quick.clientId)!
    f.main.emit('did-start-loading'); f.main.emit('did-start-loading')
    expect(detached).toEqual([main.clientId])
    expect(signal.aborted).toBe(true)
    expect(other.aborted).toBe(false)
    f.store.dispose()
    expect(detached).toEqual([main.clientId, quick.clientId])
    expect(other.aborted).toBe(true)
  })

  test('同一页面并发登记共享 Promise，不同窗口隔离；反向查询不创建身份', async () => {
    const f = open()
    const first = f.store.get(f.main.sender), second = f.store.get(f.main.sender)
    expect(first).toBe(second)
    const main = await first, quick = await f.store.get(f.quick.sender)
    expect(f.backend.calls.map((call) => call.client.kind)).toEqual(['main', 'quick'])
    expect(f.store.find(main.clientId)).toBe(f.main.sender)
    expect(f.store.matches(f.quick.sender, main.clientId)).toBe(false)
    expect(main.clientId).not.toBe(quick.clientId)
    expect(f.store.getClientSignal(main.clientId)).toBe(f.store.getClientSignal(main.clientId))
    expect(f.store.find('renderer-forged')).toBeUndefined()
    expect(f.backend.calls).toHaveLength(2)
    expect(await f.store.get(f.main.sender)).toBe(main)
    expect(f.main.listenerCount('did-start-loading')).toBe(1)
  })

  test('重载期间迟到登记注销，不能覆盖新页面；原生监听只安装一次', async () => {
    const backend = new Backend(); backend.deferred = true
    const f = open(backend)
    const old = f.store.get(f.main.sender).then(() => null, (error: unknown) => error)
    const oldCall = backend.calls[0]!
    f.main.emit('did-start-loading')
    expect(oldCall.pageSignal?.aborted).toBe(true)
    const next = f.store.get(f.main.sender)
    const nextCall = backend.calls[1]!
    nextCall.accept()
    const current = await next
    oldCall.accept()
    expect(await old).toMatchObject({ message: '客户端页面已失效' })
    expect(backend.detached).toEqual([oldCall.client.clientId])
    expect(f.store.find(current.clientId)).toBe(f.main.sender)
    expect(f.store.find(oldCall.client.clientId)).toBeUndefined()
    expect(await f.store.get(f.main.sender)).toBe(current)
    expect(f.main.listenerCount('did-start-loading')).toBe(1)
  })

  test('重载/崩溃/销毁立即取消原信号，只注销所属入口；销毁不再登记或保留监听', async () => {
    const f = open(), main = await f.store.get(f.main.sender), quick = await f.store.get(f.quick.sender)
    const old = f.store.getClientSignal(main.clientId)!, quickSignal = f.store.getClientSignal(quick.clientId)!
    f.main.emit('did-start-loading')
    expect(old.aborted).toBe(true)
    expect(quickSignal.aborted).toBe(false)
    expect(f.store.find(main.clientId)).toBeUndefined()
    const next = await f.store.get(f.main.sender), nextSignal = f.store.getClientSignal(next.clientId)!
    f.main.emit('render-process-gone')
    expect(nextSignal.aborted).toBe(true)
    expect(f.store.find(quick.clientId)).toBe(f.quick.sender)
    const last = await f.store.get(f.main.sender)
    f.main.destroyed = true; f.main.emit('destroyed')
    expect(f.store.find(last.clientId)).toBeUndefined()
    expect(f.main.listenerCount('did-start-loading')).toBe(0)
    await expect(f.store.get(f.main.sender)).rejects.toThrow('窗口已关闭')
  })

  test('后端断开取消页面信号，不自动登记；登记结束前断开也不发布失效 ID', async () => {
    const f = open(), main = await f.store.get(f.main.sender)
    const signal = f.store.getClientSignal(main.clientId)!
    f.backend.controllers.get(main.clientId)!.abort()
    expect(signal.aborted).toBe(true)
    expect(f.store.find(main.clientId)).toBeUndefined()
    expect(f.backend.calls).toHaveLength(1)
    const backend = new Backend(); backend.deferred = true
    const pending = open(backend), waiting = pending.store.get(pending.main.sender).then(() => null, (error: unknown) => error)
    const call = backend.calls[0]!
    backend.controllers.get(call.client.clientId)!.abort(); call.accept()
    expect(await waiting).toMatchObject({ message: '后端客户端已失效' })
    expect(pending.store.find(call.client.clientId)).toBeUndefined()
    expect(backend.detached).toEqual([call.client.clientId])
  })

  test('未知窗口拒绝；原生来源在等待期间改变时旧 ID 不获新来源权限，失败登记可显式重试', async () => {
    const backend = new Backend(); backend.deferred = true
    const f = open(backend)
    await expect(f.store.get(f.unknown.sender)).rejects.toThrow('不是已登记')
    expect(backend.calls).toHaveLength(0)
    const old = f.store.get(f.main.sender).then(() => null, (error: unknown) => error)
    f.kinds.set(f.main.sender, 'quick'); backend.calls[0]!.accept()
    expect(await old).toMatchObject({ message: '客户端页面已失效' })
    const failed = f.store.get(f.main.sender).then(() => null, (error: unknown) => error)
    backend.calls[1]!.reject(new Error('受控登记失败'))
    expect(await failed).toMatchObject({ message: '受控登记失败' })
    const next = f.store.get(f.main.sender); backend.calls[2]!.accept()
    const client = await next, signal = f.store.getClientSignal(client.clientId)!
    expect(client.kind).toBe('quick')
    f.kinds.delete(f.main.sender)
    await expect(f.store.get(f.main.sender)).rejects.toThrow('不是已登记')
    expect(signal.aborted).toBe(true)
    expect(f.store.find(client.clientId)).toBeUndefined()
  })

  test('整体释放先取消所有页面，移除监听，迟到身份仍回收；注销失败不复活映射', async () => {
    const f = open(), main = await f.store.get(f.main.sender), signal = f.store.getClientSignal(main.clientId)!
    f.backend.deferred = true
    const waiting = f.store.get(f.quick.sender).then(() => null, (error: unknown) => error)
    f.store.dispose(); f.store.dispose()
    expect(signal.aborted).toBe(true)
    expect(f.main.listenerCount('did-start-loading')).toBe(0)
    expect(f.quick.listenerCount('destroyed')).toBe(0)
    f.backend.calls[1]!.accept()
    expect(await waiting).toMatchObject({ message: '客户端页面已失效' })
    expect(f.backend.detached).toEqual([main.clientId, f.backend.calls[1]!.client.clientId])
    await expect(f.store.get(f.main.sender)).rejects.toThrow('窗口已关闭')
    const failed = open(), client = await failed.store.get(failed.main.sender), old = failed.store.getClientSignal(client.clientId)!
    failed.backend.detachFails = true
    failed.main.emit('did-start-loading')
    expect(old.aborted).toBe(true)
    expect(failed.store.find(client.clientId)).toBeUndefined()
  })

  test('实际 app-server 登记和主/快捷请求共用子进程；页面重载只失效该 owner，断开撤销全部映射', async () => {
    const directory = mkdtempSync(join(tmpdir(), 'axon-window-process-')); directories.push(directory)
    const backend = new AppServerProcess({ credentialCodec: createCredentialCodec(), stopTimeoutMs: 100,
      launch: { executable: process.execPath, entryArgs: [join(import.meta.dir, '../../../../../app-server/src/main.ts')],
        dataDir: join(directory, 'data'), homeDir: directory, applicationVersion: '0.1.3', environment: { ...process.env, AXON_ZIMA_PYTHON: '' } } })
    servers.push(backend)
    const main = new Surface(), quick = new Surface()
    const store = new AppServerWindowClients({ backend, kindOf: (sender) => sender === main.sender ? 'main' : sender === quick.sender ? 'quick' : undefined })
    stores.push(store)
    const [one, two] = await Promise.all([store.get(main.sender), store.get(main.sender)])
    expect(one).toBe(two)
    expect(one.clientId).toMatch(/^[0-9a-f-]{36}$/)
    const shortcut = await store.get(quick.sender), signal = store.getClientSignal(one.clientId)!, other = store.getClientSignal(shortcut.clientId)!
    expect(await backend.request(one.clientId, methods.GET_SETTINGS)).toMatchObject({ quickChatShortcuts: [] })
    main.emit('did-start-loading')
    expect(signal.aborted).toBe(true)
    await expect(backend.request(one.clientId, methods.GET_SETTINGS)).rejects.toThrow('客户端已失效')
    expect(other.aborted).toBe(false)
    expect(await backend.request(shortcut.clientId, methods.PROJECT_LIST)).toEqual([])
    const restored = await store.get(main.sender)
    expect(restored.clientId).not.toBe(one.clientId)
    expect(store.matches(main.sender, one.clientId)).toBe(false)
    await backend.stop()
    expect(store.find(restored.clientId)).toBeUndefined()
    expect(store.find(shortcut.clientId)).toBeUndefined()
    expect(other.aborted).toBe(true)
  })
})
