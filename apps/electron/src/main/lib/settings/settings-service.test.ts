import { describe, expect, test } from 'bun:test'
import { validateAgentSkillCatalogIds } from './settings-service'

describe('Agent Skill 期望设置', () => {
  test('规范化稳定 catalog ID，并拒绝重复和损坏输入', () => {
    expect(validateAgentSkillCatalogIds([' official/review ', 'team/lint']))
      .toEqual(['official/review', 'team/lint'])
    expect(() => validateAgentSkillCatalogIds(['same', ' same '])).toThrow('重复')
    expect(() => validateAgentSkillCatalogIds([1])).toThrow('无效')
  })
})
