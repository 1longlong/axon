/** 存储的分段/崩溃边界集中验收，不依赖真实用户目录。 */
import { afterEach, expect, test } from 'bun:test'
import { appendFileSync, mkdtempSync, readFileSync, readdirSync, renameSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { loopDocument, loopRun } from '../../test-support/loop-fixture'
import { LoopRepository } from './loop-repository'

const roots: string[] = []
afterEach(() => { for (const root of roots.splice(0)) rmSync(root, { recursive: true }) })
function open() {
  const root = mkdtempSync(join(tmpdir(), 'axon-loop-segments-')); roots.push(root)
  return { root, document: loopDocument(root), options: { segmentBytes: 4096 } }
}

test('日志跨段连续恢复全部结果，忽略派生缓存且可继续提交', () => {
  const f = open(), repository = new LoopRepository(f.root, f.options)
  repository.commit(f.document)
  for (let index = 1; index <= 12; index++) { f.document.runCount++; repository.commit(f.document, loopRun(f.document, index)) }
  const directory = join(f.root, f.document.definition.id)
  expect(readdirSync(directory).filter((name) => /^journal-\d/.test(name)).length).toBeGreaterThan(1)
  writeFileSync(join(directory, 'snapshot.json'), '无效派生缓存')
  const expected = repository.runs(f.document.definition.id); repository.dispose()
  const restored = new LoopRepository(f.root, f.options)
  expect(restored.failure(f.document.definition.id)).toBeUndefined()
  expect(restored.runs(f.document.definition.id)).toEqual(expected)
  f.document.runCount++; restored.commit(f.document, loopRun(f.document, 13))
  expect(restored.runs(f.document.definition.id)).toHaveLength(13)
  restored.dispose()
})

test('轮换后活动段尚未建立时仍恢复已提交段，不重置全局序号', () => {
  const f = open(), repository = new LoopRepository(f.root, f.options)
  repository.commit(f.document); repository.commit(f.document, loopRun(f.document, 1)); repository.dispose()
  const directory = join(f.root, f.document.definition.id)
  renameSync(join(directory, 'journal.jsonl'), join(directory, 'journal-0000000000000002.jsonl'))
  const restored = new LoopRepository(f.root, f.options)
  expect(restored.runs(f.document.definition.id)).toHaveLength(1)
  restored.commit(f.document, loopRun(f.document, 2)); restored.dispose()
  const verified = new LoopRepository(f.root, f.options)
  expect(verified.runs(f.document.definition.id)).toHaveLength(2)
  expect(verified.failure(f.document.definition.id)).toBeUndefined(); verified.dispose()
})

test('已关闭段损坏只封口，不截断或用缓存伪造恢复', () => {
  const f = open(), repository = new LoopRepository(f.root, f.options)
  repository.commit(f.document)
  for (let index = 1; index <= 5; index++) repository.commit(f.document, loopRun(f.document, index))
  repository.dispose()
  const directory = join(f.root, f.document.definition.id)
  const archive = join(directory, readdirSync(directory).filter((name) => /^journal-\d/.test(name)).sort()[0]!)
  appendFileSync(archive, '{"partial":')
  const bytes = readFileSync(archive)
  const restored = new LoopRepository(f.root, f.options)
  // 第一段尚有完整有效前缀；坏片段不会被当作已提交事件继续执行。
  expect(restored.list()).toHaveLength(1)
  expect(() => restored.commit(f.document)).toThrow('损坏')
  expect(readFileSync(archive)).toEqual(bytes); restored.dispose()
})
