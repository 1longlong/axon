import { afterEach, describe, expect, test } from 'bun:test'
import { mkdtempSync, readFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { createCredentialCodec } from '@axon/core'
import { createFixtureCredentialCodec } from '../../../../../../packages/core/test-support/credential-codec'
import { APP_SERVER_METHODS as methods } from '@axon/shared'
import type { Channel } from '@axon/shared'
import { AppServerProcess } from './app-server-process'
import type { AppServerProcessOptions, AppServerProcessState } from './app-server-process'

const processes: AppServerProcess[] = [], directories: string[] = []
function open(options: Partial<AppServerProcessOptions> = {}, fixture?: string) {
  const directory = mkdtempSync(join(tmpdir(), 'axon-desktop-process-'))
  directories.push(directory)
  const states: AppServerProcessState[] = []
  const server = new AppServerProcess({ credentialCodec: createCredentialCodec(), ...options,
    launch: { executable: process.execPath,
      entryArgs: [fixture ? join(import.meta.dir, '../../../../test-support/app-server-process-fixture.ts')
        : join(import.meta.dir, '../../../../../app-server/src/main.ts')],
      dataDir: join(directory, 'data'), homeDir: directory, applicationVersion: '0.1.3',
      environment: { ...process.env, AXON_ZIMA_PYTHON: '', ...(fixture ? { AXON_PROCESS_TEST_MODE: fixture } : {}) }, ...options.launch },
    onState: (state) => { states.push(state); options.onState?.(state) }, stopTimeoutMs: options.stopTimeoutMs ?? 100,
  })
  processes.push(server)
  return { server, states, directory, data: join(directory, 'data') }
}
function gone(pid: number | undefined): boolean {
  if (pid === undefined) return true
  try { process.kill(pid, 0); return false }
  catch (error) { return (error as NodeJS.ErrnoException).code === 'ESRCH' }
}
afterEach(async () => {
  for (const server of processes.splice(0)) await server.stop().catch(() => {}) // 非正常退出由具体测试断言，仍清理剩余实例。
  for (const path of directories.splice(0)) rmSync(path, { recursive: true, force: true })
})

describe('桌面独立后端进程管理', () => {
  test('并发启动同一实际子进程，握手后登记主/快捷身份；先失效后注销且不关闭其他入口', async () => {
    const f = open()
    const [first, second] = await Promise.all([f.server.start(), f.server.start()])
    expect(first).toBe(second)
    expect(f.server.pid).toBeNumber()
    expect(f.server.pid).not.toBe(process.pid)
    expect(first.dataDirectory).toBe(f.data)
    expect(f.states).toEqual(['starting', 'ready'])
    const main = await f.server.registerClient('main'), quick = await f.server.registerClient('quick')
    expect(main.clientId).not.toBe(quick.clientId)
    const mainSignal = f.server.getClientSignal(main.clientId)!, quickSignal = f.server.getClientSignal(quick.clientId)!
    expect(await f.server.request(main.clientId, methods.GET_SETTINGS)).toMatchObject({ quickChatShortcuts: [] })
    expect(await f.server.detachClient(main.clientId)).toBe(true)
    expect(mainSignal.aborted).toBe(true)
    expect(quickSignal.aborted).toBe(false)
    await expect(f.server.request(main.clientId, methods.GET_SETTINGS)).rejects.toThrow('客户端已失效')
    await expect(f.server.request('renderer-forged', methods.GET_SETTINGS)).rejects.toThrow('客户端已失效')
    expect(await f.server.request(quick.clientId, methods.PROJECT_LIST)).toEqual([])
    await f.server.stop()
    expect(quickSignal.aborted).toBe(true)
    expect(f.server.state).toBe('stopped')
    expect(gone(f.server.pid)).toBe(true)
  })

  test('父端私有凭据桥处理实际渠道写入，不在 argv/文件中保存明文；无安全存储拒绝非空密钥', async () => {
    const codec = createFixtureCredentialCodec(), f = open({ credentialCodec: codec })
    const initialized = await f.server.start(), main = await f.server.registerClient('main')
    expect(initialized.capabilities.credentialStorage).toBe('safe-storage')
    const secret = 'sk-parent-process-test'
    const channel = await f.server.request(main.clientId, methods.CHANNEL_CREATE, { name: '私有凭据', provider: 'openai', apiKey: secret,
      baseUrl: 'https://api.openai.com/v1', models: [] }) as unknown as Channel
    expect(channel.hasApiKey).toBe(true)
    expect(JSON.stringify(channel)).not.toContain(secret)
    const file = readFileSync(join(f.data, 'channels.json'), 'utf8')
    expect(file).toContain('secure:v1:')
    expect(file).not.toContain(secret)
    const unavailable = open(), client = await unavailable.server.registerClient('main')
    await expect(unavailable.server.request(client.clientId, methods.CHANNEL_CREATE,
      { name: '不可保存', provider: 'openai', apiKey: secret, baseUrl: 'https://api.openai.com/v1', models: [] })).rejects.toMatchObject({ code: -32022 })
  })

  test('实际私有目标确认绑定原入口：注销撤销等待，迟到允许不再交付或联网', async () => {
    let confirm!: () => void, approve!: (allowed: boolean) => void, owner = '', url = '', confirmationSignal: AbortSignal | undefined
    const prompted = new Promise<void>((done) => { confirm = done })
    const f = open({ confirmChannelTarget: (id, target, signal) => {
      owner = id; url = target; confirmationSignal = signal; confirm()
      return new Promise<boolean>((done) => { approve = done })
    } })
    const main = await f.server.registerClient('main'), quick = await f.server.registerClient('quick')
    const pending = f.server.request(main.clientId, methods.CHANNEL_REQUEST, { requestId: 'owner-confirmation',
      operation: 'models', provider: 'custom', baseUrl: 'http://127.0.0.1:1/v1', apiKey: '' }, { timeoutMs: 0 })
    const settled = pending.then(() => null, (error: unknown) => error)
    await prompted
    expect(owner).toBe(main.clientId)
    expect(url).toBe('http://127.0.0.1:1/v1/models')
    expect(confirmationSignal?.aborted).toBe(false)
    await f.server.detachClient(main.clientId)
    expect(confirmationSignal?.aborted).toBe(true)
    approve(true)
    expect(await settled).toMatchObject({ code: 'canceled' })
    expect(await f.server.request(quick.clientId, methods.PROJECT_LIST)).toEqual([])
  })

  test('登记期间页面取消，迟到 ID 注销；预取消不创建身份，其他身份仍可请求', async () => {
    let registered!: () => void
    const accepted = new Promise<void>((done) => { registered = done })
    const f = open({ configurePeer: (peer) => peer.handleNotification('axon/test/client-registered', registered) }, 'late-registration')
    const controller = new AbortController()
    await f.server.start()
    const registration = f.server.registerClient('main', controller.signal)
    // 取消发生在登记链的异步等待中，不取消读取响应以便回收服务器生成的 ID。
    await accepted
    controller.abort()
    await expect(registration).rejects.toThrow()
    const quick = await f.server.registerClient('quick')
    expect(await f.server.request(quick.clientId, methods.CHANNEL_LIST)).toEqual([quick.clientId])
    await expect(f.server.registerClient('main', controller.signal)).rejects.toThrow()
    expect(await f.server.request(quick.clientId, methods.CHANNEL_LIST)).toEqual([quick.clientId])
  })

  test('崩溃拒绝长请求并撤销所有身份，不自动重建或重投；stop 等待真实 PID 消失', async () => {
    const f = open({}, 'crash'), client = await f.server.registerClient('main')
    const signal = f.server.getClientSignal(client.clientId)!, pid = f.server.pid
    await expect(f.server.request(client.clientId, methods.AGENT_SEND, { text: '不重发' }, { timeoutMs: 0 })).rejects.toThrow()
    await expect(f.server.stop()).rejects.toThrow('后端未正常退出')
    expect(f.server.state).toBe('stopped')
    expect(signal.aborted).toBe(true)
    expect(f.states).toContain('unavailable')
    expect(f.server.pid).toBe(pid)
    expect(gone(pid)).toBe(true)
    await expect(f.server.start()).rejects.toThrow('不可用')
  })

  test('不配合 EOF/TERM 的自有进程有界退出；注销取消本地长请求，不重发', async () => {
    const f = open({}, 'ignore-eof'), client = await f.server.registerClient('main')
    const pending = f.server.request(client.clientId, methods.AGENT_SEND, {}, { timeoutMs: 0 })
    const settled = pending.then(() => null, (error: unknown) => error)
    await f.server.detachClient(client.clientId)
    expect(await settled).toMatchObject({ code: 'canceled' })
    await expect(f.server.stop()).rejects.toThrow('后端未正常退出')
    expect(f.server.state).toBe('stopped')
    expect(gone(f.server.pid)).toBe(true)
  })

  test('正常请求停止但子端报告清理失败，实际 close 后仍拒绝 stop，重复调用共享失败结果', async () => {
    const f = open({}, 'failed-shutdown')
    await f.server.registerClient('main')
    const stopped = f.server.stop()
    expect(f.server.stop()).toBe(stopped)
    await expect(stopped).rejects.toThrow('后端未正常退出')
    expect(f.server.state).toBe('stopped')
    expect(gone(f.server.pid)).toBe(true)
    await expect(f.server.stop()).rejects.toThrow('后端未正常退出')
  })

  test('错误响应版本/污染协议或可执行文件缺失均失败关闭，不加载进程内后端', async () => {
    for (const mode of ['bad-version', 'pollution']) {
      const f = open({}, mode)
      await expect(f.server.start()).rejects.toThrow('后端启动失败')
      await f.server.stop()
      expect(f.states).not.toContain('ready')
      expect(gone(f.server.pid)).toBe(true)
    }
    const directory = mkdtempSync(join(tmpdir(), 'axon-missing-executor-'))
    directories.push(directory)
    const server = new AppServerProcess({ launch: { executable: join(directory, 'not-present'), entryArgs: [], dataDir: join(directory, 'data'),
      homeDir: directory, applicationVersion: '0.1.3' }, credentialCodec: createCredentialCodec(), stopTimeoutMs: 100 })
    processes.push(server)
    await expect(server.start()).rejects.toThrow('后端启动失败')
    await server.stop()
    expect(gone(server.pid)).toBe(true)
  })

  test('已经收到但不返回的握手按期限失效，等待真实子进程退出后报告固定启动错误', async () => {
    let entered!: () => void
    const received = new Promise<void>((done) => { entered = done })
    const f = open({ startupTimeoutMs: 500, configurePeer: (peer) => peer.handleNotification('axon/test/init-hanging', entered) }, 'init-hang')
    const failed = f.server.start().then(() => null, (error: unknown) => error)
    await received
    expect(await failed).toMatchObject({ message: '后端启动失败或连接不可用' })
    expect(f.states).not.toContain('ready')
    expect(gone(f.server.pid)).toBe(true)
    await expect(f.server.start()).rejects.toThrow('不可用')
  })

  test('状态回调中退出不会在取消后再启动子进程，重复 stop 使用同一清理 Promise', async () => {
    let nestedStop: Promise<void> | undefined
    const f = open({ onState: (state) => {
      if (state === 'starting' || state === 'stopping') nestedStop = f.server.stop()
    } }, 'ignore-eof')
    await expect(f.server.start()).rejects.toThrow('启动已中断')
    expect(f.server.pid).toBeUndefined()
    expect(f.server.stop()).toBe(nestedStop!)
    await nestedStop
    expect(f.states).toEqual(['starting', 'stopping', 'stopped'])
    const ready = open({ onState: (state) => { if (state === 'ready') void ready.server.stop() } }, 'ignore-eof')
    await expect(ready.server.start()).rejects.toThrow('后端启动失败')
    expect(gone(ready.server.pid)).toBe(true)
  })
})
