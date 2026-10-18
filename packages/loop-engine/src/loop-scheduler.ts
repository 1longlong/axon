/** Cron 只计算时间；任务存储、派发和权限归注入的宿主端口。 */
import { Cron } from 'croner'

export interface LoopSchedule {
  loopId: string
  cron: string
  timezone: string
  enabled: boolean
  createdAt: number
  lastScheduledAt: number | null
  nextRunAt: number | null
}
export interface LoopFire { scheduledAt: number; source: 'cron' | 'once' }
export interface LoopSchedulerOptions {
  list: () => LoopSchedule[]
  fire: (id: string, fire: LoopFire) => void | Promise<void>
  onError: (id: string, error: unknown) => void
  now?: () => number
}

/** 在接纳配置前验证五字段 Cron 和 IANA 时区；不接受秒级高频计划。 */
export function validateLoopSchedule(cron: string, timezone: string): void {
  if (cron.trim().split(/\s+/).length !== 5) throw new Error('执行计划必须为五字段 Cron')
  new Intl.DateTimeFormat('en', { timeZone: timezone }).format(0)
  const probe = new Cron(cron, { timezone, paused: true })
  try { if (!probe.nextRun()) throw new Error('执行计划没有未来时间') } finally { probe.stop() }
}

export function nextLoopFire(cron: string, timezone: string, after = Date.now()): number | null {
  const probe = new Cron(cron, { timezone, paused: true })
  try { return probe.nextRun(new Date(after))?.getTime() ?? null } finally { probe.stop() }
}

/** 恢复时只查最近一次已到期时间，不枚举休眠或离线期间的所有任务。 */
export function latestLoopFire(cron: string, timezone: string, before = Date.now()): number | null {
  const probe = new Cron(cron, { timezone, paused: true })
  try { return probe.previousRuns(1, new Date(before))[0]?.getTime() ?? null } finally { probe.stop() }
}

/** 模型自调度采用独立频率下限；用户显式编辑不调用此约束。 */
export function validateLoopSelfCron(cron: string, timezone: string, now: number): void {
  validateLoopSchedule(cron, timezone)
  const probe = new Cron(cron, { timezone, paused: true })
  try {
    const times = probe.nextRuns(128, new Date(now))
    if (times.some((date, i) => i > 0 && date.getTime() - times[i - 1]!.getTime() < 15 * 60_000)) {
      throw new Error('模型不能把长期执行间隔调整为少于 15 分钟')
    }
  } finally { probe.stop() }
}

export class LoopScheduler {
  private timer?: ReturnType<typeof setTimeout>
  private stopped = true
  private checking?: Promise<void>
  private refreshRequested = false
  private readonly now: () => number

  constructor(private readonly options: LoopSchedulerOptions) { this.now = options.now ?? Date.now }

  /** 只由后端装配启动；重新计算最近一次漏跑，不积累离线期间全部执行。 */
  start(): void { this.stopped = false; this.refresh() }
  refresh(): void {
    if (this.stopped) return
    clearTimeout(this.timer)
    if (this.checking) { this.refreshRequested = true; return }
    this.checking = this.check().finally(() => {
      this.checking = undefined
      if (this.refreshRequested) { this.refreshRequested = false; this.refresh() }
    })
    // 所有单任务异常已进入 onError；兜底防止计时器产生未处理拒绝。
    void this.checking.catch((error) => this.options.onError('', error))
  }

  /** 同时覆盖正常时间点和系统睡眠后的校准；fire 只登记执行，不等待模型。 */
  private async check(): Promise<void> {
    let delay = 30_000
    for (const schedule of this.options.list()) {
      if (this.stopped) return
      if (!schedule.enabled) continue
      try {
        const now = this.now()
        const previous = latestLoopFire(schedule.cron, schedule.timezone, now)
        const once = schedule.nextRunAt
        if (once !== null && once <= now) await this.options.fire(schedule.loopId, { scheduledAt: once, source: 'once' })
        else if (previous !== null && previous > (schedule.lastScheduledAt ?? schedule.createdAt)) {
          await this.options.fire(schedule.loopId, { scheduledAt: previous, source: 'cron' })
        }
        const next = nextLoopFire(schedule.cron, schedule.timezone, now)
        for (const time of [next, once !== null && once > now ? once : null]) {
          if (time !== null) delay = Math.min(delay, Math.max(25, time - now))
        }
      } catch (error) { this.options.onError(schedule.loopId, error) }
    }
    if (!this.stopped) this.timer = setTimeout(() => this.refresh(), delay)
  }

  dispose(): void { this.stopped = true; this.refreshRequested = false; clearTimeout(this.timer) }
  async drain(): Promise<void> { await this.checking }
}
