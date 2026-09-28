import { describe, expect, test } from 'bun:test'
import { AgentPermissionService } from './agent-permission-service'

function options(signal: AbortSignal, toolUseId = 'tool-1') {
  return {
    signal,
    toolUseId,
    executionPolicy: {
      sandboxMode: 'workspaceWrite' as const,
      approvalPolicy: 'onRequest' as const,
      approvalReviewer: 'user' as const,
    },
  }
}

describe('AgentPermissionService', () => {
  test('安全读取自动允许，普通宿主工具审批后可按选择复用', async () => {
    const service = new AgentPermissionService({ createId: () => 'request-1', now: () => 100 })
    expect(service.bindOwner('session-1', 7)).toBe(true)
    const run = new AbortController()
    const events: string[] = []
    service.subscribe((event) => events.push(event.type))
    const canUseTool = service.createCanUseTool('session-1', 10, run.signal)

    expect((await canUseTool('Read', { file_path: '/tmp/a' }, options(run.signal))).behavior).toBe('allow')
    expect((await canUseTool('SkillRead', { name: 'review-code' }, options(run.signal))).behavior).toBe('allow')
    expect((await canUseTool('tool_search', { query: 'github' }, options(run.signal))).behavior).toBe('allow')
    const pending = canUseTool('mcp__test__write', { value: 'hi' }, options(run.signal))
    await Promise.resolve()
    expect(events).toEqual(['permission_request'])
    expect(service.respond(8, { requestId: 'request-1', behavior: 'allow', alwaysAllow: true })).toBe(false)
    expect(service.respond(7, { requestId: 'request-1', behavior: 'allow', alwaysAllow: true })).toBe(true)
    expect(await pending).toMatchObject({ behavior: 'allow', updatedInput: { value: 'hi' } })
    expect(events).toEqual(['permission_request', 'permission_resolved'])

    const second = await canUseTool('mcp__test__write', { value: 'hi' }, options(run.signal, 'tool-2'))
    expect(second.behavior).toBe('allow')
    service.unbindOwner('session-1', 7)
  })

  test('安全读取不经过审批', async () => {
    const service = new AgentPermissionService()
    service.bindOwner('session-1', 1)
    const run = new AbortController()
    const allowEdits = service.createCanUseTool('session-1', 1, run.signal)
    expect((await allowEdits('MemoryRead', { path: 'preferences.md' }, {
      ...options(run.signal),
    })).behavior).toBe('allow')
  })

  test('文件工具仅在宿主提出升级后审批，并按本次或会话返回精确 Grant', async () => {
    let sequence = 0
    const service = new AgentPermissionService({ createId: () => `request-${++sequence}` })
    service.bindOwner('session-1', 1)
    const run = new AbortController()
    const requests: Array<{ requestId: string; sandboxEscalation?: unknown }> = []
    service.subscribe((event) => {
      if (event.type === 'permission_request') requests.push(event.request)
    })
    const canUseTool = service.createCanUseTool('session-1', 1, run.signal)
    const escalation = {
      reason: 'filesystemWriteOutsideWorkspace' as const,
      permission: { type: 'filesystemWrite' as const, roots: ['/tmp/outside.txt'] },
      target: '/tmp/outside.txt',
      message: '文件写入目标越过沙箱可写根',
    }

    expect((await canUseTool('Write', { file_path: '/tmp/outside.txt' }, options(run.signal))).behavior)
      .toBe('allow')
    expect(requests).toHaveLength(0)

    const once = canUseTool('Write', { file_path: '/tmp/outside.txt' }, {
      ...options(run.signal), sandboxEscalation: escalation,
    })
    await Promise.resolve()
    expect(requests[0]).toMatchObject({ requestId: 'request-1', sandboxEscalation: escalation })
    service.respond(1, { requestId: 'request-1', behavior: 'allow' })
    expect(await once).toMatchObject({
      behavior: 'allow',
      sandboxGrants: [{ scope: 'once', permission: escalation.permission }],
    })

    const session = canUseTool('Write', { file_path: '/tmp/outside.txt' }, {
      ...options(run.signal, 'tool-2'), sandboxEscalation: escalation,
    })
    await Promise.resolve()
    service.respond(1, { requestId: 'request-2', behavior: 'allow', alwaysAllow: true })
    expect(await session).toMatchObject({ sandboxGrants: [{ scope: 'session' }] })

    const reused = await canUseTool('Write', { file_path: '/tmp/outside.txt' }, {
      ...options(run.signal, 'tool-3'), sandboxEscalation: escalation,
    })
    expect(reused).toMatchObject({ sandboxGrants: [{ scope: 'session' }] })
    const nextWriteAttempt = await canUseTool('Write', { file_path: '/tmp/another.txt' }, {
      ...options(run.signal, 'tool-4'),
    })
    expect(nextWriteAttempt).toMatchObject({ sandboxGrants: [{ scope: 'session' }] })
    expect(requests).toHaveLength(2)
  })

  test('Bash 未命中显式限制时先进入沙箱，forbidden 直接拒绝', async () => {
    const service = new AgentPermissionService({ createId: () => 'request-1' })
    service.bindOwner('session-1', 1)
    const run = new AbortController()
    const events: string[] = []
    service.subscribe((event) => events.push(event.type))
    const canUseTool = service.createCanUseTool('session-1', 1, run.signal)

    expect((await canUseTool('Bash', { command: 'pwd | git status' }, options(run.signal))).behavior).toBe('allow')
    expect((await canUseTool('Bash', {
      command: "cd /Users/covenant/Workspace/Github/Proma && find docs -type f -not -path '*/node_modules/*' | sort",
    }, options(run.signal, 'tool-2'))).behavior).toBe('allow')
    expect((await canUseTool('Bash', { command: 'bun test' }, options(run.signal, 'tool-3'))).behavior).toBe('allow')
    expect(await canUseTool('Bash', { command: 'sudo cat /etc/hosts' }, options(run.signal))).toMatchObject({
      behavior: 'deny',
      message: expect.stringContaining('命令规则禁止执行'),
    })
    expect(events).toEqual([])
  })

  test('Bash 会话级网络 Grant 只复用完全相同的命令输入', async () => {
    let sequence = 0
    const service = new AgentPermissionService({ createId: () => `request-${++sequence}` })
    service.bindOwner('session-1', 1)
    const run = new AbortController()
    const canUseTool = service.createCanUseTool('session-1', 1, run.signal)
    const escalation = {
      reason: 'networkAccess' as const,
      permission: { type: 'network' as const },
      message: '命令的网络访问被基础沙箱拒绝',
    }

    const first = canUseTool('Bash', { command: 'curl https://example.com' }, {
      ...options(run.signal), sandboxEscalation: escalation,
    })
    await Promise.resolve()
    service.respond(1, { requestId: 'request-1', behavior: 'allow', alwaysAllow: true })
    expect(await first).toMatchObject({ sandboxGrants: [{ scope: 'session' }] })

    expect(await canUseTool('Bash', { command: 'curl https://example.com' }, {
      ...options(run.signal, 'tool-2'), sandboxEscalation: escalation,
    })).toMatchObject({ sandboxGrants: [{ scope: 'session' }] })

    const different = canUseTool('Bash', { command: 'curl https://openai.com' }, {
      ...options(run.signal, 'tool-3'), sandboxEscalation: escalation,
    })
    await Promise.resolve()
    expect(service.respond(1, { requestId: 'request-2', behavior: 'deny' })).toBe(true)
    expect((await different).behavior).toBe('deny')
  })

  test('运行停止、窗口解绑和超时都会拒绝并清除等待', async () => {
    const service = new AgentPermissionService({ createId: () => 'request-1', timeoutMs: 10 })
    service.bindOwner('session-1', 2)
    const run = new AbortController()
    const canUseTool = service.createCanUseTool('session-1', 1, run.signal)
    const aborted = canUseTool('mcp__test__write', { action: 'test' }, options(run.signal))
    run.abort()
    expect(await aborted).toEqual({ behavior: 'deny', message: 'Agent 运行已停止' })

    const secondRun = new AbortController()
    const secondCanUseTool = service.createCanUseTool('session-1', 1, secondRun.signal)
    const timed = secondCanUseTool('mcp__test__write', { action: 'build' }, options(secondRun.signal, 'tool-2'))
    expect(await timed).toEqual({ behavior: 'deny', message: '权限确认已超时' })
    const thirdRun = new AbortController()
    const thirdCanUseTool = service.createCanUseTool('session-1', 1, thirdRun.signal)
    const ownerGone = thirdCanUseTool('mcp__test__write', { action: 'lint' }, options(thirdRun.signal, 'tool-3'))
    service.unbindOwner('session-1', 2)
    expect(await ownerGone).toEqual({ behavior: 'deny', message: '权限请求所属窗口已关闭' })
  })

  test('允许 renderer 修正输入，但不会把危险请求加入始终允许白名单', async () => {
    const service = new AgentPermissionService({ createId: () => 'request-1' })
    service.bindOwner('session-1', 3)
    const run = new AbortController()
    const canUseTool = service.createCanUseTool('session-1', 1, run.signal)
    const escalation = {
      reason: 'filesystemWriteOutsideWorkspace' as const,
      permission: { type: 'filesystemWrite' as const, roots: ['/tmp/build'] },
      target: '/tmp/build',
      message: '命令尝试写入工作区外目录',
    }
    const pending = canUseTool('Bash', { command: 'rm -rf build' }, {
      ...options(run.signal), sandboxEscalation: escalation,
    })
    await Promise.resolve()
    expect(service.respond(3, {
      requestId: 'request-1', behavior: 'allow', alwaysAllow: true,
      updatedInput: { command: 'ls' },
    })).toBe(true)
    expect(await pending).toMatchObject({
      behavior: 'allow', updatedInput: { command: 'ls' },
      sandboxGrants: [{ scope: 'once' }],
    })
    const next = canUseTool('Bash', { command: 'rm -rf build' }, {
      ...options(run.signal, 'tool-2'), sandboxEscalation: escalation,
    })
    await Promise.resolve()
    expect(service.respond(3, { requestId: 'request-1', behavior: 'deny' })).toBe(true)
    expect((await next).behavior).toBe('deny')
  })

  test('权限答复修改后的最终命令仍重新经过 forbidden 规则', async () => {
    const service = new AgentPermissionService({ createId: () => 'request-1' })
    service.bindOwner('session-1', 3)
    const run = new AbortController()
    const canUseTool = service.createCanUseTool('session-1', 1, run.signal)
    const pending = canUseTool('Bash', { command: 'bun test' }, {
      ...options(run.signal),
      sandboxEscalation: {
        reason: 'networkAccess', permission: { type: 'network' },
        message: '命令的网络访问被基础沙箱拒绝',
      },
    })
    await Promise.resolve()

    expect(service.respond(3, {
      requestId: 'request-1', behavior: 'allow', updatedInput: { command: 'sudo bun test' },
    })).toBe(true)
    expect(await pending).toMatchObject({
      behavior: 'deny',
      message: expect.stringContaining('命令规则禁止执行'),
    })
  })
})
