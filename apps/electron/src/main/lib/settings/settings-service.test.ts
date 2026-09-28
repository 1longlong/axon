import { describe, expect, test } from 'bun:test'
import { validateAgentSkillCatalogIds, validateQuickChatShortcuts } from './settings-service'

describe('Agent Skill 期望设置', () => {
  test('规范化稳定 catalog ID，并拒绝重复和损坏输入', () => {
    expect(validateAgentSkillCatalogIds([' official/review ', 'team/lint']))
      .toEqual(['official/review', 'team/lint'])
    expect(() => validateAgentSkillCatalogIds(['same', ' same '])).toThrow('重复')
    expect(() => validateAgentSkillCatalogIds([1])).toThrow('无效')
  })
})

describe('快捷会话设置', () => {
  test('规范化绑定，并拒绝重复组合键和损坏会话类型', () => {
    expect(validateQuickChatShortcuts([{
      id: ' binding-1 ',
      accelerator: ' CommandOrControl+Shift+Space ',
      sessionType: 'chat',
      sessionId: ' conversation-1 ',
    }])).toEqual([{
      id: 'binding-1',
      accelerator: 'CommandOrControl+Shift+Space',
      sessionType: 'chat',
      sessionId: 'conversation-1',
    }])
    expect(() => validateQuickChatShortcuts([
      { id: 'one', accelerator: 'Command+1', sessionType: 'chat', sessionId: 'one' },
      { id: 'two', accelerator: ' command+1 ', sessionType: 'agent', sessionId: 'two' },
    ])).toThrow('重复')
    expect(() => validateQuickChatShortcuts([
      { id: 'bad', accelerator: 'Command+2', sessionType: 'unknown', sessionId: 'one' },
    ])).toThrow('字段无效')
  })
})
