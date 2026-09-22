import { afterEach, beforeEach, describe, expect, test } from 'bun:test'
import { mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { listWorkspaceDirectory } from './workspace-directory-listing'

let directory: string

beforeEach(() => { directory = mkdtempSync(join(tmpdir(), 'axon-directory-listing-')) })
afterEach(() => rmSync(directory, { recursive: true, force: true }))

describe('工作区目录枚举', () => {
  test('目录优先排序、忽略大型目录，并只返回相对路径', async () => {
    mkdirSync(join(directory, 'src'))
    mkdirSync(join(directory, '.git'))
    mkdirSync(join(directory, 'node_modules'))
    writeFileSync(join(directory, 'README.md'), 'readme')
    writeFileSync(join(directory, 'src', 'index.ts'), 'export {}')

    const listing = await listWorkspaceDirectory(directory)

    expect(listing).toEqual({
      truncated: false,
      entries: [
        {
          name: 'src',
          relativePath: 'src',
          kind: 'directory',
          children: [{ name: 'index.ts', relativePath: 'src/index.ts', kind: 'file' }],
        },
        { name: 'README.md', relativePath: 'README.md', kind: 'file' },
      ],
    })
    expect(JSON.stringify(listing)).not.toContain(directory)
  })

  test('符号链接只展示不递归，避免读取工作区外内容', async () => {
    const outside = mkdtempSync(join(tmpdir(), 'axon-directory-outside-'))
    writeFileSync(join(outside, 'secret.txt'), 'secret')
    symlinkSync(outside, join(directory, 'outside-link'))
    try {
      const listing = await listWorkspaceDirectory(directory)
      expect(listing.entries).toEqual([
        { name: 'outside-link', relativePath: 'outside-link', kind: 'symlink' },
      ])
      expect(JSON.stringify(listing)).not.toContain('secret.txt')
    } finally {
      rmSync(outside, { recursive: true, force: true })
    }
  })

  test('达到深度或条目上限时标记截断', async () => {
    mkdirSync(join(directory, 'deep'))
    writeFileSync(join(directory, 'deep', 'nested.txt'), 'nested')
    writeFileSync(join(directory, 'one.txt'), 'one')
    writeFileSync(join(directory, 'two.txt'), 'two')

    const depthLimited = await listWorkspaceDirectory(directory, { maxDepth: 0 })
    expect(depthLimited.truncated).toBe(true)
    expect(depthLimited.entries.find((entry) => entry.name === 'deep')?.children).toEqual([])

    const countLimited = await listWorkspaceDirectory(directory, { maxEntries: 1 })
    expect(countLimited.truncated).toBe(true)
    expect(countLimited.entries).toHaveLength(1)
  })
})
