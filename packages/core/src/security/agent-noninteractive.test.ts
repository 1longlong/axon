import { describe, expect, test } from 'bun:test'
import type { AgentToolPermissionOptions } from '@axon/shared'
import { AgentAskUserService } from './agent-ask-user-service'
import { AgentPermissionService } from './agent-permission-service'

function options(signal: AbortSignal): AgentToolPermissionOptions {
  return {
    signal, toolUseId: 'tool-1', toolExecution: { kind: 'sandbox', mode: 'workspaceWrite' },
    executionPolicy: { sandboxMode: 'workspaceWrite', approvalPolicy: 'never', approvalReviewer: 'user' },
  }
}

describe('非交互工具策略', () => {
  test('never 保留基础执行边界；需要人工授权时不创建请求，已有 owner 也不等待', async () => {
    const service = new AgentPermissionService({ createId: () => { throw new Error('不应创建审批') } })
    service.bindOwner('session', 'client')
    const events: string[] = []
    service.subscribe((event) => events.push(event.type))
    const run = new AbortController()
    const canUseTool = service.createCanUseTool('session', 1, run.signal)
    const base = options(run.signal)
    expect(await canUseTool('Read', { file_path: '/project/a' }, base)).toMatchObject({ behavior: 'allow' })
    expect(await canUseTool('Bash', { command: 'pwd' }, base)).toMatchObject({ behavior: 'allow' })
    expect(await canUseTool('Write', { file_path: '/project/a' }, base)).toEqual({
      behavior: 'allow', updatedInput: { file_path: '/project/a' },
    })
    expect(await canUseTool('SkillRead', {}, { ...base, toolExecution: { kind: 'host', permissionMode: 'managed' } }))
      .toMatchObject({ behavior: 'allow' })
    for (const execution of [{ kind: 'runtime' }, { kind: 'host', permissionMode: 'ask' }] as const) {
      expect(await canUseTool('Write', {}, { ...base, toolExecution: execution }))
        .toMatchObject({ behavior: 'deny', message: expect.stringContaining('never') })
    }
    expect(await canUseTool('Bash', { command: 'sudo pwd' }, base))
      .toMatchObject({ behavior: 'deny', message: expect.stringContaining('命令规则') })
    const explore = service.createCanUseTool('session', 2, run.signal, 'explore')
    expect(await explore('Write', {}, base)).toMatchObject({ behavior: 'deny' })
    run.abort()
    expect(await canUseTool('Read', {}, base)).toMatchObject({ behavior: 'deny', message: 'Agent 运行已停止' })
    expect(events).toEqual([])
    expect(service.cancelSession('session')).toBe(0)
  })

  test('never 不复用交互轮留下的普通白名单或沙箱 Grant', async () => {
    let sequence = 0
    const service = new AgentPermissionService({ createId: () => `approval-${++sequence}` })
    service.bindOwner('session', 'client')
    const run = new AbortController()
    const canUseTool = service.createCanUseTool('session', 1, run.signal)
    const base = options(run.signal)
    const interactive: AgentToolPermissionOptions = {
      ...base, executionPolicy: { ...base.executionPolicy, approvalPolicy: 'onRequest' },
    }
    const input = { file_path: '/outside/a' }
    const rawWrite = { ...interactive, toolExecution: { kind: 'runtime' } as const }
    const first = canUseTool('Write', input, rawWrite)
    expect(service.respond('client', { requestId: 'approval-1', behavior: 'allow', alwaysAllow: true })).toBe(true)
    expect(await first).toMatchObject({ behavior: 'allow' })
    const escalation = {
      reason: 'filesystemWriteOutsideWorkspace' as const,
      permission: { type: 'filesystemWrite' as const, roots: ['/outside'] }, message: '写入越出范围',
    }
    const second = canUseTool('Write', input, { ...interactive, sandboxEscalation: escalation })
    expect(service.respond('client', { requestId: 'approval-2', behavior: 'allow', alwaysAllow: true })).toBe(true)
    expect(await second).toMatchObject({ sandboxGrants: [{ scope: 'session' }] })

    expect(await canUseTool('Write', input, { ...rawWrite, executionPolicy: base.executionPolicy }))
      .toMatchObject({ behavior: 'deny' })
    expect(await canUseTool('Write', input, { ...base, sandboxEscalation: escalation }))
      .toMatchObject({ behavior: 'deny' })
    expect(await canUseTool('Write', input, base)).toEqual({ behavior: 'allow', updatedInput: input })
    expect(sequence).toBe(2)
    expect(service.cancelSession('session')).toBe(0)
    // 桌面下一轮仍可使用用户明确保存的授权；never 只是不消费它们。
    expect(await canUseTool('Write', input, rawWrite)).toMatchObject({ behavior: 'allow' })
  })

  test('reject 不创建追问请求，也不编造回答；缺省 ask 仍正常等待真实答复', async () => {
    let sequence = 0
    const service = new AgentAskUserService(() => `question-${++sequence}`)
    service.bindOwner('session', 'client')
    const events: string[] = []
    service.subscribe((event) => events.push(event.type))
    const run = new AbortController()
    const input = { questions: [{ question: '目标版本？', options: [{ label: 'v1' }] }] }
    const result = await service.createTool('session', 1, run.signal, 'reject').execute(input, { toolUseId: 'ask-1' })
    expect(result).toMatchObject({ isError: true, content: expect.stringContaining('无法提供用户回答') })
    expect(sequence).toBe(0)
    expect(events).toEqual([])
    expect(service.cancelSession('session')).toBe(0)
    const answer = service.createTool('session', 2, run.signal).execute(input, { toolUseId: 'ask-2' })
    expect(events).toEqual(['ask_user_request'])
    expect(service.respond('client', { requestId: 'question-1', behavior: 'answer', answers: { '目标版本？': 'v1' } })).toBe(true)
    expect(await answer).toEqual({ content: { answers: { '目标版本？': 'v1' } } })
    expect(events).toEqual(['ask_user_request', 'ask_user_resolved'])
  })
})
