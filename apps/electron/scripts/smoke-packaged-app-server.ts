/** 实际安装包后端冒烟；父端只提供协议/本机模型，执行器与全部运行依赖来自指定 .app。 */
import assert from 'node:assert/strict'
import { AssertionError } from 'node:assert'
import { execFileSync, spawn } from 'node:child_process'
import { closeSync, existsSync, mkdirSync, mkdtempSync, openSync, readFileSync, realpathSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { AppServerHistoryClient, JsonRpcPeer, RpcConnectionError, RpcFault, toWireValue } from '@axon/app-server'
import { APP_SERVER_METHODS as methods, APP_SERVER_NOTIFICATIONS, APP_SERVER_RPC_OPTIONS } from '@axon/shared'
import type { AgentProject, AgentSessionMeta, AppServerInitializeResult, AttachmentSaveResult, Channel, ConversationMeta, RpcJsonValue } from '@axon/shared'
import { createDesktopAppServerLaunch } from '../src/main/lib/desktop/app-server-launch'
import { packagedDocx, packagedPdf } from '../test-support/packaged-document-fixtures'

interface ModelRequest { messages: Array<{ role: string; content?: unknown }>; tools?: Array<{ function: { name: string } }> }
const appDirectory = realpathSync(process.argv[2] ?? '')
assert(appDirectory.endsWith('/Axon.app'), '必须指定实际 Axon.app')
const resources = join(appDirectory, 'Contents/Resources')
const entry = join(resources, 'app.asar.unpacked/dist/app-server.mjs')
assert(existsSync(entry), '安装包缺少独立入口')
if (process.argv.includes('--require-readonly')) {
  let writable = false
  try { const fd = openSync(entry, 'r+'); closeSync(fd); writable = true }
  catch (error) { assert(['EROFS', 'EACCES', 'EPERM'].includes((error as NodeJS.ErrnoException).code ?? ''), '只读检查发生其他错误') }
  assert(!writable, '验证要求应用包只读；请使用只读挂载的隔离安装包')
}
for (const name of ['@earendil-works/pi-coding-agent', '@modelcontextprotocol/sdk', 'pdf-parse', 'mammoth']) {
  assert(existsSync(join(resources, 'app.asar.unpacked/node_modules', name, 'package.json')), `安装包缺少依赖 ${name}`)
}
const requests: ModelRequest[] = []
const model = Bun.serve({ hostname: '127.0.0.1', port: 0, async fetch(request) {
  const body = await request.json() as ModelRequest
  requests.push(body)
  const read = body.tools?.some((tool) => tool.function.name === 'read') && !body.messages.some((message) => message.role === 'tool')
  const delta = read ? { role: 'assistant', tool_calls: [{ index: 0, id: 'package-read', type: 'function',
    function: { name: 'read', arguments: '{"path":"probe.txt"}' } }] } : { role: 'assistant', content: 'Axon packaged response' }
  return new Response([{ delta, finish_reason: null }, { delta: {}, finish_reason: read ? 'tool_calls' : 'stop' }]
    .map((choice) => `data: ${JSON.stringify({ id: 'package-fixture', object: 'chat.completion.chunk', model: 'axon-package-fixture', choices: [{ index: 0, ...choice }] })}\n\n`).join('') + 'data: [DONE]\n\n',
  { headers: { 'content-type': 'text/event-stream' } })
} })
const directory = mkdtempSync(join(tmpdir(), 'axon-packaged-backend-'))
const data = join(directory, 'data'), home = join(directory, 'home')
mkdirSync(home); mkdirSync(join(directory, 'tmp'))
const applicationVersion = execFileSync('/usr/bin/plutil', ['-extract', 'CFBundleShortVersionString', 'raw', '-o', '-', join(appDirectory, 'Contents/Info.plist')], { encoding: 'utf8' }).trim()
assert(applicationVersion, '应用版本资源不可读')
const launch = createDesktopAppServerLaunch({ executable: join(appDirectory, 'Contents/MacOS/Axon'), packaged: true,
  resourcesDirectory: resources, mainDirectory: '', dataDir: data, homeDir: home, applicationVersion,
  environment: { ...process.env, PATH: '/usr/bin:/bin:/usr/sbin:/sbin', HOME: home, TMPDIR: join(directory, 'tmp'),
    AXON_ZIMA_PYTHON: '', HTTP_PROXY: '', HTTPS_PROXY: '', ALL_PROXY: '', http_proxy: '', https_proxy: '', all_proxy: '', NO_PROXY: '127.0.0.1,localhost' } })

/** 使用原生产启动配置，从包外空 cwd 启动；不提供源码 node_modules 或用户运行时。 */
function start() {
  const child = spawn(launch.executable, [...launch.entryArgs, '--data-dir', data, '--home-dir', home,
    '--application-version', launch.applicationVersion], { cwd: directory, env: launch.environment, stdio: 'pipe' })
  let stderr = ''
  child.stderr.on('data', (chunk: Buffer) => { stderr += chunk.toString() })
  const closed = new Promise<number | null>((done, failed) => { child.once('close', done); child.once('error', failed) })
  const peer = new JsonRpcPeer(child.stdout, child.stdin, { ...APP_SERVER_RPC_OPTIONS, requestTimeoutMs: 15_000 })
  // 超时仍只收束本次启动的 child，不杀其他用户实例；真实退出证据是 close。
  const deadline = setTimeout(() => child.kill('SIGKILL'), 40_000)
  let stopping: Promise<void> | undefined
  const shutdown = (): Promise<void> => stopping ??= (async () => {
    child.stdin.end()
    try { assert.equal(await closed, 0, '安装包后端非正常退出') }
    finally { clearTimeout(deadline); peer.close(); child.stdin.destroy(); child.stdout.destroy(); child.stderr.destroy() }
  })()
  return { peer, child, shutdown, get stderr() { return stderr } }
}

let first: ReturnType<typeof start> | undefined, second: ReturnType<typeof start> | undefined
let stage = '独立入口握手'
try {
  first = start()
  const initialized = await first.peer.request(methods.INITIALIZE, { protocolVersion: 1,
    client: { name: 'axon-packaged-smoke', version: launch.applicationVersion },
    hostCapabilities: { credentialStorage: 'unavailable', channelTargetConfirmation: false } }) as unknown as AppServerInitializeResult
  assert.equal(initialized.dataDirectory, data)
  assert.equal(initialized.capabilities.runtimes.find((runtime) => runtime.runtimeId === 'zima')?.configured, false)
  assert.equal(initialized.capabilities.runtimes.find((runtime) => runtime.runtimeId === 'pi')?.sandbox.supported, true, '真实 Seatbelt 不可用，不能把拒绝运行当打包通过')
  const client = await first.peer.request(methods.REGISTER_CLIENT, { kind: 'external' }) as { clientId: string }
  const request = (method: string, input?: RpcJsonValue) => first!.peer.request(method,
    { clientId: client.clientId, ...(input === undefined ? {} : { input }) })
  await request(methods.UPDATE_SETTINGS, { agentSystemPrompt: '仅用于隔离打包验证' })
  const project = await request(methods.PROJECT_CREATE, { name: '安装包隔离项目' }) as unknown as AgentProject
  const channel = await request(methods.CHANNEL_CREATE, { name: '安装包本机模型', provider: 'custom', apiKey: '',
    baseUrl: `http://127.0.0.1:${model.port}/v1`, models: [{ id: 'axon-package-fixture', name: '打包夹具', enabled: true }] }) as unknown as Channel

  stage = 'MCP SDK 与随包 Node 执行器'
  const mcpScript = join(directory, 'mcp.mjs')
  writeFileSync(mcpScript, readFileSync(join(import.meta.dir, '../../../packages/core/test-support/mcp-stdio-fixture.mjs')))
  const mcp = await request(methods.MCP_TEST_CONNECTION, { projectId: project.id, serverName: 'package', server: {
    type: 'stdio', command: launch.executable, args: [mcpScript, join(directory, 'mcp-closed')], env: { ELECTRON_RUN_AS_NODE: '1' },
    enabled: true, required: true, startupTimeoutMs: 5_000, requestTimeoutMs: 5_000,
  } }) as { ok: boolean; tools?: Array<{ name: string }> }
  assert.equal(mcp.ok, true, '随包 MCP 握手失败')
  assert.deepEqual(mcp.tools?.map((tool) => tool.name), ['echo', 'second'], '随包 MCP 未正确分页返回工具')
  assert.equal(readFileSync(join(directory, 'mcp-closed'), 'utf8'), 'closed', 'MCP 实际进程未收束')

  stage = '附件解析器实际资源'
  const chat = await request(methods.CHAT_CREATE_CONVERSATION, { channelId: channel.id, modelId: 'axon-package-fixture', title: '安装包附件' }) as unknown as ConversationMeta
  const attachments = []
  for (const [filename, mediaType, buffer] of [['probe.pdf', 'application/pdf', packagedPdf()],
    ['probe.docx', 'application/vnd.openxmlformats-officedocument.wordprocessingml.document', packagedDocx()]] as const) {
    const saved = await request(methods.ATTACHMENT_SAVE, { conversationId: chat.id, filename, mediaType, data: buffer.toString('base64') }) as unknown as AttachmentSaveResult
    assert(saved.success, '安装包附件保存失败')
    attachments.push(saved.attachment)
  }
  const sent = await request(methods.CHAT_SEND, toWireValue({ conversationId: chat.id, text: '提取两个附件', attachments })) as { success: boolean }
  assert.equal(sent.success, true, '安装包 Chat 未完成')
  assert(JSON.stringify(requests).includes('Axon packaged PDF'), '随包 PDF 资源未正确解析')
  assert(JSON.stringify(requests).includes('Axon packaged DOCX'), '随包 DOCX 资源未正确解析')
  const chatHistory = await new AppServerHistoryClient(first.peer, client.clientId).read({ kind: 'chat', conversationId: chat.id })
  assert.equal(chatHistory.length, 2)

  stage = 'Pi 真实 SDK/宿主工具/artifact'
  writeFileSync(join(data, 'agent-projects', project.slug, 'workspace-files/probe.txt'), 'Axon packaged host file')
  const session = await request(methods.AGENT_CREATE_SESSION, { projectId: project.id, channelId: channel.id, modelId: 'axon-package-fixture', title: '安装包 Agent' }) as unknown as AgentSessionMeta
  let events = 0
  first.peer.handleNotification(APP_SERVER_NOTIFICATIONS.AGENT_RUN, () => { events += 1 })
  assert.deepEqual(await request(methods.AGENT_SEND, { sessionId: session.id, text: '读取 probe.txt' }), { success: true, disposition: 'started' })
  assert(JSON.stringify(requests).includes('Axon packaged host file'), '未执行真实宿主读取')
  const history = await new AppServerHistoryClient(first.peer, client.clientId).read({ kind: 'agent', sessionId: session.id })
  assert(JSON.stringify(history).includes('Axon packaged response'), '真实 Pi 未完成')
  const meta = await request(methods.AGENT_GET_SESSION, session.id) as unknown as AgentSessionMeta
  assert(meta.runtimeSessionFile?.startsWith(data + '/') && existsSync(meta.runtimeSessionFile), 'artifact 未写入指定数据目录')
  assert(events > 2, '实际运行事件未广播')
  await first.shutdown()

  stage = '新进程恢复与再次执行'
  second = start()
  await second.peer.request(methods.INITIALIZE, { protocolVersion: 1, client: { name: 'axon-packaged-recovery', version: applicationVersion },
    hostCapabilities: { credentialStorage: 'unavailable', channelTargetConfirmation: false } })
  const restoredClient = await second.peer.request(methods.REGISTER_CLIENT, { kind: 'external' }) as { clientId: string }
  const histories = new AppServerHistoryClient(second.peer, restoredClient.clientId)
  assert.deepEqual(await histories.read({ kind: 'chat', conversationId: chat.id }), chatHistory)
  assert.deepEqual(await histories.read({ kind: 'agent', sessionId: session.id }), history)
  assert.deepEqual(await second.peer.request(methods.AGENT_SEND, { clientId: restoredClient.clientId,
    input: { sessionId: session.id, text: '继续回答' } }), { success: true, disposition: 'started' })
  assert(JSON.stringify(requests.at(-1)?.messages).includes('读取 probe.txt'), 'SDK 没有恢复先前上下文')
  await second.shutdown()
  assert(!(first.stderr + second.stderr).includes('退出异常'), '退出失败不能冒充打包通过')
  console.log('[打包冒烟] 随包执行器、SDK/MCP/PDF/DOCX、真实 Seatbelt Read、artifact 与新进程恢复通过；模型仅为本机 SSE')
} catch (error) {
  console.error('[打包冒烟] 失败阶段：' + stage)
  // 断言仅涉及本脚本生成的隔离夹具；未知后端错误仍只报告协议类别。
  if (error instanceof AssertionError) console.error('[打包冒烟] 断言：' + error.message)
  if (error instanceof RpcFault || error instanceof RpcConnectionError) console.error('[打包冒烟] 协议错误码：' + error.code)
  process.exitCode = 1
} finally {
  for (const process of [first, second]) {
    if (!process) continue
    await process.shutdown().catch(() => {})
  }
  model.stop(true)
  rmSync(directory, { recursive: true, force: true })
}
