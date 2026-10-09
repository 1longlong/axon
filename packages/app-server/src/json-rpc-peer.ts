/** 对称 RPC 端点：父/子均可请求、答复与通知；不理解会话、审批或凭据业务。 */
import { randomUUID } from 'node:crypto'
import type { Readable, Writable } from 'node:stream'
import { TextDecoder } from 'node:util'
import { AXON_RPC_CANCEL_METHOD, AXON_RPC_CHUNK_METHOD, AXON_RPC_CHUNK_ABORT_METHOD } from '@axon/shared'
import type { RpcFrame, RpcId, RpcJsonValue, RpcParams, RpcRequest } from '@axon/shared'
import { RpcChunkAssembler, RpcChunkLimitError } from './rpc-chunk-assembler'
import type { RpcChunkHeader, RpcChunkMetadata } from './rpc-chunk-assembler'

export class RpcConnectionError extends Error {
  constructor(readonly code: 'closed' | 'eof' | 'protocol' | 'overflow' | 'io', message: string) {
    super(message)
    this.name = 'RpcConnectionError'
  }
}
export class RpcRequestError extends Error {
  constructor(readonly code: 'canceled' | 'timeout', message: string) {
    super(message)
    this.name = 'RpcRequestError'
  }
}
/** 只有显式构造的业务错误可跨进程，其余异常统一脱敏。 */
export class RpcFault extends Error {
  constructor(readonly code: number, message: string, readonly data?: RpcJsonValue) {
    super(message)
    this.name = 'RpcFault'
  }
}

export interface RpcHandlerContext { signal: AbortSignal }
export interface RpcRequestOptions {
  signal?: AbortSignal
  /** 0 表示等待业务结束；仍响应取消/断开，不对长运行套普通请求时限。 */
  timeoutMs?: number
}
export interface JsonRpcPeerOptions {
  maxFrameBytes?: number
  /** 完整逻辑消息可以大于行帧；生产两端必须显式使用同一应用上限。 */
  maxMessageBytes?: number
  maxBufferedMessageBytes?: number
  maxChunkTransfers?: number
  maxChunkParts?: number
  chunkTimeoutMs?: number
  maxQueuedBytes?: number
  maxQueuedMessages?: number
  maxPendingRequests?: number
  requestTimeoutMs?: number
}
type RequestHandler = (params: RpcParams, context: RpcHandlerContext) => RpcJsonValue | Promise<RpcJsonValue>
type NotificationHandler = (params: RpcParams) => void | Promise<void>
interface PendingRequest {
  resolve: (result: RpcJsonValue) => void
  reject: (error: Error) => void
  cleanup: () => void
}
interface OutboundFrame {
  buffer: Buffer
  header: RpcChunkHeader
  offset: number
  chunk?: RpcChunkMetadata
}
const INTERNAL_METHODS = [AXON_RPC_CANCEL_METHOD, AXON_RPC_CHUNK_METHOD, AXON_RPC_CHUNK_ABORT_METHOD]
function header(frame: RpcFrame): RpcChunkHeader {
  return 'method' in frame ? 'id' in frame ? { kind: 'request', id: frame.id } : { kind: 'notification' }
    : { kind: 'response', id: frame.id }
}

function positive(value: number): number {
  if (!Number.isSafeInteger(value) || value <= 0) throw new Error('RPC 限制必须是正整数')
  return value
}
function isObject(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
}
function isId(value: unknown): value is RpcId {
  return value === null || typeof value === 'string' || typeof value === 'number' && Number.isFinite(value)
}
/** 拒绝不能无损传输的值，不让 JSON.stringify 静默丢掉函数、undefined 或信号。 */
function isJson(value: unknown, depth = 0): value is RpcJsonValue {
  if (depth > 64) return false
  if (value === null || typeof value === 'string' || typeof value === 'boolean') return true
  if (typeof value === 'number') return Number.isFinite(value)
  if (Array.isArray(value)) {
    for (const item of value) if (!isJson(item, depth + 1)) return false
    return true
  }
  return isObject(value) && [Object.prototype, null].includes(Object.getPrototypeOf(value))
    && Object.values(value).every((item) => isJson(item, depth + 1))
}
/** 每行仅接受一个完整消息；数组 batch 不属于 Axon 首版 stdio profile。 */
function parseFrame(value: unknown): RpcFrame {
  if (!isObject(value) || value.jsonrpc !== '2.0' || !isJson(value)) throw new Error('无效 RPC 消息')
  if ('method' in value) {
    if (typeof value.method !== 'string' || !value.method || value.method.startsWith('rpc.')
      || 'result' in value || 'error' in value || 'id' in value && !isId(value.id)
      || 'params' in value && !(isObject(value.params) || Array.isArray(value.params))) throw new Error('无效 RPC 请求')
  } else {
    if (!('id' in value) || !isId(value.id) || ('result' in value) === ('error' in value)
      || 'params' in value) throw new Error('无效 RPC 响应')
    if ('error' in value && (!isObject(value.error) || !Number.isInteger(value.error.code)
      || typeof value.error.message !== 'string')) throw new Error('无效 RPC 错误')
  }
  return value as unknown as RpcFrame
}

export class JsonRpcPeer {
  private readonly pending = new Map<RpcId, PendingRequest>()
  private readonly incoming = new Map<RpcId, AbortController>()
  private readonly handlers = new Map<string, RequestHandler>()
  private readonly notifications = new Map<string, NotificationHandler>()
  private readonly closeListeners = new Set<(error: RpcConnectionError) => void>()
  private readonly controls: OutboundFrame[] = []
  private readonly events: OutboundFrame[] = []
  private fragment = Buffer.alloc(0)
  private fragmentBytes = 0
  private queuedBytes = 0
  private handlingBytes = 0
  private blocked = false
  private pumping = false
  private failure?: RpcConnectionError
  private readonly limits: Required<JsonRpcPeerOptions>
  private readonly decoder = new TextDecoder('utf-8', { fatal: true })
  private readonly chunks: RpcChunkAssembler

  /** 入口提供私有管道；端点关闭只停止协议处理，实际进程/管道销毁由入口负责。 */
  constructor(private readonly input: Readable, private readonly output: Writable, options: JsonRpcPeerOptions = {}) {
    this.limits = {
      maxFrameBytes: positive(options.maxFrameBytes ?? 8 * 1024 * 1024),
      maxMessageBytes: positive(options.maxMessageBytes ?? options.maxFrameBytes ?? 8 * 1024 * 1024),
      maxBufferedMessageBytes: positive(options.maxBufferedMessageBytes ?? options.maxMessageBytes ?? options.maxFrameBytes ?? 8 * 1024 * 1024),
      maxChunkTransfers: positive(options.maxChunkTransfers ?? 8),
      maxChunkParts: positive(options.maxChunkParts ?? 65_536),
      chunkTimeoutMs: positive(options.chunkTimeoutMs ?? 300_000),
      maxQueuedBytes: positive(options.maxQueuedBytes ?? 16 * 1024 * 1024),
      maxQueuedMessages: positive(options.maxQueuedMessages ?? 2048),
      maxPendingRequests: positive(options.maxPendingRequests ?? 512),
      requestTimeoutMs: positive(options.requestTimeoutMs ?? 30_000),
    }
    if (this.limits.maxMessageBytes < this.limits.maxFrameBytes) throw new Error('RPC 消息上限不能小于行帧上限')
    this.chunks = new RpcChunkAssembler(this.limits, (info) => {
      if (info.kind === 'request' && this.incoming.has(info.id)) throw new Error('RPC 分段请求 ID 重复')
      return info.kind !== 'response' || this.pending.has(info.id)
    }, () => this.close(new RpcConnectionError('protocol', 'RPC 分段接收超时')), () => this.handlingBytes)
    input.on('data', this.onData)
    input.on('end', this.onEnd)
    input.on('error', this.onIoError)
    input.on('close', this.onInputClose)
    output.on('error', this.onIoError)
    output.on('close', this.onOutputClose)
    output.on('drain', this.onDrain)
    if (input.readableEnded || input.destroyed || output.destroyed || output.writableEnded) this.onEnd()
  }

  get closed(): boolean { return this.failure !== undefined }

  handle(method: string, handler: RequestHandler): void {
    if (this.closed || this.handlers.has(method) || INTERNAL_METHODS.includes(method)) throw new Error('RPC 请求注册无效')
    this.handlers.set(method, handler)
  }
  handleNotification(method: string, handler: NotificationHandler): void {
    if (this.closed || this.notifications.has(method) || INTERNAL_METHODS.includes(method)) throw new Error('RPC 通知注册无效')
    this.notifications.set(method, handler)
  }
  onClose(listener: (error: RpcConnectionError) => void): () => void {
    if (this.failure) this.callCloseListener(listener, this.failure)
    else this.closeListeners.add(listener)
    return () => this.closeListeners.delete(listener)
  }

  /** 先登记等待再写管道，响应可乱序返回；取消不重发，迟到响应不再被消费。 */
  request(method: string, params: RpcParams = {}, options: RpcRequestOptions = {}): Promise<RpcJsonValue> {
    if (this.failure) return Promise.reject(this.failure)
    if (INTERNAL_METHODS.includes(method)) return Promise.reject(new Error('RPC 内部方法不能作为业务请求'))
    if (options.signal?.aborted) return Promise.reject(new RpcRequestError('canceled', 'RPC 请求已取消'))
    if (this.pending.size >= this.limits.maxPendingRequests) return Promise.reject(new RpcConnectionError('overflow', 'RPC 待处理请求过多'))
    const timeoutMs = options.timeoutMs === 0 ? 0 : positive(options.timeoutMs ?? this.limits.requestTimeoutMs)
    const id = randomUUID()
    return new Promise((resolve, reject) => {
      const cancel = (code: 'timeout' | 'canceled'): void => {
        const current = this.pending.get(id)
        if (!current) return
        this.pending.delete(id)
        current.cleanup()
        current.reject(new RpcRequestError(code, code === 'timeout' ? 'RPC 请求超时，交付状态未知' : 'RPC 请求已取消'))
        this.chunks.discardResponse(id)
        // 未写入管道的请求直接移除；已发送的请求只发取消通知，绝不重放原请求。
        const removed = this.removeQueued('request', id)
        if (removed && removed.offset === 0) return
        if (!this.closed) {
          try {
            if (removed?.chunk) this.abortChunk(removed.chunk.transferId)
            this.send({ jsonrpc: '2.0', method: AXON_RPC_CANCEL_METHOD, params: { id } }, true)
          }
          catch { /* send 已关闭连接，原请求仍以取消/超时结束。 */ }
        }
      }
      const timer = timeoutMs === 0 ? undefined : setTimeout(() => cancel('timeout'), timeoutMs)
      const onAbort = (): void => cancel('canceled')
      const pending: PendingRequest = { resolve, reject, cleanup: () => {
        if (timer !== undefined) clearTimeout(timer)
        options.signal?.removeEventListener('abort', onAbort)
      } }
      this.pending.set(id, pending)
      options.signal?.addEventListener('abort', onAbort, { once: true })
      try { this.send({ jsonrpc: '2.0', id, method, params }, true) }
      catch (error) {
        this.pending.delete(id)
        pending.cleanup()
        reject(error)
      }
    })
  }

  notify(method: string, params: RpcParams = {}): void {
    if (INTERNAL_METHODS.includes(method)) throw new Error('RPC 内部方法不能作为业务通知')
    this.send({ jsonrpc: '2.0', method, params }, false)
  }

  /** 按字节找换行，完整帧才解码，避免中文字符跨 chunk 时被替换或反复复制大半包。 */
  private readonly onData = (chunk: Buffer): void => {
    if (this.closed) return
    if (!Buffer.isBuffer(chunk)) { this.close(new RpcConnectionError('protocol', 'RPC 管道必须提供原始字节')); return }
    let start = 0
    while (start < chunk.length && !this.closed) {
      const newline = chunk.indexOf(10, start)
      const end = newline < 0 ? chunk.length : newline
      const part = chunk.subarray(start, end)
      this.fragmentBytes += part.length
      if (this.fragmentBytes > this.limits.maxFrameBytes) { this.close(new RpcConnectionError('overflow', 'RPC 消息超过长度限制')); return }
      if (this.fragment.length < this.fragmentBytes) {
        const next = Buffer.allocUnsafe(Math.min(this.limits.maxFrameBytes, Math.max(this.fragmentBytes, this.fragment.length * 2, 1024)))
        this.fragment.copy(next, 0, 0, this.fragmentBytes - part.length)
        this.fragment = next
      }
      part.copy(this.fragment, this.fragmentBytes - part.length)
      if (newline < 0) return
      try {
        const bytes = this.fragment.subarray(0, this.fragmentBytes)
        this.fragmentBytes = 0
        this.receive(parseFrame(JSON.parse(this.decoder.decode(bytes))), bytes.length)
      } catch (error) {
        // 不记录原始行或解析异常，stdout 污染可能包含模型输入和凭据。
        this.close(error instanceof RpcChunkLimitError
          ? new RpcConnectionError('overflow', 'RPC 分段接收超过限制')
          : new RpcConnectionError('protocol', 'RPC 帧格式无效或输出被污染'))
      }
      start = newline + 1
    }
  }

  /** 读取循环不等待业务 Promise，长运行中仍能处理反向请求、响应和停止。 */
  private receive(frame: RpcFrame, byteLength: number): void {
    if ('method' in frame) {
      if (frame.method === AXON_RPC_CHUNK_METHOD || frame.method === AXON_RPC_CHUNK_ABORT_METHOD) {
        if ('id' in frame || !frame.params) throw new Error('无效分段控制帧')
        if (frame.method === AXON_RPC_CHUNK_ABORT_METHOD) { this.chunks.abort(frame.params); return }
        const completed = this.chunks.accept(frame.params)
        if (!completed) return
        const decoded = parseFrame(JSON.parse(this.decoder.decode(completed.bytes)))
        const identity = header(decoded)
        if (identity.kind !== completed.header.kind || identity.kind !== 'notification'
          && (completed.header.kind === 'notification' || identity.id !== completed.header.id)
          || 'method' in decoded && [AXON_RPC_CHUNK_METHOD, AXON_RPC_CHUNK_ABORT_METHOD].includes(decoded.method)) {
          throw new Error('分段内容与声明不一致')
        }
        this.receive(decoded, completed.bytes.length)
        return
      }
      if ('id' in frame) { void this.dispatch(frame, byteLength); return }
      if (frame.method === AXON_RPC_CANCEL_METHOD) {
        if (!isObject(frame.params) || !isId(frame.params.id)) throw new Error('无效取消通知')
        this.chunks.cancelRequest(frame.params.id)
        this.incoming.get(frame.params.id)?.abort()
        const removed = this.removeQueued('response', frame.params.id)
        if (removed?.chunk && removed.offset > 0) this.abortChunk(removed.chunk.transferId)
      } else {
        const handler = this.notifications.get(frame.method)
        if (handler) {
          const release = this.reserveIncoming(byteLength)
          try {
            // 同步调用保持帧到达顺序，但不等待异步监听完成。
            void Promise.resolve(handler(frame.params ?? {}))
              .catch(() => this.close(new RpcConnectionError('io', 'RPC 通知处理失败')))
              .finally(release)
          } catch { release(); this.close(new RpcConnectionError('io', 'RPC 通知处理失败')) }
        }
      }
      return
    }
    const pending = this.pending.get(frame.id)
    if (!pending) return
    this.pending.delete(frame.id)
    pending.cleanup()
    if ('error' in frame) pending.reject(new RpcFault(frame.error.code, frame.error.message, frame.error.data))
    else pending.resolve(frame.result)
  }

  /** 请求/异步通知继续持有正文时仍计入接收预算，不能靠完成分段绕过内存边界。 */
  private reserveIncoming(bytes: number): () => void {
    if (this.handlingBytes + this.chunks.bufferedSize + bytes > this.limits.maxBufferedMessageBytes) {
      throw new RpcChunkLimitError('RPC 在途正文超过接收预算')
    }
    this.handlingBytes += bytes
    let released = false
    return () => {
      if (released) return
      released = true
      this.handlingBytes -= bytes
    }
  }

  /** 为单个请求分配取消信号，结束后回收；异常只生成脱敏响应，不重试业务。 */
  private async dispatch(frame: RpcRequest, byteLength: number): Promise<void> {
    if (this.incoming.has(frame.id)) { this.close(new RpcConnectionError('protocol', 'RPC 请求 ID 重复')); return }
    const controller = new AbortController()
    this.incoming.set(frame.id, controller)
    let release = (): void => {}
    try {
      if (this.incoming.size > this.limits.maxPendingRequests) throw new RpcFault(-32001, 'RPC 正在处理的请求过多')
      release = this.reserveIncoming(byteLength)
      const handler = this.handlers.get(frame.method)
      if (!handler) throw new RpcFault(-32601, 'RPC 方法不存在')
      const result = await handler(frame.params ?? {}, { signal: controller.signal })
      if (!isJson(result)) throw new Error('RPC 处理结果不是 JSON')
      if (!this.closed) this.send(controller.signal.aborted
        ? { jsonrpc: '2.0', id: frame.id, error: { code: -32800, message: 'RPC 请求已取消' } }
        : { jsonrpc: '2.0', id: frame.id, result }, true)
    } catch (error) {
      if (error instanceof RpcChunkLimitError) {
        this.close(new RpcConnectionError('overflow', 'RPC 在途接收积压超过限制'))
      }
      if (!this.closed) {
        try {
          this.send({ jsonrpc: '2.0', id: frame.id, error: error instanceof RpcFault && Number.isInteger(error.code)
            && (error.data === undefined || isJson(error.data))
            ? { code: error.code, message: error.message, ...(error.data === undefined ? {} : { data: error.data }) }
            : { code: -32603, message: 'RPC 请求处理失败' } }, true)
        } catch (failure) {
          // 连错误响应也无法传输时必须明确断开，不能留下永远等不到答复的请求。
          this.close(failure instanceof RpcConnectionError ? failure
            : new RpcConnectionError('protocol', 'RPC 响应无法传输'))
        }
      }
    } finally { release(); this.incoming.delete(frame.id) }
  }

  /** 输出有界，控制帧优先于尚未写入的事件；事件自身顺序不变，溢出明确断开而非静默丢弃。 */
  private send(frame: RpcFrame, control: boolean): void {
    if (this.failure) throw this.failure
    parseFrame(frame)
    const buffer = Buffer.from(`${JSON.stringify(frame)}\n`)
    if (buffer.length - 1 > this.limits.maxMessageBytes) throw new RpcConnectionError('overflow', 'RPC 输出消息超过长度限制')
    const identity = header(frame)
    const outbound: OutboundFrame = { buffer, header: identity, offset: 0 }
    if (buffer.length - 1 > this.limits.maxFrameBytes) {
      outbound.chunk = { ...identity, transferId: randomUUID(), total: buffer.length - 1 }
      // 提前检查元数据能放进行帧，不能发出第一段后才发现无法编码。
      this.chunkFrame(outbound)
    }
    if (this.controls.length + this.events.length >= this.limits.maxQueuedMessages
      || this.queuedBytes + this.output.writableLength + buffer.length > this.limits.maxQueuedBytes) {
      const error = new RpcConnectionError('overflow', 'RPC 输出积压超过限制')
      this.close(error)
      throw error
    }
    const queue = control ? this.controls : this.events
    queue.push(outbound)
    this.queuedBytes += buffer.length
    this.pump()
  }
  /** 取消只移除同 ID 的未发送余段，并回收整条逻辑消息的输出预算。 */
  private removeQueued(kind: 'request' | 'response', id: RpcId): OutboundFrame | undefined {
    const index = this.controls.findIndex((item) => item.header.kind === kind && item.header.id === id)
    if (index < 0) return undefined
    const [removed] = this.controls.splice(index, 1)
    this.queuedBytes -= removed!.buffer.length
    return removed
  }
  private abortChunk(transferId: string): void {
    this.send({ jsonrpc: '2.0', method: AXON_RPC_CHUNK_ABORT_METHOD, params: { transferId } }, true)
  }
  /** 每次只编码一个线上段；不把整条大消息展开成无界帧队列。 */
  private chunkFrame(frame: OutboundFrame): { buffer: Buffer; bytes: number } {
    const info = frame.chunk!
    const envelope = { jsonrpc: '2.0' as const, method: AXON_RPC_CHUNK_METHOD,
      params: { ...info, offset: info.total, data: '', end: false } }
    const overhead = Buffer.byteLength(JSON.stringify(envelope))
    const capacity = Math.min(256 * 1024, Math.floor((this.limits.maxFrameBytes - overhead) / 4) * 3)
    if (capacity <= 0) throw new RpcConnectionError('overflow', 'RPC 行帧无法容纳分段元数据')
    const bytes = Math.min(capacity, info.total - frame.offset)
    if (Math.ceil(info.total / capacity) > this.limits.maxChunkParts) {
      throw new RpcConnectionError('overflow', 'RPC 分段碎片数量超过限制')
    }
    envelope.params.offset = frame.offset
    envelope.params.data = frame.buffer.subarray(frame.offset, frame.offset + bytes).toString('base64')
    envelope.params.end = frame.offset + bytes === info.total
    return { buffer: Buffer.from(`${JSON.stringify(envelope)}\n`), bytes }
  }
  /** 尊重 Writable 的背压；只有 drain 后才继续，不因长业务任务暂停管道读取。 */
  private pump(): void {
    if (this.pumping || this.blocked || this.closed) return
    this.pumping = true
    try {
      while (!this.blocked && !this.closed) {
        // 短控制请求可以穿过正在分段的大控制消息；通知只取队首，保持事件顺序。
        const queue = this.controls.length ? this.controls : this.events
        const small = queue === this.controls ? queue.findIndex((item) => !item.chunk) : -1
        const index = small >= 0 ? small : 0
        const frame = queue[index]
        if (!frame) return
        const part = frame.chunk ? this.chunkFrame(frame) : { buffer: frame.buffer, bytes: frame.buffer.length }
        frame.offset += part.bytes
        if (!frame.chunk || frame.offset === frame.chunk.total) {
          queue.splice(index, 1)
          this.queuedBytes -= frame.buffer.length
        }
        this.blocked = !this.output.write(part.buffer, (error) => { if (error) this.onIoError() })
      }
    } catch { this.onIoError() }
    finally { this.pumping = false }
  }
  private readonly onDrain = (): void => { this.blocked = false; this.pump() }
  private readonly onEnd = (): void => this.close(new RpcConnectionError('eof', this.fragmentBytes || this.chunks.incomplete
    ? 'RPC 管道以不完整消息结束' : 'RPC 输入管道已关闭'))
  private readonly onIoError = (): void => this.close(new RpcConnectionError('io', 'RPC 管道读写失败'))
  private readonly onInputClose = (): void => {
    this.onEnd()
    this.input.off('error', this.onIoError)
    this.input.off('close', this.onInputClose)
  }
  private readonly onOutputClose = (): void => {
    this.close(new RpcConnectionError(this.output.writableEnded ? 'eof' : 'io',
      this.output.writableEnded ? 'RPC 输出管道已关闭' : 'RPC 输出管道异常关闭'))
    this.output.off('error', this.onIoError)
    this.output.off('close', this.onOutputClose)
  }
  private callCloseListener(listener: (error: RpcConnectionError) => void, error: RpcConnectionError): void {
    try { listener(error) } catch { console.warn('[应用协议] 连接清理回调失败') }
  }

  /** 先使连接失效，再拒绝等待与取消在途处理；旧 Promise 完成不得向新连接投递。 */
  close(error = new RpcConnectionError('closed', 'RPC 连接已关闭')): void {
    if (this.closed) return
    this.failure = error
    this.input.off('data', this.onData)
    this.input.off('end', this.onEnd)
    this.input.pause()
    this.output.off('drain', this.onDrain)
    // error 监听保留到各管道 close，防止稍晚的 EPIPE 成为未捕获异常。
    for (const pending of this.pending.values()) { pending.cleanup(); pending.reject(error) }
    this.pending.clear()
    for (const controller of this.incoming.values()) controller.abort()
    this.incoming.clear()
    this.handlers.clear()
    this.notifications.clear()
    this.chunks.close()
    this.fragment = Buffer.alloc(0)
    this.fragmentBytes = 0
    this.controls.length = 0
    this.events.length = 0
    this.queuedBytes = 0
    for (const listener of this.closeListeners) this.callCloseListener(listener, error)
    this.closeListeners.clear()
  }
}
