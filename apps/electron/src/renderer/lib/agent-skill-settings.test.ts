import { describe, expect, test } from 'bun:test'
import type { AgentSkillSettingsSnapshot } from '@axon/shared'
import { RendererSkillSettings, skillSettingsCanApply, skillSettingsDirty } from './agent-skill-settings'
import type { RendererSkillSettingsState } from './agent-skill-settings'

function snapshot(ids: string[] = [], installed: string[] = []): AgentSkillSettingsSnapshot {
  return { available: ['a', 'b'].map((catalogId) => ({ catalogId, name: catalogId, version: '1', description: catalogId, contentHash: catalogId })),
    desiredCatalogIds: ids, installed: installed.map((catalogId) => ({ catalogId, name: catalogId, version: '1', contentHash: catalogId, installedAt: 1, files: [] })),
    discovered: [], failures: [] }
}
async function settle(): Promise<void> { for (let i = 0; i < 8; i++) await Promise.resolve() }
function open() {
  const reads: Array<ReturnType<typeof Promise.withResolvers<AgentSkillSettingsSnapshot>>> = []
  const writes: Array<{ ids: string[]; gate: ReturnType<typeof Promise.withResolvers<AgentSkillSettingsSnapshot>> }> = []
  const states: RendererSkillSettingsState[] = [], order: string[] = []
  let notice = (): void => {}, unsubscribed = 0
  const model = new RendererSkillSettings({ agentSkills: {
    getSettings: () => { order.push('read'); const gate = Promise.withResolvers<AgentSkillSettingsSnapshot>(); reads.push(gate); return gate.promise },
    applySettings: (ids) => { const gate = Promise.withResolvers<AgentSkillSettingsSnapshot>(); writes.push({ ids, gate }); return gate.promise },
  }, settings: { onChanged: (callback) => { order.push('subscribe'); notice = callback; return () => { unsubscribed += 1 } } } }, (value) => states.push(value))
  model.start()
  return { model, reads, writes, states, order, notice: () => notice(), unsubscribed: () => unsubscribed }
}

describe('Skills 设置页面投影', () => {
  test('先订阅再读，连续通知只排一个最新读取，旧响应不显示', async () => {
    const f = open(); expect(f.order).toEqual(['subscribe', 'read'])
    f.notice(); f.notice(); f.notice()
    expect(f.reads).toHaveLength(1)
    f.reads[0]!.resolve(snapshot(['a'], ['a'])); await settle()
    expect(f.reads).toHaveLength(2); expect(f.model.getSnapshot().snapshot).toBeNull()
    f.reads[1]!.resolve(snapshot(['b'], ['b'])); await settle()
    expect(f.model.getSnapshot()).toMatchObject({ snapshot: { desiredCatalogIds: ['b'] }, selected: ['b'], loading: false, refreshing: false })
    f.model.dispose()
  })

  test('干净页面跟随外部选择；脏草稿不被外部快照覆盖，但实际安装更新', async () => {
    const f = open(); f.reads[0]!.resolve(snapshot(['a'], ['a'])); await settle()
    f.notice(); f.reads[1]!.resolve(snapshot(['b'], ['b'])); await settle()
    expect(f.model.getSnapshot().selected).toEqual(['b'])
    f.model.select('a', true)
    f.notice(); f.reads[2]!.resolve(snapshot([], [])); await settle()
    expect(f.model.getSnapshot().selected).toEqual(['b', 'a'])
    expect(f.model.getSnapshot().snapshot?.installed).toEqual([])
    expect(skillSettingsDirty(f.model.getSnapshot())).toBe(true)
    f.model.dispose()
  })

  test('同 IDs 通知也刷新版本/安装状态，不把 desired 等同 installed', async () => {
    const f = open(); f.reads[0]!.resolve(snapshot(['a'], [])); await settle()
    expect(skillSettingsDirty(f.model.getSnapshot())).toBe(false)
    expect(skillSettingsCanApply(f.model.getSnapshot())).toBe(true)
    f.notice(); f.reads[1]!.resolve(snapshot(['a'], ['a'])); await settle()
    expect(skillSettingsCanApply(f.model.getSnapshot())).toBe(false)
    f.notice(); f.reads[2]!.resolve({ ...snapshot(['a'], ['a']), available: [{ ...snapshot().available[0]!, version: '2' }] }); await settle()
    expect(skillSettingsCanApply(f.model.getSnapshot())).toBe(true)
    f.model.dispose()
  })

  test('只显式提交一次；逐项失败可见，刷新不抹掉本页操作回执', async () => {
    const f = open(); f.reads[0]!.resolve(snapshot()); await settle()
    f.model.select('a', true)
    const applying = f.model.apply(); await f.model.apply(); f.model.select('b', true)
    expect(f.writes).toHaveLength(1); expect(f.writes[0]!.ids).toEqual(['a'])
    const failed = { ...snapshot(['a']), failures: [{ catalogId: 'a', message: '目标目录已存在' }] }
    f.writes[0]!.gate.resolve(failed); await applying
    expect(f.model.getSnapshot()).toMatchObject({ failures: failed.failures, snapshot: { installed: [] }, saving: false })
    f.notice(); f.reads[1]!.resolve(snapshot(['a'])); await settle()
    expect(f.model.getSnapshot().failures).toEqual(failed.failures)
    expect(skillSettingsCanApply(f.model.getSnapshot())).toBe(true)
    f.model.dispose()
  })

  test('通知先于应用响应，新快照优先；旧应用回执不覆盖其他入口后来保存的状态', async () => {
    const f = open(); f.reads[0]!.resolve(snapshot()); await settle()
    f.model.select('a', true); const applying = f.model.apply()
    f.notice(); f.reads[1]!.resolve(snapshot(['b'], ['b'])); await settle()
    f.writes[0]!.gate.resolve(snapshot(['a'], ['a'])); await applying
    expect(f.model.getSnapshot().snapshot?.installed.map((item) => item.catalogId)).toEqual(['b'])
    expect(f.reads).toHaveLength(3)
    f.reads[2]!.resolve(snapshot(['b'], ['b'])); await settle()
    expect(f.model.getSnapshot().selected).toEqual(['a'])
    expect(skillSettingsDirty(f.model.getSnapshot())).toBe(true)
    f.model.dispose()
  })

  test('交付未知只重读实际保存值，不重发或回滚', async () => {
    const f = open(); f.reads[0]!.resolve(snapshot()); await settle()
    f.model.select('a', true); const applying = f.model.apply()
    f.writes[0]!.gate.reject(new Error('原生私有路径')); await applying
    expect(f.writes).toHaveLength(1); expect(f.reads).toHaveLength(2)
    expect(f.model.getSnapshot().message).not.toContain('私有路径')
    f.reads[1]!.resolve(snapshot(['a'], ['a'])); await settle()
    expect(f.model.getSnapshot().snapshot?.installed).toHaveLength(1)
    expect(skillSettingsDirty(f.model.getSnapshot())).toBe(false)
    f.model.dispose()
  })

  test('读取失败不自动循环；手动刷新可恢复，未知异常不回显', async () => {
    const f = open(); f.reads[0]!.reject(new Error('private secret')); await settle()
    expect(f.reads).toHaveLength(1)
    expect(f.model.getSnapshot()).toMatchObject({ loading: false, refreshing: false, message: '读取 Skills 状态失败，请刷新状态' })
    f.model.refresh(); f.reads[1]!.resolve(snapshot()); await settle()
    expect(f.model.getSnapshot().snapshot).not.toBeNull()
    expect(f.model.getSnapshot().message).toBeNull()
    f.model.dispose()
  })

  test('释放订阅后旧读取/应用/通知均无效，不向新页面投递', async () => {
    const f = open(); f.reads[0]!.resolve(snapshot()); await settle()
    f.model.select('a', true); const applying = f.model.apply(); f.notice()
    f.model.dispose(); f.model.dispose(); const count = f.states.length
    f.reads[1]!.resolve(snapshot(['b'], ['b'])); f.writes[0]!.gate.resolve(snapshot(['a'], ['a'])); await applying; await settle()
    f.notice(); f.model.select('b', true); await f.model.apply()
    expect(f.states).toHaveLength(count); expect(f.reads).toHaveLength(2); expect(f.writes).toHaveLength(1); expect(f.unsubscribed()).toBe(1)
  })

  test('新通知读取失败后保留草稿但不应用过期状态，明确刷新成功后才开放应用', async () => {
    const f = open(); f.reads[0]!.resolve(snapshot()); await settle()
    f.model.select('a', true)
    f.notice(); f.reads[1]!.reject(new Error('已断开')); await settle()
    expect(f.model.getSnapshot().selected).toEqual(['a'])
    expect(skillSettingsCanApply(f.model.getSnapshot())).toBe(false)
    await f.model.apply(); expect(f.writes).toEqual([])
    f.model.refresh(); f.reads[2]!.resolve(snapshot()); await settle()
    expect(skillSettingsCanApply(f.model.getSnapshot())).toBe(true)
    f.model.dispose()
  })
})
