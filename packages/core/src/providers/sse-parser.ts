import { ProviderStreamProtocolError, type ServerSentEvent } from './types'

const DEFAULT_MAX_LINE_LENGTH = 256 * 1024
const DEFAULT_MAX_EVENT_DATA_LENGTH = 1024 * 1024

export type SseParseErrorCode =
  | 'line_too_large'
  | 'event_too_large'
  | 'invalid_utf8'

export class SseParseError extends ProviderStreamProtocolError {
  readonly code: SseParseErrorCode

  constructor(code: SseParseErrorCode, message: string, options?: ErrorOptions) {
    super(message, options)
    this.name = 'SseParseError'
    this.code = code
  }
}

export interface ParseServerSentEventsOptions {
  signal?: AbortSignal
  /** 单行允许的最大字符数。 */
  maxLineLength?: number
  /** 单个事件拼接后 data 允许的最大字符数。 */
  maxEventDataLength?: number
}

interface PendingEvent {
  event?: string
  dataLines: string[]
  dataLength: number
  retry?: number
}

function resolveLimit(value: number | undefined, fallback: number): number {
  return value !== undefined && Number.isSafeInteger(value) && value > 0
    ? value
    : fallback
}

function abortReason(signal: AbortSignal): Error {
  if (signal.reason instanceof Error) {
    return signal.reason
  }

  return new DOMException('SSE 解析已取消', 'AbortError')
}

/**
 * 严格、增量地解析 SSE 字节流。
 *
 * 本层只处理 SSE 线协议；JSON、`[DONE]` 等供应商语义由适配器负责。
 */
export async function* parseServerSentEvents(
  stream: ReadableStream<Uint8Array>,
  options: ParseServerSentEventsOptions = {},
): AsyncGenerator<ServerSentEvent> {
  const reader = stream.getReader()
  const decoder = new TextDecoder('utf-8', { fatal: true })
  const maxLineLength = resolveLimit(
    options.maxLineLength,
    DEFAULT_MAX_LINE_LENGTH,
  )
  const maxEventDataLength = resolveLimit(
    options.maxEventDataLength,
    DEFAULT_MAX_EVENT_DATA_LENGTH,
  )
  const signal = options.signal

  let buffer = ''
  let streamDone = false
  let lastEventId: string | undefined
  let pending: PendingEvent = { dataLines: [], dataLength: 0 }

  const resetPending = (): void => {
    pending = { dataLines: [], dataLength: 0 }
  }

  /** 空行触发派发；没有 data 的字段组只更新连接状态，不生成业务事件。 */
  const dispatch = (): ServerSentEvent | undefined => {
    if (pending.dataLines.length === 0) {
      resetPending()
      return undefined
    }

    const event: ServerSentEvent = {
      event: pending.event ?? 'message',
      data: pending.dataLines.join('\n'),
    }

    if (lastEventId !== undefined) {
      event.id = lastEventId
    }
    if (pending.retry !== undefined) {
      event.retry = pending.retry
    }

    resetPending()
    return event
  }

  /** 按 SSE 字段规则累计一行，并在事件边界返回完整事件。 */
  const processLine = (line: string): ServerSentEvent | undefined => {
    if (line === '') {
      return dispatch()
    }
    if (line.startsWith(':')) {
      return undefined
    }

    const colonIndex = line.indexOf(':')
    const field = colonIndex === -1 ? line : line.slice(0, colonIndex)
    let value = colonIndex === -1 ? '' : line.slice(colonIndex + 1)
    if (value.startsWith(' ')) {
      value = value.slice(1)
    }

    switch (field) {
      case 'event':
        pending.event = value
        break
      case 'data': {
        const nextLength =
          pending.dataLength + (pending.dataLines.length > 0 ? 1 : 0) + value.length
        if (nextLength > maxEventDataLength) {
          throw new SseParseError(
            'event_too_large',
            `SSE 事件 data 超过 ${maxEventDataLength} 个字符`,
          )
        }
        pending.dataLines.push(value)
        pending.dataLength = nextLength
        break
      }
      case 'id':
        if (!value.includes('\0')) {
          lastEventId = value
        }
        break
      case 'retry':
        if (/^\d+$/.test(value)) {
          const retry = Number(value)
          if (Number.isSafeInteger(retry)) {
            pending.retry = retry
          }
        }
        break
      default:
        break
    }

    return undefined
  }

  /** 从字符缓冲区取一行；分片末尾的 CR 要等待下一块，以识别 CRLF。 */
  const takeLine = (atEnd: boolean): string | undefined => {
    for (let index = 0; index < buffer.length; index += 1) {
      const character = buffer[index]
      if (character !== '\n' && character !== '\r') {
        continue
      }
      if (character === '\r' && index === buffer.length - 1 && !atEnd) {
        return undefined
      }

      const line = buffer.slice(0, index)
      const delimiterLength =
        character === '\r' && buffer[index + 1] === '\n' ? 2 : 1
      buffer = buffer.slice(index + delimiterLength)
      return line
    }

    if (atEnd && buffer.length > 0) {
      const line = buffer
      buffer = ''
      return line
    }

    if (buffer.length > maxLineLength + (buffer.endsWith('\r') ? 1 : 0)) {
      throw new SseParseError(
        'line_too_large',
        `SSE 单行超过 ${maxLineLength} 个字符`,
      )
    }
    return undefined
  }

  const ensureLineLength = (line: string): void => {
    if (line.length > maxLineLength) {
      throw new SseParseError(
        'line_too_large',
        `SSE 单行超过 ${maxLineLength} 个字符`,
      )
    }
  }

  const cancelOnAbort = (): void => {
    // abort 监听器不能等待 Promise；主动吞掉底层流的取消拒绝，解析协程会负责抛出统一终态。
    void reader.cancel(signal === undefined ? undefined : signal.reason).catch(() => {})
  }
  const throwIfAborted = (): void => {
    if (signal?.aborted === true) {
      throw abortReason(signal)
    }
  }
  signal?.addEventListener('abort', cancelOnAbort, { once: true })

  try {
    // 网络块先经过同一个流式解码器，避免 UTF-8 多字节字符被分片截断。
    while (!streamDone) {
      throwIfAborted()

      let result
      try {
        result = await reader.read()
      } catch (error) {
        throwIfAborted()
        throw error
      }

      throwIfAborted()

      if (result.done) {
        streamDone = true
        try {
          buffer += decoder.decode()
        } catch (error) {
          throw new SseParseError('invalid_utf8', 'SSE 包含无效的 UTF-8 字节', {
            cause: error,
          })
        }
      } else {
        try {
          buffer += decoder.decode(result.value, { stream: true })
        } catch (error) {
          throw new SseParseError('invalid_utf8', 'SSE 包含无效的 UTF-8 字节', {
            cause: error,
          })
        }
      }

      // 一个网络块可能包含多行，也可能只有一行的一部分。
      let line = takeLine(streamDone)
      while (line !== undefined) {
        ensureLineLength(line)
        const event = processLine(line)
        if (event !== undefined) {
          yield event
        }
        line = takeLine(streamDone)
      }
    }

    // EOF 时补一个逻辑空行，让没有尾随空行的最后一个事件仍能派发。
    const finalEvent = processLine('')
    if (finalEvent !== undefined) {
      yield finalEvent
    }
  } finally {
    signal?.removeEventListener('abort', cancelOnAbort)
    // 解析失败或消费者提前退出时取消上游；自然读完则不重复取消。
    if (!streamDone) {
      try {
        await reader.cancel()
      } catch {
        // 保留原始解析错误或消费者的提前退出结果。
      }
    }
    reader.releaseLock()
  }
}
