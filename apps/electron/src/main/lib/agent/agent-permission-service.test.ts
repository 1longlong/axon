import { describe, expect, test } from 'bun:test'
import { AgentPermissionService } from './agent-permission-service'

function options(signal: AbortSignal, toolUseId = 'tool-1') {
  return { signal, toolUseId, permissionMode: 'default' as const }
}

describe('AgentPermissionService', () => {
  test('安全读取自动允许，危险请求绑定 owner，答复后可按选择复用', async () => {
    const service = new AgentPermissionService({ createId: () => 'request-1', now: () => 100 })
    expect(service.bindOwner('session-1', 7)).toBe(true)
    const run = new AbortController()
    const events: string[] = []
    service.subscribe((event) => events.push(event.type))
    const canUseTool = service.createCanUseTool('session-1', 10, run.signal)

    expect((await canUseTool('Read', { file_path: '/tmp/a' }, options(run.signal))).behavior).toBe('allow')
    expect((await canUseTool('SkillRead', { name: 'review-code' }, options(run.signal))).behavior).toBe('allow')
    expect((await canUseTool('tool_search', { query: 'github' }, options(run.signal))).behavior).toBe('allow')
    const pending = canUseTool('Bash', { command: 'echo hi' }, options(run.signal))
    await Promise.resolve()
    expect(events).toEqual(['permission_request'])
    expect(service.respond(8, { requestId: 'request-1', behavior: 'allow', alwaysAllow: true })).toBe(false)
    expect(service.respond(7, { requestId: 'request-1', behavior: 'allow', alwaysAllow: true })).toBe(true)
    expect(await pending).toMatchObject({ behavior: 'allow', updatedInput: { command: 'echo hi' } })
    expect(events).toEqual(['permission_request', 'permission_resolved'])

    const second = await canUseTool('Bash', { command: 'echo hi' }, options(run.signal, 'tool-2'))
    expect(second.behavior).toBe('allow')
    service.unbindOwner('session-1', 7)
  })

  test('acceptEdits 只自动允许文件编辑，bypassPermissions 全放行', async () => {
    const service = new AgentPermissionService()
    service.bindOwner('session-1', 1)
    const run = new AbortController()
    const allowEdits = service.createCanUseTool('session-1', 1, run.signal)
    expect((await allowEdits('Write', { file_path: 'a' }, {
      ...options(run.signal), permissionMode: 'acceptEdits',
    })).behavior).toBe('allow')
    expect((await allowEdits('MemoryRead', { path: 'preferences.md' }, {
      ...options(run.signal), permissionMode: 'default',
    })).behavior).toBe('allow')
    expect((await allowEdits('MemoryWrite', { path: 'preferences.md' }, {
      ...options(run.signal), permissionMode: 'acceptEdits',
    })).behavior).toBe('allow')
    expect((await allowEdits('MemoryWrite', { path: 'preferences.md' }, {
      ...options(run.signal), permissionMode: 'plan',
    }))).toMatchObject({ behavior: 'deny' })
    const bypass = service.createCanUseTool('session-1', 1, run.signal)
    expect((await bypass('Bash', { command: 'rm -rf /' }, {
      ...options(run.signal), permissionMode: 'bypassPermissions',
    })).behavior).toBe('allow')
  })

  test('运行停止、窗口解绑和超时都会拒绝并清除等待', async () => {
    const service = new AgentPermissionService({ createId: () => 'request-1', timeoutMs: 10 })
    service.bindOwner('session-1', 2)
    const run = new AbortController()
    const canUseTool = service.createCanUseTool('session-1', 1, run.signal)
    const aborted = canUseTool('Write', { file_path: 'a' }, options(run.signal))
    run.abort()
    expect(await aborted).toEqual({ behavior: 'deny', message: 'Agent 运行已停止' })

    const secondRun = new AbortController()
    const secondCanUseTool = service.createCanUseTool('session-1', 1, secondRun.signal)
    const timed = secondCanUseTool('Write', { file_path: 'b' }, options(secondRun.signal, 'tool-2'))
    expect(await timed).toEqual({ behavior: 'deny', message: '权限确认已超时' })
    const thirdRun = new AbortController()
    const thirdCanUseTool = service.createCanUseTool('session-1', 1, thirdRun.signal)
    const ownerGone = thirdCanUseTool('Write', { file_path: 'c' }, options(thirdRun.signal, 'tool-3'))
    service.unbindOwner('session-1', 2)
    expect(await ownerGone).toEqual({ behavior: 'deny', message: '权限请求所属窗口已关闭' })
  })

  test('允许 renderer 修正输入，但不会把危险请求加入始终允许白名单', async () => {
    const service = new AgentPermissionService({ createId: () => 'request-1' })
    service.bindOwner('session-1', 3)
    const run = new AbortController()
    const canUseTool = service.createCanUseTool('session-1', 1, run.signal)
    const pending = canUseTool('Bash', { command: 'rm -rf build' }, options(run.signal))
    await Promise.resolve()
    expect(service.respond(3, {
      requestId: 'request-1', behavior: 'allow', alwaysAllow: true,
      updatedInput: { command: 'ls' },
    })).toBe(true)
    expect(await pending).toEqual({ behavior: 'allow', updatedInput: { command: 'ls' } })
    const next = canUseTool('Bash', { command: 'rm -rf build' }, options(run.signal, 'tool-2'))
    await Promise.resolve()
    expect(service.respond(3, { requestId: 'request-1', behavior: 'deny' })).toBe(true)
    expect((await next).behavior).toBe('deny')
  })
})
