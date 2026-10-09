import { expect, spyOn, test } from 'bun:test'
import { existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, realpathSync, rmSync, writeFileSync } from 'node:fs'
import * as fs from 'node:fs/promises'
import type { FileHandle } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { buildAgentSandboxPolicy } from '@axon/core'
import type { AgentSandboxCommandRequest, AgentSandboxFileContext } from '@axon/shared'
import { AgentSandboxCommandService } from './agent-sandbox-command-service'

function gate<T = void>() {
  let resolve!: (value: T) => void
  const promise = new Promise<T>((done) => { resolve = done })
  return { promise, resolve }
}

/** 仅在隔离目录执行真实 Shell；包装器不提供 Seatbelt，原生保护另由集成测试验证。 */
function fixture() {
  const directory = realpathSync(mkdtempSync(join(tmpdir(), 'axon-host-drain-')))
  const workspace = join(directory, 'workspace'), home = join(directory, 'home'), cache = join(directory, 'snapshots')
  mkdirSync(workspace); mkdirSync(home)
  const executable = join(directory, 'sandbox-fixture.sh')
  writeFileSync(executable, '#!/bin/sh\nshift\nshift\nexec "$@"\n', { mode: 0o700 })
  const service = new AgentSandboxCommandService({ shellSnapshotDirectory: cache,
    capability: { available: true, executablePath: executable }, killGraceMs: 100,
    resolveShell: () => ({ type: 'zsh', path: '/bin/zsh' }),
    shellInitializationEnvironment: { HOME: home, ZDOTDIR: home, PATH: '/usr/bin:/bin' },
  })
  const policy = buildAgentSandboxPolicy({ projectRoot: workspace, mode: 'workspaceWrite' })
  const context: AgentSandboxFileContext = { policy, grants: [] }
  const request = (command: string): AgentSandboxCommandRequest => ({
    argv: ['/bin/sh', '-c', command], cwd: workspace, policy, grants: [], timeoutMs: 5_000,
  })
  return { directory, workspace, home, cache, service, context, request }
}

async function assertGone(pid: number): Promise<void> {
  let error: unknown
  try { process.kill(pid, 0) } catch (caught) { error = caught }
  expect(error).toMatchObject({ code: 'ESRCH' })
}

test('宿主退出等待忽略 TERM 的命令和已释放引用的预热，真实 PID 消失才结束', async () => {
  const f = fixture(), commandStarted = gate<number>()
  const prewarmPid = join(f.home, 'prewarm-pid')
  writeFileSync(join(f.home, '.zshrc'), 'trap "" TERM\nprintf "%s" "$$" > "$HOME/prewarm-pid"\nwhile :; do /bin/sleep 1; done\n')
  const environment = f.service.initializeShellEnvironment({ sessionId: 'fixture', cwd: f.workspace })
  const command = f.service.executeCommand(f.request('trap "" TERM; printf "%s\\n" "$$"; while :; do /bin/sleep 1; done'),
    { onStdout: (text) => commandStarted.resolve(Number(text.trim())) })
  try {
    const commandPid = await commandStarted.promise
    const deadline = Date.now() + 2_000
    while (!existsSync(prewarmPid) && Date.now() < deadline) await Bun.sleep(5)
    expect(existsSync(prewarmPid)).toBe(true)
    const snapshotPid = Number(readFileSync(prewarmPid, 'utf8'))
    expect(commandPid > 0 && snapshotPid > 0).toBe(true)
    environment.dispose()
    f.service.dispose()
    let drained = false
    const draining = f.service.drain().then(() => { drained = true })
    await Bun.sleep(20)
    expect(drained).toBe(false)
    expect((await command).aborted).toBe(true)
    await draining
    await environment.drain()
    await assertGone(commandPid)
    await assertGone(snapshotPid)
    expect(!existsSync(f.cache) || readdirSync(f.cache).length === 0).toBe(true)
    expect(() => f.service.initializeShellEnvironment({ sessionId: 'late', cwd: f.workspace })).toThrow('已释放')
    await expect(f.service.executeCommand(f.request('printf late'))).rejects.toThrow('已释放')
    await expect(f.service.readFile(prewarmPid, f.context)).rejects.toThrow('已释放')
    await expect(environment.executeShellCommand({ ...f.request('true'), command: 'true' })).rejects.toThrow('已释放')
  } finally {
    environment.dispose(); f.service.dispose()
    await Promise.all([f.service.drain(), environment.drain(), command])
    rmSync(f.directory, { recursive: true, force: true })
  }
}, 8_000)

test('单个 Shell 环境释放取消自己的命令，不关闭另一环境和全局工具', async () => {
  const f = fixture(), started = gate()
  const first = f.service.initializeShellEnvironment({ sessionId: 'first', cwd: f.workspace })
  const second = f.service.initializeShellEnvironment({ sessionId: 'second', cwd: f.workspace })
  const command = first.executeShellCommand({ ...f.request('unused'), command: 'printf ready; /bin/sleep 30', login: false },
    { onStdout: () => started.resolve() })
  try {
    await started.promise
    first.dispose()
    await first.drain()
    expect((await command).aborted).toBe(true)
    expect((await second.executeShellCommand({ ...f.request('unused'), command: 'printf second', login: false })).stdout).toBe('second')
    expect((await f.service.executeCommand(f.request('printf global'))).stdout).toBe('global')
    await expect(first.executeShellCommand({ ...f.request('unused'), command: 'true' })).rejects.toThrow('已释放')
  } finally {
    first.dispose(); second.dispose(); f.service.dispose()
    await Promise.all([f.service.drain(), first.drain(), second.drain(), command])
    rmSync(f.directory, { recursive: true, force: true })
  }
})

test('原生文件读取忽略取消时仍纳入 drain，迟到内容不返回；退出后不启动下一次文件操作', async () => {
  const f = fixture(), finish = gate<Buffer<ArrayBuffer>>()
  const read = spyOn(fs, 'readFile').mockReturnValueOnce(finish.promise)
  const operation = f.service.readFile(join(f.workspace, 'late.txt'), f.context).catch((error: unknown) => error)
  try {
    expect(read).toHaveBeenCalledTimes(1)
    f.service.dispose()
    let drained = false
    const draining = f.service.drain().then(() => { drained = true })
    await Bun.sleep(10)
    expect(drained).toBe(false)
    await expect(f.service.statPath(f.workspace, f.context)).rejects.toThrow('已释放')
    finish.resolve(Buffer.from('不能交付的迟到内容'))
    expect(await operation).toMatchObject({ code: 'invalidRequest', message: '文件操作已取消' })
    await draining
    expect(read).toHaveBeenCalledTimes(1)
  } finally {
    finish.resolve(Buffer.alloc(0)); f.service.dispose()
    await Promise.all([f.service.drain(), operation])
    read.mockRestore()
    rmSync(f.directory, { recursive: true, force: true })
  }
})

test('已经进入的写盘仍等真实完成，取消不回滚已写内容', async () => {
  const f = fixture(), entered = gate(), finish = gate()
  const path = join(f.workspace, 'accepted.txt')
  const write = fs.writeFile
  const spy = spyOn(fs, 'writeFile').mockImplementationOnce(async () => {
    await write(path, '已接纳写入')
    entered.resolve()
    await finish.promise
  })
  const operation = f.service.writeFile(path, '已接纳写入', f.context).catch((error: unknown) => error)
  try {
    await entered.promise
    f.service.dispose()
    let drained = false
    const draining = f.service.drain().then(() => { drained = true })
    await Bun.sleep(10)
    expect(drained).toBe(false)
    expect(readFileSync(path, 'utf8')).toBe('已接纳写入')
    finish.resolve()
    expect(await operation).toMatchObject({ message: '文件操作已取消' })
    await draining
    expect(readFileSync(path, 'utf8')).toBe('已接纳写入')
  } finally {
    finish.resolve(); f.service.dispose()
    await Promise.all([f.service.drain(), operation])
    spy.mockRestore()
    rmSync(f.directory, { recursive: true, force: true })
  }
})

test('迟到打开的图片句柄在取消后关闭，不继续读取签名', async () => {
  const f = fixture(), finish = gate<FileHandle>()
  const path = join(f.workspace, 'image.bin')
  writeFileSync(path, Buffer.alloc(12))
  const handle = await fs.open(path, 'r')
  const open = spyOn(fs, 'open').mockImplementationOnce(() => finish.promise)
  const read = spyOn(handle, 'read')
  const operation = f.service.detectImageMimeType(path, f.context).catch((error: unknown) => error)
  try {
    f.service.dispose()
    let drained = false
    const draining = f.service.drain().then(() => { drained = true })
    await Bun.sleep(10)
    expect(drained).toBe(false)
    finish.resolve(handle)
    expect(await operation).toMatchObject({ message: '文件操作已取消' })
    await draining
    expect(read).not.toHaveBeenCalled()
    await expect(handle.stat()).rejects.toMatchObject({ code: 'EBADF' })
  } finally {
    finish.resolve(handle); f.service.dispose()
    await Promise.all([f.service.drain(), operation])
    await handle.close()
    open.mockRestore(); read.mockRestore()
    rmSync(f.directory, { recursive: true, force: true })
  }
})

test('实际宿主执行器启动失败不悬挂 close 等待，错误保持脱敏', async () => {
  const f = fixture()
  const service = new AgentSandboxCommandService({ shellSnapshotDirectory: f.cache,
    capability: { available: true, executablePath: join(f.directory, 'missing-sandbox') } })
  try {
    await expect(service.executeCommand(f.request('true'))).rejects.toMatchObject({ code: 'spawnFailed', message: '宿主工具进程启动失败' })
    service.dispose()
    await service.drain()
  } finally {
    service.dispose(); f.service.dispose()
    await Promise.all([service.drain(), f.service.drain()])
    rmSync(f.directory, { recursive: true, force: true })
  }
})
