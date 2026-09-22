import { describe, expect, test } from 'bun:test'
import type { SDKMessage } from '@axon/shared'
import { getResultSkillActivations } from './agent-skill-usage'

describe('Agent 每轮 Skill 使用摘要', () => {
  test('读取 result 中的合法激活并按名称去重', () => {
    const message: SDKMessage = {
      type: 'result',
      subtype: 'success',
      usage: { input_tokens: 1 },
      skill_activations: [
        {
          name: 'review-code',
          directoryKind: 'agents',
          relativeInstructionPath: '.agents/skills/review-code/SKILL.md',
          sources: ['skill_read'],
        },
        {
          name: 'review-code',
          directoryKind: 'agents',
          relativeInstructionPath: '.agents/skills/review-code/SKILL.md',
          sources: ['skill_read'],
        },
      ],
    }

    expect(getResultSkillActivations(message)).toEqual([{
      name: 'review-code',
      directoryKind: 'agents',
      relativeInstructionPath: '.agents/skills/review-code/SKILL.md',
      sources: ['skill_read'],
    }])
  })

  test('忽略普通消息、越界路径和未知来源', () => {
    expect(getResultSkillActivations({
      type: 'result',
      subtype: 'success',
      usage: { input_tokens: 1 },
      skill_activations: [
        {
          name: 'review-code',
          directoryKind: 'agents',
          relativeInstructionPath: '../SKILL.md',
          sources: ['skill_read'],
        },
        {
          name: 'unsafe',
          directoryKind: 'axon',
          relativeInstructionPath: '.axon/skills/unsafe/SKILL.md',
          sources: ['unknown'],
        },
      ],
    } as SDKMessage)).toEqual([])
    expect(getResultSkillActivations({
      type: 'assistant', message: { content: [] }, parent_tool_use_id: null,
    })).toEqual([])
  })

  test('接受 Axon 管理和用户全局 Skill 的固定逻辑路径', () => {
    const result = getResultSkillActivations({
      type: 'result',
      subtype: 'success',
      usage: { input_tokens: 1 },
      skill_activations: [{
        name: 'builtin-review',
        directoryKind: 'builtin',
        relativeInstructionPath: '$HOME/.axon/skills/builtin-review/SKILL.md',
        sources: ['skill_read'],
      }, {
        name: 'user-review',
        directoryKind: 'user',
        relativeInstructionPath: '$HOME/.agents/skills/user-review/SKILL.md',
        sources: ['skill_read'],
      }],
    })
    expect(result.map((item) => item.directoryKind)).toEqual(['builtin', 'user'])
  })
})
