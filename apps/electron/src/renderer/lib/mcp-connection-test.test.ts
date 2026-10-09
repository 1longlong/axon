import { describe, expect, test } from 'bun:test'
import type { McpConnectionTestInput, McpConnectionTestResult } from '@axon/shared'
import { McpConnectionTestRunner } from './mcp-connection-test'

function open() {
  const calls: McpConnectionTestInput[] = [], cancelled: string[] = [], results: McpConnectionTestResult[] = []
  const pending: Array<ReturnType<typeof Promise.withResolvers<McpConnectionTestResult>>> = []
  let started = 0, finished = 0
  const runner = new McpConnectionTestRunner({
    testConnection: (input) => { calls.push(input); const gate = Promise.withResolvers<McpConnectionTestResult>(); pending.push(gate); return gate.promise },
    cancelConnectionTest: async (id) => { cancelled.push(id); return true },
  }, { started: () => { started += 1 }, result: (value) => results.push(value), finished: () => { finished += 1 } })
  const input = { projectId: 'project', serverName: 'local', server: {
    type: 'stdio' as const, command: 'fixture', enabled: false, required: false, startupTimeoutMs: 1000, requestTimeoutMs: 1000,
  } }
  return { runner, calls, cancelled, pending, results, input, counts: () => ({ started, finished }) }
}

describe('MCP 弹窗连接测试', () => {
  test('完整 schema 交付一次，忙时不重复发送，已完成不另发取消', async () => {
    const f = open(), run = f.runner.run(f.input)
    await f.runner.run(f.input)
    expect(f.calls).toHaveLength(1)
    const value: McpConnectionTestResult = { ok: true, tools: [{ name: 'tool', inputSchema: { required: ['value'] } }] }
    f.pending[0]!.resolve(value); await run
    expect(f.results).toEqual([value]); expect(f.counts()).toEqual({ started: 1, finished: 1 })
    f.runner.cancel(); expect(f.cancelled).toEqual([])
  })

  test('取消先释放 UI，旧成功/失败/收尾不能影响下一次测试', async () => {
    const f = open(), first = f.runner.run(f.input)
    f.runner.cancel(); f.runner.cancel()
    const second = f.runner.run(f.input)
    expect(f.cancelled).toEqual([f.calls[0]!.requestId])
    expect(f.calls[1]!.requestId).not.toBe(f.calls[0]!.requestId)
    f.pending[0]!.resolve({ ok: true, tools: [] }); await first
    expect(f.results).toEqual([]); expect(f.counts()).toEqual({ started: 2, finished: 1 })
    f.pending[1]!.reject(new Error('Authorization=private-secret')); await second
    expect(f.results).toEqual([{ ok: false, message: '连接测试失败，请检查服务配置和后端状态' }])
    expect(f.counts().finished).toBe(2)
  })

  test('关闭/卸载只取消原请求，不通知已卸载 UI，不再发送测试', async () => {
    const f = open(), first = f.runner.run(f.input)
    f.runner.dispose(); f.runner.dispose()
    f.pending[0]!.reject(new Error('迟到失败')); await first
    await f.runner.run(f.input)
    expect(f.calls).toHaveLength(1); expect(f.cancelled).toEqual([f.calls[0]!.requestId])
    expect(f.results).toEqual([]); expect(f.counts()).toEqual({ started: 1, finished: 0 })
  })
})
