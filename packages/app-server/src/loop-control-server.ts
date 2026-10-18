/** app-server 的专用本地 CLI 通道；没有 HTTP、任意 RPC 或新后端启动能力。 */
import { chmodSync, lstatSync, mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from 'node:fs'
import { createServer } from 'node:net'
import type { Server, Socket } from 'node:net'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { StringDecoder } from 'node:string_decoder'
import type { LoopControlEnvironment } from '@axon/core'
import { createLoopCliScript } from './loop-cli-client'

function quote(value: string): string { return `'${value.replaceAll("'", "'\\''")}'` }
type ControlHandler = (token: string, argv: string[]) => { text: string; exitCode: number } | Promise<{ text: string; exitCode: number }>

export class LoopControlServer {
  private server?: Server
  private readonly sockets = new Set<Socket>()
  private directory?: string
  private identity?: { dev: number; ino: number }
  private disposed = false
  private starting?: Promise<LoopControlEnvironment>
  private closed?: Promise<void>
  private listened = false
  private readonly requests = new Set<Promise<void>>()

  /** 创建私有目录和静态 CLI；监听成功后才向 Loop 服务发布可用上下文。 */
  start(handler: ControlHandler): Promise<LoopControlEnvironment> {
    if (this.disposed) return Promise.reject(new Error('Loop 控制通道已关闭'))
    if (this.starting) return this.starting
    this.starting = this.open(handler)
    return this.starting
  }
  private async open(handler: ControlHandler): Promise<LoopControlEnvironment> {
    const directory = mkdtempSync(join(realpathSync(tmpdir()), 'axon-loop-'))
    this.directory = directory
    const info = lstatSync(directory); this.identity = { dev: info.dev, ino: info.ino }
    chmodSync(directory, 0o700)
    const commandDirectory = join(directory, 'bin')
    mkdirSync(commandDirectory, { mode: 0o700 })
    const script = join(directory, 'loop-cli.mjs')
    writeFileSync(script, createLoopCliScript(), { mode: 0o600, flag: 'wx' })
    const config = join(directory, 'bun-runtime.toml')
    writeFileSync(config, '# Axon Loop CLI 固定运行配置\n', { flag: 'wx', mode: 0o600 })
    const args = process.versions.bun ? [process.execPath, 'run', '--no-env-file', `--config=${config}`, script] : [process.execPath, script]
    const electron = process.versions.electron ? 'ELECTRON_RUN_AS_NODE=1 ' : ''
    writeFileSync(join(commandDirectory, 'axon'), `#!/bin/sh\n${electron}exec ${args.map(quote).join(' ')} "$@"\n`, { mode: 0o755, flag: 'wx' })
    const socketPath = join(directory, 'control.sock')
    const server = createServer((socket) => this.accept(socket, handler))
    this.server = server
    this.closed = new Promise<void>((done) => server.once('close', done))
    await new Promise<void>((done, failed) => {
      const onError = (): void => failed(new Error('Loop 本地通道启动失败'))
      server.once('error', onError)
      server.listen(socketPath, () => { this.listened = true; server.removeListener('error', onError); done() })
    })
    server.on('error', () => console.warn('[Loop] 本地控制通道异常'))
    chmodSync(socketPath, 0o600)
    if (this.disposed) { server.close(); throw new Error('Loop 控制通道初始化已取消') }
    return { commandDirectory, socketPath }
  }

  /** 有界单请求连接；token 仅交给领域校验，不写日志，也不从请求选择磁盘路径。 */
  private accept(socket: Socket, handler: ControlHandler): void {
    if (this.disposed || this.sockets.size >= 32 || this.requests.size >= 32) { socket.destroy(); return }
    this.sockets.add(socket)
    socket.once('close', () => this.sockets.delete(socket))
    socket.on('error', () => {})
    socket.setTimeout(65_000, () => socket.destroy())
    let buffer = '', handled = false, received = 0
    const decoder = new StringDecoder('utf8')
    socket.on('data', (bytes: Buffer) => {
      if (handled) { socket.destroy(); return }
      received += bytes.length; buffer += decoder.write(bytes)
      if (received > 256 * 1024) { socket.destroy(); return }
      const newline = buffer.indexOf('\n')
      if (newline < 0) return
      handled = true
      const work = (async (): Promise<void> => {
      let response: { text: string; exitCode: number }
      try {
        const value: unknown = JSON.parse(buffer.slice(0, newline))
        if (!value || typeof value !== 'object' || Array.isArray(value) || Object.keys(value).some((key) => !['token', 'argv'].includes(key))
          || !('token' in value) || typeof value.token !== 'string' || !('argv' in value) || !Array.isArray(value.argv)
          || value.argv.length > 128 || value.argv.some((arg) => typeof arg !== 'string')) throw new Error('无效请求')
        response = await handler(value.token, value.argv as string[])
      } catch (error) {
        response = { text: error instanceof Error && error.name === 'LoopServiceError' ? error.message : 'Loop 命令参数无效或暂不可用', exitCode: 1 }
      }
      const line = JSON.stringify(response) + '\n'
      socket.end(Buffer.byteLength(line) <= 512 * 1024 ? line : JSON.stringify({ text: 'Loop 应答过大，请查看桌面运行记录', exitCode: 1 }) + '\n')
      })()
      this.requests.add(work)
      void work.catch(() => socket.destroy()).finally(() => this.requests.delete(work))
    })
  }

  dispose(): void {
    if (this.disposed) return
    this.disposed = true
    for (const socket of this.sockets) socket.destroy()
    if (this.server?.listening) this.server.close()
  }
  /** 等待迟到初始化及所有连接关闭后，只清理本次自有、身份未改变的私有目录。 */
  async drain(): Promise<void> {
    if (!this.disposed) throw new Error('须先关闭 Loop 控制通道')
    try { await this.starting } catch { /* 初始化错误仍进入自有资源收束。 */ }
    if (this.server?.listening) this.server.close()
    if (this.listened && this.closed) await this.closed
    while (this.requests.size) await Promise.allSettled([...this.requests])
    if (this.directory && this.identity) {
      const current = lstatSync(this.directory)
      if (current.isSymbolicLink() || current.dev !== this.identity.dev || current.ino !== this.identity.ino
        || realpathSync(this.directory) !== this.directory) throw new Error('Loop 私有目录身份变化，已保留')
      rmSync(this.directory, { recursive: true })
      this.directory = undefined
    }
  }
}
