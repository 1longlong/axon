import { afterEach, describe, expect, test } from 'bun:test'
import { EventEmitter } from 'node:events'
import { PassThrough } from 'node:stream'
import { setTimeout as delay } from 'node:timers/promises'
import type { WebContents } from 'electron'
import { JsonRpcPeer } from '@axon/app-server'
import { AGENT_IPC_CHANNELS, AGENT_PROJECT_IPC_CHANNELS, AGENT_MEMORY_IPC_CHANNELS, CHAT_IPC_CHANNELS, CHANNEL_IPC_CHANNELS, SETTINGS_IPC_CHANNELS, USER_PROFILE_IPC_CHANNELS, APP_SERVER_CLIENT_METHODS as clientMethods, APP_SERVER_NOTIFICATIONS as notifications } from '@axon/shared'
import type { AppServerClientKind, RpcJsonObject, RpcJsonValue } from '@axon/shared'
import { AppServerEvents } from './app-server-events'
import type { AppServerEventOptions } from './app-server-events'
import { AppServerWindowClients } from './app-server-window-clients'
import { AGENT_TASK_IPC_CHANNELS } from '@axon/shared'

interface Delivery { channel: string; value: RpcJsonObject }
class Surface extends EventEmitter {
  readonly deliveries: Delivery[] = []
  readonly arraySnapshots: Array<{ channel: string; value: RpcJsonValue[] }> = []
  readonly identities: RpcJsonObject[] = []
  readonly order: string[] = []
  failSend = false
  isDestroyed(): boolean { return false }
  send(channel: string, value: RpcJsonObject | RpcJsonValue[]): void {
    if (this.failSend) throw new Error('夹具原生发送失败')
    this.order.push(channel)
    if (Array.isArray(value)) this.arraySnapshots.push({ channel, value })
    else if (channel === AGENT_IPC_CHANNELS.RUN_EVENT) this.identities.push(value)
    else this.deliveries.push({ channel, value })
    this.emit('delivery')
  }
  get sender(): WebContents { return this as unknown as WebContents }
  waitFor(type: string, offset = 0): Promise<Delivery> {
    return new Promise((resolve) => {
      const check = (): void => {
        const delivery = this.deliveries.slice(offset).find((item) => item.value.type === type)
        if (delivery) { this.removeListener('delivery', check); resolve(delivery) }
      }
      this.on('delivery', check); check()
    })
  }
}
const cleanups: Array<() => void> = []
afterEach(() => { for (const cleanup of cleanups.splice(0)) cleanup() })

/** 真正双向协议管道搭配受控原生窗口；不调用模型，不冒充 Electron GUI 验收。 */
async function open(native: Pick<AppServerEventOptions, 'onAgentEvent' | 'onProjectsChanged'> = {}) {
  const upstream = new PassThrough(), downstream = new PassThrough()
  const parent = new JsonRpcPeer(downstream, upstream, { requestTimeoutMs: 15 })
  const child = new JsonRpcPeer(upstream, downstream, { requestTimeoutMs: 15 })
  const main = new Surface(), quick = new Surface()
  const signals = new Map<string, AbortController>()
  let counter = 0
  const clients = new AppServerWindowClients({
    kindOf: (sender) => sender === main.sender ? 'main' : sender === quick.sender ? 'quick' : undefined,
    backend: {
      registerClient: async (kind: AppServerClientKind) => {
        const clientId = `client-${++counter}`
        signals.set(clientId, new AbortController())
        return { clientId, kind }
      },
      getClientSignal: (clientId) => signals.get(clientId)?.signal,
      detachClient: async (clientId) => { signals.get(clientId)?.abort(); return signals.delete(clientId) },
    },
  })
  const bridge = new AppServerEvents(parent, { clients, ...native })
  const mainId = (await clients.get(main.sender)).clientId, quickId = (await clients.get(quick.sender)).clientId
  cleanups.push(() => { bridge.dispose(); clients.dispose(); parent.close(); child.close(); upstream.destroy(); downstream.destroy() })
  return { parent, child, main, quick, bridge, clients, mainId, quickId, signals }
}
function envelope(type: string, extra: RpcJsonObject = {}, runId = 'run-1', sessionId = 'session', visibleSessionId = sessionId): RpcJsonObject {
  return { run: { sessionId, runId, runStartedAt: 100 }, visibleSessionId,
    event: { type, sessionId, runStartedAt: 100, ...extra } }
}
function interaction(type: 'permission_request' | 'ask_user_request', requestId = 'request-1', runId = 'run-1', sessionId = 'session', visibleSessionId = sessionId): RpcJsonObject {
  const request: RpcJsonObject = type === 'permission_request'
    ? { requestId, sessionId, runStartedAt: 100, toolUseId: 'tool-1', toolName: 'Bash', toolInput: { command: 'pwd' },
      description: '测试审批', dangerLevel: 'normal', allowAlways: false, createdAt: 100, expiresAt: Date.now() + 60000 }
    : { requestId, sessionId, runStartedAt: 100, questions: [{ question: '选择目录', options: [], multiSelect: false }] }
  return envelope(type, { request }, runId, sessionId, visibleSessionId)
}

describe('独立后端的固定事件和反向交互', () => {
  test('原生投影保留真实子轮次，原生异常不阻断 UI；旧页面不驱动 Dock', async () => {
    const received: Array<{ clientId: string; sessionId: string }> = []
    const f = await open({
      onAgentEvent: (clientId, event) => { received.push({ clientId, sessionId: event.sessionId }); throw new Error('原生夹具故障') },
      onProjectsChanged: () => { throw new Error('原生菜单夹具故障') },
    })
    f.child.handle('barrier', () => null)
    f.child.notify(notifications.AGENT_RUN, { clientId: f.mainId, event: envelope('run_started', { source: 'delegation' }, 'child-run', 'child', 'root') })
    f.child.notify(notifications.AGENT_RUN, { clientId: f.quickId, event: envelope('run_started', { source: 'renderer' }) })
    f.child.notify(notifications.PROJECTS_CHANGED, { clientId: f.mainId, projects: [] })
    await f.parent.request('barrier')
    expect(received).toEqual([{ clientId: f.mainId, sessionId: 'child' }, { clientId: f.quickId, sessionId: 'session' }])
    expect(f.main.identities).toEqual([])
    expect(f.quick.identities).toHaveLength(1)
    expect(f.main.arraySnapshots).toEqual([{ channel: AGENT_PROJECT_IPC_CHANNELS.CHANGED, value: [] }])
    f.main.emit('did-start-loading')
    f.child.notify(notifications.AGENT_RUN, { clientId: f.mainId, event: envelope('run_started', { source: 'renderer' }) })
    await f.parent.request('barrier')
    expect(received).toHaveLength(2)
  })

  test('Task 通知保留原订阅代次与子轮次，只送登记页面，不暴露 clientId 或新建审批', async () => {
    const f = await open()
    f.child.handle('barrier', () => null)
    const event = { type: 'agent_event', rootSessionId: 'root', taskId: 'task', agentId: 'child', run: { sessionId: 'child', runId: 'real-child', runStartedAt: 10 }, event: { type: 'run_started', sessionId: 'child', runStartedAt: 10, source: 'delegation' } }
    f.child.notify(notifications.TASK_EVENT, { clientId: f.mainId, subscriptionId: 'current', event })
    f.child.notify(notifications.TASK_EVENT, { clientId: 'unknown', subscriptionId: 'foreign', event })
    await f.parent.request('barrier')
    expect(f.main.deliveries).toEqual([{ channel: AGENT_TASK_IPC_CHANNELS.EVENT, value: { subscriptionId: 'current', event } }])
    expect(f.quick.deliveries).toEqual([])
    f.main.emit('did-start-loading')
    f.child.notify(notifications.TASK_EVENT, { clientId: f.mainId, subscriptionId: 'late', event })
    await f.parent.request('barrier')
    expect(f.main.deliveries).toHaveLength(1)
    const current = await f.clients.get(f.main.sender)
    f.bridge.dispose()
    f.child.notify(notifications.TASK_EVENT, { clientId: current.clientId, subscriptionId: 'disposed', event })
    await f.parent.request('barrier')
    expect(f.main.deliveries).toHaveLength(1)
  })
  test('工作区/记忆变化和关闭保留订阅代次但不暴露 owner；旧页面与释放后不转投', async () => {
    const f = await open()
    f.child.handle('barrier', () => null)
    const workspace = { projectId: 'p', subscriptionId: 'w', changedAt: 1 }
    const memory = { projectId: 'p', subscriptionId: 'm', changedAt: 2, relativePath: 'MEMORY.md' }
    const closed = { projectId: 'p', subscriptionId: 'm', kind: 'memory', reason: 'memory_disabled' }
    f.child.notify(notifications.WORKSPACE_CHANGED, { clientId: f.mainId, ...workspace })
    f.child.notify(notifications.MEMORY_CHANGED, { clientId: f.quickId, ...memory })
    f.child.notify(notifications.PROJECT_WATCH_CLOSED, { clientId: f.quickId, ...closed })
    await f.parent.request('barrier')
    expect(f.main.deliveries).toEqual([{ channel: AGENT_PROJECT_IPC_CHANNELS.DIRECTORY_CHANGED, value: workspace }])
    expect(f.quick.deliveries).toEqual([{ channel: AGENT_MEMORY_IPC_CHANNELS.CHANGED, value: memory },
      { channel: AGENT_PROJECT_IPC_CHANNELS.WATCH_CLOSED, value: closed }])
    f.main.emit('did-start-loading'); await f.clients.get(f.main.sender)
    f.child.notify(notifications.WORKSPACE_CHANGED, { clientId: f.mainId, ...workspace })
    f.child.notify(notifications.MEMORY_CHANGED, { clientId: 'unknown', ...memory })
    f.child.notify(notifications.PROJECT_WATCH_CLOSED, { clientId: f.mainId, ...closed })
    await f.parent.request('barrier')
    expect(f.main.deliveries).toHaveLength(1)
    expect(f.quick.deliveries).toHaveLength(2)
    f.bridge.dispose()
    f.child.notify(notifications.PROJECT_WATCH_CLOSED, { clientId: f.quickId, ...closed })
    await f.parent.request('barrier')
    expect(f.quick.deliveries).toHaveLength(2)
  })

  test('项目全量快照只投递原有效身份；重载、未知入口及释放后不转投', async () => {
    const f = await open(), projects = [{ id: 'project', memoryEnabled: true }]
    f.child.handle('barrier', () => null)
    f.child.notify(notifications.PROJECTS_CHANGED, { clientId: f.mainId, projects })
    await f.parent.request('barrier')
    expect(f.main.arraySnapshots).toEqual([{ channel: AGENT_PROJECT_IPC_CHANNELS.CHANGED, value: projects }])
    expect(f.quick.arraySnapshots).toEqual([])
    f.main.emit('did-start-loading')
    const next = await f.clients.get(f.main.sender)
    f.child.notify(notifications.PROJECTS_CHANGED, { clientId: f.mainId, projects: [] })
    f.child.notify(notifications.PROJECTS_CHANGED, { clientId: 'unknown', projects })
    f.child.notify(notifications.PROJECTS_CHANGED, { clientId: next.clientId, projects: [] })
    await f.parent.request('barrier')
    expect(f.main.arraySnapshots).toHaveLength(2)
    expect(f.main.arraySnapshots.at(-1)).toEqual({ channel: AGENT_PROJECT_IPC_CHANNELS.CHANGED, value: [] })
    f.bridge.dispose()
    f.child.notify(notifications.PROJECTS_CHANGED, { clientId: next.clientId, projects })
    await f.parent.request('barrier')
    expect(f.main.arraySnapshots).toHaveLength(2)
  })

  test('设置和资料固定通知只送已登记原页面，重载旧身份及释放后均不投递', async () => {
    const f = await open(), settings = { themeMode: 'light' }, profile = { userName: '用户', avatar: '' }
    f.child.handle('barrier', () => null)
    f.child.notify(notifications.SETTINGS_UPDATED, { clientId: f.mainId, settings })
    f.child.notify(notifications.USER_PROFILE_UPDATED, { clientId: f.quickId, profile })
    await f.parent.request('barrier')
    expect(f.main.deliveries).toEqual([{ channel: SETTINGS_IPC_CHANNELS.CHANGED, value: settings }])
    expect(f.quick.deliveries).toEqual([{ channel: USER_PROFILE_IPC_CHANNELS.CHANGED, value: profile }])
    f.main.emit('did-start-loading'); await f.clients.get(f.main.sender)
    f.child.notify(notifications.SETTINGS_UPDATED, { clientId: f.mainId, settings })
    f.child.notify(notifications.USER_PROFILE_UPDATED, { clientId: 'unknown', profile })
    await f.parent.request('barrier')
    expect(f.main.deliveries).toHaveLength(1)
    expect(f.quick.deliveries).toHaveLength(1)
    f.bridge.dispose()
    f.child.notify(notifications.USER_PROFILE_UPDATED, { clientId: f.quickId, profile })
    await f.parent.request('barrier')
    expect(f.quick.deliveries).toHaveLength(1)
  })

  test('渠道快照只送登记的原页面，未知/重载/释放后的通知不创建身份或转投', async () => {
    const f = await open()
    f.child.handle('barrier', () => null)
    const channels = [{ id: 'channel', name: '安全 DTO', hasApiKey: true }]
    f.child.notify(notifications.CHANNELS_CHANGED, { clientId: f.mainId, channels })
    f.child.notify(notifications.CHANNELS_CHANGED, { clientId: f.quickId, channels })
    await f.parent.request('barrier')
    expect(f.main.arraySnapshots).toEqual([{ channel: CHANNEL_IPC_CHANNELS.CHANGED, value: channels }])
    expect(f.quick.arraySnapshots).toEqual(f.main.arraySnapshots)
    f.main.emit('did-start-loading')
    const next = await f.clients.get(f.main.sender)
    f.child.notify(notifications.CHANNELS_CHANGED, { clientId: f.mainId, channels: [] })
    f.child.notify(notifications.CHANNELS_CHANGED, { clientId: 'unknown', channels })
    f.child.notify(notifications.CHANNELS_CHANGED, { clientId: next.clientId, channels: [] })
    await f.parent.request('barrier')
    expect(f.main.arraySnapshots).toHaveLength(2)
    expect(f.main.arraySnapshots.at(-1)).toEqual({ channel: CHANNEL_IPC_CHANNELS.CHANGED, value: [] })
    expect(f.quick.arraySnapshots).toHaveLength(1)
    f.bridge.dispose()
    f.child.notify(notifications.CHANNELS_CHANGED, { clientId: next.clientId, channels })
    await f.parent.request('barrier')
    expect(f.main.arraySnapshots).toHaveLength(2)
  })

  test('Chat 控制身份与消息保持顺序，只送原页面；重载后不转投新身份', async () => {
    const f = await open()
    const identity = { phase: 'started', generation: { conversationId: 'chat', generationId: 'actual' } }
    f.child.notify(notifications.CHAT_GENERATION_IDENTITY, { clientId: f.quickId, event: identity })
    f.child.notify(notifications.CHAT_GENERATION, { clientId: f.quickId, event: { type: 'title', conversationId: 'chat', title: '标题' } })
    await f.quick.waitFor('title')
    expect(f.quick.deliveries[0]).toEqual({ channel: CHAT_IPC_CHANNELS.GENERATION_EVENT, value: identity })
    expect(f.quick.order).toEqual([CHAT_IPC_CHANNELS.GENERATION_EVENT, CHAT_IPC_CHANNELS.EVENT])
    expect(f.main.deliveries).toEqual([])
    f.quick.emit('did-start-loading')
    await f.clients.get(f.quick.sender)
    f.child.notify(notifications.CHAT_GENERATION_IDENTITY, { clientId: f.quickId, event: identity })
    f.child.handle('barrier', () => null)
    await f.parent.request('barrier')
    expect(f.quick.deliveries).toHaveLength(2)
  })

  test('流/队列/晚到标题/Chat 只送原窗口并保持顺序，未知或重载入口不转投', async () => {
    const f = await open()
    f.child.notify(notifications.AGENT_RUN, { clientId: f.mainId, event: envelope('run_started', { source: 'renderer' }) })
    f.child.notify(notifications.AGENT_RUN, { clientId: f.mainId, event: envelope('stream', { source: 'renderer', payload: { kind: 'delta', text: '测试' } }) })
    f.child.notify(notifications.AGENT_QUEUE, { clientId: f.mainId, snapshot: { sessionId: 'session', messages: [] } })
    f.child.notify(notifications.AGENT_METADATA, { clientId: f.quickId, event: { type: 'session_title', sessionId: 'session', runStartedAt: 100, title: '晚到标题', updatedAt: 110 } })
    f.child.notify(notifications.CHAT_GENERATION, { clientId: f.quickId, event: { type: 'title', conversationId: 'chat', title: 'Chat 标题' } })
    await f.quick.waitFor('title')
    expect(f.main.deliveries.map((item) => item.value.type ?? 'queue')).toEqual(['run_started', 'stream', 'queue'])
    expect(f.main.deliveries.map((item) => item.channel)).toEqual([AGENT_IPC_CHANNELS.EVENT, AGENT_IPC_CHANNELS.EVENT, AGENT_IPC_CHANNELS.QUEUE_EVENT])
    expect(f.main.identities).toEqual([{ phase: 'started', run: { sessionId: 'session', runId: 'run-1', runStartedAt: 100 } }])
    expect(f.main.order.slice(0, 2)).toEqual([AGENT_IPC_CHANNELS.RUN_EVENT, AGENT_IPC_CHANNELS.EVENT])
    expect(f.quick.deliveries.map((item) => item.channel)).toEqual([AGENT_IPC_CHANNELS.EVENT, CHAT_IPC_CHANNELS.EVENT])
    f.main.emit('did-start-loading')
    await f.clients.get(f.main.sender)
    f.child.notify(notifications.AGENT_RUN, { clientId: f.mainId, event: envelope('run_started') })
    f.child.notify(notifications.AGENT_RUN, { clientId: 'forged', event: envelope('run_started') })
    f.child.handle('barrier', () => null)
    await f.parent.request('barrier')
    expect(f.main.deliveries).toHaveLength(3)
    expect(f.quick.deliveries).toHaveLength(2)
  })

  test('审批保持等待超过普通 RPC 时限；只接受原窗口/合法 response，交付不伪造 resolved', async () => {
    const f = await open()
    const result = f.child.request(clientMethods.AGENT_PERMISSION, { clientId: f.mainId, event: interaction('permission_request') }, { timeoutMs: 0 })
    await f.main.waitFor('permission_request')
    await delay(25)
    expect(f.bridge.respondPermission(f.quick.sender, { requestId: 'request-1', behavior: 'allow' })).toBe(false)
    expect(f.bridge.respondAskUser(f.main.sender, { requestId: 'request-1', behavior: 'cancel' })).toBe(false)
    for (const invalid of [{ requestId: 'request-1', behavior: ['allow'] }, { requestId: 'request-1', behavior: 'allow', runId: 'forged' },
      { requestId: 'request-1', behavior: 'allow', updatedInput: [] }, { requestId: 'request-1', behavior: 'allow', alwaysAllow: 'yes' },
      { requestId: 'request-1', behavior: 'allow', updatedInput: { fn: () => {} } }]) {
      expect(f.bridge.respondPermission(f.main.sender, invalid)).toBe(false)
    }
    const response = { requestId: 'request-1', behavior: 'allow', updatedInput: { command: 'pwd' } }
    expect(f.bridge.respondPermission(f.main.sender, response)).toBe(true)
    expect(f.bridge.respondPermission(f.main.sender, response)).toBe(false)
    expect(await result).toEqual(response)
    expect(f.main.deliveries).toHaveLength(1)
    f.child.notify(notifications.AGENT_RUN, { clientId: f.mainId, event: envelope('permission_resolved', { requestId: 'request-1', behavior: 'allow', reason: 'response' }) })
    await f.main.waitFor('permission_resolved')
    expect(f.main.deliveries.at(-1)?.value.behavior).toBe('allow')
  })

  test('子交互显示父会话，但保留真实 child；子流/终态不冒充父轮，错误轮次不取消请求', async () => {
    const f = await open()
    const result = f.child.request(clientMethods.AGENT_ASK_USER, { clientId: f.mainId, event: interaction('ask_user_request', 'ask-1', 'child-run', 'child', 'parent') }, { timeoutMs: 0 })
    const received = (await f.main.waitFor('ask_user_request')).value
    expect(received.sessionId).toBe('parent')
    expect(received.request).toMatchObject({ sessionId: 'child', runStartedAt: 100 })
    f.child.notify(notifications.AGENT_RUN, { clientId: f.mainId, event: envelope('stream', {}, 'child-run', 'child', 'parent') })
    f.child.notify(notifications.AGENT_RUN, { clientId: f.mainId, event: envelope('run_finished', {}, 'other-run', 'child', 'parent') })
    expect(f.bridge.respondAskUser(f.main.sender, { requestId: 'ask-1', behavior: 'answer', answers: { '选择目录': 'docs' } })).toBe(true)
    expect(await result).toEqual({ requestId: 'ask-1', behavior: 'answer', answers: { '选择目录': 'docs' } })
    f.child.notify(notifications.AGENT_RUN, { clientId: f.mainId, event: envelope('ask_user_resolved', { requestId: 'ask-1', reason: 'answered' }, 'child-run', 'child', 'parent') })
    await f.main.waitFor('ask_user_resolved')
    expect(f.main.deliveries.map((item) => item.value.type)).toEqual(['ask_user_request', 'ask_user_resolved'])
    expect(f.main.deliveries.at(-1)?.value.sessionId).toBe('parent')
    expect(f.main.identities).toEqual([])
  })

  test('RPC 取消及时关闭原页面等待，迟到审批无效且不返回批准', async () => {
    const f = await open(), controller = new AbortController()
    const result = f.child.request(clientMethods.AGENT_PERMISSION, { clientId: f.mainId, event: interaction('permission_request') }, { timeoutMs: 0, signal: controller.signal }).catch((error: unknown) => error)
    await f.main.waitFor('permission_request')
    controller.abort()
    expect(await result).toMatchObject({ code: 'canceled' })
    await f.main.waitFor('permission_resolved')
    expect(f.main.deliveries.at(-1)?.value).toMatchObject({ behavior: 'deny', reason: 'aborted' })
    expect(f.bridge.respondPermission(f.main.sender, { requestId: 'request-1', behavior: 'allow' })).toBe(false)
  })

  test('重载后的同一 WebContents 不接收旧请求/取消，旧答复无效，新请求可继续', async () => {
    const f = await open()
    const result = f.child.request(clientMethods.AGENT_ASK_USER, { clientId: f.mainId, event: interaction('ask_user_request') }, { timeoutMs: 0 })
    await f.main.waitFor('ask_user_request')
    f.main.emit('did-start-loading')
    const next = await f.clients.get(f.main.sender)
    expect(await result).toEqual({ requestId: 'request-1', behavior: 'cancel' })
    expect(f.bridge.respondAskUser(f.main.sender, { requestId: 'request-1', behavior: 'cancel' })).toBe(false)
    expect(f.main.deliveries).toHaveLength(1)
    const late = await f.child.request(clientMethods.AGENT_PERMISSION, { clientId: f.mainId, event: interaction('permission_request', 'late') })
    expect(late).toEqual({ requestId: 'late', behavior: 'deny' })
    const current = f.child.request(clientMethods.AGENT_ASK_USER, { clientId: next.clientId, event: interaction('ask_user_request', 'next', 'run-2') }, { timeoutMs: 0 })
    await f.main.waitFor('ask_user_request', 1)
    expect(f.bridge.respondAskUser(f.main.sender, { requestId: 'next', behavior: 'answer', answers: { key: 'value' } })).toBe(true)
    expect(await current).toMatchObject({ behavior: 'answer' })
  })

  test('真实轮次完成撤销等待；入口/方法/请求身份错误不能展示交互', async () => {
    const f = await open()
    const result = f.child.request(clientMethods.AGENT_ASK_USER, { clientId: f.mainId, event: interaction('ask_user_request') }, { timeoutMs: 0 })
    await f.main.waitFor('ask_user_request')
    f.child.notify(notifications.AGENT_RUN, { clientId: f.mainId, event: envelope('run_finished') })
    expect(await result).toEqual({ requestId: 'request-1', behavior: 'cancel' })
    await f.main.waitFor('run_finished')
    expect(f.main.deliveries.map((item) => item.value.type)).toEqual(['ask_user_request', 'ask_user_resolved', 'run_finished'])
    expect(await f.child.request(clientMethods.AGENT_PERMISSION, { clientId: 'unknown', event: interaction('permission_request') })).toMatchObject({ behavior: 'deny' })
    await expect(f.child.request(clientMethods.AGENT_PERMISSION, { clientId: f.mainId, event: interaction('ask_user_request') })).rejects.toMatchObject({ code: -32602 })
    const broken = interaction('permission_request'); (broken.run as RpcJsonObject).sessionId = 'wrong'
    await expect(f.child.request(clientMethods.AGENT_PERMISSION, { clientId: f.mainId, event: broken })).rejects.toMatchObject({ code: -32602 })
    expect(f.main.deliveries).toHaveLength(3)
  })

  test('后端断开/显式释放关闭交互，包括已交付但尚未 resolved 的答复；释放后拒绝新请求', async () => {
    const f = await open()
    const result = f.child.request(clientMethods.AGENT_PERMISSION, { clientId: f.mainId, event: interaction('permission_request') }, { timeoutMs: 0 })
    await f.main.waitFor('permission_request')
    expect(f.bridge.respondPermission(f.main.sender, { requestId: 'request-1', behavior: 'allow' })).toBe(true)
    await result
    f.parent.close()
    await f.main.waitFor('permission_resolved')
    expect(f.bridge.respondPermission(f.main.sender, { requestId: 'request-1', behavior: 'allow' })).toBe(false)
    const second = await open()
    const ask = second.child.request(clientMethods.AGENT_ASK_USER, { clientId: second.mainId, event: interaction('ask_user_request') }, { timeoutMs: 0 })
    await second.main.waitFor('ask_user_request')
    second.bridge.dispose(); second.bridge.dispose()
    expect(await ask).toMatchObject({ behavior: 'cancel' })
    expect(await second.child.request(clientMethods.AGENT_PERMISSION, { clientId: second.mainId, event: interaction('permission_request') })).toMatchObject({ behavior: 'deny' })
  })

  test('发送失败拒绝交互；不可序列化/畸形追问答复不交付，合法取消仍可使用', async () => {
    const f = await open(); f.main.failSend = true
    expect(await f.child.request(clientMethods.AGENT_PERMISSION, { clientId: f.mainId, event: interaction('permission_request') })).toMatchObject({ behavior: 'deny' })
    f.main.failSend = false
    const result = f.child.request(clientMethods.AGENT_ASK_USER, { clientId: f.mainId, event: interaction('ask_user_request') }, { timeoutMs: 0 })
    await f.main.waitFor('ask_user_request')
    for (const invalid of [{ requestId: 'request-1', behavior: 'answer', answers: { key: 1 } },
      { requestId: 'request-1', behavior: 'answer', answers: { ' ': 'value' } },
      { requestId: 'request-1', behavior: 'cancel', answers: {} }, { requestId: 'request-1', behavior: 'answer', answers: [] }]) {
      expect(f.bridge.respondAskUser(f.main.sender, invalid)).toBe(false)
    }
    expect(f.bridge.respondAskUser(f.main.sender, { requestId: 'request-1', behavior: 'cancel' })).toBe(true)
    expect(await result).toEqual({ requestId: 'request-1', behavior: 'cancel' })
  })

  test('服务端身份先失效再关闭 peer，原页面仍收取消；重载页面保持隔离', async () => {
    const f = await open()
    const result = f.child.request(clientMethods.AGENT_PERMISSION, { clientId: f.mainId, event: interaction('permission_request') }, { timeoutMs: 0 })
    await f.main.waitFor('permission_request')
    f.signals.get(f.mainId)!.abort()
    expect(f.clients.find(f.mainId)).toBeUndefined()
    expect(await result).toMatchObject({ behavior: 'deny' })
    await f.main.waitFor('permission_resolved')
    expect(f.bridge.respondPermission(f.main.sender, { requestId: 'request-1', behavior: 'allow' })).toBe(false)
    f.parent.close()
    expect(f.main.deliveries).toHaveLength(2)
    expect(f.clients.find(f.quickId)).toBe(f.quick.sender)
  })
})
