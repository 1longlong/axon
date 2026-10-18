/** 历史产物不借用当前文件；损坏、链接和超限不能冒充完整版本。 */
import { expect, test } from 'bun:test'
import { mkdtempSync, mkdirSync, realpathSync, rmSync, symlinkSync, unlinkSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { loopDocument } from '../../test-support/loop-fixture'
import { LoopArtifactStore } from './loop-artifacts'

test('保留两次独立内容和 Diff，截断快照不误报删除，损坏哈希拒绝读取', () => {
  const root = realpathSync(mkdtempSync(join(tmpdir(), 'axon-loop-artifacts-')))
  const definition = loopDocument(root).definition
  const source = dirname(definition.taskFile), data = join(root, 'data')
  mkdirSync(source, { recursive: true }); mkdirSync(join(data, definition.id), { recursive: true })
  const store = new LoopArtifactStore(data)
  try {
    writeFileSync(join(source, 'report.md'), '---\ntitle: 初次产物\n---\n第一版')
    writeFileSync(join(source, 'removed.md'), '稍后删除')
    expect(store.capture(definition, 'run-1')).toBe(true)
    writeFileSync(join(source, 'report.md'), '第二版'); unlinkSync(join(source, 'removed.md'))
    expect(store.capture(definition, 'run-2')).toBe(true)
    expect(store.read(definition.id, 'report.md', 'run-1').content).toContain('第一版')
    expect(store.read(definition.id, 'report.md', 'run-2').content).toBe('第二版')
    expect(store.diff(definition.id, 'run-2', 'run-1')).toEqual([
      expect.objectContaining({ path: 'removed.md', status: 'deleted' }),
      expect.objectContaining({ path: 'report.md', status: 'modified', after: '第二版' }),
    ])
    symlinkSync(join(source, 'report.md'), join(source, 'linked.md'))
    writeFileSync(join(source, 'oversize.md'), Buffer.alloc(2 * 1024 * 1024 + 1))
    writeFileSync(join(source, 'binary.bin'), Buffer.from([0, 255, 0]))
    expect(store.capture(definition, 'run-3')).toBe(false)
    expect(store.diff(definition.id, 'run-3', 'run-1').some((file) => file.status === 'deleted')).toBe(false)
    expect(store.list(definition.id).map((file) => file.path)).toEqual(['binary.bin', 'report.md'])
    expect(store.read(definition.id, 'binary.bin').encoding).toBe('base64')
    expect(() => store.read(definition.id, '../report.md')).toThrow('没有登记')
    const old = store.list(definition.id, 'run-1').find((file) => file.path === 'report.md')!
    writeFileSync(join(data, definition.id, 'artifacts', 'blobs', old.hash), '损坏')
    expect(() => store.read(definition.id, 'report.md', 'run-1')).toThrow('校验失败')
  } finally { rmSync(root, { recursive: true }) }
})
