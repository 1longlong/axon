import { describe, expect, test } from 'bun:test'
import type { AgentCustomToolDefinition } from '@axon/shared'
import {
  AGENT_TOOL_SEARCH_NAME,
  appendDeferredToolCatalogPrompt,
  createAgentToolSearchTool,
  withAgentToolSearch,
  resolveDeferredToolMode,
} from './agent-tool-search'

function tool(
  name: string,
  description: string,
  inputSchema: Record<string, unknown>,
  isDeferred: boolean,
): AgentCustomToolDefinition {
  return {
    name,
    description,
    inputSchema,
    isDeferred,
    execute: async () => ({ content: 'ok' }),
  }
}

describe('Agent tool_search', () => {
  const definitions = [
    tool('Read', '读取项目文件', { type: 'object', properties: { path: { type: 'string' } } }, false),
    tool('mcp__github__issues', '查询代码仓库问题', {
      type: 'object',
      required: ['repository'],
      properties: { repository: { type: 'string', description: 'GitHub 仓库名称' } },
    }, true),
    tool('mcp__calendar__events', '查询日历事件', {
      type: 'object',
      properties: { start_date: { type: 'string', description: '开始日期' } },
    }, true),
  ]

  test('自身保持 eager，并只返回匹配 deferred 工具的完整 schema', async () => {
    const search = createAgentToolSearchTool(definitions)
    expect(search.name).toBe(AGENT_TOOL_SEARCH_NAME)
    expect(search.isDeferred).toBe(false)

    const result = await search.execute({ query: 'github repository' }, { toolUseId: 'search-1' })
    expect(result.isError).toBeUndefined()
    expect(result.content).toMatchObject({
      query: 'github repository',
      tools: [{
        name: 'mcp__github__issues',
        input_schema: definitions[1]!.inputSchema,
      }],
    })
    expect(result.addedToolNames).toEqual(['mcp__github__issues'])
  })

  test('可以按参数名称和描述检索，且不会返回 eager 工具', async () => {
    const search = createAgentToolSearchTool(definitions)
    const byParameter = await search.execute({ query: 'start date' }, { toolUseId: 'search-2' })
    expect(byParameter.content).toMatchObject({
      tools: [{ name: 'mcp__calendar__events' }],
    })

    const eager = await search.execute({ query: '读取 path' }, { toolUseId: 'search-3' })
    expect(eager.content).toMatchObject({ tools: [] })
  })

  test('拒绝空查询和超长查询', async () => {
    const search = createAgentToolSearchTool(definitions)
    expect((await search.execute({ query: ' ' }, { toolUseId: 'search-4' })).isError).toBe(true)
    expect((await search.execute({ query: 'x'.repeat(501) }, { toolUseId: 'search-5' })).isError).toBe(true)
  })

  test('有延迟工具时追加唯一搜索工具，没有时保持原集合', () => {
    const appended = withAgentToolSearch(definitions)
    expect(appended.map((definition) => definition.name)).toEqual([
      'Read', 'mcp__github__issues', 'mcp__calendar__events', AGENT_TOOL_SEARCH_NAME,
    ])
    expect(withAgentToolSearch(appended)).toHaveLength(appended.length)
    expect(withAgentToolSearch([definitions[0]!])).toEqual([definitions[0]!])
  })

  test('动态提示词只列名称和短说明，并固定追加在最末尾', () => {
    const deferred = tool(
      'mcp__remote__large',
      `远程搜索 ${'详细说明 '.repeat(80)}`,
      { type: 'object', required: ['secret_parameter'], properties: { secret_parameter: { type: 'string' } } },
      true,
    )
    const prompt = appendDeferredToolCatalogPrompt('稳定前缀\n\n动态记忆', [definitions[0]!, deferred])
    expect(prompt.startsWith('稳定前缀\n\n动态记忆')).toBe(true)
    expect(prompt).toContain('mcp__remote__large: 远程搜索')
    expect(prompt).toContain('先调用 tool_search')
    expect(prompt).not.toContain('secret_parameter')
    expect(prompt.endsWith('</system-reminder>')).toBe(true)
  })

  test('拒绝把 tool_search 本身配置成延迟工具', () => {
    expect(() => withAgentToolSearch([
      tool(AGENT_TOOL_SEARCH_NAME, '错误定义', { type: 'object' }, true),
    ])).toThrow('tool_search 不能设置为延迟工具')
  })

  test('协议不支持时移除搜索入口并恢复完整工具为 eager', () => {
    const tools = withAgentToolSearch(definitions)
    const resolved = resolveDeferredToolMode(tools, false)
    expect(resolved.map((tool) => [tool.name, tool.isDeferred])).toEqual([
      ['Read', false],
      ['mcp__github__issues', false],
      ['mcp__calendar__events', false],
    ])
  })
})
