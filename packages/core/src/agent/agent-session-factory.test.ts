/** 通用创建入口验证：不按业务来源分支，预检/取消/退出与目录校验先于落盘。 */
import { expect, test } from 'bun:test'
import { mkdirSync, mkdtempSync, realpathSync, renameSync, rmSync, symlinkSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { AgentSessionFactory } from './agent-session-factory'
import { AgentSessionManager } from './agent-session-manager'

test('普通、Loop 与 CLI 通过同一个创建器，输入快照不受调用方后续修改影响', async () => {
  const root = realpathSync(mkdtempSync(join(tmpdir(), 'axon-session-factory-')))
  const sessions = new AgentSessionManager({ indexPath: join(root, 'index.json'), sessionsDir: join(root, 'sessions') })
  const entered = Promise.withResolvers<void>(), release = Promise.withResolvers<void>()
  const factory = new AgentSessionFactory({ sessions, validateCreate: async () => { entered.resolve(); await release.promise } })
  try {
    const config = { title: '原配置', projectId: 'project' }
    const pending = factory.create(config)
    await entered.promise
    config.title = '外部改变'; release.resolve()
    expect((await pending).title).toBe('原配置')
    for (const creationOrigin of ['loop', 'exec'] as const) {
      const session = await factory.create({ title: creationOrigin, creationOrigin, creationWorkspacePath: root })
      expect(session.creationOrigin).toBe(creationOrigin)
      expect(session.creationWorkspacePath).toBe(root)
    }
    // 新用途可先创建普通中立会话，目录与工具由该宿主自己的上下文端口提供。
    expect((await factory.create({ title: '其他宿主用途' })).projectId).toBeUndefined()
    expect(sessions.list()).toHaveLength(4)
  } finally { release.resolve(); factory.dispose(); await factory.drain(); rmSync(root, { recursive: true }) }
})

test.each(['cancel', 'dispose', 'directory'] as const)('预检期间 %s 不落盘，仍等待实际校验结束', async (mode) => {
  const root = realpathSync(mkdtempSync(join(tmpdir(), 'axon-session-factory-boundary-')))
  const workspace = join(root, 'workspace'), other = join(root, 'other')
  mkdirSync(workspace); mkdirSync(other)
  const sessions = new AgentSessionManager({ indexPath: join(root, 'index.json'), sessionsDir: join(root, 'sessions') })
  const entered = Promise.withResolvers<void>(), release = Promise.withResolvers<void>(), controller = new AbortController()
  const factory = new AgentSessionFactory({ sessions, validateCreate: async () => { entered.resolve(); await release.promise } })
  try {
    const pending = factory.create({ creationOrigin: 'loop', creationWorkspacePath: workspace }, controller.signal)
    await entered.promise
    if (mode === 'cancel') controller.abort()
    else if (mode === 'dispose') factory.dispose()
    else { renameSync(workspace, join(root, 'previous')); symlinkSync(other, workspace) }
    let drained = false
    const draining = factory.drain().then(() => { drained = true })
    await Promise.resolve(); expect(drained).toBe(false)
    release.resolve()
    await expect(pending).rejects.toThrow()
    await draining
    expect(sessions.list()).toEqual([])
  } finally { release.resolve(); factory.dispose(); await factory.drain(); rmSync(root, { recursive: true }) }
})
