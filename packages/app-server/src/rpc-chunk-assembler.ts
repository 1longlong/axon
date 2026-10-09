/** 大消息接收状态：累计实收字节而非按声明预分配，完整校验后才交给业务。 */
import type { RpcId, RpcJsonObject, RpcParams } from '@axon/shared'

interface IdentifiedChunkHeader { kind: 'request' | 'response'; id: RpcId }
interface NotificationChunkHeader { kind: 'notification' }
export type RpcChunkHeader = IdentifiedChunkHeader | NotificationChunkHeader
export type RpcChunkMetadata = RpcChunkHeader & { transferId: string; total: number }
interface ChunkState {
  header: RpcChunkMetadata
  parts: Buffer[]
  bytes: number
  count: number
  ignored: boolean
  timer: ReturnType<typeof setTimeout>
}
export interface RpcChunkLimits {
  maxMessageBytes: number
  maxBufferedMessageBytes: number
  maxChunkTransfers: number
  maxChunkParts: number
  chunkTimeoutMs: number
}
const TRANSFER_ID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/

/** 与格式错误分开归一；不把原始分段或凭据带入诊断。 */
export class RpcChunkLimitError extends Error {}

function isId(value: unknown): value is RpcId {
  return value === null || typeof value === 'string' || typeof value === 'number' && Number.isFinite(value)
}
/** 只校验传输身份与字节声明，不把声明当作会话 owner 或执行权限。 */
function parse(params: RpcParams): { header: RpcChunkMetadata; offset: number; data: string; end: boolean } {
  if (Array.isArray(params)) throw new Error('分段格式无效')
  const { transferId, total, kind, id, offset, data, end } = params
  if (Object.keys(params).some((key) => !['transferId', 'total', 'kind', 'id', 'offset', 'data', 'end'].includes(key))
    || typeof transferId !== 'string' || !TRANSFER_ID.test(transferId)
    || typeof total !== 'number' || !Number.isSafeInteger(total) || total <= 0
    || typeof offset !== 'number' || !Number.isSafeInteger(offset) || offset < 0
    || typeof data !== 'string' || !data || typeof end !== 'boolean') throw new Error('分段格式无效')
  let identity: RpcChunkHeader
  if (kind === 'notification' && !Object.hasOwn(params, 'id')) identity = { kind }
  else if ((kind === 'request' || kind === 'response') && isId(id)) identity = { kind, id }
  else throw new Error('分段身份无效')
  return { header: { ...identity, transferId, total }, offset, data, end }
}
function same(a: RpcChunkMetadata, b: RpcChunkMetadata): boolean {
  return a.total === b.total && a.kind === b.kind && (a.kind === 'notification'
    || b.kind !== 'notification' && a.id === b.id)
}

export class RpcChunkAssembler {
  private readonly active = new Map<string, ChunkState>()
  private bufferedBytes = 0

  constructor(private readonly limits: RpcChunkLimits,
    private readonly acceptHeader: (header: RpcChunkMetadata) => boolean,
    private readonly onTimeout: () => void,
    private readonly heldBytes: () => number) {}

  get incomplete(): boolean { return this.active.size > 0 }
  get bufferedSize(): number { return this.bufferedBytes }

  /** 验证声明、顺序和容量；最后一段前不解析 JSON、不分配运行或调用工具。 */
  accept(params: RpcParams): { header: RpcChunkMetadata; bytes: Buffer } | undefined {
    const { header, offset, data, end } = parse(params)
    if (header.total > this.limits.maxMessageBytes) throw new RpcChunkLimitError('分段消息超限')
    let state = this.active.get(header.transferId)
    if (!state) {
      if (offset !== 0) throw new Error('分段起点无效')
      if (this.active.size >= this.limits.maxChunkTransfers) throw new RpcChunkLimitError('分段数量超限')
      if (header.kind === 'request' && [...this.active.values()].some((item) =>
        item.header.kind === 'request' && item.header.id === header.id)) throw new Error('分段请求身份重复')
      state = { header, parts: [], bytes: 0, count: 0, ignored: !this.acceptHeader(header),
        timer: setTimeout(this.onTimeout, this.limits.chunkTimeoutMs) }
      this.active.set(header.transferId, state)
    } else if (!same(header, state.header)) throw new Error('分段声明变化')
    // 拒绝非规范 base64 与碎片洪泛；内存只随实际收到的有效内容增长。
    const bytes = Buffer.from(data, 'base64')
    if (bytes.toString('base64') !== data || !bytes.length || offset !== state.bytes
      || bytes.length > header.total - state.bytes
      || end !== (state.bytes + bytes.length === header.total)) throw new Error('分段长度或顺序无效')
    if (++state.count > this.limits.maxChunkParts) throw new RpcChunkLimitError('分段碎片数量超限')
    if (!state.ignored && this.bufferedBytes + bytes.length + this.heldBytes() > this.limits.maxBufferedMessageBytes) {
      throw new RpcChunkLimitError('分段接收积压超限')
    }
    state.bytes += bytes.length
    if (!state.ignored) {
      state.parts.push(bytes)
      this.bufferedBytes += bytes.length
    }
    if (!end) return undefined
    this.active.delete(header.transferId)
    clearTimeout(state.timer)
    if (state.ignored) return undefined
    this.bufferedBytes -= state.bytes
    return { header: state.header, bytes: Buffer.concat(state.parts, state.bytes) }
  }

  /** 取消本地响应等待时释放已收正文；继续校验线上余段，不消费迟到结果。 */
  discardResponse(id: RpcId): void {
    for (const state of this.active.values()) {
      if (state.header.kind !== 'response' || state.header.id !== id || state.ignored) continue
      this.bufferedBytes -= state.bytes
      state.parts.length = 0
      state.ignored = true
    }
  }
  cancelRequest(id: RpcId): void {
    for (const state of this.active.values()) {
      if (state.header.kind === 'request' && state.header.id === id) this.remove(state.header.transferId)
    }
  }
  /** 发起者中止未发送的余段时，释放对应半条消息，不能把半条交给业务执行。 */
  abort(params: RpcParams): void {
    const value = params as RpcJsonObject
    if (Array.isArray(params) || Object.keys(params).length !== 1
      || typeof value.transferId !== 'string' || !TRANSFER_ID.test(value.transferId)) throw new Error('分段中止格式无效')
    this.remove(value.transferId)
  }
  private remove(id: string): void {
    const state = this.active.get(id)
    if (!state) return
    clearTimeout(state.timer)
    if (!state.ignored) this.bufferedBytes -= state.bytes
    state.parts.length = 0
    this.active.delete(id)
  }
  /** 连接失效后释放半条消息与超时引用，不能向下一连接复用状态。 */
  close(): void { for (const id of this.active.keys()) this.remove(id) }
}
