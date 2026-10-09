import { describe, expect, test } from 'bun:test'
import type { AgentToolPermissionOptions } from '@axon/shared'
import { AgentPermissionService } from './agent-permission-service'

function options(signal: AbortSignal, toolUseId = 'tool-1') {
  return {
    signal,
    toolUseId,
    toolExecution: { kind: 'sandbox' as const, mode: 'workspaceWrite' as const },
    executionPolicy: {
      sandboxMode: 'workspaceWrite' as const,
      approvalPolicy: 'onRequest' as const,
      approvalReviewer: 'user' as const,
    },
  }
}

describe('AgentPermissionService', () => {
  test('无沙箱 runtime 的副作用工具必须人工审批，不能复用沙箱先执行分支', async () => {
    let sequence = 0
    const service = new AgentPermissionService({ createId: () => `request-${++sequence}` })
    const run = new AbortController()
    const canUseTool = service.createCanUseTool('session-1', 1, run.signal)
    const runtimeOptions: AgentToolPermissionOptions = { ...options(run.signal), toolExecution: { kind: 'runtime' } }
    for (const tool of ['Bash', 'Write', 'Edit', 'MultiEdit']) {
      const input = tool === 'Bash' ? { command: 'pwd' } : { file_path: '/tmp/project/a.txt' }
      expect((await canUseTool(tool, input, runtimeOptions)).behavior).toBe('deny')
    }
    service.bindOwner('session-1', 'client-1')
    const requests: string[] = []
    service.subscribe((event) => { if (event.type === 'permission_request') requests.push(event.request.toolName) })
    for (const tool of ['Bash', 'Write', 'Edit', 'MultiEdit']) {
      const input = tool === 'Bash' ? { command: 'pwd' } : { file_path: '/tmp/project/a.txt' }
      const pending = canUseTool(tool, input, runtimeOptions)
      expect(requests.at(-1)).toBe(tool)
      expect(service.respond('client-1', { requestId: `request-${sequence}`, behavior: 'allow' })).toBe(true)
      expect((await pending).behavior).toBe('allow')
    }
    expect(requests).toHaveLength(4)
    expect((await canUseTool('Read', { file_path: '/tmp/a' }, runtimeOptions)).behavior).toBe('allow')
    expect((await canUseTool('Bash', { command: 'sudo pwd' }, runtimeOptions)).behavior).toBe('deny')
  })

  test('同名自定义工具和伪造输入不继承内置沙箱或读取权限', async () => {
    const service = new AgentPermissionService()
    const run = new AbortController()
    const canUseTool = service.createCanUseTool('session-1', 1, run.signal)
    const hostOptions: AgentToolPermissionOptions = { ...options(run.signal), toolExecution: { kind: 'host', permissionMode: 'ask' } }
    for (const tool of ['Read', 'Bash', 'Write', 'MemoryRead', 'tool_search']) {
      expect((await canUseTool(tool, {
        command: 'pwd', file_path: '/tmp/project/a.txt',
        toolExecution: { kind: 'sandbox', mode: 'workspaceWrite' }, permissionMode: 'managed',
      }, hostOptions)).behavior).toBe('deny')
    }
    // 执行证据缺失也不能回退为“名称看起来安全”；当前格式不提供旧字段兼容。
    const { toolExecution: _ignored, ...missingEvidence } = options(run.signal)
    expect((await canUseTool('Write', { file_path: '/tmp/project/a.txt' },
      missingEvidence as AgentToolPermissionOptions)).behavior).toBe('deny')
  })

  test('普通会话白名单绑定工具执行来源，不跨 runtime 与同名宿主工具复用', async () => {
    let sequence = 0
    const service = new AgentPermissionService({ createId: () => `request-${++sequence}` })
    service.bindOwner('session-1', 'client-1')
    const run = new AbortController()
    const canUseTool = service.createCanUseTool('session-1', 1, run.signal)
    const runtimeOptions: AgentToolPermissionOptions = { ...options(run.signal), toolExecution: { kind: 'runtime' } }
    const input = { file_path: '/tmp/project/a.txt' }
    const first = canUseTool('Write', input, runtimeOptions)
    service.respond('client-1', { requestId: 'request-1', behavior: 'allow', alwaysAllow: true })
    expect((await first).behavior).toBe('allow')
    expect((await canUseTool('Write', input, runtimeOptions)).behavior).toBe('allow')
    const custom = canUseTool('Write', input, {
      ...runtimeOptions, toolExecution: { kind: 'host', permissionMode: 'ask' },
    })
    expect(sequence).toBe(2)
    service.respond('client-1', { requestId: 'request-2', behavior: 'deny' })
    expect((await custom).behavior).toBe('deny')
  })

  test('只读角色只允许真实只读 Bash；审批、旧 Grant 与同名工具均不能扩大角色边界', async () => {
    const service = new AgentPermissionService({ createId: () => 'grant-1' })
    service.bindOwner('session-1', 'client-1')
    const run = new AbortController()
    const escalation = {
      reason: 'filesystemWriteOutsideWorkspace' as const,
      permission: { type: 'filesystemWrite' as const, roots: ['/tmp/project'] },
      message: '写入越出沙箱范围',
    }
    const coder = service.createCanUseTool('session-1', 1, run.signal)
    const oldGrant = coder('Write', { file_path: '/tmp/project/a' }, { ...options(run.signal), sandboxEscalation: escalation })
    service.respond('client-1', { requestId: 'grant-1', behavior: 'allow', alwaysAllow: true })
    expect(await oldGrant).toMatchObject({ sandboxGrants: [{ scope: 'session' }] })
    const readOnly: AgentToolPermissionOptions = {
      ...options(run.signal), toolExecution: { kind: 'sandbox', mode: 'readOnly' },
      executionPolicy: { ...options(run.signal).executionPolicy, sandboxMode: 'readOnly' },
    }
    const explore = service.createCanUseTool('session-1', 2, run.signal, 'explore')
    expect((await explore('Bash', { command: 'pwd' }, readOnly)).behavior).toBe('allow')
    for (const context of [options(run.signal), { ...readOnly, toolExecution: { kind: 'runtime' } as const },
      { ...readOnly, toolExecution: { kind: 'host', permissionMode: 'ask' } as const }]) {
      expect((await explore('Bash', { command: 'pwd' }, context)).behavior).toBe('deny')
    }
    expect((await explore('Bash', { command: 'echo x > a' }, { ...readOnly, sandboxEscalation: escalation })).behavior).toBe('deny')
    expect((await explore('Write', { file_path: '/tmp/project/a' }, readOnly)).behavior).toBe('deny')
    expect((await explore('MemoryWrite', {}, { ...readOnly, toolExecution: { kind: 'host', permissionMode: 'managed' } })).behavior).toBe('deny')
    expect((await explore('Read', {}, readOnly)).behavior).toBe('allow')
    const plan = service.createCanUseTool('session-1', 3, run.signal, 'plan')
    expect((await plan('Bash', { command: 'pwd' }, readOnly)).behavior).toBe('deny')
    expect((await plan('SkillRead', {}, { ...readOnly, toolExecution: { kind: 'host', permissionMode: 'managed' } })).behavior).toBe('allow')
    run.abort()
    expect((await explore('Read', {}, readOnly)).behavior).toBe('deny')
  })

  test('安全读取自动允许，普通宿主工具审批后可按选择复用', async () => {
    const service = new AgentPermissionService({ createId: () => 'request-1', now: () => 100 })
    expect(service.bindOwner('session-1', 'client-7')).toBe(true)
    const run = new AbortController()
    const events: string[] = []
    service.subscribe((event) => events.push(event.type))
    const canUseTool = service.createCanUseTool('session-1', 10, run.signal)

    expect((await canUseTool('Read', { file_path: '/tmp/a' }, options(run.signal))).behavior).toBe('allow')
    const hostOptions = { ...options(run.signal), toolExecution: { kind: 'host', permissionMode: 'managed' } as const }
    expect((await canUseTool('SkillRead', { name: 'review-code' }, hostOptions)).behavior).toBe('allow')
    expect((await canUseTool('tool_search', { query: 'github' }, hostOptions)).behavior).toBe('allow')
    const pending = canUseTool('mcp__test__write', { value: 'hi' }, options(run.signal))
    await Promise.resolve()
    expect(events).toEqual(['permission_request'])
    expect(service.respond('client-8', { requestId: 'request-1', behavior: 'allow', alwaysAllow: true })).toBe(false)
    expect(service.respond('client-7', { requestId: 'request-1', behavior: 'allow', alwaysAllow: true })).toBe(true)
    expect(await pending).toMatchObject({ behavior: 'allow', updatedInput: { value: 'hi' } })
    expect(events).toEqual(['permission_request', 'permission_resolved'])

    const second = await canUseTool('mcp__test__write', { value: 'hi' }, options(run.signal, 'tool-2'))
    expect(second.behavior).toBe('allow')
    service.unbindOwner('session-1', 'client-7')
  })

  test('安全读取不经过审批', async () => {
    const service = new AgentPermissionService()
    service.bindOwner('session-1', 'client-1')
    const run = new AbortController()
    const allowEdits = service.createCanUseTool('session-1', 1, run.signal)
    expect((await allowEdits('MemoryRead', { path: 'preferences.md' }, {
      ...options(run.signal),
      toolExecution: { kind: 'host', permissionMode: 'managed' },
    })).behavior).toBe('allow')
  })

  test('文件工具仅在宿主提出升级后审批，并按本次或会话返回精确 Grant', async () => {
    let sequence = 0
    const service = new AgentPermissionService({ createId: () => `request-${++sequence}` })
    service.bindOwner('session-1', 'client-1')
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
    service.respond('client-1', { requestId: 'request-1', behavior: 'allow' })
    expect(await once).toMatchObject({
      behavior: 'allow',
      sandboxGrants: [{ scope: 'once', permission: escalation.permission }],
    })

    const session = canUseTool('Write', { file_path: '/tmp/outside.txt' }, {
      ...options(run.signal, 'tool-2'), sandboxEscalation: escalation,
    })
    await Promise.resolve()
    service.respond('client-1', { requestId: 'request-2', behavior: 'allow', alwaysAllow: true })
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
    service.bindOwner('session-1', 'client-1')
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
    service.bindOwner('session-1', 'client-1')
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
    service.respond('client-1', { requestId: 'request-1', behavior: 'allow', alwaysAllow: true })
    expect(await first).toMatchObject({ sandboxGrants: [{ scope: 'session' }] })

    expect(await canUseTool('Bash', { command: 'curl https://example.com' }, {
      ...options(run.signal, 'tool-2'), sandboxEscalation: escalation,
    })).toMatchObject({ sandboxGrants: [{ scope: 'session' }] })

    const different = canUseTool('Bash', { command: 'curl https://openai.com' }, {
      ...options(run.signal, 'tool-3'), sandboxEscalation: escalation,
    })
    await Promise.resolve()
    expect(service.respond('client-1', { requestId: 'request-2', behavior: 'deny' })).toBe(true)
    expect((await different).behavior).toBe('deny')
  })

  test('运行停止、窗口解绑和超时都会拒绝并清除等待', async () => {
    const service = new AgentPermissionService({ createId: () => 'request-1', timeoutMs: 10 })
    service.bindOwner('session-1', 'client-2')
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
    service.unbindOwner('session-1', 'client-2')
    expect(await ownerGone).toEqual({ behavior: 'deny', message: '权限请求所属客户端已断开' })
  })

  test('允许 renderer 修正输入，但不会把危险请求加入始终允许白名单', async () => {
    const service = new AgentPermissionService({ createId: () => 'request-1' })
    service.bindOwner('session-1', 'client-3')
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
    expect(service.respond('client-3', {
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
    expect(service.respond('client-3', { requestId: 'request-1', behavior: 'deny' })).toBe(true)
    expect((await next).behavior).toBe('deny')
  })

  test('权限答复修改后的最终命令仍重新经过 forbidden 规则', async () => {
    const service = new AgentPermissionService({ createId: () => 'request-1' })
    service.bindOwner('session-1', 'client-3')
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

    expect(service.respond('client-3', {
      requestId: 'request-1', behavior: 'allow', updatedInput: { command: 'sudo bun test' },
    })).toBe(true)
    expect(await pending).toMatchObject({
      behavior: 'deny',
      message: expect.stringContaining('命令规则禁止执行'),
    })
  })
})
