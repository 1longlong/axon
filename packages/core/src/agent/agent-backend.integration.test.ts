import { afterEach, describe, expect, test } from 'bun:test'
import { mkdtempSync, readFileSync, realpathSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type {
  AgentGenerationEvent,
  AgentProviderAdapter,
  AgentQueryInput,
  AgentRuntimeId,
  AgentStreamPayload,
} from '@axon/shared'
import {
  AgentCollaborationService,
  AgentDelegationManager,
  AgentEventBus,
  AgentRootStateStore,
  AgentService,
  AgentSessionManager,
  ChannelManager,
  createAgentCollaborationTools,
  createBackendPaths,
  initializeBackendDirectories,
  writeTextFileAtomic,
} from '../index'
import type { BackendPaths } from '../index'
import { createFixtureCredentialCodec } from '../../test-support/credential-codec'

const directories: string[] = []
afterEach(() => {
  for (const directory of directories.splice(0)) rmSync(directory, { recursive: true, force: true })
})

/** 夹具只实现中立流，不模拟任何 Runtime 私有历史格式或真实工具沙箱。 */
class ScriptedAdapter implements AgentProviderAdapter {
  readonly inputs: AgentQueryInput[] = []
  handler: (input: AgentQueryInput) => AsyncIterable<AgentStreamPayload> = async function* () {}

  query(input: AgentQueryInput): AsyncIterable<AgentStreamPayload> {
    this.inputs.push(input)
    return this.handler(input)
  }

  abort(): void {}
  dispose(): void {}
  async drain(): Promise<void> {}
}

function isolatedPaths(): BackendPaths {
  const directory = mkdtempSync(join(tmpdir(), 'axon-core-agent-run-'))
  directories.push(directory)
  const paths = createBackendPaths({ dataDir: join(directory, 'data'), homeDir: directory })
  initializeBackendDirectories(paths)
  return paths
}

/** 通过公共包入口重建真实配置和会话存储，不使用应用单例。 */
function openStores(paths: BackendPaths) {
  const state = new AgentRootStateStore(paths.agentSessionsDir)
  return {
    state,
    channels: new ChannelManager({ configPath: paths.channelsPath, credentialCodec: createFixtureCredentialCodec() }),
    sessions: new AgentSessionManager({
      indexPath: paths.agentSessionsIndexPath, sessionsDir: paths.agentSessionsDir, stateStore: state,
    }),
    tasks: new AgentDelegationManager({ stateStore: state }),
  }
}

/** 把明确的存储、目录和测试 adapter 装入服务；完整消息广播时核对它已经落盘。 */
function openService(paths: BackendPaths, stores: ReturnType<typeof openStores>, adapter: ScriptedAdapter) {
  const eventBus = new AgentEventBus()
  const events: AgentGenerationEvent[] = []
  const persistedAtBroadcast: boolean[] = []
  eventBus.subscribe((event) => {
    events.push(event)
    if (event.type === 'stream' && event.payload.kind === 'sdk_message'
      && event.payload.message.type !== 'tool_progress') {
      const uuid = 'uuid' in event.payload.message ? event.payload.message.uuid : undefined
      persistedAtBroadcast.push(stores.sessions.getMessages(event.sessionId)
        .some((message) => 'uuid' in message && message.uuid === uuid))
    }
  })
  const service = new AgentService({
    adapter, resolveAdapter: () => adapter,
    eventBus, channelManager: stores.channels, sessionManager: stores.sessions,
    runtimeConfigDir: paths.runtimeConfigDir, runtimeSessionDir: paths.runtimeSessionsDir,
    resolveProjectCwd: () => paths.dataDir,
    getSystemPrompt: () => '隔离测试规则',
    createCanUseTool: () => async () => ({ behavior: 'deny', message: '测试入口没有交互授权能力' }),
  })
  return { service, events, persistedAtBroadcast }
}

async function createSession(stores: ReturnType<typeof openStores>, runtimeId: AgentRuntimeId) {
  const channel = await stores.channels.create({
    name: '隔离渠道', provider: 'openai', baseUrl: 'https://example.test/v1', apiKey: 'fixture-secret',
    models: [{ id: 'fixture-model', name: '测试模型', enabled: true }],
  })
  return stores.sessions.create({ runtimeId, channelId: channel.id, modelId: 'fixture-model', projectId: 'fixture-project' })
}

async function* successStream(text: string): AsyncIterable<AgentStreamPayload> {
  yield { kind: 'sdk_message', message: {
    type: 'assistant', message: { content: [{ type: 'text', text }] }, parent_tool_use_id: null,
  } }
  yield { kind: 'sdk_message', message: { type: 'result', subtype: 'success', usage: { input_tokens: 2, output_tokens: 1 } } }
}

describe('公共 core 入口的 Agent 运行与重建', () => {
  test.each(['pi', 'zima'] as const)('%s 归属经中立 adapter 运行，重建后传递 opaque 凭据和前序历史', async (runtimeId) => {
    expect(process.versions.electron).toBeUndefined()
    const paths = isolatedPaths()
    const stores = openStores(paths)
    const session = await createSession(stores, runtimeId)
    const artifact = join(paths.runtimeSessionsDir, 'opaque-artifact')
    writeTextFileAtomic(artifact, '由 adapter 独占解释的内容')
    const adapter = new ScriptedAdapter()
    adapter.handler = async function* (input) {
      expect(stores.sessions.getMessages(input.sessionId)).toHaveLength(1)
      expect(input.connection?.apiKey).toBe('fixture-secret')
      expect(input.cwd).toBe(paths.dataDir)
      const permission = await input.canUseTool?.('Write', { file_path: 'test.txt' }, {
        toolUseId: 'probe', executionPolicy: input.executionPolicy!, toolExecution: { kind: 'runtime' },
      })
      expect(permission?.behavior).toBe('deny')
      input.onRuntimeSession?.('opaque-session', artifact)
      yield { kind: 'sdk_delta', delta: {
        uuid: 'draft-only', deltas: [{ type: 'text_delta', contentIndex: 0, delta: '瞬时内容' }], runStartedAt: 1,
      } }
      yield { kind: 'sdk_message', message: { type: 'system', subtype: 'compact_boundary',
        compact_result: 'success', compact_reason: 'threshold', summary: '保留的压缩摘要' } }
      yield* successStream('已完成第一次处理')
    }
    const first = openService(paths, stores, adapter)
    const outcome = await first.service.sendMessage({ sessionId: session.id, text: '第一次请求' })
    expect(outcome.finalText).toBe('已完成第一次处理')
    expect(first.persistedAtBroadcast).toEqual([true, true, true, true])
    expect(first.service.listActiveRuns()).toEqual([])
    const before = stores.sessions.getMessages(session.id)
    expect(before.map((message) => message.type)).toEqual(['user', 'system', 'assistant', 'result'])
    expect(JSON.stringify(before)).not.toContain('瞬时内容')
    expect(readFileSync(paths.channelsPath, 'utf8')).not.toContain('fixture-secret')

    // 全部业务对象重建后继续：core 不读取 artifact 正文，也不把当前 prompt 重复放进恢复前缀。
    const reloaded = openStores(paths)
    expect(reloaded.sessions.getMessages(session.id)).toEqual(before)
    const nextAdapter = new ScriptedAdapter()
    nextAdapter.handler = async function* (input) {
      expect(input).toMatchObject({ prompt: '第二次独立请求', resumeSessionId: 'opaque-session', runtimeSessionFile: artifact })
      expect(input.recoveryPrompt).toContain('第一次请求')
      expect(input.recoveryPrompt).toContain('已完成第一次处理')
      expect(input.recoveryPrompt).not.toContain('第二次独立请求')
      yield* successStream('继续完成')
    }
    const second = openService(paths, reloaded, nextAdapter)
    await second.service.sendMessage({ sessionId: session.id, text: '第二次独立请求' })
    const history = openStores(paths).sessions.getMessages(session.id)
    expect(history).toHaveLength(7)
    expect(history[1]).toMatchObject({ subtype: 'compact_boundary', summary: '保留的压缩摘要' })
    expect(readFileSync(artifact, 'utf8')).toBe('由 adapter 独占解释的内容')
    expect(second.persistedAtBroadcast).toEqual([true, true, true])
  })

  test('真实 AgentService 的前台子任务直接返回结果，主/子历史与任务状态独立恢复', async () => {
    const paths = isolatedPaths()
    const stores = openStores(paths)
    const root = await createSession(stores, 'pi')
    const adapter = new ScriptedAdapter()
    const { service } = openService(paths, stores, adapter)
    const collaboration = new AgentCollaborationService({
      sessions: stores.sessions, delegations: stores.tasks, agent: service, resolveProjectCwd: () => paths.dataDir,
    })
    adapter.handler = async function* (input) {
      if (input.sessionId !== root.id) {
        expect(input.executionPolicy?.sandboxMode).toBe('readOnly')
        expect(input.allowedBuiltinTools).toEqual(['Read', 'Glob', 'Grep', 'LS'])
        expect(realpathSync(input.cwd!)).toBe(realpathSync(paths.dataDir))
        yield* successStream('子 Agent 的直接结果')
        return
      }
      const agentTool = createAgentCollaborationTools({
        collaboration, sessionId: root.id, runSignal: input.abortSignal!,
      }).find((tool) => tool.name === 'Agent')!
      const result = await agentTool.execute({ description: '只读检查', prompt: '检查项目', subagent_type: 'explore' }, {
        toolUseId: 'delegate-call', signal: input.abortSignal,
      })
      expect(result.isError).not.toBe(true)
      expect(JSON.stringify(result.content)).toContain('子 Agent 的直接结果')
      yield* successStream('主 Agent 整合结论')
    }
    await service.sendMessage({ sessionId: root.id, text: '委派只读检查' })
    const reloaded = openStores(paths)
    const task = reloaded.tasks.list(root.id)[0]!
    expect(task).toMatchObject({ status: 'completed', resultSummary: '子 Agent 的直接结果' })
    expect(reloaded.sessions.get(task.childSessionId)).toMatchObject({ parentSessionId: root.id, rootSessionId: root.id })
    expect(reloaded.sessions.getMessages(root.id)).toHaveLength(3)
    expect(reloaded.sessions.getMessages(task.childSessionId)).toHaveLength(3)
    expect(service.listActiveRuns()).toEqual([])
  })
})
