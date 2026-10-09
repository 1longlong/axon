/** 在 Electron 自带 Node 子进程验证宿主 Shell/Seatbelt 模块；不是生产 Agent 全链路验收。 */
import { strict as assert } from 'node:assert'
import { createServer } from 'node:http'
import { existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, realpathSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { AgentSandboxEscalationError } from '@axon/shared'
import type { AgentHostShellEnvironment, AgentSandboxShellCommandRequest } from '@axon/shared'
import { AgentSandboxCommandService } from '@axon/host-node'
import { buildAgentSandboxPolicy } from '@axon/core'
import { AgentPermissionService } from '@axon/core'

const directory = realpathSync(mkdtempSync(join(tmpdir(), 'axon-shell-smoke-')))
let environment: AgentHostShellEnvironment | undefined
const server = createServer((_request, response) => { response.end('network-approved') })
const timeout = setTimeout(() => { console.error('Shell 冒烟超时'); finish(1) }, 30_000)

function quote(value: string): string { return `'${value.replaceAll("'", "'\\''")}'` }

/** 关闭隔离资源并清理本次夹具，不触碰真实用户配置或应用会话。 */
function finish(code: number): void {
  clearTimeout(timeout)
  environment?.dispose()
  server.close()
  rmSync(directory, { recursive: true, force: true })
  process.exit(code)
}

/** 只等待夹具快照发布，生产工具入口本身不等待初始化。 */
async function waitForSnapshot(cache: string): Promise<string> {
  const deadline = Date.now() + 5_000
  while (Date.now() < deadline) {
    const file = existsSync(cache) ? readdirSync(cache).find((name) => name.endsWith('.sh')) : undefined
    if (file) return join(cache, file)
    await new Promise((done) => setTimeout(done, 10))
  }
  throw new Error('隔离快照未发布')
}

/** 原始命令先被 Seatbelt 拒绝；仅携带返回的精确权限重新执行，其他路径仍不放宽。 */
async function expectEscalation(
  request: AgentSandboxShellCommandRequest,
  reason: AgentSandboxEscalationError['escalation']['reason'],
): Promise<AgentSandboxEscalationError> {
  try {
    const result = await environment!.executeShellCommand(request)
    throw new Error(`夹具越界命令未产生结构化审批：${JSON.stringify(result)}`)
  }
  catch (error) {
    if (!(error instanceof AgentSandboxEscalationError)) throw error
    assert.equal(error.escalation.reason, reason)
    return error
  }
}

delete process.env.ELECTRON_RUN_AS_NODE
void (async () => {
  const workspace = join(directory, 'workspace')
  const home = join(directory, 'home')
  const tools = join(home, 'tools')
  const cache = join(directory, 'snapshots')
  const initialization = join(home, 'initialized')
  for (const path of [workspace, home, tools]) mkdirSync(path)
  writeFileSync(join(tools, 'axon-fixture-tool'), '#!/bin/sh\nprintf profile-tool\n', { mode: 0o700 })
  writeFileSync(join(home, '.zshrc'), `export PATH=${quote(tools)}:$PATH\nexport AXON_FIXTURE=profile\nprintf x >> ${quote(initialization)}\n`)
  const host = new AgentSandboxCommandService({
    resolveShell: () => ({ type: 'zsh', path: '/bin/zsh' }), shellSnapshotDirectory: cache,
    shellInitializationEnvironment: { HOME: home, ZDOTDIR: home, PATH: '/usr/bin:/bin' },
    getShellSessionActivity: () => new Map([['smoke', Date.now()]]),
  })
  assert.equal(host.getCapability().available, true, '当前进程无法实际应用 Seatbelt')
  environment = host.initializeShellEnvironment({ sessionId: 'smoke', cwd: workspace })
  const snapshot = await waitForSnapshot(cache)
  const context: Omit<AgentSandboxShellCommandRequest, 'command'> = {
    cwd: workspace, policy: buildAgentSandboxPolicy({ projectRoot: workspace, mode: 'workspaceWrite' }), grants: [],
    environment: { HOME: home, ZDOTDIR: home, PATH: '/usr/bin:/bin' },
    environmentOverrides: { HOME: home, ZDOTDIR: home },
  }
  const stream: string[] = []
  const restored = await environment.executeShellCommand({ ...context, command: 'axon-fixture-tool; printf ":%s" "$AXON_FIXTURE"; printf error >&2' }, {
    onStdout: (chunk) => stream.push(chunk),
  })
  assert.equal(restored.exitCode, 0)
  assert.equal(restored.stdout, 'profile-tool:profile')
  assert.equal(restored.stderr, 'error')
  assert.equal(stream.join(''), restored.stdout)
  // 初始化可写用户配置区域，模型命令仍不可写；就绪后不再重跑启动配置。
  assert.equal(readFileSync(initialization, 'utf8'), 'x')
  const inside = join(workspace, 'inside.txt')
  assert.equal((await environment.executeShellCommand({ ...context, command: `printf inside > ${quote(inside)}` })).exitCode, 0)
  assert.equal(readFileSync(inside, 'utf8'), 'inside')
  // explore 的 Shell 实际采用只读 profile；项目写入被 OS 拒绝，审批也不能扩大角色权限。
  const readOnly = { ...context, policy: buildAgentSandboxPolicy({ projectRoot: workspace, mode: 'readOnly' }) }
  assert.equal((await environment.executeShellCommand({ ...readOnly, command: `cat ${quote(inside)}` })).stdout, 'inside')
  const readOnlyTarget = join(workspace, 'read-only-denied.txt')
  const readOnlyCommand = `printf denied > ${quote(readOnlyTarget)}`
  const readOnlyDenied = await expectEscalation({ ...readOnly, command: readOnlyCommand }, 'filesystemWriteOutsideWorkspace')
  assert.equal(existsSync(readOnlyTarget), false)
  const run = new AbortController()
  const permission = new AgentPermissionService().createCanUseTool('explore-smoke', Date.now(), run.signal, 'explore')
  assert.equal((await permission('Bash', { command: readOnlyCommand }, {
    signal: run.signal, toolUseId: 'read-only-write',
    executionPolicy: { sandboxMode: 'readOnly', approvalPolicy: 'onRequest', approvalReviewer: 'user' },
    toolExecution: { kind: 'sandbox', mode: 'readOnly' }, sandboxEscalation: readOnlyDenied.escalation,
  })).behavior, 'deny')
  const outside = join(home, 'outside.txt')
  const original = { ...context, command: `printf outside > ${quote(outside)}` }
  const denied = await expectEscalation(original, 'filesystemWriteOutsideWorkspace')
  assert.deepEqual(denied.escalation.permission, { type: 'filesystemWrite', roots: [outside] })
  assert.equal(existsSync(outside), false)
  assert.equal((await environment.executeShellCommand({ ...original, grants: [{ scope: 'once', permission: denied.escalation.permission }] })).exitCode, 0)
  assert.equal(readFileSync(outside, 'utf8'), 'outside')
  await expectEscalation({ ...context, command: `printf no > ${quote(join(home, 'still-denied.txt'))}` }, 'filesystemWriteOutsideWorkspace')

  await new Promise<void>((done) => server.listen(0, '127.0.0.1', done))
  const address = server.address()
  assert(address && typeof address !== 'string')
  // nc 保留系统 errno，curl 的通用连接失败并不提供可归因的沙箱拒绝证据。
  const network = { ...context, command: `/usr/bin/nc -z -v -w 3 127.0.0.1 ${address.port}` }
  const networkDenied = await expectEscalation(network, 'networkAccess')
  assert.equal((await environment.executeShellCommand({ ...network, grants: [{ scope: 'once', permission: networkDenied.escalation.permission }] })).exitCode, 0)
  const overridden = await environment.executeShellCommand({
    ...context, command: 'printf "%s:%s" "$AXON_FIXTURE" "$TMPDIR"',
    environmentOverrides: { ...context.environmentOverrides, AXON_FIXTURE: 'explicit', TMPDIR: home },
  })
  assert(overridden.stdout.startsWith('explicit:'))
  const toolTemp = overridden.stdout.slice('explicit:'.length)
  assert.notEqual(toolTemp, home)
  assert.equal(existsSync(toolTemp), false)
  const child = join(workspace, 'child')
  mkdirSync(child)
  assert.equal((await environment.executeShellCommand({ ...context, cwd: child, command: 'printf %s "${AXON_FIXTURE-unset}"' })).stdout, 'unset')
  const abort = new AbortController()
  const running = environment.executeShellCommand({ ...context, command: '/bin/sleep 20', abortSignal: abort.signal })
  setTimeout(() => abort.abort(), 80)
  assert.equal((await running).aborted, true)
  assert.equal((await environment.executeShellCommand({ ...context, command: '/bin/sleep 20', timeoutMs: 80 })).timedOut, true)
  assert.equal(readFileSync(initialization, 'utf8'), 'x')
  environment.dispose()
  assert.equal(existsSync(snapshot), false)
  assert.deepEqual(readdirSync(cache), [])
  console.log('SHELL_SMOKE_OK: 真实 Electron/Seatbelt、异步初始化、PATH 恢复、输出流、工作区写入、只读角色写入拒绝且不能升级、精确文件/网络授权、环境覆盖、cwd 回退、停止/超时及释放清理通过')
  finish(0)
})().catch((error: unknown) => { console.error('Shell 冒烟失败', error); finish(1) })
