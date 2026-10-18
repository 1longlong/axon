import { describe, expect, test } from 'bun:test'
import { createLoopLifecycle, LoopLifecycleError, queueLoopRun, settleLoopRun, startLoopRun } from './index'
import type { LoopLifecycleErrorCode, LoopLifecycleState, LoopRunIdentity, LoopRunRole } from './index'

const target: LoopRunIdentity = { loopId: 'loop-a', runId: 'run-a', definitionRevision: 1 }

function queued(goal: string | null = null, role: LoopRunRole = 'exec'): LoopLifecycleState {
  return queueLoopRun(createLoopLifecycle({ loopId: target.loopId, goal }), { runId: target.runId, role, queuedAt: 100 })
}

function running(goal: string | null = null, role: LoopRunRole = 'exec'): LoopLifecycleState {
  return startLoopRun(queued(goal, role), target, 200)
}

function rejectsCode(action: () => unknown, code: LoopLifecycleErrorCode): void {
  try {
    action()
    throw new Error('预期拒绝非法状态迁移')
  } catch (error) {
    expect(error).toBeInstanceOf(LoopLifecycleError)
    expect((error as LoopLifecycleError).code).toBe(code)
  }
}

describe('Loop 生命周期内核', () => {
  test('默认开启且无目标，排队/领取/结算不修改上游快照', () => {
    const initial = createLoopLifecycle({ loopId: target.loopId })
    const pending = queueLoopRun(initial, { runId: target.runId, role: 'exec', queuedAt: 100 })
    const active = startLoopRun(pending, target, 200)
    const result = settleLoopRun(active, target, { phase: 'done' }, 300)
    expect(initial).toEqual({ loopId: 'loop-a', definitionRevision: 1, enabled: true, goal: null, completion: null, activeRun: null })
    expect(pending.activeRun).toMatchObject({ phase: 'pending', startedAt: null })
    expect(active.activeRun).toMatchObject({ phase: 'running', startedAt: 200 })
    expect(result.run).toMatchObject({ phase: 'done', queuedAt: 100, startedAt: 200, finishedAt: 300, error: null })
    expect(result.state.activeRun).toBeNull()
    expect(result.state.enabled).toBe(true)
    expect(result.goalCompleted).toBe(false)
  })

  test('同一 Loop 不重叠，不同 Loop 不增加项目互斥', () => {
    for (const state of [queued(), running()]) {
      rejectsCode(() => queueLoopRun(state, { runId: 'run-b', role: 'exec', queuedAt: 300 }), 'busy')
    }
    const other = queueLoopRun(createLoopLifecycle({ loopId: 'loop-b' }), { runId: 'run-b', role: 'exec', queuedAt: 100 })
    expect(other.activeRun?.loopId).toBe('loop-b')
    const settled = settleLoopRun(running(), target, { phase: 'done' }, 300)
    expect(queueLoopRun(settled.state, { runId: 'run-b', role: 'exec', queuedAt: 400 }).activeRun?.runId).toBe('run-b')
  })

  test('停用任务不排队，已停用或变更配置的待执行不启动', () => {
    rejectsCode(() => queueLoopRun(createLoopLifecycle({ loopId: 'loop-a', enabled: false }), {
      runId: 'run-a', role: 'exec', queuedAt: 100,
    }), 'disabled')
    rejectsCode(() => startLoopRun({ ...queued(), enabled: false }, target, 200), 'disabled')
    rejectsCode(() => startLoopRun({ ...queued(), definitionRevision: 2 }, target, 200), 'definition_changed')
    rejectsCode(() => startLoopRun(running(), target, 300), 'invalid_transition')
  })

  test('跨 Loop、旧运行和错误配置令牌不能领取或结算当前执行', () => {
    for (const stale of [{ ...target, loopId: 'loop-b' }, { ...target, runId: 'old-run' }, { ...target, definitionRevision: 2 }]) {
      rejectsCode(() => startLoopRun(queued(), stale, 200), 'stale_run')
      rejectsCode(() => settleLoopRun(running(), stale, { phase: 'done' }, 300), 'stale_run')
    }
  })

  test('成功回复不等于业务目标完成，明确 finish 才停止计划', () => {
    const active = running('测试全部通过')
    const ordinary = settleLoopRun(active, target, { phase: 'done' }, 300)
    expect(ordinary.state.enabled).toBe(true)
    expect(ordinary.state.completion).toBeNull()
    const finished = settleLoopRun(active, target, { phase: 'done', finish: { reason: '全部测试通过' } }, 300)
    expect(finished.goalCompleted).toBe(true)
    expect(finished.state).toMatchObject({ enabled: false, activeRun: null, completion: { runId: 'run-a', completedAt: 300, reason: '全部测试通过' } })
    rejectsCode(() => queueLoopRun(finished.state, { runId: 'run-b', role: 'exec', queuedAt: 400 }), 'completed')
    rejectsCode(() => settleLoopRun(finished.state, target, { phase: 'done' }, 400), 'stale_run')
  })

  test('无目标巡检、优化和编辑运行都不能声明完成目标', () => {
    rejectsCode(() => settleLoopRun(running(), target, { phase: 'done', finish: { reason: '误完成' } }, 300), 'goal_required')
    for (const role of ['evolve', 'edit'] as const) {
      rejectsCode(() => settleLoopRun(running('目标', role), target, { phase: 'done', finish: { reason: '误完成' } }, 300), 'forbidden_role')
      expect(settleLoopRun(running('目标', role), target, { phase: 'done' }, 300).state.enabled).toBe(true)
    }
  })

  test('配置改版或目标被清除后，原执行可收尾但不能关闭新计划', () => {
    for (const changed of [{ ...running('旧目标'), goal: null }, { ...running('旧目标'), definitionRevision: 2, goal: '新目标' }]) {
      const result = settleLoopRun(changed, target, { phase: 'done', finish: { reason: '旧目标完成' } }, 300)
      expect(result.run.phase).toBe('done')
      expect(result.state.activeRun).toBeNull()
      expect(result.goalCompleted).toBe(false)
      expect(result.state.enabled).toBe(true)
      expect(result.state.completion).toBeNull()
    }
  })

  test('失败、取消和崩溃中断可释放待执行或活跃记录，不假造目标完成', () => {
    for (const state of [queued('目标'), running('目标')]) {
      for (const phase of ['error', 'canceled', 'interrupted'] as const) {
        const outcome = phase === 'error' ? { phase, error: '模型请求失败' } as const : { phase }
        const result = settleLoopRun({ ...state, enabled: false }, target, outcome, 300)
        expect(result.run.phase).toBe(phase)
        expect(result.run.error).toBe(phase === 'error' ? '模型请求失败' : null)
        expect(result.state).toMatchObject({ activeRun: null, enabled: false, completion: null })
      }
    }
    rejectsCode(() => settleLoopRun(queued(), target, { phase: 'done' }, 300), 'invalid_transition')
  })
})
