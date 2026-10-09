import { createServer } from 'node:net'
import type { Socket } from 'node:net'
import { join } from 'node:path'

export interface GitHelperPids { gitPid: number; helperPid: number }

function quote(value: string): string { return "'" + value.replaceAll("'", "'\\''") + "'" }

/** 只接收真实 Git helper 的就绪通知；不借测试回调替代生产 Git 启动和进程组清理。 */
export async function createBlockingGitHelper() {
  const sockets = new Set<Socket>()
  let resolveReady!: (pids: GitHelperPids) => void
  let rejectReady!: (error: Error) => void
  const ready = new Promise<GitHelperPids>((resolve, reject) => { resolveReady = resolve; rejectReady = reject })
  // 启动异常可能早于测试开始等待；保留拒绝给 waitReady，又避免未处理拒绝。
  void ready.catch(() => {})
  const server = createServer((socket) => {
    sockets.add(socket)
    socket.once('close', () => sockets.delete(socket))
    socket.once('error', rejectReady)
    let input = ''
    socket.on('data', (chunk: Buffer) => {
      input += chunk.toString()
      if (input.length > 1024) { rejectReady(new Error('Git helper 就绪消息超限')); socket.destroy(); return }
      if (!input.includes('\n')) return
      try {
        const value: unknown = JSON.parse(input.slice(0, input.indexOf('\n')))
        if (!value || typeof value !== 'object' || !('gitPid' in value) || !('helperPid' in value)
          || !Number.isSafeInteger(value.gitPid) || !Number.isSafeInteger(value.helperPid)
          || Number(value.gitPid) <= 1 || Number(value.helperPid) <= 1) throw new Error('Git helper PID 无效')
        resolveReady({ gitPid: Number(value.gitPid), helperPid: Number(value.helperPid) })
      } catch (error) { rejectReady(error instanceof Error ? error : new Error('Git helper 就绪消息无效')) }
    })
  })
  await new Promise<void>((resolve, reject) => { server.once('error', reject); server.listen(0, '127.0.0.1', resolve) })
  const address = server.address()
  if (!address || typeof address === 'string') throw new Error('Git helper 就绪端口不可用')
  return {
    // exec 使 Shell 被 helper 替换，通知中的 ppid 必须仍是真实 Git，而非多余包装进程。
    command: `exec ${quote(process.execPath)} ${quote(join(import.meta.dir, 'blocking-git-helper.mjs'))} ${address.port}`,
    async waitReady(): Promise<GitHelperPids> {
      let timer: ReturnType<typeof setTimeout> | undefined
      try {
        return await Promise.race([ready, new Promise<never>((_, reject) => {
          timer = setTimeout(() => reject(new Error('Git helper 三秒内未发送就绪通知')), 3000)
        })])
      } finally { if (timer) clearTimeout(timer) }
    },
    async close(): Promise<void> {
      const closed = new Promise<void>((resolve, reject) => server.close((error) => error ? reject(error) : resolve()))
      for (const socket of sockets) socket.destroy()
      await closed
    },
  }
}

/** 管道 close 不等于孙进程已被系统回收；只接受 ESRCH，仍存活或权限错误都失败。 */
export async function waitForGitHelperExit(pid: number): Promise<void> {
  const deadline = Date.now() + 3000
  for (;;) {
    try { process.kill(pid, 0) }
    catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ESRCH') return
      throw error
    }
    if (Date.now() >= deadline) throw new Error(`Git/helper 未退出：${pid}`)
    await Bun.sleep(10)
  }
}
