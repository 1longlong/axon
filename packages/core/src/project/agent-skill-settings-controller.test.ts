import { describe, expect, test } from 'bun:test'
import type {
  AgentSkillInstallationState,
  AgentSkillReconcileResult,
  InstallableSkillCatalog,
} from '@axon/shared'
import { AgentSkillSettingsController } from './agent-skill-settings-controller'
import type { AgentSkillCatalog } from './project-skill-discovery'

const installable: InstallableSkillCatalog = {
  packages: [{
    catalogId: 'official/review-code',
    name: 'review-code',
    version: '1.0.0',
    description: '审查关键代码',
    contentHash: 'a'.repeat(64),
    files: [{ path: 'SKILL.md', contentBase64: 'eA==', sha256: 'b'.repeat(64) }],
  }],
}

const discovered: AgentSkillCatalog = {
  projectRoot: '',
  skills: [{
    name: 'review-code', description: 'Axon 版本', directoryKind: 'builtin',
    directoryPath: '/private', instructionPath: '/private/SKILL.md',
    relativeInstructionPath: '$HOME/.axon/skills/review-code/SKILL.md', contentHash: 'c'.repeat(64),
  }],
  shadowedSkills: [{
    name: 'review-code', description: '用户版本', directoryKind: 'user',
    directoryPath: '/secret', instructionPath: '/secret/SKILL.md',
    relativeInstructionPath: '$HOME/.agents/skills/review-code/SKILL.md', contentHash: 'd'.repeat(64),
  }],
  diagnostics: [],
}

describe('AgentSkillSettingsController', () => {
  test('预取消不读目录或磁盘；目录挂起期间取消，迟到结果不安装或发现', async () => {
    for (const applying of [false, true]) {
      let finish = (): void => {}
      const catalog = new Promise<InstallableSkillCatalog>((resolve) => { finish = () => resolve(installable) })
      let reads = 0, installs = 0, discoveries = 0
      const controller = new AgentSkillSettingsController({
        catalog: { getCatalog: () => { reads += 1; return catalog } },
        installations: { getState: () => { throw new Error('不应读取安装清单') }, getDesiredCatalogIds: () => [],
          reconcile: () => { installs += 1; return { desiredCatalogIds: [], installed: [], failures: [] } } },
        discoverGlobalSkills: () => { discoveries += 1; return discovered },
      })
      const cancelled = new AbortController(); cancelled.abort()
      await expect(applying ? controller.apply([], cancelled.signal) : controller.getSnapshot(cancelled.signal)).rejects.toMatchObject({ name: 'AbortError' })
      expect(reads).toBe(0)
      const abort = new AbortController()
      const pending = applying ? controller.apply(['official/review-code'], abort.signal) : controller.getSnapshot(abort.signal)
      const outcome = pending.catch((error: unknown) => error)
      expect(reads).toBe(1)
      abort.abort(); expect(await outcome).toMatchObject({ name: 'AbortError' })
      finish(); await Promise.resolve(); await Promise.resolve()
      expect(installs).toBe(0); expect(discoveries).toBe(0)
    }
  })

  test('目录返回前取消不能进入同步写盘；写盘已接纳的操作不伪装为回滚', async () => {
    const abort = new AbortController()
    let installs = 0
    const controller = new AgentSkillSettingsController({
      catalog: { getCatalog: () => { abort.abort(); return installable } },
      installations: { getState: () => ({ version: 1, installed: [] }), getDesiredCatalogIds: () => [],
        reconcile: () => { installs += 1; return { desiredCatalogIds: [], installed: [], failures: [] } } },
      discoverGlobalSkills: () => discovered,
    })
    await expect(controller.apply(['official/review-code'], abort.signal)).rejects.toMatchObject({ name: 'AbortError' })
    expect(installs).toBe(0)
    const during = new AbortController()
    const accepted = new AgentSkillSettingsController({
      catalog: { getCatalog: () => installable },
      installations: { getState: () => ({ version: 1, installed: [] }), getDesiredCatalogIds: () => [],
        reconcile: () => { during.abort(); return { desiredCatalogIds: ['official/review-code'], installed: [], failures: [] } } },
      discoverGlobalSkills: () => discovered,
    })
    expect(await accepted.apply(['official/review-code'], during.signal)).toMatchObject({ desiredCatalogIds: ['official/review-code'] })
  })

  test('查询只返回安全摘要，并标记有效与被覆盖来源', async () => {
    const state: AgentSkillInstallationState = { version: 1, installed: [] }
    const controller = new AgentSkillSettingsController({
      catalog: { getCatalog: () => installable },
      installations: {
        getState: () => state,
        getDesiredCatalogIds: () => ['official/review-code'],
        reconcile: () => ({ desiredCatalogIds: [], installed: [], failures: [] }),
      },
      discoverGlobalSkills: () => discovered,
    })

    const snapshot = await controller.getSnapshot()
    expect(snapshot.available[0]).toEqual({
      catalogId: 'official/review-code', name: 'review-code', version: '1.0.0',
      description: '审查关键代码', contentHash: 'a'.repeat(64),
    })
    expect(snapshot.discovered.map((item) => [item.directoryKind, item.effective]))
      .toEqual([['builtin', true], ['user', false]])
    expect(JSON.stringify(snapshot)).not.toContain('/private')
    expect(JSON.stringify(snapshot)).not.toContain('/secret')
    expect(JSON.stringify(snapshot)).not.toContain('contentBase64')
  })

  test('应用时把选择交给安装服务，并返回逐项失败', async () => {
    let received: string[] = []
    const result: AgentSkillReconcileResult = {
      desiredCatalogIds: ['official/review-code'],
      installed: [],
      failures: [{ catalogId: 'official/review-code', message: '模拟失败' }],
    }
    const controller = new AgentSkillSettingsController({
      catalog: { getCatalog: async () => installable },
      installations: {
        getState: () => ({ version: 1, installed: [] }),
        getDesiredCatalogIds: () => [],
        reconcile: (_catalog, ids) => { received = ids ?? []; return result },
      },
      discoverGlobalSkills: () => discovered,
    })

    const snapshot = await controller.apply([' official/review-code '])
    expect(received).toEqual(['official/review-code'])
    expect(snapshot.failures).toEqual(result.failures)
    await expect(controller.apply('invalid')).rejects.toThrow('选择格式无效')
  })
})
