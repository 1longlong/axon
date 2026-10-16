import { afterEach, describe, expect, test } from 'bun:test'
import { mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { APP_SERVER_METHODS as methods } from '@axon/shared'
import { parseExecArguments, ExecInputError } from './arguments'
import { ExecBackendError, ExecBackendProcess } from './backend-process'
import { createExecChildEnvironment, prepareExec } from './preflight'
import { prepareExecSession } from './session-target'

const cleanups: Array<() => Promise<void>> = []
afterEach(async () => { for (const cleanup of cleanups.splice(0).reverse()) await cleanup() })

/** 配置/工作区/密钥全部隔离；fake 只验证父端协议，省略 mode 才启动真实正式后端。 */
async function fixture(mode?: string, options: { credential?: boolean; executable?: string; startupTimeoutMs?: number } = {}) {
  const root = realpathSync(mkdtempSync(join(tmpdir(), 'axon-exec-parent-')))
  const home = join(root, 'home'), cwd = join(root, 'project')
  mkdirSync(home); mkdirSync(cwd); mkdirSync(join(home, '.axon-exec'))
  const channels = ['selected', 'foreign'].map((id, index) => ({ id, provider: 'custom',
    baseUrl: `http://localhost:${8123 + index}/v1`, defaultModel: 'fixture', models: [{ id: 'fixture' }],
    apiKeyRequired: options.credential !== false,
    ...(options.credential === false ? {} : { apiKey: id === 'selected' ? 'fixture-secret' : 'foreign-secret' }) }))
  writeFileSync(join(home, '.axon-exec', 'config.json'), JSON.stringify({ defaults: {
    channel: 'selected', skills: false, mcp: false, tasks: false, memory: false,
  }, channels }))
  const prepared = await prepareExec(parseExecArguments(['exec', '--skip-git-repo-check', '  原始任务\n']),
    { originalCwd: cwd, homeDir: home, platform: 'darwin', isTTY: true })
  const environment = { ...process.env }
  delete environment.AXON_API_KEY
  environment.AXON_API_KEY = 'ignored-env-secret'
  const childEnvironment = createExecChildEnvironment(environment)
  let entered!: () => void
  const enteredStage = new Promise<void>((resolve) => { entered = resolve })
  const server = new ExecBackendProcess({ prepared, childEnvironment, startupTimeoutMs: options.startupTimeoutMs ?? 5000,
    stopTimeoutMs: mode === 'stubborn' || mode === 'inherited-stdio' ? 100 : 1000,
    configurePeer: (peer) => peer.handleNotification('axon/test/entered', entered),
    ...(mode || options.executable ? { launch: { executable: options.executable ?? process.execPath,
      entryArgs: [join(import.meta.dir, 'test-support', 'backend-fixture.ts'), mode ?? 'normal'] } } : {}) })
  cleanups.push(async () => { await server.stop().catch(() => {}); rmSync(root, { recursive: true, force: true }) })
  return { root, prepared, server, enteredStage }
}

describe('exec 父端独立进程与私有桥', () => {
  test('并发 start 复用握手、只登记 external；配置密钥只交付确切选中渠道，不进入继承环境', async () => {
    const { server } = await fixture('normal')
    const first = server.start()
    expect(server.start()).toBe(first)
    await first
    expect(server.clientId).toBe('external-fixture')
    expect(await server.request(methods.GET_SETTINGS)).toEqual({ clientId: 'external-fixture', initializeCount: 1,
      inheritedKey: null, results: { selected: 'fixture-secret', foreign: 'denied', wrongAddress: 'denied' } })
    expect(server.start()).toBe(first)
    const stop = server.stop()
    expect(server.stop()).toBe(stop)
    await stop
    expect(server.signal.aborted).toBe(true)
    await expect(server.request(methods.GET_SETTINGS)).rejects.toBeInstanceOf(ExecBackendError)
    await expect(server.start()).rejects.toBeInstanceOf(ExecBackendError)
  })

  test('无密钥渠道可取得空字符串，不假造安全存储或共享给其他配置目标', async () => {
    const { server } = await fixture('normal', { credential: false })
    await server.start()
    expect(await server.request(methods.GET_SETTINGS)).toMatchObject({ inheritedKey: null,
      results: { selected: '', foreign: 'denied', wrongAddress: 'denied' } })
    await server.stop()
  })

  test('恢复授权前不交付密钥；授权原渠道后只用它的配置，不用默认渠道或残留环境变量', async () => {
    const { server, prepared } = await fixture('normal')
    prepared.args.kind = 'resume'
    prepared.args.sessionId = 'existing-root'
    await server.start()
    expect(await server.request(methods.GET_SETTINGS)).toMatchObject({
      results: { selected: 'denied', foreign: 'denied', wrongAddress: 'denied' },
    })
    server.authorizeChannel('foreign')
    expect(await server.request(methods.GET_SETTINGS)).toMatchObject({ inheritedKey: null,
      results: { selected: 'denied', foreign: 'foreign-secret', wrongAddress: 'denied' },
    })
    expect(() => server.authorizeChannel('selected')).toThrow(ExecInputError)
    await server.stop()
  })

  test('选中渠道缺密钥时不能借用其他渠道密钥或残留环境变量，不启动后端', async () => {
    const { server, prepared } = await fixture('normal')
    prepared.configuration.channel!.apiKey = ''
    await expect(server.start()).rejects.toThrow('channel.apiKey')
    expect(server.pid).toBeUndefined()
  })

  test('错误版本、stdout 污染和沙箱不足拒绝，不向调用者泄漏原始日志；实际 child 被回收', async () => {
    for (const mode of ['bad-version', 'polluted', 'unsupported']) {
      const { server } = await fixture(mode)
      try { await server.start(); throw new Error('应拒绝启动') }
      catch (error) {
        expect(error).toBeInstanceOf(mode === 'unsupported' ? ExecInputError : ExecBackendError)
        expect((error as Error).message).not.toContain('fixture-secret')
      }
      await server.stop()
      expect(() => process.kill(server.pid!, 0)).toThrow()
    }
  })

  test('启动可取消；握手与身份登记期间的迟到初始化都不成为可用 owner', async () => {
    for (const mode of ['stall-initialize', 'stall-register']) {
      const { server, enteredStage } = await fixture(mode)
      const started = server.start()
      // 立即附加拒绝处理，避免取消期间出现未处理 Promise；stop 不等待握手返回。
      const outcome = started.then(() => 'ready', () => 'canceled')
      await enteredStage
      await server.stop()
      expect(await outcome).toBe('canceled')
      expect(server.clientId).toBeUndefined()
      expect(() => process.kill(server.pid!, 0)).toThrow()
    }
  })

  test('握手/登记超时均收束自有 child，缺少必需凭据在 spawn 前拒绝', async () => {
    for (const mode of ['stall-initialize', 'stall-register']) {
      const { server } = await fixture(mode, { startupTimeoutMs: 200 })
      await expect(server.start()).rejects.toMatchObject({ code: 'startup' })
      await server.stop()
      expect(server.clientId).toBeUndefined()
      expect(() => process.kill(server.pid!, 0)).toThrow()
    }
    const { server, prepared } = await fixture('normal', { credential: false })
    prepared.configuration.channel!.apiKeyRequired = true
    await expect(server.start()).rejects.toBeInstanceOf(ExecInputError)
    expect(server.pid).toBeUndefined()
    await server.stop()
  })

  test('spawn 失败明确收束、不重建、不泄漏执行器原始异常', async () => {
    const { server } = await fixture('normal', { executable: '/axon-fixture-does-not-exist' })
    await expect(server.start()).rejects.toMatchObject({ code: 'startup' })
    await expect(server.stop()).rejects.toMatchObject({ code: 'shutdown' })
    expect(server.pid).toBeUndefined()
  })

  test('运行时 child 异常结束、非零 EOF 与强制 TERM/KILL 都不能算正常清理', async () => {
    for (const mode of ['crash', 'shutdown-nonzero', 'stubborn']) {
      const { server } = await fixture(mode)
      await server.start()
      if (mode === 'crash') await expect(server.request(methods.GET_SETTINGS)).rejects.toThrow()
      await expect(server.stop()).rejects.toMatchObject({ code: 'shutdown' })
      expect(server.signal.aborted).toBe(true)
      expect(() => process.kill(server.pid!, 0)).toThrow()
    }
  })

  test('直接 child 已退出但后代仍持有 stdio 时有界失败，不假称后代已收束', async () => {
    const { server } = await fixture('inherited-stdio')
    await server.start()
    const begin = performance.now()
    await expect(server.stop()).rejects.toMatchObject({ code: 'shutdown' })
    expect(performance.now() - begin).toBeLessThan(550)
    expect(() => process.kill(server.pid!, 0)).toThrow()
    // 测试自有后代有 600ms 自退期限；正式父端不声称可以回收任意异常后代。
    await new Promise<void>((resolve) => setTimeout(resolve, 650))
  })

  test.skipIf(process.platform !== 'darwin')('真实后端握手/external/无密钥持久化/独占拒绝/EOF 后重新取锁', async () => {
    const { server, prepared } = await fixture()
    const initialized = await server.start()
    expect(initialized.dataDirectory).toBe(prepared.dataDir)
    expect(server.clientId).toBeString()
    expect(await server.request(methods.CHANNEL_LIST)).toMatchObject([{ id: 'selected', hasApiKey: false }, { id: 'foreign', hasApiKey: false }])
    const channelsBefore = readFileSync(join(prepared.dataDir, 'channels.json'), 'utf8')
    expect(channelsBefore).not.toContain('fixture-secret')
    const firstTarget = await prepareExecSession(server, prepared)
    const secondTarget = await prepareExecSession(server, prepared)
    expect(secondTarget.project.id).toBe(firstTarget.project.id)
    expect(secondTarget.session.id).not.toBe(firstTarget.session.id)
    expect(firstTarget.session).toMatchObject({ sandboxMode: 'readOnly', approvalPolicy: 'never', userInputPolicy: 'reject' })
    expect(firstTarget.prompt).toBe('  原始任务\n')
    expect(await server.request(methods.PROJECT_LIST)).toHaveLength(1)
    expect(await server.request(methods.AGENT_LIST_SESSIONS)).toHaveLength(2)
    const childEnvironment = createExecChildEnvironment({ ...process.env, AXON_API_KEY: 'ignored-secret' })
    const competitor = new ExecBackendProcess({ prepared, childEnvironment, startupTimeoutMs: 5000, stopTimeoutMs: 1000 })
    cleanups.push(() => competitor.stop())
    await expect(competitor.start()).rejects.toMatchObject({ code: 'busy' })
    expect(readFileSync(join(prepared.dataDir, 'channels.json'), 'utf8')).toBe(channelsBefore)
    await server.stop()
    const next = new ExecBackendProcess({ prepared, childEnvironment, startupTimeoutMs: 5000, stopTimeoutMs: 1000 })
    cleanups.push(() => next.stop())
    await next.start()
    await next.stop()
  })
})
