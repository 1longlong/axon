import { afterEach, describe, expect, test } from 'bun:test'
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { createBackendPaths, initializeBackendDirectories } from './backend-paths'
import { getSettings, updateSettings, validateAgentSkillCatalogIds, validateQuickChatShortcuts } from './settings-service'

const directories: string[] = []
afterEach(() => {
  for (const directory of directories.splice(0)) rmSync(directory, { recursive: true, force: true })
})

describe('显式设置文件', () => {
  test('不加载 Electron，以指定数据目录独立读写且两个实例互不覆盖', () => {
    const directory = mkdtempSync(join(tmpdir(), 'axon-explicit-settings-'))
    directories.push(directory)
    const first = createBackendPaths({ dataDir: join(directory, 'first'), homeDir: directory })
    const second = createBackendPaths({ dataDir: join(directory, 'second'), homeDir: directory })
    initializeBackendDirectories(first)
    initializeBackendDirectories(second)
    expect(getSettings(first.settingsPath).agentSystemPrompt).toBeUndefined()
    expect(existsSync(first.settingsPath)).toBe(false)

    updateSettings({ agentSystemPrompt: '项目规则', themeMode: 'light' }, first.settingsPath)
    updateSettings({ themeMode: 'dark' }, second.settingsPath)
    const changed = updateSettings({ rightPanelWidth: 300 }, first.settingsPath)
    expect(changed.agentSystemPrompt).toBe('项目规则')
    expect(changed.themeMode).toBe('light')
    expect(getSettings(second.settingsPath).agentSystemPrompt).toBeUndefined()
    expect(getSettings(second.settingsPath).themeMode).toBe('dark')
    expect(JSON.parse(readFileSync(first.settingsPath, 'utf8'))).toEqual(changed)

    // 恢复仍使用同一原子写备份链，不为目录注入更换持久化格式。
    writeFileSync(first.settingsPath, '{ broken')
    expect(getSettings(first.settingsPath).agentSystemPrompt).toBe('项目规则')
    expect(getSettings(first.settingsPath).rightPanelWidth).toBeUndefined()
  })
})

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
