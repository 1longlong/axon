import { afterEach, beforeEach, describe, expect, test } from 'bun:test'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type { AgentGenerationEvent } from '@axon/shared'
import { AgentEventBus } from './agent-event-bus'
import { AgentRunCoordinator } from './agent-run-coordinator'
import type { AgentRunCoordinatorOptions } from './agent-run-coordinator'
import { AgentServiceError } from './agent-service'
import { AgentSessionManager } from './agent-session-manager'
import { BackendClientRegistry } from '../backend-client-registry'

let directory: string
let sessions: AgentSessionManager
let nextId: number
let clients: BackendClientRegistry

beforeEach(() => {
  let sequence = 0
  clients = new BackendClientRegistry(() => `client-${++sequence}`)
  for (let index = 0; index < 8; index += 1) clients.register()
  directory = mkdtempSync(join(tmpdir(), 'axon-agent-ipc-'))
  nextId = 1
  sessions = new AgentSessionManager({
    indexPath: join(directory, 'sessions.json'),
    sessionsDir: join(directory, 'sessions'),
    createId: () => `session-${nextId++}`,
    now: () => 1_000 + nextId,
  })
})

afterEach(() => {
  clients.dispose()
  rmSync(directory, { recursive: true, force: true })
})

function passiveAgent(
  overrides: Partial<AgentRunCoordinatorOptions['agent']> = {},
): AgentRunCoordinatorOptions['agent'] {
  return {
    sendMessage: async () => {},
    stop: () => false,
    isActive: () => false,
    listActiveRuns: () => [],
    getActiveRun: () => undefined,
    ...overrides,
  }
}

describe('AgentRunCoordinator CRUD 与输入边界', () => {
  test('创建校验未完成前不写索引，异步失败仍不留下会话', async () => {
    let finish: (value: void) => void = () => { throw new Error('校验未启动') }
    const delayed = new Promise<void>((resolve) => { finish = resolve })
    const controller = new AgentRunCoordinator({ clients,
      sessions, agent: passiveAgent(), events: new AgentEventBus(), validateCreate: () => delayed,
    })
    const pending = controller.createSession({ runtimeId: 'zima' })
    expect(controller.listSessions()).toEqual([])
    finish()
    expect((await pending).runtimeId).toBe('zima')
    const failed = new AgentRunCoordinator({ clients,
      sessions, agent: passiveAgent(), events: new AgentEventBus(),
      validateCreate: async () => { throw new Error('凭据不可用') },
    })
    await expect(failed.createSession({ runtimeId: 'zima' })).rejects.toThrow('凭据不可用')
    expect(failed.listSessions()).toHaveLength(1)
  })

  test('Zima 创建前校验失败不会持久化，创建后不能切换 runtime', async () => {
    let allowed = false
    const controller = new AgentRunCoordinator({ clients,
      sessions, agent: passiveAgent(), events: new AgentEventBus(),
      validateCreate: (input) => {
        if (input.runtimeId === 'zima' && !allowed) throw new Error('Zima 未配置')
      },
    })
    await expect(controller.createSession({ runtimeId: 'zima' })).rejects.toThrow('Zima 未配置')
    expect(controller.listSessions()).toEqual([])
    allowed = true
    const created = (await controller.createSession({ runtimeId: 'zima' }))
    expect(created.runtimeId).toBe('zima')
    expect(() => controller.updateSession(created.id, { runtimeId: 'pi' })).toThrow()
  })

  test('会话 CRUD、消息读取和运行状态经过安全 DTO', async () => {
    const controller = new AgentRunCoordinator({ clients, sessions, agent: passiveAgent(), events: new AgentEventBus() })
    const created = (await controller.createSession({
      title: '编码任务', channelId: 'channel-1', modelId: 'model-1', projectId: 'project-1',
      thinkingLevel: 'low',
    }))
    expect(controller.listSessions()).toEqual([created])
    expect(controller.getSession(created.id)).toEqual(created)
    expect(controller.getSession('missing')).toBeNull()
    expect(controller.getMessages(created.id)).toEqual([])
    expect(controller.isActive(created.id)).toBe(false)

    const updated = controller.updateSession(created.id, { title: '新标题', projectId: null, thinkingLevel: 'xhigh' })
    expect(updated.title).toBe('新标题')
    expect(updated.thinkingLevel).toBe('xhigh')
    expect(updated).not.toHaveProperty('projectId')
    expect(controller.deleteSession(created.id).id).toBe(created.id)
  })

  test('拒绝未知字段、恢复凭据注入、错误执行策略与运行中删除', async () => {
    const created = sessions.create()
    const controller = new AgentRunCoordinator({ clients,
      sessions,
      agent: passiveAgent({ isActive: (id) => id === created.id }),
      events: new AgentEventBus(),
    })
    for (const value of [
      null,
      [],
      { hidden: true },
      { sdkSessionId: 'injected' },
      { sandboxMode: 'dangerFullAccess' },
      { approvalPolicy: 'never' },
      { approvalReviewer: 'autoReview' },
      { thinkingLevel: 'extreme' },
    ]) {
      await expect(controller.createSession(value)).rejects.toThrow(
        expect.objectContaining({ code: 'invalid_input' }),
      )
    }
    expect(() => controller.updateSession(created.id, { runtimeSessionFile: '/tmp/x' })).toThrow(
      expect.objectContaining({ code: 'invalid_input' }),
    )
    expect(() => controller.deleteSession(created.id)).toThrow(
      expect.objectContaining({ code: 'already_active' }),
    )
  })
})

describe('AgentRunCoordinator 运行所有权', () => {
  test('标题元数据使用常驻订阅，且不会混入发送 owner 的运行事件', async () => {
    const created = sessions.create()
    const events = new AgentEventBus()
    const ownerEvents: AgentGenerationEvent[] = []
    const metadataEvents: AgentGenerationEvent[] = []
    const controller = new AgentRunCoordinator({ clients,
      sessions,
      events,
      agent: passiveAgent({
        sendMessage: async () => {
          events.emit({ type: 'run_started', sessionId: created.id, runStartedAt: 10, source: 'renderer' })
          events.emit({
            type: 'session_title', sessionId: created.id, runStartedAt: 10,
            title: '新标题', updatedAt: 11,
          })
        },
      }),
    })
    const release = controller.subscribeSessionMetadata((event) => metadataEvents.push(event))

    await controller.send('client-7', { sessionId: created.id, text: '开始' }, (event) => ownerEvents.push(event))
    release()

    expect(ownerEvents.map((event) => event.type)).toEqual(['run_started'])
    expect(metadataEvents).toHaveLength(1)
    expect(metadataEvents[0]).toMatchObject({ type: 'session_title', title: '新标题' })
  })

  test('订阅先于服务启动，且只转发当前会话事件', async () => {
    const created = sessions.create()
    const events = new AgentEventBus()
    const received: AgentGenerationEvent[] = []
    const controller = new AgentRunCoordinator({ clients,
      sessions,
      events,
      agent: passiveAgent({
        sendMessage: async () => {
          events.emit({ type: 'run_started', sessionId: created.id, runStartedAt: 10, source: 'renderer' })
          events.emit({ type: 'run_started', sessionId: 'other', runStartedAt: 11, source: 'renderer' })
          events.emit({
            type: 'run_finished', sessionId: created.id, runStartedAt: 10, source: 'renderer',
            completion: {
              terminalReason: 'completed', resultSubtype: 'success', stoppedByUser: false,
              usage: { input_tokens: 0, output_tokens: 0 }, completedAt: 11, durationMs: 1, persisted: true,
            },
          })
        },
      }),
    })
    expect(await controller.send('client-7', { sessionId: created.id, text: '实现功能' }, (event) => {
      received.push(event)
    })).toEqual({ success: true, disposition: 'started' })
    expect(received.map((event) => event.type)).toEqual(['run_started', 'run_finished'])
  })

  test('只有 owner 能停止；同会话不能被另一客户端接管，清理会取消全部运行', async () => {
    const firstId = sessions.create().id
    const secondId = sessions.create().id
    const active = new Set<string>()
    const stopped: string[] = []
    const resolvers = new Map<string, () => void>()
    const agent = passiveAgent({
      sendMessage: async (input) => {
        active.add(input.sessionId)
        await new Promise<void>((resolve) => resolvers.set(input.sessionId, resolve))
        active.delete(input.sessionId)
      },
      stop: (id) => {
        if (!active.has(id) || stopped.includes(id)) return false
        stopped.push(id)
        return true
      },
      isActive: (id) => id === undefined ? active.size > 0 : active.has(id),
    })
    const controller = new AgentRunCoordinator({ clients, sessions, agent, events: new AgentEventBus() })
    const first = controller.send('client-1', { sessionId: firstId, text: '一' }, () => {})
    const second = controller.send('client-1', { sessionId: secondId, text: '二' }, () => {})
    expect(await controller.send('client-2', { sessionId: firstId, text: '接管' }, () => {})).toMatchObject({
      success: false, code: 'already_active',
    })
    expect(controller.stop('client-2', firstId)).toBe(false)
    expect(controller.stop('client-1', firstId)).toBe(true)
    expect(controller.cancelOwner('client-1')).toBe(1)
    expect(stopped).toEqual([firstId, secondId])
    resolvers.get(firstId)?.()
    resolvers.get(secondId)?.()
    await Promise.all([first, second])
  })

  test('保留业务错误码并隐藏未知异常细节', async () => {
    const created = sessions.create()
    const known = new AgentRunCoordinator({ clients,
      sessions, events: new AgentEventBus(),
      agent: passiveAgent({ sendMessage: async () => { throw new AgentServiceError('runtime_error', '运行失败') } }),
    })
    expect(await known.send('client-1', { sessionId: created.id, text: 'x' }, () => {})).toEqual({
      success: false, code: 'runtime_error', message: '运行失败',
    })
    const unknown = new AgentRunCoordinator({ clients,
      sessions, events: new AgentEventBus(),
      agent: passiveAgent({ sendMessage: async () => { throw new Error('secret') } }),
    })
    expect(await unknown.send('client-1', { sessionId: created.id, text: 'x' }, () => {})).toEqual({
      success: false, code: 'internal_error', message: 'Agent 请求失败',
    })
    expect(await unknown.send('client-1', { sessionId: created.id, text: 1 }, () => {})).toMatchObject({
      success: false, code: 'invalid_input',
    })
  })
})
