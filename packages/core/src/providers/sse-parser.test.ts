import { describe, expect, test } from 'bun:test'

import { parseServerSentEvents, SseParseError } from './sse-parser'
import type { ServerSentEvent } from './types'

const encoder = new TextEncoder()

function streamFromChunks(chunks: readonly Uint8Array[]): ReadableStream<Uint8Array> {
  return new ReadableStream<Uint8Array>({
    start(controller) {
      for (const chunk of chunks) {
        controller.enqueue(chunk)
      }
      controller.close()
    },
  })
}

function streamFromText(text: string): ReadableStream<Uint8Array> {
  return streamFromChunks([encoder.encode(text)])
}

async function collect(
  stream: ReadableStream<Uint8Array>,
  options?: Parameters<typeof parseServerSentEvents>[1],
): Promise<ServerSentEvent[]> {
  const events: ServerSentEvent[] = []
  for await (const event of parseServerSentEvents(stream, options)) {
    events.push(event)
  }
  return events
}

describe('parseServerSentEvents', () => {
  test('跨任意字节分片解析 Unicode、多行 data 与三种换行符', async () => {
    const bytes = encoder.encode(
      'event: token\r\ndata: 你\rdata: 好\n\nid: final\ndata: done',
    )
    const chunks = Array.from(bytes, (byte) => Uint8Array.of(byte))

    expect(await collect(streamFromChunks(chunks))).toEqual([
      { event: 'token', data: '你\n好' },
      { event: 'message', data: 'done', id: 'final' },
    ])
  })

  test('忽略注释与未知字段，并且只移除冒号后的一个空格', async () => {
    expect(
      await collect(
        streamFromText(': keepalive\nunknown: x\ndata:  one\ndata\n\n'),
      ),
    ).toEqual([{ event: 'message', data: ' one\n' }])
  })

  test('空 data 会派发事件，没有 data 的块不会派发', async () => {
    expect(
      await collect(streamFromText('event: ignored\n\ndata:\n\n')),
    ).toEqual([{ event: 'message', data: '' }])
  })

  test('继承、清空和校验 id，并只接受非负十进制 retry', async () => {
    expect(
      await collect(
        streamFromText(
          'id: 7\nretry: 1200\ndata: a\n\n' +
            'id: bad\0id\nretry: -1\ndata: b\n\n' +
            'id:\nretry: nope\ndata: c\n\n',
        ),
      ),
    ).toEqual([
      { event: 'message', data: 'a', id: '7', retry: 1200 },
      { event: 'message', data: 'b', id: '7' },
      { event: 'message', data: 'c', id: '' },
    ])
  })

  test('消费 UTF-8 BOM，并保留被拆开的多字节字符', async () => {
    const bytes = encoder.encode('\uFEFFdata: 中文\n\n')
    expect(
      await collect(
        streamFromChunks([bytes.slice(0, 10), bytes.slice(10, 11), bytes.slice(11)]),
      ),
    ).toEqual([{ event: 'message', data: '中文' }])
  })

  test('限制单行和单事件 data 大小', async () => {
    await expect(
      collect(streamFromText('data: 12345\n\n'), { maxLineLength: 5 }),
    ).rejects.toMatchObject({ code: 'line_too_large' } satisfies Partial<SseParseError>)

    await expect(
      collect(streamFromText('data: 123\ndata: 456\n\n'), {
        maxEventDataLength: 6,
      }),
    ).rejects.toMatchObject({ code: 'event_too_large' } satisfies Partial<SseParseError>)
  })

  test('无效限制值回退默认值', async () => {
    expect(
      await collect(streamFromText('data: ok\n\n'), {
        maxLineLength: 0,
        maxEventDataLength: Number.NaN,
      }),
    ).toEqual([{ event: 'message', data: 'ok' }])
  })

  test('无效 UTF-8 返回稳定错误码', async () => {
    await expect(
      collect(streamFromChunks([Uint8Array.of(0xff)])),
    ).rejects.toMatchObject({ code: 'invalid_utf8' } satisfies Partial<SseParseError>)
  })

  test('外部取消和消费者提前退出都会取消底层流', async () => {
    const abortController = new AbortController()
    const abortReason = new DOMException('停止测试', 'AbortError')
    let abortCancelled = false
    const abortStream = new ReadableStream<Uint8Array>({
      start(controller) {
        controller.enqueue(encoder.encode('data: first\n\n'))
      },
      cancel(reason) {
        abortCancelled = reason === abortReason
      },
    })
    const iterator = parseServerSentEvents(abortStream, {
      signal: abortController.signal,
    })
    expect(await iterator.next()).toEqual({
      done: false,
      value: { event: 'message', data: 'first' },
    })
    abortController.abort(abortReason)
    await expect(iterator.next()).rejects.toBe(abortReason)
    expect(abortCancelled).toBe(true)

    let breakCancelled = false
    const breakStream = new ReadableStream<Uint8Array>({
      start(controller) {
        controller.enqueue(encoder.encode('data: first\n\n'))
      },
      cancel() {
        breakCancelled = true
      },
    })
    for await (const _event of parseServerSentEvents(breakStream)) {
      break
    }
    expect(breakCancelled).toBe(true)
  })

  test('外部取消时底层 cancel 拒绝不会覆盖统一的取消原因', async () => {
    const abortController = new AbortController()
    const abortReason = new DOMException('用户停止', 'AbortError')
    const stream = new ReadableStream<Uint8Array>({
      start(controller) {
        controller.enqueue(encoder.encode('data: first\n\n'))
      },
      cancel() {
        return Promise.reject(new Error('底层取消失败'))
      },
    })
    const iterator = parseServerSentEvents(stream, { signal: abortController.signal })
    expect(await iterator.next()).toEqual({
      done: false,
      value: { event: 'message', data: 'first' },
    })

    abortController.abort(abortReason)
    await expect(iterator.next()).rejects.toBe(abortReason)
  })

  test('自然结束不会额外取消底层流', async () => {
    let cancelled = false
    const stream = new ReadableStream<Uint8Array>({
      start(controller) {
        controller.enqueue(encoder.encode('data: ok\n\n'))
        controller.close()
      },
      cancel() {
        cancelled = true
      },
    })

    expect(await collect(stream)).toHaveLength(1)
    expect(cancelled).toBe(false)
  })
})
