/** 迭代收尾：执行身份、恢复、调度与角色边界集中验收。 */
import { afterEach, expect, test } from 'bun:test'
import { mkdtempSync, realpathSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { queueLoopRun, startLoopRun } from '@axon/loop-engine'
import type { LoopCreateInput } from '@axon/shared'
import { LoopService } from './loop-service'
import type { LoopExecutionRequest, LoopExecutionResult, LoopServiceOptions } from './loop-service'
import { LoopRepository } from './loop-repository'
import { loopDocument, loopRun } from '../../test-support/loop-fixture'

const cleanups: Array<() => Promise<void>> = []
afterEach(async () => { for (const cleanup of cleanups.splice(0).reverse()) await cleanup() })
const context = { commandDirectory: '/controlled/bin', socketPath: '/controlled/socket' }
const base: LoopCreateInput = { name: '验收任务', workspacePath: '/unused', channelId: 'channel', modelId: 'model', task: '检查任务',
  cron: '0 0 1 1 *', timezone: 'UTC', notify: 'never' }
async function wait(check: () => boolean): Promise<void> {
  const end = Date.now() + 3000
  while (!check()) { if (Date.now() > end) throw new Error('领域状态未收束'); await Bun.sleep(2) }
}
function gate() {
  const result = Promise.withResolvers<void>(); cleanups.push(async () => result.resolve()); return result
}
function fixture(execute: LoopServiceOptions['execute'], options: Partial<LoopServiceOptions> = {}) {
  const root = realpathSync(mkdtempSync(join(tmpdir(), 'axon-loop-boundary-')))
  const service = new LoopService({ directory: join(root, 'data'), validateDefinition: () => {}, execute, ...options })
  cleanups.unshift(async () => { service.dispose(); await service.drain(); rmSync(root, { recursive: true }) })
  service.start(context)
  return { root, service }
}

test('不同 Loop 同时执行，凭据不能选其他任务、旧控制或越权结构', async () => {
  const release = gate(), scopes: LoopExecutionRequest[] = []
  const f = fixture(async (request) => { scopes.push(request); await release.promise; return { phase: request.signal.aborted ? 'canceled' : 'done' } })
  const first = f.service.create({ ...base, workspacePath: f.root, goal: '完成目标' }), second = f.service.create({ ...base, workspacePath: f.root })
  const one = f.service.run(first.id).runId!, two = f.service.run(second.id).runId!
  expect(scopes).toHaveLength(2)
  expect(() => f.service.run(first.id)).toThrow('已有执行')
  expect(f.service.stop(first.id, two)).toBe(false)
  const token = scopes[0]!.control.token
  expect(() => f.service.cli(token, ['report', '--loopId', second.id])).toThrow('未知参数')
  expect(() => f.service.cli(token, ['set-ui', '--body', '<p>越权</p>'])).toThrow('编辑或优化')
  expect(() => f.service.cli(token, ['reschedule', '--run-at', '1m'])).toThrow('5 分钟')
  expect(() => f.service.cli(token, ['finish', '--message', '草案'])).not.toThrow()
  expect(f.service.get(first.id).job.completedAt).toBeNull()
  f.service.update(first.id, { task: '用户修改了任务' })
  expect(() => f.service.cli(token, ['report', '--message', '原执行的结果'])).not.toThrow()
  expect(() => f.service.cli(token, ['finish', '--message', '旧目标'])).toThrow('用户修改')
  expect(() => f.service.cli(token, ['reschedule', '--run-at', '10m'])).toThrow('用户修改')
  expect(f.service.stop(first.id, one)).toBe(true)
  expect(f.service.get(first.id).job.running).toBe(true)
  release.resolve(); await wait(() => !f.service.get(first.id).job.running && !f.service.get(second.id).job.running)
  expect(f.service.getRun(first.id, one).phase).toBe('canceled')
  expect(f.service.get(first.id).job.completedAt).toBeNull()
})

test('用户编辑排在优化之前，旧模型不能关闭新要求，固定计划不约束用户明确编辑', async () => {
  const release = gate(), roles: string[] = [], first: LoopExecutionRequest[] = []
  let now = Date.now()
  let service!: LoopService
  const f = fixture(async (request) => {
    roles.push(request.role)
    if (roles.length === 1) { first.push(request); await release.promise }
    if (request.role === 'edit') {
      service.cli(request.control.token, ['set-task', '--body', '新的规范'])
      service.cli(request.control.token, ['set-cron', '*/1 * * * *'])
      service.cli(request.control.token, ['reschedule', '--run-at', '1m'])
    }
    service.cli(request.control.token, ['report', '--message', request.role])
    return { phase: 'done' }
  }, { now: () => now })
  service = f.service
  const job = service.create({ ...base, workspacePath: f.root, allowControl: false })
  service.run(job.id)
  expect(service.run(job.id, 'evolve')).toEqual({ runId: null, queued: true })
  expect(service.run(job.id, 'edit', '按用户要求改规范与频率')).toEqual({ runId: null, queued: true })
  expect(() => service.cli(first[0]!.control.token, ['pause'])).toThrow('用户修改')
  release.resolve()
  await wait(() => service.get(job.id).job.runCount >= 2)
  expect(roles.slice(0, 2)).toEqual(['exec', 'edit'])
  expect(service.get(job.id).job.task).toBe('新的规范')
  expect(service.get(job.id).job.cron).toBe('*/1 * * * *')
  now += 61000; service.start(context)
  await wait(() => roles.includes('evolve'))
  expect(roles[2]).toBe('evolve')
})

test('十次执行夹具失败自动暂停，通知首个/第五/第十，静默完成不提示', async () => {
  let index = 0
  const notifications: string[] = []
  const f = fixture(async (): Promise<LoopExecutionResult> => { index++; return { phase: 'error', error: `失败 ${index}` } },
    { notify: (event) => { notifications.push(event.message) } })
  const job = f.service.create({ ...base, workspacePath: f.root, notify: 'auto' })
  const document = f.service.repository.read(job.id)
  document.lastEvolveAt = Date.now(); f.service.repository.commit(document)
  for (let count = 1; count <= 10; count++) {
    f.service.run(job.id); await wait(() => f.service.get(job.id).job.runCount === count)
  }
  expect(index).toBe(10)
  expect(f.service.get(job.id).job.enabled).toBe(false)
  expect(notifications).toHaveLength(3)
  expect(notifications[2]).toContain('自动暂停')
  expect(() => f.service.run(job.id)).toThrow('计划已暂停')
  const quiet = fixture(async () => ({ phase: 'done', outcome: 'silent' }), { notify: (event) => notifications.push(event.message) })
  const silent = quiet.service.create({ ...base, workspacePath: quiet.root, notify: 'auto' }); quiet.service.run(silent.id)
  await wait(() => quiet.service.get(silent.id).job.runCount === 1)
  expect(notifications).toHaveLength(3)
})

test('MCP 只允许确切白名单，取消等待真实执行退出，迟到回报失效', async () => {
  const release = gate(), ready = Promise.withResolvers<LoopExecutionRequest>()
  let called = 0
  const f = fixture(async (request) => { ready.resolve(request); await release.promise; return { phase: 'done' } }, {
    callMcp: async (_project, _name, _args, signal) => { called++; await new Promise<void>((done) => signal.addEventListener('abort', () => done(), { once: true })); signal.throwIfAborted() },
  })
  const job = f.service.create({ ...base, workspacePath: f.root, allowedMcpTools: ['mcp_exact'] })
  const id = f.service.run(job.id).runId!, scope = await ready.promise
  await expect(f.service.dispatchCli(scope.control.token, ['mcp-call', '--name', 'mcp_other', '--args', '{}'])).rejects.toThrow('授权')
  expect(called).toBe(0)
  const calling = f.service.dispatchCli(scope.control.token, ['mcp-call', '--name', 'mcp_exact', '--args', '{}'])
  expect(called).toBe(1)
  f.service.stop(job.id, id); await expect(calling).rejects.toThrow()
  expect(f.service.get(job.id).job.running).toBe(true)
  release.resolve(); await wait(() => !f.service.get(job.id).job.running)
  expect(f.service.getRun(job.id, id).phase).toBe('canceled')
  expect(() => f.service.cli(scope.control.token, ['report', '--message', '迟到'])).toThrow('失效')
})

test('优化在首条记录后安排，后续须同时满足三条新增记录和二十四小时', async () => {
  let now = Date.UTC(2026, 9, 17, 12, 30)
  const f = fixture(async () => ({ phase: 'done' }), { now: () => now })
  const job = f.service.create({ ...base, workspacePath: f.root })
  f.service.run(job.id); await wait(() => f.service.get(job.id).job.runCount === 1)
  expect(f.service.repository.read(job.id).evolveDue).toBe(true)
  f.service.run(job.id, 'evolve'); await wait(() => f.service.get(job.id).job.runCount === 2)
  expect(f.service.repository.read(job.id).evolveDue).toBe(false)
  for (let count = 3; count <= 5; count++) {
    f.service.run(job.id); await wait(() => f.service.get(job.id).job.runCount === count)
  }
  expect(f.service.repository.read(job.id).evolveDue).toBe(false)
  now += 24 * 3600000
  f.service.run(job.id); await wait(() => f.service.get(job.id).job.runCount === 6)
  expect(f.service.repository.read(job.id).evolveDue).toBe(true)
})

test('失败/编辑不自动优化；后写的优化时间仍覆盖唯一下一次安排，来源持久化', async () => {
  const now = Date.UTC(2026, 9, 17, 12, 30)
  const f = fixture(async (request) => {
    if (request.definition.name === '失败') return { phase: 'error', error: '配置不可用' }
    if (request.role === 'exec') f.service.cli(request.control.token, ['reschedule', '--run-at', '10m'])
    return { phase: 'done' }
  }, { now: () => now })
  const failed = f.service.create({ ...base, workspacePath: f.root, name: '失败' }); f.service.run(failed.id)
  await wait(() => f.service.get(failed.id).job.runCount === 1)
  expect(f.service.repository.read(failed.id)).toMatchObject({ evolveDue: false, nextRunAt: null })
  const edited = f.service.create({ ...base, workspacePath: f.root }); f.service.run(edited.id, 'edit', '仅修改任务')
  await wait(() => f.service.get(edited.id).job.runCount === 1)
  expect(f.service.repository.read(edited.id).evolveDue).toBe(false)
  expect(f.service.get(edited.id).runs[0]?.trigger).toBe('user_edit')
  const success = f.service.create({ ...base, workspacePath: f.root }); f.service.run(success.id)
  await wait(() => f.service.get(success.id).job.runCount === 1)
  expect(f.service.repository.read(success.id)).toMatchObject({ evolveDue: true, nextRunAt: now + 5000, nextTrigger: 'auto_evolve' })
  expect(f.service.get(success.id).pendingMaintenance).toEqual([{ role: 'evolve', trigger: 'auto_evolve' }])
  const persisted = new LoopRepository(join(f.root, 'data'))
  expect(persisted.runs(success.id)[0]?.trigger).toBe('manual'); persisted.dispose()
})

test('暂停/通知不撤销本轮回报和原目标完成；旧控制不能重新开启用户暂停的计划', async () => {
  const release = gate(), ready = Promise.withResolvers<LoopExecutionRequest>()
  const f = fixture(async (request) => { ready.resolve(request); await release.promise; return { phase: 'done' } })
  const job = f.service.create({ ...base, workspacePath: f.root, goal: '原目标', stateSchema: [{ key: 'count', label: '数量' }] })
  const runId = f.service.run(job.id).runId!, scope = await ready.promise
  f.service.update(job.id, { enabled: false, notify: 'always' })
  expect(f.service.get(job.id).job).toMatchObject({ executionRevision: 1, revision: 2, running: true, enabled: false })
  expect(() => f.service.cli(scope.control.token, ['resume'])).toThrow('用户修改')
  expect(() => f.service.cli(scope.control.token, ['report', '--state', '{"count":1}', '--message', '本轮结果'])).not.toThrow()
  expect(() => f.service.cli(scope.control.token, ['finish', '--message', '完成原目标'])).not.toThrow()
  release.resolve(); await wait(() => !f.service.get(job.id).job.running)
  expect(f.service.getRun(job.id, runId)).toMatchObject({ phase: 'done', message: '完成原目标', state: { count: 1 } })
  expect(f.service.get(job.id).job).toMatchObject({ enabled: false, completionReason: '完成原目标' })
})

test('用户换目标/权限后旧执行只可回报原指标，不能 finish、改计划或调用 MCP', async () => {
  const release = gate(), ready = Promise.withResolvers<LoopExecutionRequest>()
  const f = fixture(async (request) => { ready.resolve(request); await release.promise; return { phase: 'done' } }, {
    callMcp: async () => { throw new Error('不应执行') },
  })
  const job = f.service.create({ ...base, workspacePath: f.root, goal: '旧目标', allowedMcpTools: ['mcp_old'], stateSchema: [{ key: 'old', label: '原指标' }] })
  const runId = f.service.run(job.id).runId!, scope = await ready.promise
  f.service.cli(scope.control.token, ['finish', '--message', '旧目标已完成'])
  f.service.update(job.id, { goal: '新目标', allowedMcpTools: [], stateSchema: [] })
  expect(() => f.service.cli(scope.control.token, ['report', '--state', '{"old":1}'])).not.toThrow()
  expect(() => f.service.cli(scope.control.token, ['finish', '--message', '完成新目标'])).toThrow('不能完成新目标')
  await expect(f.service.dispatchCli(scope.control.token, ['mcp-call', '--name', 'mcp_old', '--args', '{}'])).rejects.toThrow('用户修改')
  release.resolve(); await wait(() => !f.service.get(job.id).job.running)
  expect(f.service.getRun(job.id, runId).state).toEqual({ old: 1 })
  expect(f.service.get(job.id).job.completedAt).toBeNull()
  expect(f.service.repository.read(job.id).evolveDue).toBe(false)
})

test('恢复合并旧普通 pending，保留编辑 pending，running 仅记中断不重放', async () => {
  for (const phase of ['pending', 'edit', 'running'] as const) {
    const root = realpathSync(mkdtempSync(join(tmpdir(), 'axon-loop-recover-')))
    const now = Date.UTC(2026, 9, 17, 12, 30), document = loopDocument(root)
    document.definition.cron = '0 * * * *'; document.definition.timezone = 'UTC'; document.definition.createdAt = now - 5 * 3600000
    document.lifecycle = queueLoopRun(document.lifecycle, { runId: 'run-1', role: phase === 'edit' ? 'edit' : 'exec', queuedAt: now - 2 * 3600000 })
    if (phase === 'running') document.lifecycle = startLoopRun(document.lifecycle, document.lifecycle.activeRun!, now - 3600000)
    if (phase === 'edit') document.editRequest = '保留的明确修改'
    document.lastScheduledAt = phase === 'running' ? now : now - 2 * 3600000
    const run = { ...loopRun(document, 1), role: phase === 'edit' ? 'edit' as const : 'exec' as const,
      phase: phase === 'running' ? 'running' as const : 'pending' as const, queuedAt: now - 2 * 3600000,
      startedAt: phase === 'running' ? now - 3600000 : null, finishedAt: null, durationMs: null,
      running: phase === 'running', queued: phase !== 'running', ...(phase === 'edit' ? { instruction: '保留的明确修改' } : {}) }
    const repository = new LoopRepository(join(root, 'data')); repository.commit(document, run); repository.dispose()
    const calls: string[] = [], release = gate()
    const service = new LoopService({ directory: join(root, 'data'), validateDefinition: () => {}, now: () => now,
      execute: async (request) => { calls.push(request.role); await release.promise; return { phase: 'done' } } })
    cleanups.unshift(async () => { service.dispose(); release.resolve(); await service.drain(); rmSync(root, { recursive: true }) })
    service.start(context)
    if (phase === 'running') { expect(calls).toEqual([]); expect(service.getRun(document.definition.id, 'run-1').phase).toBe('interrupted') }
    else if (phase === 'edit') { expect(calls).toEqual(['edit']); expect(service.getRun(document.definition.id, 'run-1').phase).toBe('running') }
    else { expect(calls).toEqual(['exec']); expect(service.getRun(document.definition.id, 'run-1')).toMatchObject({ phase: 'canceled', outcome: 'skipped' }) }
    release.resolve(); service.dispose(); await service.drain()
  }
})
