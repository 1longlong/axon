import { describe, expect, test } from 'bun:test'
import { Writable } from 'node:stream'
import type { ExecAgentEvent } from '@axon/shared'
import { ExecOutputError, ExecOutputStream } from './output-stream'

const event = (sequence = 1): ExecAgentEvent => ({ version: 1, executionId: 'exec', sequence, timestamp: 1, type: 'agent_event',
  run: { runId: 'run', sessionId: 'session', runStartedAt: 1 }, visibleSessionId: 'session',
  event: { type: 'run_started', sessionId: 'session', runStartedAt: 1, source: 'external' } })
/** 受控真实 Writable 回调用于验证背压；不是把入队数组当已交付 stdout。 */
function slow() {
  const chunks: string[] = [], callbacks: Array<(error?: Error | null) => void> = []
  const output = new Writable({ highWaterMark: 1, write(chunk: Buffer, _encoding, callback) {
    chunks.push(chunk.toString('utf8')); callbacks.push(callback)
  } })
  return { output, chunks, callbacks }
}

describe('exec 有界 stdout 单写入者', () => {
  test('JSONL 保持序号、Unicode 和换行，逐个真实 write 后才 flush，最终正文不重复输出', async () => {
    const f = slow(), sink = new ExecOutputStream(f.output, true)
    const unicode: ExecAgentEvent = { ...event(2), event: { type: 'stream', sessionId: 'session', runStartedAt: 1,
      source: 'external', payload: { kind: 'sdk_message', message: { type: 'assistant', uuid: 'unicode', parent_tool_use_id: null,
        message: { content: [{ type: 'text', text: '中文\n第二行\u001b' }] } } } } }
    sink.emit(event(1)); sink.emit(unicode)
    let delivered = false
    const flushed = sink.writeFinal('模型正文\n不是额外 JSONL 行').then(() => { delivered = true })
    expect(f.chunks).toHaveLength(1)
    expect(delivered).toBe(false)
    f.callbacks.shift()!()
    expect(f.chunks).toHaveLength(2)
    expect(delivered).toBe(false)
    f.callbacks.shift()!()
    await flushed
    expect(delivered).toBe(true)
    expect(f.chunks.map((line) => JSON.parse(line).sequence)).toEqual([1, 2])
    expect(f.chunks[1]!.split('\n')).toHaveLength(2)
    expect(f.chunks[1]).not.toContain('\u001b')
    expect(JSON.parse(f.chunks[1]!).event.payload.message.message.content[0].text).toBe('中文\n第二行\u001b')
    await expect(sink.writeFinal('重复')).rejects.toBeInstanceOf(ExecOutputError)
    sink.dispose(); f.output.destroy()
  })
  test('普通模式只输出最终正文，保留空白；无正文不编造文字，不关闭宿主 stdout', async () => {
    const chunks: string[] = []
    const output = new Writable({ write(chunk: Buffer, _encoding, callback) { chunks.push(chunk.toString()); callback() } })
    const sink = new ExecOutputStream(output, false)
    sink.emit(event()); await sink.flush()
    expect(chunks).toEqual([])
    await sink.writeFinal('  原样正文\n\n')
    expect(chunks).toEqual(['  原样正文\n\n'])
    sink.dispose(); expect(output.writableEnded).toBe(false); output.destroy()
    const empty = slow(), emptySink = new ExecOutputStream(empty.output, false)
    await emptySink.writeFinal('')
    expect(empty.chunks).toEqual([])
    emptySink.dispose(); empty.output.destroy()
  })
  test('容量包含在途 write；溢出立即封口并唤醒 flush，不丢事件后假装成功', async () => {
    const f = slow(), size = Buffer.byteLength(`${JSON.stringify(event())}\n`)
    const sink = new ExecOutputStream(f.output, true, size + 1)
    sink.emit(event())
    const outcome = sink.flush().catch((error: unknown) => error)
    expect(() => sink.emit(event(2))).toThrow(ExecOutputError)
    expect(await outcome).toBeInstanceOf(ExecOutputError)
    expect(sink.signal.aborted).toBe(true)
    expect(f.chunks).toHaveLength(1)
    sink.dispose(); f.callbacks.shift()!(); f.output.destroy()
  })
  test('EPIPE/提前 close/写入中 dispose 都不能当成功；迟到 error 不成为未处理异常', async () => {
    for (const mode of ['error', 'close', 'dispose']) {
      const f = slow(), sink = new ExecOutputStream(f.output, true)
      sink.emit(event())
      const outcome = sink.flush().catch((error: unknown) => error)
      if (mode === 'error') { f.callbacks.shift()!(Object.assign(new Error('fixture-secret'), { code: 'EPIPE' })); sink.dispose() }
      else if (mode === 'close') f.output.destroy()
      else { sink.dispose(); f.callbacks.shift()!(new Error('late fixture-secret')) }
      const error = await outcome
      expect(error).toBeInstanceOf(ExecOutputError)
      expect((error as Error).message).not.toContain('fixture-secret')
      expect(sink.signal.aborted).toBe(true)
      sink.dispose(); f.output.destroy()
      await new Promise<void>((resolve) => setImmediate(resolve))
      expect(f.output.listenerCount('error')).toBe(0)
    }
  })
})
