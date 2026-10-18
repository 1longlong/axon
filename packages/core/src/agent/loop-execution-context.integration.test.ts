/** 真实 core 主子工作流验证独立目录；Runtime 为中立夹具，不宣称已执行 OS 沙箱。 */
import { expect, test } from 'bun:test'
import { mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type { AgentProviderAdapter, AgentQueryInput } from '@axon/shared'
import { createBackend } from '../backend'
import type { AxonBackend } from '../backend'
import { AgentSessionManager } from './agent-session-manager'
import { resolveBackendAgentContext } from '../backend-agent-session-context'
import { createBackendPaths } from '../settings/backend-paths'
import { createFixtureCredentialCodec } from '../../test-support/credential-codec'

test('无项目 Loop 根和子 Agent 共用目录/沙箱根，按目录加载指令与 Skills，不借用项目 MCP 或记忆', async () => {
  const directory = realpathSync(mkdtempSync(join(tmpdir(), 'axon-loop-context-backend-')))
  const workspace = join(directory, 'workspace')
  mkdirSync(join(workspace, '.agents', 'skills', 'local-check'), { recursive: true })
  writeFileSync(join(workspace, 'AGENTS.md'), '只检查这个目录中的测试文件。')
  writeFileSync(join(workspace, '.agents', 'skills', 'local-check', 'SKILL.md'), '---\nname: local-check\ndescription: 检查本地测试文件\n---\n只读检查现有文件。')
  let backend!: AxonBackend
  const queries: AgentQueryInput[] = []
  let mcpConnections = 0
  const adapter: AgentProviderAdapter = {
    getSandboxCapability: () => ({ supported: true, modes: ['workspaceWrite', 'readOnly'], sandboxedTools: ['bash', 'read', 'write', 'edit', 'glob', 'grep', 'ls'] }),
    async *query(input) {
      queries.push(input)
      expect(input.cwd).toBe(workspace)
      expect(input.sandboxPolicy?.sandboxCwd).toBe(workspace)
      expect(input.sandboxPolicy?.networkAccess).toBe(false)
      expect(input.executionPolicy?.approvalPolicy).toBe('never')
      expect(input.executionPolicy?.userInputPolicy).toBe('reject')
      expect(input.systemPrompt).toContain('只检查这个目录中的测试文件')
      expect(input.systemPrompt).toContain('local-check')
      expect(input.customTools?.some((tool) => /^(Memory|mcp__)/.test(tool.name))).toBe(false)
      const session = backend.sessions.get(input.sessionId)!
      expect(session.projectId).toBeUndefined()
      if (!session.parentSessionId) {
        const delegate = input.customTools!.find((tool) => tool.name === 'Agent')!
        const result = await delegate.execute({ description: '独立目录子任务', prompt: '只检查当前目录', subagent_type: 'explore' },
          { toolUseId: 'context-child', signal: input.abortSignal! })
        expect(result.isError).not.toBe(true)
        expect(JSON.stringify(result.content)).toContain('completed')
      } else {
        expect(input.sandboxPolicy?.mode).toBe('readOnly')
        expect(input.sandboxPolicy?.writableRoots).toEqual([])
      }
      yield { kind: 'sdk_message', message: { type: 'assistant', message: { content: [{ type: 'text', text: '目录检查完成' }] } } }
      yield { kind: 'sdk_message', message: { type: 'result', subtype: 'success' } }
    }, abort() {}, dispose() {}, async drain() {},
  }
  backend = createBackend({ paths: createBackendPaths({ dataDir: join(directory, 'data'), homeDir: join(directory, 'home') }),
    applicationVersion: '0.1.5', credentialCodec: createFixtureCredentialCodec(), resolveAdapter: () => adapter,
    connectMcpServer: () => { mcpConnections++; throw new Error('不得借用项目 MCP') },
    providerStream: async function* () { yield { type: 'text_delta', delta: '目录检查' }; yield { type: 'finish', reason: 'stop' } },
  })
  try {
    const channel = await backend.channels.create({ name: '隔离模型', provider: 'custom', apiKey: 'fixture', baseUrl: 'http://localhost:8123/v1',
      models: [{ id: 'fixture', name: '模型', enabled: true }] })
    const session = await backend.sessionFactory.create({ channelId: channel.id, modelId: 'fixture', runtimeId: 'pi',
      sandboxMode: 'workspaceWrite', approvalPolicy: 'never', userInputPolicy: 'reject', creationOrigin: 'loop', creationWorkspacePath: workspace })
    const owner = backend.clients.register()
    const result = await backend.agentRuns.executeWorkflow(owner, { sessionId: session.id, text: '检查工作目录' }, new AbortController().signal)
    expect(result.status).toBe('completed')
    expect(queries).toHaveLength(2)
    expect(backend.projects.list()).toEqual([])
    expect(backend.tasks.list(session.id)[0]?.status).toBe('completed')
    expect(mcpConnections).toBe(0)
    expect(backend.sessions.getMessages(session.id).some((message) => message.type === 'result')).toBe(true)
    // 新读取器只消费已落盘的根归属，子会话无需重复保存目录或创建来源。
    const restored = new AgentSessionManager({ indexPath: backend.paths.agentSessionsIndexPath, sessionsDir: backend.paths.agentSessionsDir })
    expect(restored.get(session.id)?.creationWorkspacePath).toBe(workspace)
    const child = restored.get(backend.tasks.list(session.id)[0]!.childSessionId)!
    expect(child.creationWorkspacePath).toBeUndefined()
    expect(child.rootSessionId).toBe(session.id)
    expect(resolveBackendAgentContext(child, { getSession: (id) => restored.get(id),
      resolveProjectCwd: () => { throw new Error('恢复不能借用项目') } })).toEqual({ workspacePath: workspace })
    backend.clients.detach(owner)
  } finally { backend.dispose(); await backend.drain(); rmSync(directory, { recursive: true }) }
})
