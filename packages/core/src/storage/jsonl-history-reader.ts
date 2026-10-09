/** 原子替换的 JSONL 使用打开的旧 inode 做只读快照；不复制全文，也不写 Runtime 历史。 */
import { closeSync, fstatSync, openSync, readSync } from 'node:fs'
import { MESSAGE_HISTORY_PAGE_BYTES, MESSAGE_HISTORY_PAGE_MESSAGES } from '@axon/shared'

export class JsonlHistoryError extends Error {
  constructor(readonly code: 'storage_error' | 'too_large', message: string) {
    super(message)
    this.name = 'JsonlHistoryError'
  }
}
export interface JsonlHistoryReaderOptions<T> {
  path: string
  maxFileBytes: number
  normalize: (value: unknown) => { message: T; id: string }
}
export interface JsonlHistoryReadResult<T> { messages: T[]; done: boolean }

export class JsonlHistoryReader<T> {
  private fd?: number
  private size = 0
  private position = 0
  private buffer = Buffer.alloc(0)
  private offset = 0
  private readonly ids = new Set<string>()
  private pending?: { message: T; bytes: number }
  private ended = false
  private closed = false

  /** 仓储先校验会话与路径；只打开一次，后续追加的原子 rename 不改变此快照。 */
  constructor(private readonly options: JsonlHistoryReaderOptions<T>) {
    try {
      this.fd = openSync(options.path, 'r')
      const stat = fstatSync(this.fd)
      if (!stat.isFile()) throw new JsonlHistoryError('storage_error', '历史文件不可读取')
      if (stat.size > options.maxFileBytes) throw new JsonlHistoryError('too_large', '历史文件过大')
      this.size = stat.size
    } catch (error) {
      this.close()
      if (error instanceof Error && 'code' in error && error.code === 'ENOENT') {
        this.closed = false
        this.ended = true
        return
      }
      if (error instanceof JsonlHistoryError) throw error
      throw new JsonlHistoryError('storage_error', '读取历史文件失败')
    }
  }

  /** 按条数和正文预算分页；单条完整消息允许越过页预算，不截断工具结果或摘要。 */
  readPage(): JsonlHistoryReadResult<T> {
    if (this.closed) throw new JsonlHistoryError('storage_error', '历史快照已关闭')
    const messages: T[] = []
    let bytes = 0
    try {
      while (true) {
        const next = this.pending ?? this.nextMessage()
        if (!next) {
          this.releaseFile()
          return { messages, done: true }
        }
        if (messages.length && (messages.length >= MESSAGE_HISTORY_PAGE_MESSAGES || bytes + next.bytes > MESSAGE_HISTORY_PAGE_BYTES)) {
          this.pending = next
          return { messages, done: false }
        }
        this.pending = undefined
        messages.push(next.message)
        bytes += next.bytes
      }
    } catch (error) {
      this.close()
      if (error instanceof JsonlHistoryError) throw error
      throw new JsonlHistoryError('storage_error', '读取历史文件失败')
    }
  }

  private nextMessage(): { message: T; bytes: number } | undefined {
    while (!this.ended) {
      const line = this.nextLine()
      if (line === undefined) { this.ended = true; return undefined }
      if (!line.trim()) continue
      // 沿用仓储的规范化与去重；只读分页隔离坏行，不改写正被执行层使用的历史。
      let normalized: { message: T; id: string }
      try { normalized = this.options.normalize(JSON.parse(line) as unknown) } catch { continue }
      if (this.ids.has(normalized.id)) continue
      this.ids.add(normalized.id)
      return { message: normalized.message, bytes: Buffer.byteLength(JSON.stringify(normalized.message)) + 1 }
    }
    return undefined
  }

  /** 64 KiB 块只拼接当前一行；UTF-8 跨块字符在整行完成后解码。 */
  private nextLine(): string | undefined {
    const parts: Buffer[] = []
    let length = 0
    while (true) {
      if (this.offset >= this.buffer.length) {
        if (this.position >= this.size || this.fd === undefined) return length ? Buffer.concat(parts, length).toString('utf8') : undefined
        this.buffer = Buffer.allocUnsafe(Math.min(64 * 1024, this.size - this.position))
        const read = readSync(this.fd, this.buffer, 0, this.buffer.length, this.position)
        if (!read) throw new JsonlHistoryError('storage_error', '历史快照读取未完成')
        this.buffer = this.buffer.subarray(0, read)
        this.position += read
        this.offset = 0
      }
      const newline = this.buffer.indexOf(10, this.offset)
      const end = newline < 0 ? this.buffer.length : newline
      const part = this.buffer.subarray(this.offset, end)
      parts.push(part)
      length += part.length
      this.offset = newline < 0 ? end : end + 1
      if (newline >= 0) return Buffer.concat(parts, length).toString('utf8')
    }
  }

  private releaseFile(): void {
    const fd = this.fd
    this.fd = undefined
    this.buffer = Buffer.alloc(0)
    if (fd !== undefined) closeSync(fd)
  }
  /** EOF、取消、入口注销和超时均释放句柄；重复释放不触碰其他快照。 */
  close(): void {
    if (this.closed) return
    this.closed = true
    this.pending = undefined
    this.ids.clear()
    this.releaseFile()
  }
}
