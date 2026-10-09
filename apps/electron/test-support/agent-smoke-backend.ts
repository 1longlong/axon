/** Agent UI 专用独立测试入口；中立事件为夹具，业务工厂/协议/持久化使用实际实现。 */
import { writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { AppServerConnection, JsonRpcPeer, createPrivateHostPorts } from '@axon/app-server'
import { createBackend, createBackendPaths } from '@axon/core'
import { checkAgentEnvironment } from '@axon/host-node'
import { AGENT_RUNTIME_CAPABILITIES, APP_SERVER_RPC_OPTIONS } from '@axon/shared'
import type { AgentProviderAdapter, AgentQueryInput, AgentStreamPayload } from '@axon/shared'
import { ZimaAgentAdapter, assertZimaConnection } from '@axon/runtime-adapters'
import type { AgentSessionCreateInput } from '@axon/shared'
import { isolateAppServerStdio } from '../../app-server/src/stdio-isolation'
import { parseAppServerStartupConfig } from '../../app-server/src/startup-config'

const io = isolateAppServerStdio()
delete process.env.ELECTRON_RUN_AS_NODE
const config = parseAppServerStartupConfig(process.argv.slice(2), process.env)
let capturedQuery: AgentQueryInput | undefined
let resumeReadingCheck: (() => void) | undefined

/** 暂停输出只控制测试节奏；停止/断开立即释放等待，不把 resolver 跨进程序列化。 */
function waitForReadingCheck(signal: AbortSignal): Promise<void> {
  signal.throwIfAborted()
  return new Promise((done, reject) => {
    const cleanup = (): void => {
      signal.removeEventListener('abort', abort)
      resumeReadingCheck = undefined
    }
    const abort = (): void => { cleanup(); reject(signal.reason) }
    resumeReadingCheck = () => { cleanup(); done() }
    signal.addEventListener('abort', abort, { once: true })
  })
}

/** 用中立事件模拟 runtime；分片间隔让 renderer 的运行中状态可被真实观察。 */
const adapter: AgentProviderAdapter = {
  getSandboxCapability: () => ({
    supported: true, modes: ['readOnly', 'workspaceWrite'],
    sandboxedTools: ['bash', 'read', 'write', 'edit', 'grep', 'glob', 'ls'],
  }),
  getReasoningCapability: () => ({ levels: ['off', 'low', 'medium', 'high'], defaultLevel: 'medium' }),
  async *query(input: AgentQueryInput): AsyncIterable<AgentStreamPayload> {
    if (!input.abortSignal || !input.executionPolicy || !input.cwd) throw new Error('查询缺少停止信号、执行策略或工作区')
    // 追问使用工厂注入的真实工具；回答回到同一轮，而不是伪造下一条用户输入。
    if (input.prompt === '验证追问链路') {
      const tool = input.customTools?.find((item) => item.name === 'AskUserQuestion')
      if (!tool) throw new Error('追问工具未注入')
      const question = { questions: [{ question: '请选择测试方案', options: [{ label: '方案一' }, { label: '方案二' }] }] }
      yield { kind: 'sdk_message', message: { type: 'assistant', uuid: 'ask-call', parent_tool_use_id: null,
        message: { content: [{ type: 'tool_use', id: 'ask-smoke', name: 'AskUserQuestion', input: question }] } } }
      const result = await tool.execute(question, { toolUseId: 'ask-smoke', signal: input.abortSignal })
      if (result.isError || !JSON.stringify(result.content).includes('方案一')) throw new Error('追问答案未返回原工具')
      yield { kind: 'sdk_message', message: { type: 'user', uuid: 'ask-result', parent_tool_use_id: null,
        message: { content: [{ type: 'tool_result', tool_use_id: 'ask-smoke', content: JSON.stringify(result.content) }] } } }
      yield { kind: 'sdk_message', message: { type: 'assistant', uuid: 'ask-answer', parent_tool_use_id: null,
        message: { content: [{ type: 'text', text: '已收到方案一，继续本轮任务。' }] } } }
      yield { kind: 'sdk_message', message: { type: 'result', subtype: 'success', terminal_reason: 'completed' } }
      return
    }
    // 没有成功终态；core 消费停止信号后负责写唯一取消终态。
    if (input.prompt === '验证停止链路') {
      yield { kind: 'sdk_delta', delta: { uuid: 'stop-check', deltas: [{ type: 'text_delta', contentIndex: 0, delta: '停止验证正在等待' }] } }
      await waitForReadingCheck(input.abortSignal)
      throw new Error('停止验证不应被恢复')
    }
    if (input.prompt === '验证消息阅读体验') {
      const history = Array.from({ length: 60 }, (_, index) => `阅读验证段落 ${index + 1}：保留用户正在查看的位置。`).join('\n\n')
      const firstUpdate = '\n\n阅读验证新增输出一'
      const secondUpdate = '\n\n阅读验证新增输出二'
      yield { kind: 'sdk_delta', delta: { uuid: 'reading-check', deltas: [{ type: 'text_delta', contentIndex: 0, delta: history }] } }
      await waitForReadingCheck(input.abortSignal)
      yield { kind: 'sdk_delta', delta: { uuid: 'reading-check', deltas: [{ type: 'text_delta', contentIndex: 0, delta: firstUpdate }] } }
      await waitForReadingCheck(input.abortSignal)
      yield { kind: 'sdk_delta', delta: { uuid: 'reading-check', deltas: [{ type: 'text_delta', contentIndex: 0, delta: secondUpdate }] } }
      yield {
        kind: 'sdk_message',
        message: { type: 'assistant', uuid: 'reading-check', parent_tool_use_id: null, message: { content: [
          { type: 'text', text: history + firstUpdate + secondUpdate },
          { type: 'tool_use', id: 'reading-long-tool', name: 'Read', input: { path: 'reading-check.txt' } },
        ] } },
      }
      yield {
        kind: 'sdk_message',
        message: { type: 'user', uuid: 'reading-tool-result', parent_tool_use_id: null, message: { content: [
          { type: 'tool_result', tool_use_id: 'reading-long-tool', content: history },
        ] } },
      }
      yield { kind: 'sdk_message', message: { type: 'result', subtype: 'success', terminal_reason: 'completed' } }
      return
    }
    if (input.systemPrompt?.includes('## 子 Agent 角色')) {
      yield {
        kind: 'sdk_message',
        message: { type: 'system', subtype: 'init', model: input.model, context_window_tokens: 200_000 },
      }
      yield {
        kind: 'sdk_delta',
        delta: { uuid: 'child-assistant-smoke', deltas: [{ type: 'text_delta', contentIndex: 0, delta: '子 Agent 正在检查' }] },
      }
      await new Promise((done) => setTimeout(done, 120))
      yield {
        kind: 'sdk_message',
        message: {
          type: 'assistant',
          message: { content: [{ type: 'text', text: '子 Agent 已完成检查' }] },
          parent_tool_use_id: null,
          uuid: 'child-assistant-smoke',
        },
      }
      yield {
        kind: 'sdk_message',
        message: {
          type: 'result', subtype: 'success', usage: { input_tokens: 2, output_tokens: 2 },
          terminal_reason: 'completed',
        },
      }
      return
    }

    capturedQuery = input
    if (!input.runtimeSessionDir) throw new Error('中立查询缺少 Runtime 目录')
    input.onRuntimeSession?.('runtime-smoke', join(input.runtimeSessionDir, 'runtime-smoke.jsonl'))
    yield {
      kind: 'sdk_message',
      message: { type: 'system', subtype: 'init', model: input.model, context_window_tokens: 200_000 },
    }
    yield {
      kind: 'sdk_delta',
      delta: { uuid: 'assistant-smoke', deltas: [{ type: 'text_delta', contentIndex: 0, delta: '正在处理' }] },
    }
    await new Promise((done) => setTimeout(done, 120))
    const sandboxPermission = await input.canUseTool?.(
      'Bash',
      { command: 'curl https://example.com' },
      {
        toolUseId: 'sandbox-network-smoke',
        toolExecution: { kind: 'sandbox', mode: input.executionPolicy.sandboxMode },
        executionPolicy: input.executionPolicy,
        sandboxEscalation: {
          reason: 'networkAccess', permission: { type: 'network' },
          message: '命令的网络访问被基础沙箱拒绝；命令可能已产生部分本地副作用',
        },
      },
    )
    if (sandboxPermission?.behavior !== 'allow'
      || sandboxPermission.sandboxGrants?.[0]?.permission.type !== 'network') {
      throw new Error('沙箱网络升级未返回精确 Grant')
    }
    const agentTool = input.customTools?.find((tool) => tool.name === 'Agent')
    if (!agentTool) throw new Error('Agent 协作工具未注入主会话')
    yield {
      kind: 'sdk_message',
      message: {
        type: 'assistant',
        message: {
          content: [{
            type: 'tool_use', id: 'agent-task-smoke', name: 'Agent',
            input: {
              description: '检查子流程',
              prompt: '检查当前项目并返回简洁结论。',
              subagent_type: 'explore',
              run_in_background: false,
            },
          }],
        },
        parent_tool_use_id: null,
        uuid: 'agent-tool-call-smoke',
      },
    }
    const agentToolResult = await agentTool.execute(
      {
        description: '检查子流程',
        prompt: '检查当前项目并返回简洁结论。',
        subagent_type: 'explore',
        run_in_background: false,
      },
      { toolUseId: 'agent-task-smoke', signal: input.abortSignal },
    )
    yield {
      kind: 'sdk_message',
      message: {
        type: 'user',
        message: {
          content: [{
            type: 'tool_result',
            tool_use_id: 'agent-task-smoke',
            content: typeof agentToolResult.content === 'string'
              ? agentToolResult.content
              : JSON.stringify(agentToolResult.content),
            ...(agentToolResult.isError ? { is_error: true } : {}),
          }],
        },
        parent_tool_use_id: null,
        uuid: 'agent-tool-result-smoke',
      },
    }
    yield {
      kind: 'sdk_message',
      message: {
        type: 'assistant',
        message: {
          content: [
            { type: 'thinking', thinking: '检查工具调用展示。' },
            { type: 'text', text: 'Agent 正常回答' },
            { type: 'tool_use', id: 'bash-smoke', name: 'Bash', input: { command: 'bun test' } },
            { type: 'tool_use', id: 'write-smoke', name: 'write', input: { file_path: 'agent-generated.txt' } },
          ],
          usage: {
            input_tokens: 4_000,
            output_tokens: 500,
            cache_read_input_tokens: 300,
            cache_creation_input_tokens: 200,
          },
        },
        parent_tool_use_id: null,
        session_id: 'runtime-smoke',
        uuid: 'assistant-smoke',
      },
    }
    for (let index = 0; index < 3; index += 1) {
      yield {
        kind: 'sdk_message',
        message: {
          type: 'tool_progress', tool_use_id: 'bash-smoke', tool_name: 'Bash',
          parent_tool_use_id: null,
        },
      }
    }
    await new Promise((done) => setTimeout(done, 350))
    writeFileSync(join(input.cwd, 'agent-generated.txt'), 'Agent generated file\n')
    yield {
      kind: 'sdk_message',
      message: {
        type: 'user',
        message: { content: [
          { type: 'tool_result', tool_use_id: 'bash-smoke', content: '测试通过' },
          { type: 'tool_result', tool_use_id: 'write-smoke', content: '写入成功' },
        ] },
        parent_tool_use_id: null,
        session_id: 'runtime-smoke',
        uuid: 'tool-result-smoke',
      },
    }
    yield {
      kind: 'sdk_message',
      message: {
        type: 'result', subtype: 'success', usage: { input_tokens: 4, output_tokens: 4 },
        terminal_reason: 'completed', session_id: 'runtime-smoke',
        skill_activations: [{
          name: 'review-code',
          directoryKind: 'axon',
          relativeInstructionPath: '.axon/skills/review-code/SKILL.md',
          sources: ['skill_read'],
        }],
      },
    }
  },
  abort(): void {},
  dispose(): void {},
  async drain(): Promise<void> {},
}

const peer = new JsonRpcPeer(process.stdin, io.protocolOutput, APP_SERVER_RPC_OPTIONS)
// 两个方法只存在于测试程序，可信测试父端直接调用；不加生产方法或 renderer IPC。
peer.handle('axon/test/reading/resume', () => {
  if (!resumeReadingCheck) throw new Error('阅读夹具未处于等待状态')
  resumeReadingCheck()
  return true
})
peer.handle('axon/test/query/report', () => capturedQuery ? {
  model: capturedQuery.model ?? null, thinkingLevel: capturedQuery.thinkingLevel ?? null,
  cwd: capturedQuery.cwd ?? '', credentialMatched: capturedQuery.connection?.apiKey === 'synthetic-agent-key',
  toolNames: capturedQuery.customTools?.map((tool) => tool.name) ?? [],
  projectInstructionIncluded: capturedQuery.systemPrompt?.includes('回答前先检查工作区。') ?? false,
  memoryIncluded: capturedQuery.systemPrompt?.includes('external.md：外部记忆') ?? false,
} : null)

const zima = config.zimaPython ? new ZimaAgentAdapter(config.zimaPython, config.applicationVersion) : undefined
// 握手成功后才装配实际业务；只有模型事件源与标题传输由隔离夹具替换。
const connection = new AppServerConnection({ peer, bootstrap: (input, signal) => {
  signal.throwIfAborted()
  const ports = createPrivateHostPorts(peer, input.hostCapabilities)
  /** 创建/发送共用配置预检；测试也不能绕过受控解释器、启用模型与协议要求。 */
  const validateRuntime = async (value: AgentSessionCreateInput): Promise<void> => {
    if (value.runtimeId !== 'zima') return
    if (!zima || !value.channelId || !value.modelId) throw new Error('Zima 夹具缺少受控解释器或模型配置')
    const channel = await backend.channels.resolve(value.channelId)
    if (!channel.enabled || !channel.models.some((model) => model.enabled && model.id === value.modelId)) throw new Error('Zima 夹具模型不可用')
    assertZimaConnection(channel)
  }
  const backend = createBackend({
    paths: createBackendPaths(config), applicationVersion: config.applicationVersion,
    credentialCodec: ports.credentialCodec, confirmChannelTarget: ports.confirmChannelTarget,
    checkEnvironment: checkAgentEnvironment,
    validateCreate: validateRuntime, validateRuntimeSession: validateRuntime,
    resolveAdapter: (runtimeId) => {
      if (runtimeId === 'pi') return adapter
      if (!zima) throw new Error('测试未提供受控 Zima 解释器')
      return zima
    },
    // 标题仍走实际编排，只替换传输以避免测试访问正式模型渠道。
    providerStream: async function* () { yield { type: 'text_delta', delta: 'Agent 冒烟任务' } },
  })
  return { backend, applicationVersion: config.applicationVersion, capabilities: {
    ...input.hostCapabilities,
    runtimes: [
      { runtimeId: 'pi', configured: true, capabilities: { ...AGENT_RUNTIME_CAPABILITIES.pi, osSandbox: true },
        sandbox: { supported: true, modes: ['readOnly', 'workspaceWrite'], sandboxedTools: ['bash', 'read', 'write', 'edit', 'grep', 'glob', 'ls'] } },
      { runtimeId: 'zima', configured: !!zima, capabilities: AGENT_RUNTIME_CAPABILITIES.zima,
        sandbox: { supported: false, modes: [], sandboxedTools: [], limitation: 'runtimeToolDelegationUnavailable' } },
    ],
  } }
} })
let closing = false
/** 夹具进程有界退出；不以管道结束冒充生产资源的完整异步 drain。 */
function close(code: number): void {
  if (closing) return
  closing = true
  connection.close()
  zima?.dispose()
  process.stdin.destroy()
  const deadline = setTimeout(() => process.exit(1), 1_000)
  io.protocolOutput.end(() => { clearTimeout(deadline); process.exit(code) })
}
peer.onClose((error) => close(error.code === 'eof' || error.code === 'closed' ? 0 : 1))
process.once('SIGTERM', () => close(0))
process.once('SIGINT', () => close(0))
process.once('uncaughtException', () => { io.diagnostic('shutdown_failed'); close(1) })
process.once('unhandledRejection', () => { io.diagnostic('shutdown_failed'); close(1) })
io.diagnostic('ready')
