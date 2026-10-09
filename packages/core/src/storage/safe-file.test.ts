/**
 * safe-file 原子写与容错读取测试
 */

import { describe, expect, test, beforeEach, afterEach } from 'bun:test'
import { mkdtempSync, rmSync, writeFileSync, readFileSync, existsSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { writeJsonFileAtomic, readJsonFileSafe, writeTextFileAtomic } from './safe-file'

let dir: string

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'axon-safe-file-'))
})

afterEach(() => {
  rmSync(dir, { recursive: true, force: true })
})

describe('writeJsonFileAtomic', () => {
  test('正常路径：写入并读回', () => {
    const file = join(dir, 'settings.json')
    writeJsonFileAtomic(file, { themeMode: 'dark' })

    const parsed = JSON.parse(readFileSync(file, 'utf-8'))
    expect(parsed).toEqual({ themeMode: 'dark' })
  })

  test('写入前生成 .bak 备份', () => {
    const file = join(dir, 'settings.json')
    writeJsonFileAtomic(file, { v: 1 })
    writeJsonFileAtomic(file, { v: 2 })

    expect(existsSync(file + '.bak')).toBe(true)
    const bak = JSON.parse(readFileSync(file + '.bak', 'utf-8'))
    expect(bak).toEqual({ v: 1 })
  })

  test('写入后不残留 .tmp', () => {
    const file = join(dir, 'settings.json')
    writeJsonFileAtomic(file, { v: 1 })
    expect(existsSync(file + '.tmp')).toBe(false)
  })
})

describe('readJsonFileSafe', () => {
  test('主文件损坏时从 .bak 恢复', () => {
    const file = join(dir, 'settings.json')
    // 写两次：第二次写入前会为 v1 生成 .bak 备份
    writeJsonFileAtomic(file, { v: 1 })
    writeJsonFileAtomic(file, { v: 2 })
    // 模拟主文件被截断
    writeFileSync(file, '{ "v": 2, "trunc', 'utf-8')

    const result = readJsonFileSafe<{ v: number }>(file)
    expect(result).toEqual({ v: 1 })
    // 主文件应被 .bak 恢复
    expect(JSON.parse(readFileSync(file, 'utf-8'))).toEqual({ v: 1 })
  })

  test('主文件缺失但存在有效 .tmp 时提升为主文件', () => {
    const file = join(dir, 'settings.json')
    writeFileSync(file + '.tmp', JSON.stringify({ v: 3 }), 'utf-8')

    const result = readJsonFileSafe<{ v: number }>(file)
    expect(result).toEqual({ v: 3 })
    expect(existsSync(file)).toBe(true)
    expect(existsSync(file + '.tmp')).toBe(false)
  })

  test('全部不可用时返回 null', () => {
    const file = join(dir, 'none.json')
    expect(readJsonFileSafe(file)).toBeNull()
  })

  test('空文件视为损坏', () => {
    const file = join(dir, 'empty.json')
    writeFileSync(file, '   ', 'utf-8')
    expect(readJsonFileSafe(file)).toBeNull()
  })
})

describe('writeTextFileAtomic', () => {
  test('原子重写文本文件', () => {
    const file = join(dir, 'session.jsonl')
    writeTextFileAtomic(file, 'line1\n')
    writeTextFileAtomic(file, 'line1\nline2\n')

    expect(readFileSync(file, 'utf-8')).toBe('line1\nline2\n')
    expect(existsSync(file + '.tmp')).toBe(false)
  })
})
