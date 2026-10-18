/** 第三类宿主不提供项目或 Loop 标记，也能复用相同会话创建、工作流及逐轮上下文。 */
import { expect, test } from 'bun:test'
import { mkdtempSync, realpathSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type { AgentProviderAdapter } from '@axon/shared'
import { AgentSessionManager } from './agent-session-manager'
import { AgentSessionFactory } from './agent-session-factory'
import { AgentService } from './agent-service'
import { AgentEventBus } from './agent-event-bus'
import { AgentRunCoordinator } from './agent-run-coordinator'
import { BackendClientRegistry } from '../backend-client-registry'

test('来源中立的会话消费宿主上下文，后续运行重新解析工具和记忆而非冻结创建时配置', async () => {
  const workspace = realpathSync(mkdtempSync(join(tmpdir(), 'axon-generic-session-')))
  const sessions = new AgentSessionManager({ indexPath: join(workspace, 'data', 'index.json'), sessionsDir: join(workspace, 'data', 'sessions') })
  const factory = new AgentSessionFactory({ sessions }), clients = new BackendClientRegistry(), events = new AgentEventBus()
  let version = 1, calls = 0
  const adapter: AgentProviderAdapter = {
    async *query(input) {
      calls++
      expect(input.cwd).toBe(workspace)
      expect(input.systemPrompt).toContain(`外接记忆版本 ${version}`)
      expect(input.customTools?.map((tool) => tool.name)).toContain(`ExternalTool${version}`)
      expect(input.toolEnvironment?.environmentOverrides.AXON_HOST_CONTEXT).toBe(String(version))
      yield { kind: 'sdk_message', message: { type: 'assistant', message: { content: [{ type: 'text', text: '宿主任务完成' }] } } }
      yield { kind: 'sdk_message', message: { type: 'result', subtype: 'success' } }
    }, abort() {}, dispose() {}, async drain() {},
  }
  const agent = new AgentService({ adapter, sessionManager: sessions, eventBus: events,
    runtimeConfigDir: join(workspace, 'runtime'), runtimeSessionDir: join(workspace, 'runtime', 'sessions'),
    resolveExecutionContext: () => ({ workspacePath: workspace, toolEnvironment: { environmentOverrides: { AXON_HOST_CONTEXT: String(version) } } }),
    getMemoryContext: () => ({ prompt: `外接记忆版本 ${version}`, fileStates: {}, shouldPersistStates: false }),
    getCustomTools: async () => [{ name: `ExternalTool${version}`, description: '宿主工具', inputSchema: { type: 'object' }, execute: async () => ({ content: 'ok' }) }],
    channelManager: { resolve: async () => ({ id: 'channel', name: '夹具', provider: 'openai', apiKey: '', baseUrl: 'http://localhost:8123/v1',
      models: [{ id: 'model', name: '模型', enabled: true }], enabled: true, createdAt: 1, updatedAt: 1 }) },
  })
  const runs = new AgentRunCoordinator({ clients, sessions, agent, events, sessionFactory: factory,
    // 此宿主没有装配子任务工具，因此没有需等待或取消的后代；不省略完整工作流端口。
    cancelWorkflowDescendants: () => {}, waitForWorkflowDescendants: async () => {},
  })
  try {
    const session = await factory.create({ title: '第三类宿主任务', channelId: 'channel', modelId: 'model',
      approvalPolicy: 'never', userInputPolicy: 'reject' })
    expect(session.projectId).toBeUndefined(); expect(session.creationOrigin).toBeUndefined()
    const owner = clients.register()
    for (version = 1; version <= 2; version++) {
      const result = await runs.executeWorkflow(owner, { sessionId: session.id, text: '处理本次输入' }, new AbortController().signal)
      expect(result.status).toBe('completed')
    }
    expect(calls).toBe(2)
    expect(sessions.getMessages(session.id).filter((message) => message.type === 'result')).toHaveLength(2)
  } finally {
    runs.dispose(); agent.dispose(); clients.dispose(); factory.dispose()
    await Promise.all([runs.drain(), agent.drain(), factory.drain()])
    rmSync(workspace, { recursive: true })
  }
})
