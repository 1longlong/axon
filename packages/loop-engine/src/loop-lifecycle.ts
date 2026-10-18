/** 一次执行与长期计划分离；所有变更返回新值，由宿主一致保存。 */
export type LoopRunRole = 'exec' | 'evolve' | 'edit' | 'setup'
export type LoopRunPhase = 'pending' | 'running' | 'done' | 'error' | 'canceled' | 'interrupted'

export interface LoopRunIdentity {
  loopId: string
  runId: string
  definitionRevision: number
}

export interface LoopRunRecord extends LoopRunIdentity {
  role: LoopRunRole
  phase: LoopRunPhase
  /** 本次执行领取的目标；后续更改任务不能让旧结果关闭新目标。 */
  goal: string | null
  queuedAt: number
  startedAt: number | null
  finishedAt: number | null
  error: string | null
}

export interface LoopGoalCompletion {
  runId: string
  completedAt: number
  reason: string
}

export interface LoopLifecycleState {
  loopId: string
  definitionRevision: number
  enabled: boolean
  goal: string | null
  completion: LoopGoalCompletion | null
  activeRun: (LoopRunRecord & { phase: 'pending' | 'running' }) | null
}

export interface LoopLifecycleInput {
  loopId: string
  goal?: string | null
  enabled?: boolean
}

export interface LoopRunRequest {
  runId: string
  role: LoopRunRole
  queuedAt: number
}

/** 只有完整工作流实际收束后，宿主才能提交此结果；不是模型 report 的 DTO。 */
export type LoopRunOutcome =
  | { phase: 'done'; finish?: { reason: string } }
  | { phase: 'error'; error: string }
  | { phase: 'canceled' | 'interrupted' }

export interface LoopRunSettlement {
  state: LoopLifecycleState
  run: LoopRunRecord
  goalCompleted: boolean
}

export type LoopLifecycleErrorCode =
  | 'disabled' | 'completed' | 'busy' | 'stale_run' | 'definition_changed'
  | 'invalid_transition' | 'goal_required' | 'forbidden_role'

export class LoopLifecycleError extends Error {
  constructor(readonly code: LoopLifecycleErrorCode, message: string) {
    super(message)
    this.name = 'LoopLifecycleError'
  }
}

/** 从已校验的任务输入生成初始状态；ID、时钟和数据读写均归宿主。 */
export function createLoopLifecycle(input: LoopLifecycleInput): LoopLifecycleState {
  return {
    loopId: input.loopId, definitionRevision: 1, enabled: input.enabled ?? true,
    goal: input.goal ?? null, completion: null, activeRun: null,
  }
}

/** 登记单个 Loop 的待执行快照；宿主须串行更新此聚合，不以纯函数代替存储原子性。 */
export function queueLoopRun(state: LoopLifecycleState, input: LoopRunRequest): LoopLifecycleState {
  if (state.completion) throw new LoopLifecycleError('completed', 'Loop 已完成目标')
  if (!state.enabled && input.role !== 'setup') throw new LoopLifecycleError('disabled', 'Loop 已暂停调度')
  if (state.activeRun) throw new LoopLifecycleError('busy', '此 Loop 已有待执行或执行中的任务')
  return { ...state, activeRun: {
    loopId: state.loopId, runId: input.runId, definitionRevision: state.definitionRevision,
    role: input.role, phase: 'pending', goal: state.goal, queuedAt: input.queuedAt,
    startedAt: null, finishedAt: null, error: null,
  } }
}

function getActiveRun(state: LoopLifecycleState, target: LoopRunIdentity): NonNullable<LoopLifecycleState['activeRun']> {
  const run = state.activeRun
  if (!run || state.loopId !== target.loopId || run.runId !== target.runId
    || run.definitionRevision !== target.definitionRevision) {
    throw new LoopLifecycleError('stale_run', '执行身份已失效')
  }
  return run
}

/** 领取待执行任务；停用或配置变化后不得继续启动旧快照。 */
export function startLoopRun(state: LoopLifecycleState, target: LoopRunIdentity, startedAt: number): LoopLifecycleState {
  const run = getActiveRun(state, target)
  if (run.phase !== 'pending') throw new LoopLifecycleError('invalid_transition', '任务已被领取')
  if (!state.enabled && run.role !== 'setup') throw new LoopLifecycleError('disabled', 'Loop 已暂停调度')
  if (state.definitionRevision !== run.definitionRevision) {
    throw new LoopLifecycleError('definition_changed', '任务配置已改变，不能启动旧执行')
  }
  return { ...state, activeRun: { ...run, phase: 'running', startedAt } }
}

/** 把实际执行终态和计划状态作为一次结算返回；下游应整体保存，不分别宣布成功。 */
export function settleLoopRun(
  state: LoopLifecycleState,
  target: LoopRunIdentity,
  outcome: LoopRunOutcome,
  finishedAt: number,
): LoopRunSettlement {
  const run = getActiveRun(state, target)
  if (outcome.phase === 'done' && run.phase !== 'running') {
    throw new LoopLifecycleError('invalid_transition', '尚未执行的任务不能结算为成功')
  }
  const finish = outcome.phase === 'done' ? outcome.finish : undefined
  if (finish && run.role !== 'exec') throw new LoopLifecycleError('forbidden_role', '只有普通执行可以完成目标')
  if (finish && run.goal === null) throw new LoopLifecycleError('goal_required', '长期巡检没有可完成的目标')

  // 即使用户修改或停用了计划，仍要释放原执行；旧目标的完成声明不能关闭新配置。
  const completion = finish && state.definitionRevision === run.definitionRevision && state.goal === run.goal
    ? { runId: run.runId, completedAt: finishedAt, reason: finish.reason }
    : null
  const goalCompleted = completion !== null
  return {
    state: { ...state, activeRun: null, enabled: goalCompleted ? false : state.enabled, completion: completion ?? state.completion },
    run: { ...run, phase: outcome.phase, finishedAt, error: outcome.phase === 'error' ? outcome.error : null },
    goalCompleted,
  }
}
