/** 少量关键链路验收：真实 CLI、精确 Seatbelt 通道与资源清理，不请求外部模型。 */
import { expect, test } from 'bun:test'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { LoopControlServer } from '@axon/app-server'
import { buildAgentSandboxPolicy } from '@axon/core'
import { AgentSandboxCommandService, LoopPrecheckRunner, LoopPrecheckPermissionError } from '@axon/host-node'

test('真实 CLI 可回报中文且沙箱只允许当前精确 socket', async () => {
  if (process.platform !== 'darwin') return
  const directory = mkdtempSync(join(tmpdir(), 'axon-loop-control-check-'))
  const first = new LoopControlServer(), other = new LoopControlServer()
  const host = new AgentSandboxCommandService({ shellSnapshotDirectory: join(directory, 'snapshots'),
    resolveShell: () => ({ path: '/bin/sh', type: 'sh' }) })
  let calls = 0, otherCalls = 0
  try {
    const context = await first.start((token, argv) => {
      expect(token).toBe('a'.repeat(64)); expect(argv).toEqual(['report', '--message', '中文结果'])
      calls += 1; return { text: '回报已保存', exitCode: 0 }
    })
    const second = await other.start(() => { otherCalls += 1; return { text: '不应到达', exitCode: 0 } })
    const policy = { ...buildAgentSandboxPolicy({ projectRoot: directory, mode: 'workspaceWrite' }), controlSocketPath: context.socketPath }
    let output = ''
    const result = await host.executeShellCommand({ command: 'axon loop report --message "中文结果"', cwd: directory,
      policy, grants: [], pathPrepend: [context.commandDirectory],
      environmentOverrides: { AXON_LOOP_SOCKET: context.socketPath, AXON_LOOP_TOKEN: 'a'.repeat(64) }, timeoutMs: 15_000 },
    { onStdout: (chunk) => { output += chunk }, onStderr: (chunk) => { output += chunk } })
    if (result.exitCode !== 0) throw new Error(`受控 CLI 未执行成功：${output}`)
    expect(result.exitCode).toBe(0); expect(calls).toBe(1); expect(output).toContain('回报已保存')
    const denied = await host.executeShellCommand({ command: 'axon loop report --message "中文结果"', cwd: directory,
      policy, grants: [], pathPrepend: [context.commandDirectory],
      environmentOverrides: { AXON_LOOP_SOCKET: second.socketPath, AXON_LOOP_TOKEN: 'a'.repeat(64) }, timeoutMs: 15_000 }, {})
    expect(denied.exitCode).not.toBe(0); expect(otherCalls).toBe(0)
  } finally {
    first.dispose(); other.dispose(); host.dispose()
    await Promise.all([first.drain(), other.drain(), host.drain()])
    rmSync(directory, { recursive: true })
  }
}, 40_000)

test('真实预检进程返回游标与模型信号，MCP 拒绝不降级重放', async () => {
  if (process.platform !== 'darwin') return
  const directory = mkdtempSync(join(tmpdir(), 'axon-loop-precheck-check-'))
  const control = new LoopControlServer()
  const host = new AgentSandboxCommandService({ shellSnapshotDirectory: join(directory, 'snapshots') })
  const runner = new LoopPrecheckRunner(host)
  try {
    const context = await control.start((_token, argv) => argv[2] === 'allowed'
      ? { text: JSON.stringify({ content: [{ type: 'text', text: 'MCP 中文结果' }] }), exitCode: 0 }
      : { text: '此 Loop 没有该 MCP 工具的无人值守授权', exitCode: 1 })
    const input = { cwd: directory, policy: buildAgentSandboxPolicy({ projectRoot: directory, mode: 'readOnly' }),
      control: { ...context, token: 'b'.repeat(64) }, signal: new AbortController().signal }
    expect(await runner.run({ ...input, prev: { count: 1 }, code: 'return { message: "直接完成", state: { count: prev.count + 1 } }' }))
      .toEqual({ message: '直接完成', cursor: { count: 2 }, signals: [] })
    const result = await runner.run({ ...input, prev: null, code: 'const result = await tools.call("allowed", {}); agent("需要模型", result); return { state: 3 }' })
    expect(result.cursor).toBe(3)
    expect(result.signals[0]).toContain('MCP 中文结果')
    await expect(runner.run({ ...input, prev: null, code: 'await tools.call("denied", {})' })).rejects.toBeInstanceOf(LoopPrecheckPermissionError)
    await expect(runner.run({ ...input, prev: null, code: 'await tools.call("allowed", {}); throw new Error("调用后脚本失败")' })).rejects.toBeInstanceOf(LoopPrecheckPermissionError)
    await expect(runner.run({ ...input, prev: null, code: 'return Promise.reject(new Error("普通脚本错误"))' })).rejects.not.toBeInstanceOf(LoopPrecheckPermissionError)
  } finally {
    runner.dispose(); control.dispose(); host.dispose()
    await Promise.all([runner.drain(), control.drain(), host.drain()])
    rmSync(directory, { recursive: true })
  }
}, 40_000)
