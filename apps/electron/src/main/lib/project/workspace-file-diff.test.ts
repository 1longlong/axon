import { afterEach, beforeEach, describe, expect, test } from 'bun:test'
import { execFileSync } from 'node:child_process'
import { mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { readWorkspaceFileDiff, WorkspaceFileDiffError } from './workspace-file-diff'

let directory: string

beforeEach(() => { directory = mkdtempSync(join(tmpdir(), 'axon-file-diff-')) })
afterEach(() => rmSync(directory, { recursive: true, force: true }))

function git(...args: string[]): void {
  execFileSync('git', args, { cwd: directory, stdio: 'ignore' })
}

function initRepository(): void {
  git('init', '--quiet')
  writeFileSync(join(directory, 'tracked.txt'), 'before\n')
  git('add', 'tracked.txt')
  git('-c', 'user.name=Axon Test', '-c', 'user.email=axon@example.invalid', 'commit', '--quiet', '-m', 'initial')
}

async function expectCode(request: Promise<unknown>, code: WorkspaceFileDiffError['code']): Promise<void> {
  try {
    await request
    throw new Error('expected WorkspaceFileDiffError')
  } catch (error) {
    expect(error).toBeInstanceOf(WorkspaceFileDiffError)
    expect((error as WorkspaceFileDiffError).code).toBe(code)
  }
}

describe('工作区单文件 Git Diff', () => {
  test('读取已跟踪文件的未暂存和已暂存修改', async () => {
    initRepository()
    writeFileSync(join(directory, 'tracked.txt'), 'after\n')
    const unstaged = await readWorkspaceFileDiff('project-1', directory, 'tracked.txt')
    expect(unstaged).toMatchObject({ projectId: 'project-1', relativePath: 'tracked.txt', status: 'changed' })
    expect(unstaged.status === 'changed' && unstaged.patch).toContain('+after')

    git('add', 'tracked.txt')
    const staged = await readWorkspaceFileDiff('project-1', directory, 'tracked.txt')
    expect(staged.status).toBe('changed')
    expect(staged.status === 'changed' && staged.patch).toContain('+after')
  })

  test('读取未跟踪文件且不向 renderer 暴露绝对路径', async () => {
    initRepository()
    const absolutePath = join(directory, 'new file.txt')
    writeFileSync(absolutePath, 'new content\n')

    const value = await readWorkspaceFileDiff('project-1', directory, 'new file.txt')
    expect(value.status).toBe('changed')
    expect(value.status === 'changed' && value.patch).toContain('+new content')
    expect(value.status === 'changed' && value.patch).not.toContain(directory)
  })

  test('区分干净文件和非 Git 工作区', async () => {
    initRepository()
    expect(await readWorkspaceFileDiff('project-1', directory, 'tracked.txt')).toEqual({
      projectId: 'project-1', relativePath: 'tracked.txt', status: 'clean', message: '当前文件没有未提交变更',
    })

    const plain = mkdtempSync(join(tmpdir(), 'axon-file-diff-plain-'))
    try {
      writeFileSync(join(plain, 'plain.txt'), 'plain')
      expect(await readWorkspaceFileDiff('project-1', plain, 'plain.txt')).toMatchObject({ status: 'unavailable' })
    } finally {
      rmSync(plain, { recursive: true, force: true })
    }
  })

  test('拒绝绝对路径、路径穿越和符号链接', async () => {
    initRepository()
    mkdirSync(join(directory, 'folder'))
    symlinkSync(join(directory, 'tracked.txt'), join(directory, 'linked.txt'))

    await expectCode(readWorkspaceFileDiff('project-1', directory, '/etc/passwd'), 'invalid_path')
    await expectCode(readWorkspaceFileDiff('project-1', directory, '../outside.txt'), 'outside_workspace')
    await expectCode(readWorkspaceFileDiff('project-1', directory, 'linked.txt'), 'outside_workspace')
  })

  test('超过展示上限时返回稳定状态', async () => {
    initRepository()
    writeFileSync(join(directory, 'tracked.txt'), `${'x'.repeat(560 * 1024)}\n`)
    const value = await readWorkspaceFileDiff('project-1', directory, 'tracked.txt')
    expect(value).toEqual({
      projectId: 'project-1', relativePath: 'tracked.txt', status: 'unavailable', message: 'Diff 内容过大，暂不展示',
    })
  })
})
