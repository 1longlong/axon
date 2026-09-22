import { describe, expect, test } from 'bun:test'
import {
  DEFAULT_MCP_REQUEST_TIMEOUT_MS,
  DEFAULT_MCP_STARTUP_TIMEOUT_MS,
} from '@axon/shared'
import { parseMcpProjectConfig } from './mcp-validator'

describe('MCP 项目配置校验', () => {
  test('解析 stdio/HTTP 并物化稳定默认值', () => {
    const result = parseMcpProjectConfig({
      version: 1,
      servers: {
        files: { type: 'stdio', command: 'npx', args: ['-y', 'server'] },
        docs: { type: 'http', url: 'https://example.com/mcp', headers: { Authorization: 'Bearer token' } },
      },
    })
    expect(result.ok).toBe(true)
    if (!result.ok) return
    expect(result.config.servers.files).toMatchObject({
      enabled: true,
      required: false,
      startupTimeoutMs: DEFAULT_MCP_STARTUP_TIMEOUT_MS,
      requestTimeoutMs: DEFAULT_MCP_REQUEST_TIMEOUT_MS,
    })
    expect(result.config.servers.docs?.type).toBe('http')
  })

  test('拒绝旧传输别名、未知字段和无效超时', () => {
    const result = parseMcpProjectConfig({
      version: 1,
      servers: { legacy: { type: 'sse', url: 'https://example.com', extra: true, requestTimeoutMs: 1 } },
    })
    expect(result.ok).toBe(false)
    if (result.ok) return
    expect(result.diagnostics.map((item) => item.code)).toContain('invalid_transport')
  })

  test('拒绝 URL 凭据、非 HTTP 协议和请求头换行注入', () => {
    for (const server of [
      { type: 'http', url: 'https://user:pass@example.com/mcp' },
      { type: 'http', url: 'file:///tmp/mcp' },
      { type: 'http', url: 'https://example.com/mcp', headers: { Authorization: 'ok\r\nInjected: yes' } },
    ]) expect(parseMcpProjectConfig({ version: 1, servers: { remote: server } }).ok).toBe(false)
  })

  test('一次返回多个字段诊断而不是遇到首错即停止', () => {
    const result = parseMcpProjectConfig({
      version: 2,
      unknown: true,
      servers: { 'Bad Name': { type: 'stdio', command: '' } },
    })
    expect(result.ok).toBe(false)
    if (result.ok) return
    expect(result.diagnostics.length).toBeGreaterThanOrEqual(3)
  })
})
