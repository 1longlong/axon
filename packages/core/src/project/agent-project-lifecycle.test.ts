import { expect, spyOn, test } from 'bun:test'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { createBackend } from '../backend'
import { createBackendPaths } from '../settings/backend-paths'
import { createFixtureCredentialCodec } from '../../test-support/credential-codec'
import * as listing from './workspace-directory-listing'
import * as preview from './workspace-file-preview'
import * as diff from './workspace-file-diff'

function gate() {
  let resolve!: () => void
  const promise = new Promise<void>((done) => { resolve = done })
  return { promise, resolve }
}

test('实际工厂退出封住项目入口，三种工作区响应取消后仍等待真实读取', async () => {
  const directory = mkdtempSync(join(tmpdir(), 'axon-project-drain-'))
  const entered = gate(), finishes = [gate(), gate(), gate()]
  const signals: AbortSignal[] = []
  const started = (signal: AbortSignal): void => { signals.push(signal); if (signals.length === 3) entered.resolve() }
  const spies = [
    spyOn(listing, 'listWorkspaceDirectory').mockImplementation(async (_root, options) => {
      started(options!.signal!); await finishes[0]!.promise
      return { entries: [], truncated: false }
    }),
    spyOn(preview, 'readWorkspaceFilePreview').mockImplementation(async (_root, _path, _max, signal) => {
      started(signal!); await finishes[1]!.promise
      return { relativePath: 'late.txt', name: 'late.txt', size: 0, kind: 'text', content: '' }
    }),
    spyOn(diff, 'readWorkspaceFileDiff').mockImplementation(async (projectId, _root, _path, signal) => {
      started(signal!); await finishes[2]!.promise
      return { projectId, relativePath: 'late.txt', status: 'clean', message: '迟到结果' }
    }),
  ]
  const backend = createBackend({ paths: createBackendPaths({ dataDir: join(directory, 'data'), homeDir: directory }),
    applicationVersion: '0.1.3', credentialCodec: createFixtureCredentialCodec(),
    resolveAdapter: () => ({ async *query() { throw new Error('文件请求不能调用模型') }, abort() {}, dispose() {}, async drain() {} }) })
  try {
    const project = backend.projects.create({ name: '隔离项目' })
    const controller = backend.projectController
    const requests = [controller.listDirectory(project.id), controller.readFile(project.id, 'late.txt'),
      controller.readDiff(project.id, 'late.txt')].map((work) => work.catch((error: unknown) => error))
    await entered.promise
    backend.dispose()
    expect(signals.every((signal) => signal.aborted)).toBe(true)
    for (const result of await Promise.all(requests)) expect(result).toMatchObject({ name: 'AbortError' })
    expect(() => controller.create({ name: '退出后' })).toThrow('已释放')
    expect(() => controller.list()).toThrow('已释放')
    expect(() => controller.update(project.id, { name: '退出后' })).toThrow('已释放')
    expect(() => controller.delete(project.id)).toThrow('已释放')
    await expect(controller.readFile(project.id, 'late.txt')).rejects.toMatchObject({ name: 'AbortError' })
    let drained = false
    const draining = controller.drain().then(() => { drained = true })
    for (const finish of finishes) {
      await Bun.sleep(5)
      expect(drained).toBe(false)
      finish.resolve()
    }
    await draining
    expect(signals.length).toBe(3)
    expect(backend.projects.get(project.id)?.name).toBe('隔离项目')
  } finally {
    finishes.forEach((finish) => finish.resolve())
    backend.dispose()
    await backend.projectController.drain()
    spies.forEach((spy) => spy.mockRestore())
    rmSync(directory, { recursive: true, force: true })
  }
})

test('解绑监听失败也继续取消读取并清理所有已登记 owner', async () => {
  const { AgentProjectController } = await import('./agent-project-controller')
  const cleared: string[] = []
  const controller = new AgentProjectController({
    clients: { has: () => true, subscribeDetached: () => () => { throw new Error('解绑夹具失败') } },
    projects: { list: () => [], get: () => undefined, create: () => { throw new Error('未调用') },
      update: () => { throw new Error('未调用') }, delete: () => { throw new Error('未调用') }, resolveProjectCwd: () => '/fixture' },
    sessions: { list: () => [] },
    watcher: { watch: () => {}, unwatch: () => {}, clearOwner: (owner) => { cleared.push(owner) } },
  })
  controller.watchDirectory('first', 'project', () => {})
  controller.watchDirectory('second', 'project', () => {})
  expect(() => controller.dispose()).toThrow(AggregateError)
  expect(cleared).toEqual(['first', 'second'])
  await expect(controller.listDirectory('project')).rejects.toMatchObject({ name: 'AbortError' })
  await controller.drain()
  expect(() => controller.dispose()).not.toThrow()
})
