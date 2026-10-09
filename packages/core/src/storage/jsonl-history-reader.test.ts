import { afterEach, describe, expect, test } from 'bun:test'
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { JsonlHistoryReader } from './jsonl-history-reader'
import { writeTextFileAtomic } from './safe-file'

const directories: string[] = []
afterEach(() => { for (const directory of directories.splice(0)) rmSync(directory, { recursive: true, force: true }) })
interface Message { id: string; text: string }
function fixture(maxFileBytes = 128 * 1024 * 1024) {
  const directory = mkdtempSync(join(tmpdir(), 'axon-history-reader-'))
  directories.push(directory)
  const path = join(directory, 'messages.jsonl')
  const create = () => new JsonlHistoryReader<Message>({ path, maxFileBytes, normalize(value) {
    if (!value || typeof value !== 'object' || !('id' in value) || typeof value.id !== 'string'
      || !('text' in value) || typeof value.text !== 'string') throw new Error('无效消息')
    return { message: { id: value.id, text: value.text }, id: value.id }
  } })
  return { path, create }
}

describe('JSONL 文件快照增量读取', () => {
  test('跨块 UTF-8、坏行/重复隔离和末行无换行；不在只读分页中重写历史', () => {
    const f = fixture()
    const values = Array.from({ length: 230 }, (_, i) => ({ id: `m-${i}`, text: `第${i}条-${'汉🙂'.repeat(137)}` }))
    const raw = ['坏行', '', ...values.slice(0, 110).map((value) => JSON.stringify(value)), JSON.stringify(values[0]),
      '{"id":"invalid"}', ...values.slice(110).map((value) => JSON.stringify(value))].join('\n')
    writeFileSync(f.path, raw)
    const reader = f.create(), messages: Message[] = []
    try {
      let pages = 0
      while (true) {
        const result = reader.readPage()
        pages += 1
        expect(result.messages.length).toBeLessThanOrEqual(100)
        messages.push(...result.messages)
        if (result.done) break
      }
      expect(pages).toBe(3)
      expect(messages).toEqual(values)
      expect(readFileSync(f.path, 'utf8')).toBe(raw)
    } finally { reader.close() }
    expect(() => reader.readPage()).toThrow('历史快照已关闭')
  })

  test('原子替换期间续页保持旧 inode；新快照读取最新完整版本', () => {
    const f = fixture(), old = Array.from({ length: 210 }, (_, i) => ({ id: `m-${i}`, text: `旧-${i}` }))
    writeTextFileAtomic(f.path, old.map((value) => JSON.stringify(value)).join('\n') + '\n')
    const reader = f.create()
    try {
      expect(reader.readPage().messages).toEqual(old.slice(0, 100))
      writeTextFileAtomic(f.path, JSON.stringify({ id: 'replacement', text: '替换后的正文' }) + '\n')
      expect(reader.readPage()).toEqual({ messages: old.slice(100, 200), done: false })
      expect(reader.readPage()).toEqual({ messages: old.slice(200), done: true })
      const latest = f.create()
      try { expect(latest.readPage()).toEqual({ messages: [{ id: 'replacement', text: '替换后的正文' }], done: true }) }
      finally { latest.close() }
    } finally { reader.close() }
  })

  test('正文预算分页，超预算单条完整传递，不截断内容', () => {
    const f = fixture(), values = [{ id: 'first', text: '汉'.repeat(190_000) }, { id: 'large', text: '🙂'.repeat(400_000) },
      { id: 'last', text: '末尾' }]
    writeFileSync(f.path, values.map((value) => JSON.stringify(value)).join('\n'))
    const reader = f.create()
    try {
      expect(reader.readPage()).toEqual({ messages: [values[0]!], done: false })
      expect(reader.readPage()).toEqual({ messages: [values[1]!], done: false })
      expect(reader.readPage()).toEqual({ messages: [values[2]!], done: true })
    } finally { reader.close() }
  })

  test('不存在文件是空快照；文件容量仍由当前领域限制，拒绝不完整读取', () => {
    const f = fixture(10), empty = f.create()
    try { expect(empty.readPage()).toEqual({ messages: [], done: true }) } finally { empty.close() }
    writeFileSync(f.path, 'x'.repeat(11))
    expect(() => f.create()).toThrow('历史文件过大')
    const truncated = fixture(), values = Array.from({ length: 210 }, (_, i) => ({ id: `m-${i}`, text: '原文'.repeat(500) }))
    writeFileSync(truncated.path, values.map((value) => JSON.stringify(value)).join('\n'))
    const reader = truncated.create()
    try {
      reader.readPage()
      // 非原子外部截断不属于应用正常写入；不能把提前 EOF 当完整恢复。
      writeFileSync(truncated.path, '')
      expect(() => { while (!reader.readPage().done) { /* 读到尚未缓存的部分。 */ } }).toThrow('历史快照读取未完成')
    } finally { reader.close() }
  })
})
