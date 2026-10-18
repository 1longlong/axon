/** 首次创作与业务执行隔离；验证权限、取消、恢复和配置变更不会激活半成品。 */
import { afterEach, expect, test } from 'bun:test'
import { mkdtempSync, realpathSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { queueLoopRun, startLoopRun } from '@axon/loop-engine'
import type { LoopComposeInput } from '@axon/shared'
import { LoopService } from './loop-service'
import type { LoopExecutionRequest, LoopServiceOptions } from './loop-service'
import { LoopRepository } from './loop-repository'
import { loopDocument, loopRun } from '../../test-support/loop-fixture'

const context = { commandDirectory: '/controlled/bin', socketPath: '/controlled/socket' }
const input: LoopComposeInput = { name: '自动创作', workspacePath: '/unused', channelId: 'channel', modelId: 'model',
  task: '检查现有报告，展示真实结果', cron: '0 0 1 1 *', timezone: 'UTC', notify: 'never' }
const cleanups: Array<() => Promise<void>> = []
afterEach(async () => { for (const cleanup of cleanups.splice(0).reverse()) await cleanup() })
function fixture(execute: LoopServiceOptions['execute']) {
  const root = realpathSync(mkdtempSync(join(tmpdir(), 'axon-loop-preparation-')))
  const options = { directory: join(root, 'data'), validateDefinition: () => {}, execute }
  const service = new LoopService(options)
  cleanups.unshift(async () => { service.dispose(); await service.drain(); rmSync(root, { recursive: true }) })
  service.start(context)
  return { root, service, options }
}
function gate() {
  const value = Promise.withResolvers<void>()
  cleanups.push(async () => value.resolve())
  return value
}
async function wait(check: () => boolean): Promise<void> {
  const end = Date.now() + 3000
  while (!check()) { if (Date.now() > end) throw new Error('准备状态未收束'); await Bun.sleep(2) }
}

test('只提交意图：准备轮保存配置并回报成功后，才执行用户要求的立即运行', async () => {
  const release = gate(), roles: string[] = []
  const f = fixture(async (request) => {
    roles.push(request.role)
    if (request.role === 'setup') {
      const token = request.control.token
      f.service.cli(token, ['set-schema', '--body', '[{"key":"count","label":"数量"}]'])
      f.service.cli(token, ['set-ui', '--body', '<axon-chart series="count:数量"></axon-chart>'])
      f.service.cli(token, ['set-task', '--body', '读取 reports 下真实报告，回报 count 指标'])
      expect(() => f.service.cli(token, ['resume'])).toThrow('不改变用户确认')
      expect(() => f.service.cli(token, ['set-cron', '*/1 * * * *'])).toThrow('不改变用户确认')
      expect(() => f.service.cli(token, ['finish', '--message', '提前完成'])).toThrow('不能完成目标')
      await release.promise
      f.service.cli(token, ['report', '--status', 'resolved', '--message', '指标和面板已准备'])
    }
    return { phase: 'done' }
  })
  const job = await f.service.createWithAgent({ ...input, workspacePath: f.root, goal: '明确完成目标', runImmediately: true })
  expect(job).toMatchObject({ preparation: 'pending', nextFire: null })
  expect(roles).toEqual(['setup'])
  expect(() => f.service.run(job.id)).toThrow('先完成')
  expect(() => f.service.run(job.id, 'evolve')).toThrow('先完成')
  release.resolve()
  await wait(() => f.service.get(job.id).job.runCount === 2)
  expect(roles).toEqual(['setup', 'exec'])
  expect(f.service.get(job.id).job).toMatchObject({ preparation: 'ready', task: '读取 reports 下真实报告，回报 count 指标',
    stateSchema: [{ key: 'count', label: '数量' }], ui: '<axon-chart series="count:数量"></axon-chart>' })
  expect(f.service.get(job.id).job.precheckNetworkAccess).not.toBe(true)
  expect(f.service.get(job.id).job.completedAt).toBeNull()
  expect(f.service.runs(job.id).find((run) => run.role === 'setup')).toMatchObject({ phase: 'done', status: 'resolved', trigger: 'initial_setup' })
})

test.each(['no-report', 'blocked', 'error', 'cancel'] as const)('准备未成功不会运行；可显式重试：%s', async (mode) => {
  const release = gate(), requests: LoopExecutionRequest[] = []
  const f = fixture(async (request) => {
    requests.push(request)
    await release.promise
    if (requests.length > 1) f.service.cli(request.control.token, ['report', '--status', 'resolved', '--message', '重试准备完成'])
    else if (mode === 'blocked') f.service.cli(request.control.token, ['report', '--status', 'new', '--message', '数据源不存在，请调整任务'])
    return mode === 'error' && requests.length === 1 ? { phase: 'error', error: '模型连接失败' } : { phase: 'done' }
  })
  const job = await f.service.createWithAgent({ ...input, workspacePath: f.root, runImmediately: true })
  const runId = f.service.get(job.id).runs[0]!.id
  if (mode === 'cancel') expect(f.service.stop(job.id, runId)).toBe(true)
  release.resolve(); await wait(() => !f.service.get(job.id).job.running)
  expect(requests).toHaveLength(1)
  expect(f.service.get(job.id).job).toMatchObject({ preparation: 'failed', nextFire: null, nextRunAt: null })
  expect(() => f.service.run(job.id)).toThrow('先完成')
  f.service.prepare(job.id)
  await wait(() => f.service.get(job.id).job.preparation === 'ready')
  expect(requests.map((request) => request.role)).toEqual(['setup', 'setup'])
  expect(f.service.get(job.id).job.nextRunAt).toBeNull()
})

test.each([false, true])('计划暂停不妨碍配置准备，也不暗中恢复普通任务：预先暂停 %s', async (paused) => {
  const release = gate(), roles: string[] = []
  const f = fixture(async (request) => {
    roles.push(request.role); await release.promise
    f.service.cli(request.control.token, ['report', '--status', 'resolved', '--message', '无需预检或面板'])
    return { phase: 'done' }
  })
  const job = await f.service.createWithAgent({ ...input, workspacePath: f.root, enabled: !paused, runImmediately: !paused })
  if (!paused) f.service.update(job.id, { enabled: false })
  release.resolve(); await wait(() => !f.service.get(job.id).job.running)
  expect(f.service.get(job.id).job).toMatchObject({ preparation: 'ready', enabled: false, ui: null, workflow: null, nextFire: null, nextRunAt: null })
  expect(roles).toEqual(['setup'])
})

test('准备中用户改变任务使旧准备失效，生成结果不会覆盖新任务或自动激活', async () => {
  const release = gate()
  const f = fixture(async (request) => {
    f.service.cli(request.control.token, ['set-ui', '--body', '<p>旧面板</p>'])
    await release.promise
    expect(() => f.service.cli(request.control.token, ['set-task', '--body', '旧规范'])).toThrow('用户修改')
    f.service.cli(request.control.token, ['report', '--status', 'resolved', '--message', '旧准备结果'])
    return { phase: 'done' }
  })
  const job = await f.service.createWithAgent({ ...input, workspacePath: f.root, runImmediately: true })
  f.service.update(job.id, { task: '新的用户规范' })
  release.resolve(); await wait(() => !f.service.get(job.id).job.running)
  expect(f.service.get(job.id).job).toMatchObject({ preparation: 'failed', task: '新的用户规范', nextFire: null })
  expect(f.service.get(job.id).runs[0]!.phase).toBe('error')
})

test.each(['pending', 'running'] as const)('准备恢复只领取未开始任务，不重放已运行的准备：%s', async (phase) => {
  const f = fixture(async () => ({ phase: 'done' }))
  f.service.dispose(); await f.service.drain()
  const document = loopDocument(f.root)
  document.preparation = 'pending'; document.runAfterPreparation = true
  document.lifecycle = queueLoopRun(document.lifecycle, { runId: 'run-1', role: 'setup', queuedAt: Date.now() })
  if (phase === 'running') document.lifecycle = startLoopRun(document.lifecycle, document.lifecycle.activeRun!, Date.now())
  const repository = new LoopRepository(f.options.directory)
  const active = document.lifecycle.activeRun!
  repository.commit(document, { ...loopRun(document, 1), role: 'setup', trigger: 'initial_setup', phase, queued: phase === 'pending',
    running: phase === 'running', queuedAt: active.queuedAt, startedAt: active.startedAt, finishedAt: null, durationMs: null })
  repository.dispose()
  let calls = 0
  const restored = new LoopService({ ...f.options, execute: async (request) => {
    calls++; restored.cli(request.control.token, ['report', '--status', 'new', '--message', '隔离恢复验收'])
    return { phase: 'done' }
  } })
  cleanups.push(async () => { restored.dispose(); await restored.drain() })
  restored.start(context)
  await wait(() => restored.get(document.definition.id).job.preparation === 'failed')
  expect(calls).toBe(phase === 'pending' ? 1 : 0)
  expect(restored.runs(document.definition.id)[0]!.phase).toBe(phase === 'pending' ? 'error' : 'interrupted')
})

test('桌面边界拒绝手写技术配置、伪造准备状态和错误立即执行参数', () => {
  const f = fixture(async () => ({ phase: 'done' }))
  for (const extra of [{ ui: '<p>任意</p>' }, { workflow: '' }, { stateSchema: [] }, { preparation: 'ready' },
    { runImmediately: 'true' }, { runImmediately: true, enabled: false }]) {
    expect(() => f.service.createWithAgent({ ...input, workspacePath: f.root, ...extra })).toThrow()
  }
  expect(f.service.list()).toHaveLength(0)
})
