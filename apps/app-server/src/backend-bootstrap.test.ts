import { afterEach, expect, spyOn, test } from 'bun:test'
import { PassThrough } from 'node:stream'
import { existsSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { AgentDelegationManager } from '@axon/core'
import { AppServerBootstrapCleanupError, JsonRpcPeer } from '@axon/app-server'
import { AgentSandboxCommandService } from '@axon/host-node'
import { PiAgentAdapter, ZimaAgentAdapter } from '@axon/runtime-adapters'
import type { AppServerInitializeInput } from '@axon/shared'
import { bootstrapAppServerBackend } from './backend-bootstrap'

const initialize: AppServerInitializeInput = { protocolVersion: 1, client: { name: 'axon-bootstrap-fixture', version: '0.1.3' },
  hostCapabilities: { credentialStorage: 'unavailable', channelTargetConfirmation: false } }
const cleanups: Array<() => void | Promise<void>> = []
afterEach(async () => { for (const cleanup of cleanups.splice(0).reverse()) await cleanup() })

/** 实际装配工厂和资源对象；只把 drain 返回时机延迟，不替换任何业务/SDK 类型。 */
function fixture() {
  const directory = mkdtempSync(join(tmpdir(), 'axon-bootstrap-drain-'))
  const input = new PassThrough(), output = new PassThrough()
  output.resume()
  const peer = new JsonRpcPeer(input, output)
  const config = { dataDir: join(directory, 'data'), homeDir: directory, applicationVersion: '0.1.3' }
  cleanups.push(() => { peer.close(); input.destroy(); output.destroy(); rmSync(directory, { recursive: true, force: true }) })
  return { directory, config, peer }
}

function gate() {
  let release!: () => void
  const promise = new Promise<void>((done) => { release = done })
  cleanups.push(release)
  return { promise, release }
}

async function expectPending(promise: Promise<unknown>): Promise<void> {
  let settled = false
  void promise.then(() => { settled = true }, () => { settled = true })
  await new Promise<void>((done) => setTimeout(done, 0))
  expect(settled).toBe(false)
}

test('真实入口移交 Pi、未配置且未解析的 Zima 和宿主，后端 drain 等全部资源', async () => {
  const f = fixture(), piGate = gate(), zimaGate = gate(), hostGate = gate()
  const actualPi = PiAgentAdapter.prototype.drain, actualZima = ZimaAgentAdapter.prototype.drain
  const actualHost = AgentSandboxCommandService.prototype.drain
  const pi = spyOn(PiAgentAdapter.prototype, 'drain').mockImplementation(async function (this: PiAgentAdapter) { await actualPi.call(this); await piGate.promise })
  const zima = spyOn(ZimaAgentAdapter.prototype, 'drain').mockImplementation(async function (this: ZimaAgentAdapter) { await actualZima.call(this); await zimaGate.promise })
  const host = spyOn(AgentSandboxCommandService.prototype, 'drain').mockImplementation(async function (this: AgentSandboxCommandService) { await actualHost.call(this); await hostGate.promise })
  cleanups.push(() => { pi.mockRestore(); zima.mockRestore(); host.mockRestore() })
  const result = await bootstrapAppServerBackend(f.peer, initialize, f.config, new AbortController().signal)
  try {
    expect(result.capabilities.runtimes.find((item) => item.runtimeId === 'zima')?.configured).toBe(false)
    expect(() => result.backend.getAdapter('zima')).toThrow('受控解释器')
    result.backend.dispose()
    const draining = result.backend.drain()
    await expectPending(draining)
    expect(pi).toHaveBeenCalledTimes(1); expect(zima).toHaveBeenCalledTimes(1); expect(host).toHaveBeenCalledTimes(1)
    piGate.release(); hostGate.release()
    await expectPending(draining)
    zimaGate.release()
    await draining
    expect(result.backend.drain()).toBe(draining)
  } finally { piGate.release(); zimaGate.release(); hostGate.release(); result.backend.dispose(); await result.backend.drain() }
})

for (const stage of ['factory', 'post-factory'] as const) {
  test(`${stage} 装配失败：返回失败前等待包括未使用 Zima 的真实资源清理`, async () => {
    const f = fixture(), finish = gate(), entered = gate()
    if (stage === 'factory') writeFileSync(f.config.dataDir, '阻止目录初始化')
    else {
      const failure = spyOn(AgentDelegationManager.prototype, 'markRunningDelegationsAsInterrupted')
        .mockImplementation(() => { throw new Error('初始化失败') })
      cleanups.push(() => failure.mockRestore())
    }
    const original = ZimaAgentAdapter.prototype.drain
    const pending = spyOn(ZimaAgentAdapter.prototype, 'drain').mockImplementation(async function (this: ZimaAgentAdapter) {
      entered.release(); await original.call(this); await finish.promise
    })
    const piDisposed = spyOn(PiAgentAdapter.prototype, 'dispose')
    const hostDisposed = spyOn(AgentSandboxCommandService.prototype, 'dispose')
    cleanups.push(() => { pending.mockRestore(); piDisposed.mockRestore(); hostDisposed.mockRestore() })
    const creating = bootstrapAppServerBackend(f.peer, initialize, f.config, new AbortController().signal)
      .catch((reason: unknown) => reason)
    try {
      await entered.promise
      await expectPending(creating)
      expect(piDisposed).toHaveBeenCalledTimes(1)
      expect(hostDisposed).toHaveBeenCalledTimes(1)
      finish.release()
      expect(await creating).toBeInstanceOf(Error)
    } finally { finish.release(); await creating }
  })
}

test('工厂未返回时同步/异步清理失败不跳过其他资源，最终错误脱敏', async () => {
  const f = fixture(), finish = gate(), entered = gate()
  writeFileSync(f.config.dataDir, '阻止目录初始化')
  const piDisposed = spyOn(PiAgentAdapter.prototype, 'dispose').mockImplementation(() => { throw new Error('sk-sync-secret') })
  const zimaDrain = spyOn(ZimaAgentAdapter.prototype, 'drain').mockImplementation(() => { throw new Error('sk-async-secret') })
  const actualHost = AgentSandboxCommandService.prototype.drain
  const host = spyOn(AgentSandboxCommandService.prototype, 'drain').mockImplementation(async function (this: AgentSandboxCommandService) {
    entered.release(); await actualHost.call(this); await finish.promise
  })
  cleanups.push(() => { piDisposed.mockRestore(); zimaDrain.mockRestore(); host.mockRestore() })
  const creating = bootstrapAppServerBackend(f.peer, initialize, f.config, new AbortController().signal).catch((reason: unknown) => reason)
  try {
    await entered.promise
    await expectPending(creating)
    expect(piDisposed).toHaveBeenCalledTimes(1); expect(zimaDrain).toHaveBeenCalledTimes(1)
    finish.release()
    expect(await creating).toMatchObject({ message: '后端装配资源清理失败' })
    expect(await creating).toBeInstanceOf(AppServerBootstrapCleanupError)
  } finally { finish.release(); await creating }
})

test('进入装配前已取消，不创建业务目录或任何资源', async () => {
  const f = fixture()
  const disposed = spyOn(AgentSandboxCommandService.prototype, 'dispose')
  cleanups.push(() => disposed.mockRestore())
  const controller = new AbortController(); controller.abort()
  await expect(bootstrapAppServerBackend(f.peer, initialize, f.config, controller.signal)).rejects.toMatchObject({ name: 'AbortError' })
  expect(existsSync(f.config.dataDir)).toBe(false)
  expect(disposed).not.toHaveBeenCalled()
})

test('工厂已返回后装配失败，真实 backend drain 失败使用固定生命周期标记', async () => {
  const f = fixture()
  const initialization = spyOn(AgentDelegationManager.prototype, 'markRunningDelegationsAsInterrupted')
    .mockImplementation(() => { throw new Error('sk-initialization-secret') })
  const original = ZimaAgentAdapter.prototype.drain
  const cleanup = spyOn(ZimaAgentAdapter.prototype, 'drain').mockImplementation(async function (this: ZimaAgentAdapter) {
    await original.call(this)
    throw new Error('sk-cleanup-secret')
  })
  cleanups.push(() => { initialization.mockRestore(); cleanup.mockRestore() })
  const error = await bootstrapAppServerBackend(f.peer, initialize, f.config, new AbortController().signal)
    .catch((reason: unknown) => reason)
  expect(error).toBeInstanceOf(AppServerBootstrapCleanupError)
  expect(error).toMatchObject({ message: '后端装配资源清理失败' })
  expect(cleanup).toHaveBeenCalledTimes(1)
})
