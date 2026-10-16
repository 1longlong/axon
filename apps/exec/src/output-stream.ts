/** stdout 的单写入者；通知不等待消费，但队列有界，失败供执行入口停止自有工作流。 */
import type { Writable } from 'node:stream'
import type { ExecEvent } from '@axon/shared'

export class ExecOutputError extends Error {
  constructor() { super('CLI 输出无法完成，未自动重跑任务'); this.name = 'ExecOutputError' }
}
export class ExecOutputStream {
  private readonly failure = new AbortController()
  private readonly queue: string[] = []
  private pendingBytes = 0
  private writing = false
  private disposed = false
  private finalWritten = false
  private closedObserved = false
  private readonly waiters = new Set<() => void>()
  private readonly onError = (): void => this.fail()
  private readonly onClose = (): void => { this.closedObserved = true; if (!this.disposed) this.fail(); else this.detach() }

  constructor(private readonly output: Writable, private readonly json: boolean, private readonly limitBytes = 64 * 1024 * 1024) {
    if (!Number.isSafeInteger(limitBytes) || limitBytes <= 0) throw new ExecOutputError()
    output.on('error', this.onError)
    output.on('close', this.onClose)
  }
  get signal(): AbortSignal { return this.failure.signal }

  /** JSONL 一行一个中立事件；普通模式不输出流片段，避免最终正文重复。 */
  emit(event: ExecEvent): void {
    this.assertLive()
    if (this.json) this.enqueue(`${JSON.stringify(event)}\n`)
  }
  /** 整个工作流结束后仅调用一次；JSON 模式不另插入纯文本行。 */
  async writeFinal(text: string): Promise<void> {
    this.assertLive()
    if (this.finalWritten) throw new ExecOutputError()
    this.finalWritten = true
    if (!this.json && text) this.enqueue(text.endsWith('\n') ? text : `${text}\n`)
    await this.flush()
  }
  private assertLive(): void {
    this.signal.throwIfAborted()
    if (this.disposed || this.output.destroyed || this.output.writableEnded) { this.fail(); throw new ExecOutputError() }
  }
  private enqueue(text: string): void {
    this.pendingBytes += Buffer.byteLength(text)
    if (this.pendingBytes > this.limitBytes) { this.fail(); throw new ExecOutputError() }
    this.queue.push(text)
    this.pump()
  }

  /** 只保持一个在途 write；等真实回调再取下一行，背压不转成无限 Promise 堆积。 */
  private pump(): void {
    if (this.writing || this.signal.aborted) return
    const text = this.queue.shift()
    if (text === undefined) { this.wake(); return }
    this.writing = true
    try {
      this.output.write(text, 'utf8', (error) => {
        this.writing = false
        if (error) this.fail()
        else if (!this.signal.aborted) { this.pendingBytes -= Buffer.byteLength(text); this.pump() }
        this.wake()
      })
    } catch { this.writing = false; this.fail() }
  }
  private wake(): void {
    if (!this.signal.aborted && (this.writing || this.queue.length)) return
    for (const resolve of this.waiters) resolve()
    this.waiters.clear()
  }
  private fail(): void {
    if (this.signal.aborted) return
    this.failure.abort(new ExecOutputError())
    this.queue.length = 0
    this.pendingBytes = 0
    this.wake()
  }

  /** 成功须等待所有 write 回调；断管、关闭或溢出明确失败，不把入队当交付成功。 */
  async flush(): Promise<void> {
    this.assertLive()
    if (this.writing || this.queue.length) await new Promise<void>((resolve) => { this.waiters.add(resolve) })
    this.assertLive()
  }
  /** 不关闭调用方 stdout；正常清理前先 flush，未交付数据不能通过 dispose 伪装成功。 */
  dispose(): void {
    if (this.disposed) return
    if (this.writing || this.queue.length) this.fail()
    this.disposed = true
    // write 的错误回调后还可能异步发 error；失败时保留监听直到实际 close。
    if (!this.signal.aborted || this.closedObserved) this.detach()
  }
  private detach(): void {
    this.output.removeListener('error', this.onError)
    this.output.removeListener('close', this.onClose)
  }
}
