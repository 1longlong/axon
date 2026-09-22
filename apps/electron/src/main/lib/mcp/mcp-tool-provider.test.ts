import { describe, expect, test } from 'bun:test'
import type { McpProjectConfig, McpServerConfig } from '@axon/shared'
import {
  McpToolProvider,
  McpToolProviderError,
  type ConnectedMcpClientSession,
  type McpClientSession,
} from './mcp-tool-provider'

function stdioConfig(command = 'server', required = false): McpServerConfig {
  return {
    type: 'stdio', command, enabled: true, required,
    startupTimeoutMs: 1_000, requestTimeoutMs: 2_000,
  }
}

function projectConfig(server: McpServerConfig): McpProjectConfig {
  return { version: 1, servers: { local: server } }
}

function connected(client: McpClientSession, ready: Promise<void> = Promise.resolve()): ConnectedMcpClientSession {
  return { client, ready }
}

describe('MCP 工具提供器', () => {
  test('分页发现工具、复用连接并转发调用结果', async () => {
    let connects = 0
    let calls = 0
    const client: McpClientSession = {
      listTools: async (params) => params?.cursor
        ? { tools: [{ name: 'image.tool', inputSchema: { type: 'object' } }] }
        : { tools: [{ name: 'read-file', description: '读取', inputSchema: { type: 'object' } }], nextCursor: 'page-2' },
      callTool: async ({ name, arguments: input }) => {
        calls += 1
        return { content: [{ type: 'text', text: `${name}:${String(input.path)}` }], structuredContent: { ok: true } }
      },
      close: async () => undefined,
    }
    const provider = new McpToolProvider({
      getProjectConfig: () => projectConfig(stdioConfig()),
      connectServer: () => { connects += 1; return connected(client) },
    })

    const first = await provider.getTools('project-1')
    const second = await provider.getTools('project-1')
    expect(connects).toBe(1)
    expect(first.map((tool) => tool.name)).toEqual(['mcp__local__read_file', 'mcp__local__image_tool'])
    expect(first.every((tool) => tool.isDeferred === true)).toBe(true)
    const result = await second[0]!.execute({ path: 'a.ts' }, { toolUseId: 'tool-1' })
    expect(result.content).toEqual([{ type: 'text', text: 'read-file:a.ts' }])
    expect(result.details).toEqual({ ok: true })
    expect(calls).toBe(1)
  })

  test('图片原样传递，runtime 不支持的资源块完整转成文本', async () => {
    const client: McpClientSession = {
      listTools: async () => ({ tools: [{ name: 'mixed', inputSchema: { type: 'object' } }] }),
      callTool: async () => ({ content: [
        { type: 'image', data: 'base64', mimeType: 'image/png' },
        { type: 'resource', resource: { uri: 'file:///a', text: 'hello' } },
      ] }),
      close: async () => undefined,
    }
    const provider = new McpToolProvider({
      getProjectConfig: () => projectConfig(stdioConfig()),
      connectServer: () => connected(client),
    })
    const [tool] = await provider.getTools('project-1')
    const result = await tool!.execute({}, { toolUseId: 'tool-1' })
    expect(Array.isArray(result.content)).toBe(true)
    if (!Array.isArray(result.content)) throw new Error('预期 MCP 混合结果为内容块数组')
    expect(result.content[0]).toEqual({ type: 'image', data: 'base64', mimeType: 'image/png' })
    expect(result.content[1]).toMatchObject({ type: 'text' })
    expect((result.content[1] as { text: string }).text).toContain('file:///a')
  })

  test('可选服务器失败时降级，必需服务器失败时阻断', async () => {
    const failure = new Error('offline')
    const unavailable = (required: boolean) => new McpToolProvider({
      getProjectConfig: () => projectConfig(stdioConfig('server', required)),
      connectServer: () => connected({
        listTools: async () => ({ tools: [] }),
        callTool: async () => ({ content: [] }),
        close: async () => undefined,
      }, Promise.reject(failure)),
    })
    expect(await unavailable(false).getTools('project-1')).toEqual([])
    await expect(unavailable(true).getTools('project-1')).rejects.toBeInstanceOf(McpToolProviderError)
  })

  test('配置哈希变化时关闭旧连接并建立新连接', async () => {
    let config = projectConfig(stdioConfig('one'))
    let connects = 0
    let closes = 0
    const provider = new McpToolProvider({
      getProjectConfig: () => config,
      connectServer: () => {
        connects += 1
        return connected({
          listTools: async () => ({ tools: [] }),
          callTool: async () => ({ content: [] }),
          close: async () => { closes += 1 },
        })
      },
    })
    await provider.getTools('project-1')
    config = projectConfig(stdioConfig('two'))
    await provider.getTools('project-1')
    await Promise.resolve()
    expect(connects).toBe(2)
    expect(closes).toBe(1)
  })

  test('项目失效时等待活跃调用释放租约后再关闭', async () => {
    let finishCall: (() => void) | undefined
    let closes = 0
    const client: McpClientSession = {
      listTools: async () => ({ tools: [{ name: 'slow', inputSchema: { type: 'object' } }] }),
      callTool: () => new Promise((resolve) => {
        finishCall = () => resolve({ content: [{ type: 'text', text: 'done' }] })
      }),
      close: async () => { closes += 1 },
    }
    const provider = new McpToolProvider({
      getProjectConfig: () => projectConfig(stdioConfig()),
      connectServer: () => connected(client),
    })
    const [tool] = await provider.getTools('project-1')
    const execution = tool!.execute({}, { toolUseId: 'tool-1' })
    for (let index = 0; index < 10 && !finishCall; index += 1) await Promise.resolve()
    expect(finishCall).toBeDefined()
    provider.disposeProject('project-1')
    expect(closes).toBe(0)
    finishCall?.()
    await execution
    await Promise.resolve()
    expect(closes).toBe(1)
  })
})
