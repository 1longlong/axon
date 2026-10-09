/** 专用进程退出协调：真实资源等待和协议输出共用一个总期限。 */
import type { Readable, Writable } from 'node:stream'
import type { AppServerConnection } from '@axon/app-server'
import { APP_SERVER_SHUTDOWN_TIMEOUT_MS } from '@axon/shared'

export interface AppServerShutdownOptions {
  connection: Pick<AppServerConnection, 'close' | 'drain'>
  input: Pick<Readable, 'destroy'>
  output: Writable
  diagnostic: () => void
  exit: (code: number) => void
  timeoutMs?: number
}

export class AppServerShutdown {
  private closing = false
  private finished = false
  private exitCode = 0
  private diagnosed = false
  private outputFailed = false
  private deadline?: ReturnType<typeof setTimeout>

  /** 输出失败也走同一清理链；不要在清理尚未结束时直接退出。 */
  constructor(private readonly options: AppServerShutdownOptions) {
    options.output.on('error', this.onOutputFailure)
    options.output.on('close', this.onOutputClose)
  }

  private fail(): void {
    this.exitCode = 1
    if (this.diagnosed) return
    this.diagnosed = true
    try { this.options.diagnostic() } catch { /* 诊断端口失败不能阻止专用进程退出。 */ }
  }

  private readonly onOutputFailure = (): void => {
    this.outputFailed = true
    this.close(1)
  }
  private readonly onOutputClose = (): void => {
    if (!this.options.output.writableFinished) this.onOutputFailure()
  }

  /** EOF/信号/异常共用一次关闭；后来的异常可升级退出码，但不重启清理或重置期限。 */
  close(code: 0 | 1): void {
    if (this.finished) return
    if (code) this.fail()
    if (this.closing) return
    this.closing = true
    // 期限先于同步释放登记，涵盖资源等待与最后的管道 flush。
    this.deadline = setTimeout(() => { this.fail(); this.finish() }, this.options.timeoutMs ?? APP_SERVER_SHUTDOWN_TIMEOUT_MS)
    try { this.options.connection.close() } catch { this.fail() }
    try { this.options.input.destroy() } catch { this.fail() }
    void Promise.resolve().then(() => this.options.connection.drain()).then(
      () => this.endOutput(),
      () => { this.fail(); this.endOutput() },
    )
  }

  /** 不向关闭的 peer 重放消息；底层已写入帧的 flush 必须在资源等待之后完成。 */
  private endOutput(): void {
    if (this.finished) return
    if (this.outputFailed || this.options.output.destroyed) { this.fail(); this.finish(); return }
    try { this.options.output.end(() => this.finish()) }
    catch { this.fail(); this.finish() }
  }

  private finish(): void {
    if (this.finished) return
    this.finished = true
    clearTimeout(this.deadline)
    this.options.output.off('error', this.onOutputFailure)
    this.options.output.off('close', this.onOutputClose)
    this.options.exit(this.exitCode)
  }
}
