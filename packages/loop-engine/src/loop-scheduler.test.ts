/** 调度端口只登记一次最近到期任务；不实际启动 Agent。 */
import { expect, test } from 'bun:test'
import { latestLoopFire, LoopScheduler, nextLoopFire, validateLoopSchedule, validateLoopSelfCron } from './loop-scheduler'
import type { LoopSchedule } from './loop-scheduler'

test('五字段/时区和模型频率规则与用户计划分离', () => {
  const now = Date.UTC(2026, 9, 17, 12, 31)
  expect(() => validateLoopSchedule('* * * * *', 'Asia/Shanghai')).not.toThrow()
  expect(() => validateLoopSchedule('* * * * * *', 'Asia/Shanghai')).toThrow()
  expect(() => validateLoopSchedule('0 * * * *', 'Unknown/Zone')).toThrow()
  expect(() => validateLoopSelfCron('* * * * *', 'Asia/Shanghai', now)).toThrow('15')
  expect(() => validateLoopSelfCron('*/15 * * * *', 'Asia/Shanghai', now)).not.toThrow()
  expect(latestLoopFire('0 * * * *', 'UTC', now)).toBe(Date.UTC(2026, 9, 17, 12))
  expect(nextLoopFire('0 * * * *', 'UTC', now)).toBe(Date.UTC(2026, 9, 17, 13))
})

test('离线多次漏跑合并一次，过去的一次性时间优先，停用不派发', async () => {
  const now = Date.UTC(2026, 9, 17, 12, 31), fired: string[] = []
  const schedules: LoopSchedule[] = ['cron', 'once', 'disabled'].map((loopId) => ({ loopId, cron: '0 * * * *', timezone: 'UTC',
    createdAt: now - 86400000, lastScheduledAt: null, nextRunAt: loopId === 'once' ? now - 1000 : null, enabled: loopId !== 'disabled' }))
  const scheduler = new LoopScheduler({ now: () => now, list: () => schedules, onError: () => { throw new Error('不应失败') },
    fire: (id, fire) => { fired.push(`${id}:${fire.source}`); const plan = schedules.find((item) => item.loopId === id)!; plan.lastScheduledAt = now; plan.nextRunAt = null } })
  try {
    scheduler.start(); await scheduler.drain(); scheduler.refresh(); await scheduler.drain()
    expect(fired).toEqual(['cron:cron', 'once:once'])
  } finally { scheduler.dispose(); await scheduler.drain() }
})
