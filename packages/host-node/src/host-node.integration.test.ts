import { expect, test } from 'bun:test'
import { existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, realpathSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { buildAgentSandboxPolicy } from '@axon/core'
import { AgentSandboxEscalationError } from '@axon/shared'
import type { AgentSandboxShellCommandRequest } from '@axon/shared'
import { AgentSandboxCommandService, detectSeatbeltCapability } from './index'

/** 独立 Bun 进程调用包入口，验证真实 Seatbelt；启动配置与输出均局限于隔离目录。 */
test.skipIf(process.platform !== 'darwin')('非 Electron 宿主：真实沙箱、精确授权、快照恢复和释放', async () => {
  expect(process.versions.electron).toBeUndefined()
  const capability = detectSeatbeltCapability()
  expect(capability.available).toBe(true)
  const directory = realpathSync(mkdtempSync(join(tmpdir(), 'axon-host-node-')))
  const cwd = join(directory, 'workspace')
  const home = join(directory, 'home')
  const cache = join(directory, 'snapshots')
  mkdirSync(cwd)
  mkdirSync(home)
  writeFileSync(join(home, '.zshrc'), 'export AXON_HOST_FIXTURE="快照恢复"\n')
  const service = new AgentSandboxCommandService({ capability, shellSnapshotDirectory: cache,
    resolveShell: () => ({ type: 'zsh', path: '/bin/zsh' }),
    shellInitializationEnvironment: { HOME: home, ZDOTDIR: home, PATH: '/usr/bin:/bin', LANG: 'en_US.UTF-8' },
  })
  const environment = service.initializeShellEnvironment({ sessionId: 'fixture', cwd })
  const request = (command: string): AgentSandboxShellCommandRequest => ({
    command, cwd, policy: buildAgentSandboxPolicy({ projectRoot: cwd, mode: 'workspaceWrite' }), grants: [],
    environment: { HOME: home, ZDOTDIR: home, LANG: 'en_US.UTF-8' }, environmentOverrides: {}, timeoutMs: 2_000,
  })
  try {
    // 仅测试等待隔离预热；生产工具仍不等待快照就绪。
    const deadline = Date.now() + 5_000
    while (!existsSync(cache) && Date.now() < deadline) await Bun.sleep(10)
    let restored = ''
    while (Date.now() < deadline) {
      restored = (await environment.executeShellCommand(request('printf %s "$AXON_HOST_FIXTURE"'))).stdout
      if (restored === '快照恢复') break
      await Bun.sleep(10)
    }
    expect(restored).toBe('快照恢复')
    expect((await environment.executeShellCommand(request('printf workspace > result.txt'))).exitCode).toBe(0)
    expect(readFileSync(join(cwd, 'result.txt'), 'utf8')).toBe('workspace')
    const outside = join(directory, 'outside.txt')
    const outsideRequest = request(`printf allowed > '${outside}'`)
    let escalation: AgentSandboxEscalationError | undefined
    try { await environment.executeShellCommand(outsideRequest) }
    catch (error) { if (!(error instanceof AgentSandboxEscalationError)) throw error; escalation = error }
    expect(escalation?.escalation.permission).toEqual({ type: 'filesystemWrite', roots: [outside] })
    expect(existsSync(outside)).toBe(false)
    if (!escalation) throw new Error('真实沙箱未产生精确升级请求')
    const approved = await environment.executeShellCommand({ ...outsideRequest, grants: [{
      scope: 'once', permission: escalation.escalation.permission,
    }] })
    expect(approved.exitCode).toBe(0)
    expect(readFileSync(outside, 'utf8')).toBe('allowed')
    await expect(environment.executeShellCommand(outsideRequest)).rejects.toBeInstanceOf(AgentSandboxEscalationError)
    const stop = new AbortController()
    const stopped = await environment.executeShellCommand({
      ...request('printf ready; /bin/sleep 30'), abortSignal: stop.signal,
    }, { onStdout: () => stop.abort() })
    expect(stopped.aborted).toBe(true)
    expect(stopped.timedOut).toBe(false)
  } finally {
    environment.dispose()
    service.dispose()
    await Promise.all([environment.drain(), service.drain()])
    if (existsSync(cache)) expect(readdirSync(cache)).toEqual([])
    rmSync(directory, { recursive: true, force: true })
  }
  expect(existsSync(cache)).toBe(false)
}, 10_000)

test.skipIf(process.platform !== 'darwin')('真实 Seatbelt：宿主退出等待忽略 TERM 的 Shell 实际 close', async () => {
  const capability = detectSeatbeltCapability()
  expect(capability.available).toBe(true)
  const directory = realpathSync(mkdtempSync(join(tmpdir(), 'axon-host-seatbelt-drain-')))
  const service = new AgentSandboxCommandService({ capability, shellSnapshotDirectory: join(directory, 'snapshots'), killGraceMs: 100 })
  const started = Promise.withResolvers<number>()
  const command = service.executeCommand({
    argv: ['/bin/sh', '-c', 'trap "" TERM; printf "%s\\n" "$$"; while :; do /bin/sleep 1; done'],
    cwd: directory, policy: buildAgentSandboxPolicy({ projectRoot: directory, mode: 'workspaceWrite' }), grants: [], timeoutMs: 3_000,
  }, { onStdout: (text) => started.resolve(Number(text.trim())) })
  try {
    const pid = await started.promise
    expect(pid > 0).toBe(true)
    process.kill(pid, 0)
    service.dispose()
    let drained = false
    const draining = service.drain().then(() => { drained = true })
    await Bun.sleep(20)
    expect(drained).toBe(false)
    const result = await command
    await draining
    expect(result).toMatchObject({ aborted: true, timedOut: false })
    let error: unknown
    try { process.kill(pid, 0) } catch (caught) { error = caught }
    expect(error).toMatchObject({ code: 'ESRCH' })
  } finally {
    service.dispose()
    await Promise.all([service.drain(), command])
    rmSync(directory, { recursive: true, force: true })
  }
}, 5_000)
