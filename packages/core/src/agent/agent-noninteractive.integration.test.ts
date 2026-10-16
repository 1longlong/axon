import { afterEach, describe, expect, spyOn, test } from 'bun:test'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type { AgentExecutionPolicy, AgentProviderAdapter, AgentQueryInput, AgentStreamPayload } from '@axon/shared'
import { createBackend, createBackendPaths } from '../index'
import { createFixtureCredentialCodec } from '../../test-support/credential-codec'

const cleanups: Array<() => Promise<void>> = []
afterEach(async () => { for (const cleanup of cleanups.splice(0).reverse()) await cleanup() })

class Adapter implements AgentProviderAdapter {
  handler: (input: AgentQueryInput) => AsyncIterable<AgentStreamPayload> = async function* () {}
  query(input: AgentQueryInput) { return this.handler(input) }
  abort(): void {}
  dispose(): void {}
  async drain(): Promise<void> {}
}

async function* success(text: string): AsyncIterable<AgentStreamPayload> {
  yield { kind: 'sdk_message', message: { type: 'assistant', message: { content: [{ type: 'text', text }] } } }
  yield { kind: 'sdk_message', message: { type: 'result', subtype: 'success' } }
}

/** 真实 core/工具/会话持久化；只替换模型，不把此测试当作真实 OS 沙箱验证。 */
async function open() {
  const directory = mkdtempSync(join(tmpdir(), 'axon-noninteractive-'))
  const adapter = new Adapter()
  const backend = createBackend({
    paths: createBackendPaths({ dataDir: join(directory, 'data'), homeDir: directory }),
    applicationVersion: '0.1.4', credentialCodec: createFixtureCredentialCodec(), resolveAdapter: () => adapter,
  })
  cleanups.push(async () => { backend.dispose(); await backend.drain(); rmSync(directory, { recursive: true, force: true }) })
  const owner = backend.clients.register()
  const channel = await backend.channels.create({ name: '夹具渠道', provider: 'openai', baseUrl: 'https://example.test/v1',
    apiKey: 'fixture-secret', models: [{ id: 'fixture-model', name: '夹具模型', enabled: true }] })
  const project = backend.projects.create({ name: '夹具项目' })
  const session = await backend.agentRuns.createSession({ title: '命名会话', channelId: channel.id,
    modelId: 'fixture-model', projectId: project.id, approvalPolicy: 'never', userInputPolicy: 'reject' })
  return { adapter, backend, owner, session }
}

describe('core 非交互执行链', () => {
  test('主轮完成不代表后台工作流结束；根等待覆盖子结果交付后的主轮实际收尾', async () => {
    const { adapter, backend, owner, session } = await open()
    const childGate = Promise.withResolvers<void>(), resumeGate = Promise.withResolvers<void>(), resumed = Promise.withResolvers<void>()
    let rootCalls = 0
    adapter.handler = async function* (input) {
      if (input.sessionId !== session.id) { await childGate.promise; yield* success('后台子结果'); return }
      rootCalls++
      if (rootCalls === 1) {
        const delegate = input.customTools!.find((tool) => tool.name === 'Agent')!
        await delegate.execute({ description: '后台检查', prompt: '分析目录', subagent_type: 'explore', run_in_background: true },
          { toolUseId: 'background', signal: input.abortSignal })
        yield* success('主轮初步回复')
      } else {
        expect(input.prompt).toContain('后台子结果')
        resumed.resolve(); await resumeGate.promise
        yield* success('收齐子结果后的最终回复')
      }
    }
    try {
      expect(await backend.agentRuns.send(owner, { sessionId: session.id, text: '委派后台检查' }, () => {}, { source: 'external' }))
        .toMatchObject({ success: true })
      expect(backend.agentRuns.isActive(session.id)).toBe(false)
      expect(rootCalls).toBe(1)
      let finished = false
      const waiting = backend.collaboration.waitForRootIdle(session.id).then(() => { finished = true })
      childGate.resolve(); await resumed.promise
      expect(rootCalls).toBe(2)
      expect(backend.tasks.list(session.id)[0]?.status).toBe('completed')
      expect(finished).toBe(false)
      resumeGate.resolve(); await waiting
      expect(backend.agentRuns.isActive(session.id)).toBe(false)
      expect(backend.agentRuns.getOwnedRun(owner, session.id)).toBeUndefined()
      const messages = backend.sessions.getMessages(session.id)
      expect(messages.filter((message) => message.type === 'result')).toHaveLength(2)
      expect(messages.at(-2)).toMatchObject({ type: 'assistant', message: { content: [{ type: 'text', text: '收齐子结果后的最终回复' }] } })
    } finally { childGate.resolve(); resumeGate.resolve() }
  })

  test('后台续跑接管失败会传回根等待，不能被协调层日志吞掉', async () => {
    const { adapter, backend, owner, session } = await open()
    const childGate = Promise.withResolvers<void>()
    const refusal = spyOn(backend.agentRuns, 'sendBackgroundNotification').mockResolvedValue({ success: false, code: 'runtime_error', message: '后台接管失败' })
    adapter.handler = async function* (input) {
      if (input.sessionId !== session.id) { await childGate.promise; yield* success('后台结果'); return }
      const delegate = input.customTools!.find((tool) => tool.name === 'Agent')!
      await delegate.execute({ description: '后台任务', prompt: '检查', subagent_type: 'explore', run_in_background: true },
        { toolUseId: 'background-failure', signal: input.abortSignal })
      yield* success('初步回复')
    }
    try {
      expect(await backend.agentRuns.send(owner, { sessionId: session.id, text: '委派后台任务' }, () => {})).toMatchObject({ success: true })
      childGate.resolve()
      await expect(backend.collaboration.waitForRootIdle(session.id)).rejects.toMatchObject({ code: 'runtime_error' })
      expect(refusal).toHaveBeenCalledTimes(1)
      expect(backend.tasks.list(session.id)[0]?.status).toBe('completed')
    } finally { childGate.resolve(); refusal.mockRestore() }
  })

  test('原始首尾空白和换行经过协调层/AgentService，模型输入与应用历史完全一致', async () => {
    const { adapter, backend, owner, session } = await open()
    const prompt = '  原始用户任务\n\n'
    adapter.handler = async function* (input) {
      expect(input.prompt).toBe(prompt)
      yield* success('正文')
    }
    expect(await backend.agentRuns.send(owner, { sessionId: ` ${session.id} `, text: prompt }, () => {}))
      .toMatchObject({ success: true })
    const user = backend.sessions.getMessages(session.id).find((message) => message.type === 'user')
    expect(user).toMatchObject({ message: { content: [{ type: 'text', text: prompt }] } })
    for (const text of [' \n', 'a\0b', 'a'.repeat(100_000) + ' ']) {
      expect(await backend.agentRuns.send(owner, { sessionId: session.id, text }, () => {})).toMatchObject({ success: false, code: 'invalid_input' })
    }
  })

  test('会话策略进入 adapter 和真实工具；拒绝不会广播交互或中止后续模型回复', async () => {
    const { adapter, backend, owner, session } = await open()
    const interactionEvents: string[] = []
    backend.events.subscribe((event) => {
      if (event.type === 'permission_request' || event.type === 'ask_user_request') interactionEvents.push(event.type)
    })
    adapter.handler = async function* (input) {
      expect(input.executionPolicy).toMatchObject({ approvalPolicy: 'never', userInputPolicy: 'reject' })
      expect(input.systemPrompt).toContain('不能申请额外权限')
      expect(input.systemPrompt).toContain('不要编造用户的选择或授权')
      expect(await input.canUseTool!('Write', { file_path: 'a' }, { toolUseId: 'write',
        executionPolicy: input.executionPolicy!, toolExecution: { kind: 'runtime' } }))
        .toMatchObject({ behavior: 'deny' })
      const ask = input.customTools!.find((tool) => tool.name === 'AskUserQuestion')!
      expect(await ask.execute({ questions: [{ question: '目标？', options: [] }] }, { toolUseId: 'ask' }))
        .toMatchObject({ isError: true })
      yield* success('无法写入，已完成授权范围内的分析')
    }
    expect(await backend.agentRuns.send(owner, { sessionId: session.id, text: '执行任务' }, () => {}))
      .toMatchObject({ success: true })
    expect(interactionEvents).toEqual([])
    expect(backend.sessions.getMessages(session.id).at(-1)).toMatchObject({ type: 'result', subtype: 'success' })
    expect(backend.permissions.cancelSession(session.id)).toBe(0)
    expect(backend.askUsers.cancelSession(session.id)).toBe(0)
  })

  test('子 Agent 继承在途父轮限制；父设置改为交互也不能放宽当前派生', async () => {
    const { adapter, backend, owner, session } = await open()
    const childPolicies: AgentExecutionPolicy[] = []
    adapter.handler = async function* (input) {
      if (input.sessionId !== session.id) {
        childPolicies.push(input.executionPolicy!)
        expect(await input.canUseTool!('Write', {}, { toolUseId: 'child-write',
          executionPolicy: input.executionPolicy!, toolExecution: { kind: 'runtime' } }))
          .toMatchObject({ behavior: 'deny' })
        yield* success('子任务已分析')
        return
      }
      backend.sessions.update(session.id, { approvalPolicy: 'onRequest', userInputPolicy: 'ask' })
      const delegate = input.customTools!.find((tool) => tool.name === 'Agent')!
      const result = await delegate.execute({ description: '分析子任务', prompt: '检查目录',
        subagent_type: 'coder', run_in_background: false }, { toolUseId: 'child', signal: input.abortSignal })
      expect(result.isError).not.toBe(true)
      yield* success('主任务完成')
    }
    expect(await backend.agentRuns.send(owner, { sessionId: session.id, text: '委派分析' }, () => {}))
      .toMatchObject({ success: true })
    expect(childPolicies).toHaveLength(1)
    expect(childPolicies[0]).toMatchObject({ approvalPolicy: 'never', userInputPolicy: 'reject' })
    const task = backend.tasks.list(session.id)[0]!
    expect(task.status).toBe('completed')
    expect(backend.sessions.get(task.childSessionId)).toMatchObject({ approvalPolicy: 'never', userInputPolicy: 'reject' })
  })
})
