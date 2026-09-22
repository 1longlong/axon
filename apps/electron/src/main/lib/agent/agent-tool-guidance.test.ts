import { describe, expect, test } from 'bun:test'
import { buildAgentToolGuidance } from './agent-tool-guidance'

describe('Agent 内置工具使用指引', () => {
  test('主 Agent 以 read 读文件，搜索和命令交给 bash，修改交给 edit/write', () => {
    const prompt = buildAgentToolGuidance()
    expect(prompt).toContain('优先调用 read')
    expect(prompt).toContain('rg --files')
    expect(prompt).toContain('rg -n')
    expect(prompt).toContain('优先用 edit')
    expect(prompt).toContain('用 write')
    expect(prompt).not.toContain('调用 Glob')
    expect(prompt).not.toContain('调用 Grep')
  })

  test('explore 子 Agent 不收到编辑工具指引', () => {
    const prompt = buildAgentToolGuidance('explore')
    expect(prompt).toContain('优先调用 read')
    expect(prompt).toContain('bash 执行 rg')
    expect(prompt).not.toContain('用 edit')
    expect(prompt).not.toContain('用 write')
  })

  test('plan 子 Agent 只收到 read 指引', () => {
    const prompt = buildAgentToolGuidance('plan')
    expect(prompt).toContain('优先调用 read')
    expect(prompt).not.toContain('bash')
    expect(prompt).not.toContain('edit')
    expect(prompt).not.toContain('write')
  })
})
