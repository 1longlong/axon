/** Agent Electron 冒烟入口：验证真实 UI 正常发送、流式展示与 JSONL 恢复。 */
import { app, BrowserWindow, ipcMain } from 'electron'
import { execFileSync } from 'node:child_process'
import { createServer } from 'node:http'
import { mkdirSync, mkdtempSync, realpathSync, writeFileSync } from 'node:fs'
import { join, resolve } from 'node:path'
import { tmpdir } from 'node:os'
import { registerAgentIpcHandlers } from '../src/main/ipc/agent-ipc-handlers'
import { registerAgentMemoryIpcHandlers } from '../src/main/ipc/agent-memory-ipc-handlers'
import { registerAgentProjectIpcHandlers } from '../src/main/ipc/agent-project-ipc-handlers'
import { registerAgentTaskIpcHandlers } from '../src/main/ipc/agent-task-ipc-handlers'
import { registerChannelIpcHandlers } from '../src/main/ipc/channel-ipc-handlers'
import { registerMcpProjectIpcHandlers } from '../src/main/ipc/mcp-project-ipc-handlers'
import { AgentEventBus } from '../src/main/lib/agent/agent-event-bus'
import { AgentIpcController } from '../src/main/lib/agent/agent-ipc-handlers'
import { AgentService } from '../src/main/lib/agent/agent-service'
import { AgentSessionManager } from '../src/main/lib/agent/agent-session-manager'
import { AgentDelegationManager } from '../src/main/lib/collaboration/agent-delegation-manager'
import { AgentCollaborationService } from '../src/main/lib/collaboration/agent-collaboration-service'
import {
  buildAgentCollaborationSystemPrompt,
  buildSubagentSystemPrompt,
  createAgentCollaborationTools,
} from '../src/main/lib/collaboration/agent-collaboration-tools'
import { AgentTaskIpcController } from '../src/main/lib/collaboration/agent-task-ipc-handlers'
import { AgentProjectManager } from '../src/main/lib/project/agent-project-manager'
import { AgentProjectIpcController } from '../src/main/lib/project/agent-project-ipc-handlers'
import { WorkspaceWatcher } from '../src/main/lib/project/workspace-watcher'
import { AgentMemoryWatcher } from '../src/main/lib/memory/agent-memory-watcher'
import { AgentMemoryService } from '../src/main/lib/memory/agent-memory-service'
import { AgentMemoryIpcController } from '../src/main/lib/memory/agent-memory-ipc-handlers'
import { createAgentMemoryTools, resolveAgentMemoryContext } from '../src/main/lib/memory/agent-memory-tools'
import { ChannelManager } from '../src/main/lib/channel/channel-manager'
import { createChannelCredentialCodec } from '../src/main/lib/channel/channel-credential-codec'
import { resolveProjectInstructions } from '../src/main/lib/project/project-instruction-resolver'
import { discoverAgentSkills } from '../src/main/lib/project/project-skill-discovery'
import { McpProjectConfigManager } from '../src/main/lib/mcp/mcp-project-config-manager'
import { McpProjectIpcController } from '../src/main/lib/mcp/mcp-project-ipc-handlers'
import { CHAT_IPC_CHANNELS } from '@axon/shared'
import type { AgentProviderAdapter, AgentQueryInput, AgentStreamPayload } from '@axon/shared'
import { SETTINGS_IPC_CHANNELS, USER_PROFILE_IPC_CHANNELS, WINDOW_IPC_CHANNELS } from '../src/types'
import type { AppSettings } from '../src/types'
import { setMainWindow } from '../src/main/lib/desktop/main-window-store'
import { assertZimaConnection, ZimaAgentAdapter } from '../src/main/lib/adapters/zima-agent-adapter'

const directory = mkdtempSync(join(tmpdir(), 'axon-agent-smoke-'))
app.setPath('userData', join(directory, 'electron'))
const timeout = setTimeout(() => {
  console.error('Agent 冒烟验证超时')
  app.exit(1)
}, process.env.AXON_ZIMA_PYTHON ? 60_000 : 30_000)

let capturedQuery: AgentQueryInput | undefined

/** 用中立事件模拟 runtime；分片间隔让 renderer 的运行中状态可被真实观察。 */
const adapter: AgentProviderAdapter = {
  async *query(input: AgentQueryInput): AsyncIterable<AgentStreamPayload> {
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
    input.onRuntimeSession?.('runtime-smoke', join(directory, 'runtime-sessions', 'runtime-smoke.jsonl'))
    yield {
      kind: 'sdk_message',
      message: { type: 'system', subtype: 'init', model: input.model, context_window_tokens: 200_000 },
    }
    yield {
      kind: 'sdk_delta',
      delta: { uuid: 'assistant-smoke', deltas: [{ type: 'text_delta', contentIndex: 0, delta: '正在处理' }] },
    }
    await new Promise((done) => setTimeout(done, 120))
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
}

void app.whenReady().then(async () => {
  // Zima 冒烟只连接本机临时模型端点，不使用开发配置中的真实渠道或密钥。
  const zimaPython = process.env.AXON_ZIMA_PYTHON
  const modelServer = zimaPython ? createServer((request, response) => {
    const chunks: Buffer[] = []
    request.on('data', (chunk: Buffer) => chunks.push(chunk))
    request.on('end', () => {
      const payload = JSON.parse(Buffer.concat(chunks).toString('utf8')) as {
        messages: Array<{ role: string; content?: string }>
      }
      const prompt = [...payload.messages].reverse().find((message) => message.role === 'user')?.content ?? ''
      const id = 'zima-desktop-smoke'
      const frames = [
        { id, model: 'gpt-5.6-smoke', choices: [{ index: 0, delta: { content: `Zima 回复：${prompt}` } }] },
        { id, model: 'gpt-5.6-smoke', choices: [], usage: { prompt_tokens: 10, completion_tokens: 3, total_tokens: 13 } },
      ]
      response.writeHead(200, { 'Content-Type': 'text/event-stream' })
      response.end(`${frames.map((frame) => `data: ${JSON.stringify(frame)}\n\n`).join('')}data: [DONE]\n\n`)
    })
  }) : undefined
  if (modelServer) await new Promise<void>((resolveListen) => modelServer.listen(0, '127.0.0.1', resolveListen))
  const modelAddress = modelServer?.address()
  const modelBaseUrl = modelAddress && typeof modelAddress !== 'string'
    ? `http://127.0.0.1:${modelAddress.port}/v1` : 'http://127.0.0.1:1/v1'
  const zimaAdapter = zimaPython ? new ZimaAgentAdapter(zimaPython, app.getVersion()) : undefined
  writeFileSync(join(directory, 'workspace-tree-marker.txt'), 'workspace tree smoke')
  writeFileSync(join(directory, 'AGENTS.md'), '# 项目指令\n\n回答前先检查工作区。\n')
  mkdirSync(join(directory, '.axon', 'skills', 'review-code'), { recursive: true })
  writeFileSync(join(directory, '.axon', 'skills', 'review-code', 'SKILL.md'), [
    '---',
    'name: review-code',
    'description: 检查本轮代码改动。',
    '---',
    '',
    '# Review Code',
  ].join('\n'))
  execFileSync('git', ['init', '--quiet'], { cwd: directory })
  const sessions = new AgentSessionManager({
    indexPath: join(directory, 'agent-sessions.json'),
    sessionsDir: join(directory, 'sessions'),
  })
  const channels = new ChannelManager({
    configPath: join(directory, 'channels.json'),
    credentialCodec: createChannelCredentialCodec(),
  })
  const projects = new AgentProjectManager({
    indexPath: join(directory, 'agent-projects.json'),
    projectsDir: join(directory, 'agent-projects'),
  })
  const smokeProject = projects.create({ name: 'Agent 冒烟项目', workspace: { kind: 'managed' } })
  const mcpConfigs = new McpProjectConfigManager({
    credentialCodec: createChannelCredentialCodec(),
    resolveProjectDataDir: (projectId) => projects.resolveProjectDataDir(projectId),
  })
  const memory = new AgentMemoryService({ projects })
  const channel = channels.create({
    name: 'Agent 本地测试渠道',
    provider: 'custom',
    baseUrl: modelBaseUrl,
    apiKey: 'synthetic-agent-key',
    models: [{ id: 'gpt-5.6-smoke', name: 'Agent 冒烟模型', enabled: true, source: 'manual' }],
  })
  const events = new AgentEventBus()
  const delegations = new AgentDelegationManager({ sessionsDir: join(directory, 'sessions') })
  let collaboration: AgentCollaborationService
  const agent = new AgentService({
    adapter,
    ...(zimaAdapter ? {
      resolveAdapter: (runtimeId: string) => runtimeId === 'zima' ? zimaAdapter : adapter,
      validateRuntimeSession: (session: { runtimeId: string; channelId?: string }) => {
        if (session.runtimeId === 'zima' && session.channelId) assertZimaConnection(channels.resolve(session.channelId))
      },
    } : {}),
    channelManager: channels,
    sessionManager: sessions,
    eventBus: events,
    runtimeConfigDir: join(directory, 'runtime-config'),
    runtimeSessionDir: join(directory, 'runtime-sessions'),
    resolveProjectCwd: (projectId) => projects.resolveProjectCwd(projectId),
    resolveProjectInstructions: (projectRoot) => resolveProjectInstructions({ projectRoot }),
    discoverAgentSkills: (projectRoot) => discoverAgentSkills({ projectRoot }),
    getProjectMemoryContext: (projectId, previous) => {
      if (!projects.get(projectId)?.memoryEnabled) return undefined
      return resolveAgentMemoryContext(projectId, memory, previous)
    },
    getSystemPrompt: (session) => session.subagentType
      ? buildSubagentSystemPrompt('', session.subagentType)
      : buildAgentCollaborationSystemPrompt(''),
    getCustomTools: async ({ sessionId, projectId, runSignal }) => [
      ...(sessions.get(sessionId)?.parentSessionId
        ? []
        : createAgentCollaborationTools({ sessionId, runSignal, collaboration })),
      ...(projects.get(projectId)?.memoryEnabled
        ? createAgentMemoryTools({ projectId, memory })
        : []),
    ],
  })
  collaboration = new AgentCollaborationService({
    sessions,
    delegations,
    agent,
    resolveProjectCwd: (projectId) => projects.resolveProjectCwd(projectId),
  })
  registerAgentIpcHandlers(
    new AgentIpcController({ sessions, agent, events, ...(zimaAdapter ? {
      validateCreate: (input) => {
        if (input.runtimeId === 'zima' && input.channelId) assertZimaConnection(channels.resolve(input.channelId))
      },
    } : {}) }),
    { resolveProjectCwd: (projectId) => projects.resolveProjectCwd(projectId), channelManager: channels },
  )
  registerAgentTaskIpcHandlers(new AgentTaskIpcController({ sessions, tasks: delegations, events }))
  registerAgentProjectIpcHandlers(
    new AgentProjectIpcController({ projects, sessions, watcher: new WorkspaceWatcher() }),
    {
      pickLocalWorkspace: async () => ({
        canceled: false,
        path: directory,
        suggestedName: 'Agent 本地项目',
      }),
    },
  )
  registerMcpProjectIpcHandlers(new McpProjectIpcController({
    configs: mcpConfigs,
    tools: { disposeProject: () => undefined },
    projects,
  }))
  registerAgentMemoryIpcHandlers(new AgentMemoryIpcController({
    memory,
    projects,
    watcher: new AgentMemoryWatcher(),
  }))
  registerChannelIpcHandlers(channels)
  // 完整 renderer 会初始化共享状态；为本冒烟补齐最小非 Agent handler，避免噪音干扰诊断。
  ipcMain.handle(CHAT_IPC_CHANNELS.LIST_CONVERSATIONS, () => [])
  let settings: AppSettings = { themeMode: 'light' }
  ipcMain.handle(SETTINGS_IPC_CHANNELS.GET, () => settings)
  ipcMain.handle(SETTINGS_IPC_CHANNELS.UPDATE, (_event, value: unknown) => {
    if (value && typeof value === 'object' && !Array.isArray(value)) {
      settings = { ...settings, ...(value as Partial<AppSettings>) }
    }
    return settings
  })
  ipcMain.handle(USER_PROFILE_IPC_CHANNELS.GET, () => ({ userName: '测试用户', avatar: '🧪' }))
  ipcMain.handle(WINDOW_IPC_CHANNELS.IS_MAXIMIZED, () => false)

  const win = new BrowserWindow({
    width: 1280,
    height: 800,
    show: false,
    webPreferences: {
      preload: resolve('dist/preload.cjs'),
      contextIsolation: true,
      nodeIntegration: false,
      backgroundThrottling: false,
    },
  })
  setMainWindow(win)
  const run = (script: string): Promise<unknown> => win.webContents.executeJavaScript(script)
  const waitFor = async (expression: string): Promise<void> => {
    const started = Date.now()
    while (!(await run(expression))) {
      if (Date.now() - started > 8_000) throw new Error(`等待界面失败：${expression}`)
      await new Promise((done) => setTimeout(done, 30))
    }
  }
  const clickText = (text: string): Promise<unknown> => run(`(() => {
    const button = [...document.querySelectorAll('button')].find(item => item.offsetParent && item.textContent.trim() === ${JSON.stringify(text)});
    if (!button || button.disabled) throw new Error('按钮不可用：${text}'); button.click();
  })()`)
  const clickAria = (label: string): Promise<unknown> => run(`(() => {
    const target = [...document.querySelectorAll('[aria-label=${JSON.stringify(label)}]')].find(item => item.offsetParent);
    if (!target || target.disabled) throw new Error('控件不可用：${label}'); target.click();
  })()`)
  const typeEditor = (value: string): Promise<unknown> => run(`(() => {
    const editor = [...document.querySelectorAll('.ProseMirror[contenteditable=true]')].find(item => item.offsetParent);
    if (!editor) throw new Error('Agent 输入框不可用');
    editor.focus();
    if (!document.execCommand('insertText', false, ${JSON.stringify(value)})) throw new Error('输入失败');
  })()`)
  const fillInput = (label: string, value: string): Promise<unknown> => run(`(() => {
    const input = document.querySelector('input[aria-label=${JSON.stringify(label)}]');
    if (!input) throw new Error('输入框不可用：${label}');
    const setter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value').set;
    setter.call(input, ${JSON.stringify(value)});
    input.dispatchEvent(new Event('input', { bubbles: true }));
  })()`)
  const fillTextarea = (label: string, value: string): Promise<unknown> => run(`(() => {
    const input = document.querySelector('textarea[aria-label=${JSON.stringify(label)}]');
    if (!input) throw new Error('文本框不可用：${label}');
    const setter = Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, 'value').set;
    setter.call(input, ${JSON.stringify(value)});
    input.dispatchEvent(new Event('input', { bubbles: true }));
  })()`)
  const assert = async (expression: string): Promise<void> => {
    if (!(await run(expression))) throw new Error(`Agent 冒烟断言失败：${expression}`)
  }

  await win.loadFile(resolve('dist/renderer/index.html'))
  await waitFor("[...document.querySelectorAll('button')].some(item => item.textContent.trim() === 'Agent')")
  await clickText('Agent')
  await assert("!document.querySelector('[role=\"tablist\"]')")
  const leftWidth = await run("document.querySelector('[aria-label=\"左侧会话栏\"]').getBoundingClientRect().width") as number
  await run("document.querySelector('[aria-label=\"调整左侧栏宽度\"]').dispatchEvent(new KeyboardEvent('keydown', { key: 'ArrowRight', bubbles: true }))")
  await waitFor(`document.querySelector('[aria-label="左侧会话栏"]').getBoundingClientRect().width === ${leftWidth + 16}`)
  await clickAria('收起侧栏')
  await waitFor("!!document.querySelector('[aria-label=\"展开侧栏\"]') && !document.querySelector('[aria-label=\"调整左侧栏宽度\"]')")
  await assert("(() => { const sidebar = document.querySelector('[aria-label=\"左侧会话栏\"]'); const button = document.querySelector('[aria-label=\"展开侧栏\"]'); return Math.abs(sidebar.getBoundingClientRect().bottom - button.getBoundingClientRect().bottom) <= 16 })()")
  await clickAria('展开侧栏')
  await waitFor(`!!document.querySelector('[aria-label="在 Agent 冒烟项目 中新建会话"]')`)
  await assert("(() => { const sidebar = document.querySelector('[aria-label=\"左侧会话栏\"]'); const button = document.querySelector('[aria-label=\"收起侧栏\"]'); return Math.abs(sidebar.getBoundingClientRect().bottom - button.getBoundingClientRect().bottom) <= 16 })()")
  await clickAria('在 Agent 冒烟项目 中新建会话')
  await assert("(() => { const menu = document.querySelector('[role=menu][aria-label*=Runtime]'); const rect = menu?.getBoundingClientRect(); return !!rect && rect.left >= 0 && rect.right <= innerWidth && rect.top >= 0 && rect.bottom <= innerHeight })()")
  writeFileSync(join(directory, 'runtime-menu.png'), (await win.webContents.capturePage()).toPNG())
  await run("document.querySelector('main').dispatchEvent(new PointerEvent('pointerdown', { bubbles: true }))")
  await waitFor("!document.querySelector('[role=menu][aria-label*=Runtime]')")
  await clickAria('在 Agent 冒烟项目 中新建会话')
  await clickText('Pi · 默认')
  await waitFor("!!document.querySelector('select[aria-label=\"选择 Agent 渠道和模型\"]') && !!document.querySelector('.ProseMirror[contenteditable=true]')")
  await assert("!document.querySelector('header [aria-label=\"选择 Agent 渠道和模型\"]')")
  await assert("document.querySelector('[aria-label=\"选择 Agent 渠道和模型\"]').getBoundingClientRect().top >= document.querySelector('.ProseMirror').getBoundingClientRect().bottom")
  await assert("!document.body.textContent.includes('Shift + Enter')")
  await assert("!document.querySelector('select[aria-label=\"选择 Agent 项目\"]')")

  // 项目菜单点击外部后关闭，不让多个操作层滞留在侧栏。
  await clickAria('管理项目 Agent 冒烟项目')
  await assert("document.querySelector('[aria-label=\"管理项目 Agent 冒烟项目\"]')?.closest('details')?.open === true")
  await run("document.querySelector('main').dispatchEvent(new PointerEvent('pointerdown', { bubbles: true }))")
  await waitFor("document.querySelector('[aria-label=\"管理项目 Agent 冒烟项目\"]')?.closest('details')?.open === false")

  // MCP 预设只生成草稿；点击保存后才通过 IPC 校验并写入项目私有配置。
  await clickAria('管理项目 Agent 冒烟项目')
  await clickText('MCP 服务')
  await waitFor("!!document.querySelector('[role=\"dialog\"][aria-label^=\"配置 \"][aria-label$=\" 的 MCP 服务\"]')")
  await clickText('工作区文件系统')
  await waitFor("document.querySelector('[role=\"dialog\"]')?.textContent.includes('filesystem')")
  await clickText('保存')
  await waitFor("document.querySelector('[role=\"dialog\"]')?.textContent.includes('配置已保存')")
  await clickAria('关闭 MCP 配置')
  await waitFor("!document.querySelector('[role=\"dialog\"][aria-label$=\" 的 MCP 服务\"]')")

  // 创建时不选择本地文件夹便自动使用默认目录，界面不暴露内部管理方式。
  await clickAria('新建 Agent 项目')
  await waitFor("!!document.querySelector('input[aria-label=\"项目名称\"]')")
  await fillInput('项目名称', 'Agent 默认项目')
  await clickText('创建')
  await waitFor("!!document.querySelector('[aria-label=\"项目 Agent 默认项目\"]')")
  await assert("!document.body.textContent.includes('托管工作区')")
  await clickAria('新建 Agent 项目')
  await waitFor("!!document.querySelector('input[aria-label=\"项目名称\"]')")
  await fillInput('项目名称', 'Agent 本地项目')
  await clickText('选择本地文件夹')
  await waitFor(`document.querySelector('[aria-label="创建项目"]')?.textContent.includes(${JSON.stringify(directory)})`)
  await clickText('创建')
  await waitFor("!!document.querySelector('[aria-label=\"项目 Agent 本地项目\"]')")
  const projectHoverPoint = await run("(() => { const rect = document.querySelector('[aria-label=\"项目 Agent 本地项目\"] > div').getBoundingClientRect(); return { x: Math.round(rect.left + 90), y: Math.round(rect.top + rect.height / 2) } })()") as { x: number; y: number }
  win.webContents.sendInputEvent({ type: 'mouseMove', ...projectHoverPoint })
  await waitFor("document.querySelector('[role=tooltip][aria-label=\"项目 Agent 本地项目 信息\"]')?.textContent.includes('工作区 · 本地目录')")
  await assert("(() => { const rect = document.querySelector('[role=tooltip][aria-label=\"项目 Agent 本地项目 信息\"]').getBoundingClientRect(); return rect.left >= 0 && rect.right <= innerWidth })()")
  writeFileSync(join(directory, 'project-hover.png'), (await win.webContents.capturePage()).toPNG())
  await clickAria('管理项目 Agent 本地项目')
  await clickText('启用项目记忆')
  await waitFor("document.querySelector('[aria-label=\"管理项目 Agent 本地项目\"]')?.closest('details')?.textContent.includes('关闭项目记忆') === true")
  await clickAria('在 Agent 本地项目 中新建会话')
  await assert("(() => { const menu = document.querySelector('[role=menu][aria-label*=Runtime]'); const rect = menu?.getBoundingClientRect(); return !!rect && rect.left >= 0 && rect.right <= innerWidth && rect.top >= 0 && rect.bottom <= innerHeight })()")
  await clickText('Pi · 默认')
  await waitFor("!!document.querySelector('input[aria-label=\"搜索 Agent 会话\"]') && document.body.textContent.includes('Agent 本地项目')")
  await fillInput('搜索 Agent 会话', '没有这个会话')
  await waitFor("document.body.textContent.includes('没有匹配的项目或会话')")
  await fillInput('搜索 Agent 会话', 'Agent 本地项目')
  await waitFor("document.querySelector('[aria-label=\"项目 Agent 本地项目\"]')?.textContent.includes('新任务')")
  await fillInput('搜索 Agent 会话', '')
  await waitFor("document.body.textContent.includes('workspace-tree-marker.txt')")

  // 记忆面板先经 IPC 创建索引，再验证外部写入自动刷新及未保存草稿保护。
  await clickAria('打开项目记忆面板')
  await waitFor("document.querySelector('[aria-label=\"项目记忆面板\"]')?.textContent.includes('尚未建立项目记忆')")
  await clickText('新建 MEMORY.md')
  await waitFor("!!document.querySelector('textarea[aria-label=\"编辑项目记忆\"]')")
  writeFileSync(join(directory, 'memory', 'external.md'), '# 外部记忆\n\n由文件监听发现。\n')
  await waitFor("!!document.querySelector('[aria-label=\"打开记忆 external.md\"]')")
  writeFileSync(join(directory, 'memory', 'external.md'), '# 外部记忆\n\n由文件监听再次刷新。\n')
  await waitFor("document.body.textContent.includes('已自动刷新')")
  await fillTextarea('编辑项目记忆', '# MEMORY\n\n尚未保存的草稿。\n')
  await waitFor("document.body.textContent.includes('未保存')")
  writeFileSync(join(directory, 'memory', 'MEMORY.md'), '# MEMORY\n\n- external.md：外部记忆。\n')
  await waitFor("document.body.textContent.includes('当前草稿尚未覆盖')")
  await assert("document.querySelector('textarea[aria-label=\"编辑项目记忆\"]').value.includes('尚未保存的草稿')")
  await run("window.confirm = () => true; true")
  await clickText('重新加载')
  await waitFor("document.querySelector('textarea[aria-label=\"编辑项目记忆\"]')?.value.includes('external.md：外部记忆') && !document.body.textContent.includes('当前草稿尚未覆盖')")
  await clickAria('打开文件面板')
  await assert("document.querySelector('button[aria-label=\"打开文件面板\"]').getAttribute('aria-pressed') === 'true'")
  const rightWidth = await run("[...document.querySelectorAll('[aria-label=\"工作区文件面板\"]')].find(item => item.offsetParent).getBoundingClientRect().width") as number
  await run("document.querySelector('[aria-label=\"调整右侧栏宽度\"]').dispatchEvent(new KeyboardEvent('keydown', { key: 'ArrowLeft', bubbles: true }))")
  await waitFor(`[...document.querySelectorAll('[aria-label="工作区文件面板"]')].find(item => item.offsetParent).getBoundingClientRect().width === ${rightWidth + 16}`)
  await clickAria('收起右侧栏')
  await waitFor("!!document.querySelector('[aria-label=\"展开右侧栏\"]') && ![...document.querySelectorAll('[aria-label=\"工作区文件面板\"]')].some(item => item.offsetParent)")
  await clickAria('打开文件面板')
  await waitFor("document.body.textContent.includes('workspace-tree-marker.txt')")
  writeFileSync(join(directory, 'auto-refresh-marker.txt'), 'watcher smoke')
  await waitFor("document.body.textContent.includes('auto-refresh-marker.txt')")
  await clickAria('打开终端面板')
  await waitFor("document.querySelector('[aria-label=\"终端面板\"]')?.textContent.includes('后续阶段接入')")
  await clickAria('打开浏览器面板')
  await waitFor("document.querySelector('[aria-label=\"浏览器面板\"]')?.textContent.includes('后续阶段接入')")
  await clickAria('打开文件面板')
  await waitFor("document.body.textContent.includes('auto-refresh-marker.txt')")
  await clickAria('预览 auto-refresh-marker.txt')
  await waitFor("document.querySelector('[aria-label=\"文件预览\"]')?.textContent.includes('watcher smoke')")
  await assert("(() => { const panel = [...document.querySelectorAll('[aria-label=\"Agent 右侧工具面板\"]')].find(item => item.offsetParent); return panel.previousElementSibling && Math.abs(panel.getBoundingClientRect().top - panel.previousElementSibling.getBoundingClientRect().top) < 2 })()")
  await assert(`[...document.querySelectorAll('select[aria-label="选择 Agent 渠道和模型"]')].find(item => item.offsetParent).value === JSON.stringify([${JSON.stringify(channel.id)}, 'gpt-5.6-smoke'])`)
  // 思考等级通过现有会话更新链落盘，下一轮再交给 adapter，运行中不允许漂移。
  await run(`(() => {
    const select = [...document.querySelectorAll('select[aria-label="选择 Agent 思考等级"]')].find(item => item.offsetParent);
    if (!select || select.disabled) throw new Error('思考等级选择不可用');
    const setter = Object.getOwnPropertyDescriptor(HTMLSelectElement.prototype, 'value').set;
    setter.call(select, 'high');
    select.dispatchEvent(new Event('change', { bubbles: true }));
  })()`)
  await waitFor(`[...document.querySelectorAll('select[aria-label="选择 Agent 思考等级"]')].find(item => item.offsetParent)?.value === 'high'`)
  await assert("!document.querySelector('button[aria-label=\"粗体\"]') && !document.querySelector('button[aria-label=\"无序列表\"]')")
  await typeEditor('执行本地 Agent 冒烟任务')
  await clickText('发送')
  await waitFor("document.body.textContent.includes('正在处理') && document.body.textContent.includes('Agent 运行中')")
  await waitFor("document.querySelector('summary[aria-label=\"工具调用 Bash\"] svg.animate-spin') !== null")
  await assert("document.querySelectorAll('summary[aria-label=\"工具调用 Bash\"]').length === 1")
  await waitFor("document.body.textContent.includes('Agent 正常回答') && !document.body.textContent.includes('Agent 运行中')")
  await assert("document.querySelector('summary[aria-label=\"工具调用 Bash\"]')?.textContent.includes('Bash · bun test')")
  await assert("document.querySelectorAll('summary[aria-label=\"工具调用 Bash\"]').length === 1")
  await assert("[...document.querySelectorAll('summary')].some(item => item.textContent.includes('思考过程'))")
  await run("document.querySelector('summary[aria-label=\"工具调用 Bash\"]').click()")
  await waitFor("document.body.textContent.includes('测试通过')")
  await waitFor("!!document.querySelector('[aria-label=\"查看子任务 检查子流程\"]') && document.body.textContent.includes('已完成')")
  await clickAria('查看子任务 检查子流程')
  await waitFor("document.querySelector('[role=\"dialog\"][aria-label=\"子任务：检查子流程\"]')?.textContent.includes('子 Agent 已完成检查')")
  await clickAria('关闭子任务详情')
  await waitFor("document.body.textContent.includes('本轮使用') && document.body.textContent.includes('review-code')")
  await waitFor("document.body.textContent.includes('本轮变更 1 个文件')")
  await assert("document.querySelector('[role=\"img\"][aria-label*=\"上下文窗口 200K\"][aria-label*=\"已用 5K\"]') !== null")
  await run("[...document.querySelectorAll('summary')].find(item => item.textContent.includes('本轮变更 1 个文件')).click()")
  await clickAria('查看 agent-generated.txt Diff')
  await waitFor("document.body.textContent.includes('+Agent generated file')")
  await clickAria('关闭 Diff')
  writeFileSync(join(directory, 'agent-complete.png'), (await win.webContents.capturePage()).toPNG())
  // AppShell 以防抖方式保存标签状态；等待其落入测试 settings 后再重载。
  await new Promise((done) => setTimeout(done, 260))

  const session = sessions.list()[0]
  const selectedProject = session?.projectId ? projects.get(session.projectId) : undefined
  const expectedProjectRoot = realpathSync(directory)
  const savedMcp = mcpConfigs.get(smokeProject.id).servers.filesystem
  const expectedMcpRoot = projects.resolveProjectCwd(smokeProject.id)
  if (savedMcp?.type !== 'stdio' || savedMcp.args?.at(-1) !== expectedMcpRoot) {
    throw new Error('MCP UI 未把可信项目工作区物化并持久化')
  }
  if (!session || session.channelId !== channel.id || session.modelId !== 'gpt-5.6-smoke' || session.thinkingLevel !== 'high' || selectedProject?.workspace.kind !== 'local' || selectedProject.workspace.path !== expectedProjectRoot) {
    throw new Error('Agent UI 未把项目归属、渠道、模型和思考等级写入会话')
  }
  if (capturedQuery?.model !== 'gpt-5.6-smoke' || capturedQuery.thinkingLevel !== 'high' || capturedQuery.connection?.apiKey !== 'synthetic-agent-key') {
    throw new Error('AgentService 未把安全解析后的模型、思考等级与连接交给 adapter')
  }
  if (capturedQuery.cwd !== expectedProjectRoot) {
    throw new Error('AgentService 未把工作区解析为可信 cwd')
  }
  if (!capturedQuery.systemPrompt?.includes('回答前先检查工作区。')) {
    throw new Error('AgentService 未把项目根 AGENTS.md 注入系统提示词')
  }
  if (!capturedQuery.customTools?.some((tool) => tool.name === 'SkillRead')) {
    throw new Error('AgentService 未注入统一 SkillRead 工具')
  }
  if (!capturedQuery.systemPrompt?.includes('external.md：外部记忆')) {
    throw new Error('AgentService 未把最新 MEMORY.md 追加到系统提示词末尾')
  }
  if (!capturedQuery.customTools?.some((tool) => tool.name === 'MemoryRead')
    || !capturedQuery.customTools.some((tool) => tool.name === 'MemoryWrite')) {
    throw new Error('AgentService 未给已启用项目注入记忆工具')
  }
  const messages = sessions.getMessages(session.id)
  const messageKinds = messages.map((message) => `${message.type}:${'subtype' in message ? String(message.subtype) : ''}`).join(',')
  if (messageKinds !== 'user:,system:init,assistant:,user:,assistant:,user:,result:success') {
    throw new Error(`Agent JSONL 终态不完整：${messageKinds}`)
  }
  const childTask = delegations.list(session.id)[0]
  if (!childTask || childTask.status !== 'completed' || childTask.resultSummary !== '子 Agent 已完成检查') {
    throw new Error('子任务终态未正确聚合到 state.json')
  }
  if (sessions.get(childTask.childSessionId)?.thinkingLevel !== 'high') {
    throw new Error('子 Agent 未继承父会话思考等级')
  }
  const childKinds = sessions.getMessages(childTask.childSessionId)
    .map((message) => `${message.type}:${'subtype' in message ? String(message.subtype) : ''}`)
    .join(',')
  if (childKinds !== 'user:,system:init,assistant:,result:success') {
    throw new Error(`子 Agent JSONL 终态不完整：${childKinds}`)
  }
  if (session.sdkSessionId !== 'runtime-smoke' || !session.runtimeSessionFile?.endsWith('runtime-smoke.jsonl')) {
    throw new Error('Agent runtime resume 凭据未回写')
  }

  // renderer 重载后只从会话索引和 JSONL 恢复，不依赖上一轮内存状态。
  win.webContents.reload()
  await waitFor("document.body.textContent.includes('Agent 正常回答') && !!document.querySelector('.ProseMirror[contenteditable=true]')")
  await assert("document.body.textContent.includes('执行本地 Agent 冒烟任务')")
  await waitFor("!!document.querySelector('[aria-label=\"查看子任务 检查子流程\"]')")
  await clickAria('查看子任务 检查子流程')
  await waitFor("document.querySelector('[role=\"dialog\"][aria-label=\"子任务：检查子流程\"]')?.textContent.includes('子 Agent 已完成检查')")
  await clickAria('关闭子任务详情')
  await assert("document.body.textContent.includes('本轮使用') && document.body.textContent.includes('review-code')")
  await assert(`document.querySelector('[aria-label="左侧会话栏"]').getBoundingClientRect().width === ${leftWidth + 16}`)
  await assert(`[...document.querySelectorAll('[aria-label="工作区文件面板"]')].find(item => item.offsetParent).getBoundingClientRect().width === ${rightWidth + 16}`)
  await assert(`[...document.querySelectorAll('select[aria-label="选择 Agent 思考等级"]')].find(item => item.offsetParent)?.value === 'high'`)

  if (zimaAdapter) {
    await clickAria('在 Agent 本地项目 中新建会话')
    await clickText('Zima')
    await waitFor("!!document.querySelector('.ProseMirror[contenteditable=true]') && document.body.textContent.includes('Runtime: Zima')")
    await assert("![...document.querySelectorAll('select[aria-label=\"选择 Agent 思考等级\"]')].some(item => item.offsetParent)")
    await typeEditor('Zima 桌面冒烟')
    await clickText('发送')
    await waitFor("document.body.textContent.includes('Zima 回复：Zima 桌面冒烟') && !document.body.textContent.includes('Agent 运行中')")
    await assert("document.querySelector('[role=img][aria-label*=\"上下文窗口 128K\"]') !== null")
    writeFileSync(join(directory, 'zima-complete.png'), (await win.webContents.capturePage()).toPNG())
    const zimaSession = sessions.list().find((item) => item.runtimeId === 'zima')
    if (!zimaSession || !zimaSession.runtimeSessionFile || !zimaSession.runtimeSessionFile.endsWith('state.json')) {
      throw new Error('Zima 桌面会话未保存 runtime 恢复凭据')
    }
    const zimaKinds = sessions.getMessages(zimaSession.id).map((message) => message.type)
    if (zimaKinds.join(',') !== 'user,system,assistant,result') {
      throw new Error(`Zima 桌面会话 JSONL 消息异常：${zimaKinds.join(',')}`)
    }
    win.webContents.reload()
    await waitFor("document.body.textContent.includes('Zima 回复：Zima 桌面冒烟') && !!document.querySelector('.ProseMirror[contenteditable=true]')")
    if (!sessions.list().some((item) => item.runtimeId === 'pi')) throw new Error('Pi 会话在 Zima 创建后丢失')
    zimaAdapter.dispose()
    modelServer?.close()
  }

  console.log(`Agent 冒烟验证通过：项目工作区、思考等级、项目指令、Skills、MCP 配置、项目记忆与变化刷新、协作子 Agent 任务卡与详情、双侧栏、文件树、用量圆环、变更汇总、Diff、流式消息、聚合 state/JSONL 与重载恢复${zimaAdapter ? '、Zima 创建/发送/恢复及 Pi 并存' : ''}。截图目录：${directory}`)
  clearTimeout(timeout)
  win.destroy()
  app.exit(0)
}).catch((error: unknown) => {
  console.error(error)
  clearTimeout(timeout)
  app.exit(1)
})
