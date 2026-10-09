import { afterEach, beforeEach, describe, expect, spyOn, test } from 'bun:test'
import * as fs from 'node:fs/promises'
import { mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { readWorkspaceFilePreview, WorkspaceFilePreviewError } from './workspace-file-preview'

let directory: string

beforeEach(() => { directory = mkdtempSync(join(tmpdir(), 'axon-file-preview-')) })
afterEach(() => rmSync(directory, { recursive: true, force: true }))

async function expectCode(request: Promise<unknown>, code: WorkspaceFilePreviewError['code']): Promise<void> {
  try {
    await request
    throw new Error('expected WorkspaceFilePreviewError')
  } catch (error) {
    expect(error).toBeInstanceOf(WorkspaceFilePreviewError)
    expect((error as WorkspaceFilePreviewError).code).toBe(code)
  }
}

describe('工作区文件预览', () => {
  test('根路径解析期间取消，不继续读取文件，也不误报 not_found', async () => {
    writeFileSync(join(directory, 'not-read.txt'), '不继续读取')
    const metadata = spyOn(fs, 'lstat'), contents = spyOn(fs, 'readFile')
    const stop = new AbortController()
    try {
      const preview = readWorkspaceFilePreview(directory, 'not-read.txt', undefined, stop.signal)
      stop.abort()
      await expect(preview).rejects.toMatchObject({ name: 'AbortError' })
      expect(metadata).not.toHaveBeenCalled()
      expect(contents).not.toHaveBeenCalled()
      await expect(readWorkspaceFilePreview(directory, 'not-read.txt', undefined, stop.signal)).rejects.toMatchObject({ name: 'AbortError' })
    } finally { metadata.mockRestore(); contents.mockRestore() }
  })

  test('读取工作区内小型 UTF-8 文本且只返回相对元数据', async () => {
    mkdirSync(join(directory, 'src'))
    writeFileSync(join(directory, 'src', 'index.ts'), 'export const value = 1\n')

    expect(await readWorkspaceFilePreview(directory, 'src/index.ts')).toEqual({
      relativePath: 'src/index.ts',
      name: 'index.ts',
      size: 23,
      kind: 'text',
      content: 'export const value = 1\n',
    })
  })

  test('拒绝绝对路径、路径穿越、目录与工作区外符号链接', async () => {
    const outside = mkdtempSync(join(tmpdir(), 'axon-file-preview-outside-'))
    writeFileSync(join(outside, 'secret.txt'), 'secret')
    mkdirSync(join(directory, 'folder'))
    symlinkSync(join(outside, 'secret.txt'), join(directory, 'secret-link'))
    try {
      await expectCode(readWorkspaceFilePreview(directory, '/etc/passwd'), 'invalid_path')
      await expectCode(readWorkspaceFilePreview(directory, '../outside.txt'), 'outside_workspace')
      await expectCode(readWorkspaceFilePreview(directory, 'folder'), 'not_file')
      await expectCode(readWorkspaceFilePreview(directory, 'secret-link'), 'outside_workspace')
    } finally {
      rmSync(outside, { recursive: true, force: true })
    }
  })

  test('二进制和超大文件只返回元数据，不返回内容', async () => {
    writeFileSync(join(directory, 'binary.bin'), Buffer.from([0, 1, 2]))
    writeFileSync(join(directory, 'large.txt'), '12345')

    expect(await readWorkspaceFilePreview(directory, 'binary.bin')).toEqual({
      relativePath: 'binary.bin', name: 'binary.bin', size: 3, kind: 'binary',
    })
    expect(await readWorkspaceFilePreview(directory, 'large.txt', 4)).toEqual({
      relativePath: 'large.txt', name: 'large.txt', size: 5, kind: 'too_large',
    })
  })
})
