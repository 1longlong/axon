import { afterEach, beforeEach, describe, expect, test } from 'bun:test'
import { execFileSync } from 'node:child_process'
import { mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { readWorkspaceFileDiff, WorkspaceFileDiffError } from './workspace-file-diff'
import { AgentProjectController } from './agent-project-controller'
import { createBlockingGitHelper, waitForGitHelperExit } from '../../test-support/blocking-git-helper'

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
  test('原生 Git helper 忽略 TERM 时，取消响应先返回，drain 等实际管道关闭和进程退出', async () => {
    if (process.platform === 'win32') return
    initRepository()
    const helper = await createBlockingGitHelper()
    // 与独立后端测试共享主动握手；仍由真实 Git 启动并保留其管道。
    git('config', 'core.fsmonitor', helper.command)
    const controller = new AgentProjectController({
      clients: { has: () => true, subscribeDetached: () => () => {} },
      projects: { list: () => [], get: () => undefined, create: () => { throw new Error('未调用') },
        update: () => { throw new Error('未调用') }, delete: () => { throw new Error('未调用') }, resolveProjectCwd: () => directory },
      sessions: { list: () => [] },
    })
    const request = controller.readDiff('fixture', 'tracked.txt').catch((error: unknown) => error)
    try {
      const { gitPid, helperPid } = await Promise.race([
        helper.waitReady(), request.then(() => { throw new Error('Diff 在 Git helper 就绪前结束') }),
      ])
      expect(gitPid > 1 && helperPid > 1).toBe(true)
      process.kill(gitPid, 0); process.kill(helperPid, 0)
      // 就绪意味着 handler 已生效；主动 TERM 后仍存活，不能用一个普通会退出的 helper 充数。
      process.kill(helperPid, 'SIGTERM')
      await Bun.sleep(30)
      expect(() => process.kill(helperPid, 0)).not.toThrow()
      controller.dispose()
      expect(await request).toMatchObject({ name: 'AbortError' })
      let drained = false
      const draining = controller.drain().then(() => { drained = true })
      await Bun.sleep(30)
      expect(drained).toBe(false)
      await draining
      for (const pid of [gitPid, helperPid]) await waitForGitHelperExit(pid)
    } finally {
      controller.dispose()
      await controller.drain()
      await request
      await helper.close()
    }
  })

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
