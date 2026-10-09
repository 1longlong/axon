import { expect, test } from 'bun:test'
import { spawn } from 'node:child_process'
import { join } from 'node:path'
import { JsonRpcPeer } from './index'

/** 通过真实 Bun 子进程 stdin/stdout 验证双向调用，stderr 从未混入协议解析。 */
test('真实 stdio：反向交互等待期间处理控制、取消、事件与 EOF 退出', async () => {
  const child = spawn(process.execPath, [join(import.meta.dir, '../test-support/stdio-fixture.ts')], {
    stdio: ['pipe', 'pipe', 'pipe'],
  })
  const exited = new Promise<number | null>((resolve, reject) => {
    child.once('exit', (code) => resolve(code))
    child.once('error', reject)
  })
  const peer = new JsonRpcPeer(child.stdout, child.stdin, { requestTimeoutMs: 3_000 })
  let stderr = ''
  child.stderr.on('data', (chunk: Buffer) => { stderr += chunk.toString() })
  const approval = Promise.withResolvers<string>()
  const waiting = Promise.withResolvers<void>()
  const cancelable = Promise.withResolvers<void>()
  const phases: string[] = []
  peer.handle('host/confirm', (params) => { expect(params).toEqual({ target: 'fixture' }); waiting.resolve(); return approval.promise })
  peer.handleNotification('fixture/event', (params) => {
    const phase = String((params as { phase: string }).phase)
    phases.push(phase)
    if (phase === 'cancelable') cancelable.resolve()
  })
  try {
    if (child.pid === undefined) throw new Error('传输夹具未启动')
    expect(await peer.request('ping')).toEqual({ pid: child.pid, electron: false })
    const work = peer.request('work')
    await Promise.race([waiting.promise, work.then(() => { throw new Error('交互开始前运行已结束') })])
    expect(await peer.request('control')).toEqual({ accepted: true })
    expect(phases).toEqual(['waiting'])
    approval.resolve('用户确认')
    expect(await work).toBe('用户确认')
    expect(phases).toEqual(['waiting', 'finished'])
    const stop = new AbortController()
    const request = peer.request('wait', {}, { signal: stop.signal })
    const result = request.catch((error: unknown) => error)
    await Promise.race([cancelable.promise, request.then(() => { throw new Error('等待取消前运行已结束') })])
    stop.abort()
    expect(await result).toMatchObject({ code: 'canceled' })
    expect(await peer.request('canceled')).toBe(1)
    const final = peer.request('wait')
    const closed = final.catch((error: unknown) => error)
    // 不发送业务 shutdown：直接 EOF，证明断开能结束真实子进程。
    child.stdin.end()
    expect(await exited).toBe(0)
    expect(await closed).toMatchObject({ code: 'eof' })
    expect(peer.closed).toBe(true)
    expect(stderr).toContain('[应用协议夹具] 已就绪')
  } finally {
    peer.close()
    if (child.exitCode === null && child.signalCode === null) child.kill()
    child.stdin.destroy()
    child.stdout.destroy()
    child.stderr.destroy()
  }
}, 10_000)
