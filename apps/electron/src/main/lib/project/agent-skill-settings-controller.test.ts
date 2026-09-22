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
