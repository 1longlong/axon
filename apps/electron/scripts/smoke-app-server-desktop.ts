/** 真实生产启动冒烟：需 5173 Vite；只调整原生目录，不在父端组装业务夹具。 */
import { app, BrowserWindow, dialog } from 'electron'
import type { BaseWindow, MessageBoxOptions } from 'electron'
import type { ChannelNetworkResult, ChatMessage, SDKMessage } from '@axon/shared'
import { mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { createServer } from 'node:http'
import { createServer as createTcpServer } from 'node:net'
import type { Socket } from 'node:net'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { getMainWindow } from '../src/main/lib/desktop/main-window-store'

const directory = mkdtempSync(join(tmpdir(), 'axon-production-desktop-'))
mkdirSync(join(directory, 'application'), { recursive: true })
app.setPath('home', directory)
app.setPath('appData', join(directory, 'application'))
process.env.AXON_DEV_INSTANCE = 'backend-smoke-' + process.pid
process.env.AXON_ZIMA_PYTHON = ''
// 默认 zsh 的预热只读取测试启动目录；HOME 保持原值供原生 Keychain 使用。
process.env.ZDOTDIR = directory
for (const key of ['HTTP_PROXY', 'HTTPS_PROXY', 'ALL_PROXY', 'http_proxy', 'https_proxy', 'all_proxy']) delete process.env[key]
process.env.NO_PROXY = '127.0.0.1,localhost'
let passed = false
let stage = '等待主窗口'
let requests = 0
const screenshots = mkdtempSync(join(tmpdir(), 'axon-source-desktop-evidence-'))
const mcpRequests: Array<{ path: string; method: string; closed: boolean }> = []
const mcpSockets = new Set<Socket>()
const generationSockets = new Set<Socket>()
const generations: string[] = []
let closedGenerations = 0
let closedModelRequests = 0
let inFlight: { sessionId: string; conversationId: string } | undefined
// 合法 SSE 只发送首个增量并保持连接；实际 SDK/流解析与退出取消均由生产链执行。
const generationModel = createTcpServer((socket) => {
  generationSockets.add(socket)
  socket.once('close', () => { generationSockets.delete(socket); closedGenerations += 1 })
  socket.on('error', () => {})
  let bytes = Buffer.alloc(0), handled = false
  socket.on('data', (chunk: Buffer) => {
    if (handled) return
    bytes = Buffer.concat([bytes, chunk])
    if (bytes.length > 16 * 1024 * 1024) { socket.destroy(); return }
    const split = bytes.indexOf('\r\n\r\n')
    if (split < 0) return
    const length = Number(bytes.subarray(0, split).toString('utf8').match(/\r\ncontent-length:\s*(\d+)/i)?.[1])
    if (!Number.isSafeInteger(length) || length < 1) { socket.destroy(); return }
    if (bytes.length < split + 4 + length) return
    handled = true
    const body = JSON.parse(bytes.subarray(split + 4, split + 4 + length).toString('utf8')) as { tools?: unknown[] }
    const kind = body.tools?.length ? 'agent' : 'chat'
    generations.push(kind)
    socket.once('close', () => { closedModelRequests += 1 })
    const frame = `data: ${JSON.stringify({ id: 'desktop-drain', object: 'chat.completion.chunk',
      model: 'axon-drain-fixture', choices: [{ index: 0, delta: { role: 'assistant', content: kind + ' 局部内容' }, finish_reason: null }],
    })}\n\n`
    // 直接 TCP 默认在收到 FIN 后关闭；HTTP Server 的半关闭响应会滞留，不能拿来证明取消失效。
    socket.write('HTTP/1.1 200 OK\r\nContent-Type: text/event-stream\r\nTransfer-Encoding: chunked\r\nConnection: close\r\n\r\n')
    socket.write(`${Buffer.byteLength(frame).toString(16)}\r\n${frame}\r\n`)
  })
})
// 本机协议夹具仅控制服务器何时回答；客户端、IPC、独立后端和 TCP 关闭仍是实际实现。
const mcp = createTcpServer((socket) => {
  mcpSockets.add(socket)
  socket.once('close', () => mcpSockets.delete(socket))
  let bytes = Buffer.alloc(0), handled = false
  socket.on('data', (chunk: Buffer) => {
    if (handled) return
    bytes = Buffer.concat([bytes, chunk])
    const split = bytes.indexOf('\r\n\r\n')
    if (split < 0) return
    const header = bytes.subarray(0, split).toString('utf8')
    const length = Number(header.match(/\r\ncontent-length:\s*(\d+)/i)?.[1])
    if (!Number.isSafeInteger(length) || length < 0) { socket.destroy(); return }
    if (bytes.length < split + 4 + length) return
    handled = true
    const message = JSON.parse(bytes.subarray(split + 4, split + 4 + length).toString('utf8')) as {
      id?: string | number; method: string; params?: { protocolVersion?: string }
    }
    const entry = { path: header.split(' ')[1] ?? '', method: message.method, closed: false }
    mcpRequests.push(entry)
    socket.once('close', () => { entry.closed = true })
    // 保持工具发现真正在线等待，避免“请求尚未建立就取消”的假阳性。
    if (entry.path !== '/success' && message.method === 'tools/list') return
    if (message.id === undefined) { socket.end('HTTP/1.1 204 No Content\r\nConnection: close\r\n\r\n'); return }
    const result = message.method === 'initialize'
      ? { protocolVersion: message.params?.protocolVersion, capabilities: { tools: {} }, serverInfo: { name: 'axon-desktop-fixture', version: '1.0.0' } }
      : { tools: [{ name: 'desktop_probe', description: '源码连接验证', inputSchema: { type: 'object', properties: { text: { type: 'string' } }, required: ['text'] } }] }
    const body = JSON.stringify({ jsonrpc: '2.0', id: message.id, result })
    socket.end(`HTTP/1.1 200 OK\r\nContent-Type: application/json\r\nContent-Length: ${Buffer.byteLength(body)}\r\nConnection: close\r\n\r\n${body}`)
  })
})
const model = createServer((_request, response) => {
  requests += 1
  response.writeHead(200, { 'content-type': 'application/json' })
  response.end(JSON.stringify({ data: [] }))
})
const confirmations: Array<{ signal?: AbortSignal; completed: boolean }> = []
const nativeMessageBox = dialog.showMessageBox.bind(dialog)
// 仅观察实际原生 API 的调用与完成，不替换用户选择、返回值或取消信号。
dialog.showMessageBox = (...args: [MessageBoxOptions] | [BaseWindow, MessageBoxOptions]) => {
  const options = args.length === 2 ? args[1] : args[0]
  const pending = args.length === 2 ? nativeMessageBox(args[0], args[1]) : nativeMessageBox(args[0])
  if (options.title !== '确认渠道请求目标') return pending
  const observed = { signal: options.signal, completed: false }
  confirmations.push(observed)
  return pending.finally(() => { observed.completed = true })
}
const timeout = setTimeout(() => {
  console.error('[桌面冒烟] 生产启动验证超时：' + stage)
  app.once('will-quit', () => app.exit(1))
  app.quit()
}, 90_000)

/** 等待实际页面状态，不以固定延时把尚未完成的启动或重载当成功。 */
async function waitUntil(check: () => boolean | Promise<boolean>): Promise<void> {
  const deadline = Date.now() + 20_000
  while (Date.now() < deadline) {
    if (await check()) return
    await new Promise<void>((resolve) => setTimeout(resolve, 50))
  }
  throw new Error('桌面页面状态未就绪')
}

/** 用真实 preload 查询后端并点击 React 创建入口；不替换 IPC、业务服务或 safeStorage。 */
async function verifyDesktop(): Promise<void> {
  await waitUntil(() => !!getMainWindow() && !getMainWindow()!.webContents.isLoadingMainFrame())
  const window = getMainWindow()!
  window.webContents.closeDevTools()
  const run = (script: string): Promise<unknown> => window.webContents.executeJavaScript(script)
  const capture = async (name: string): Promise<void> => {
    // DOM 已提交不等于合成器已绘制；等待实际前台帧，避免保存旧主界面截图。
    window.show()
    window.focus()
    await run(`new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve)))`)
    writeFileSync(join(screenshots, name), (await window.webContents.capturePage()).toPNG())
  }
  stage = '等待 React 主界面'
  await waitUntil(async () => await run(`Boolean([...document.querySelectorAll('button')].find(item => item.textContent === 'Chat'))`) === true)
  await run(`[...document.querySelectorAll('button')].find(item => item.textContent === 'Chat').click()`)
  stage = '等待新建对话入口'
  await waitUntil(async () => await run(`Boolean([...document.querySelectorAll('button')].find(item => item.textContent === '新建对话' && !item.disabled))`) === true)
  await run(`[...document.querySelectorAll('button')].find(item => item.textContent === '新建对话').click()`)
  stage = '等待会话输入区'
  await waitUntil(async () => await run(`Boolean(document.querySelector('[aria-label="消息输入"]'))`) === true)
  stage = '验证业务 IPC 与私有凭据桥'
  const result = await run(`(async () => {
    const conversations = await window.axon.chat.listConversations();
    if (conversations.length !== 1) throw new Error('React 创建未进入共享后端');
    const channel = await window.axon.channels.create({ name: '生产桥测试', provider: 'openai', apiKey: 'synthetic-desktop-key', models: [] });
    if (!channel.hasApiKey || 'apiKey' in channel) throw new Error('safeStorage 私有桥或 DTO 异常');
    const project = await window.axon.agentProjects.create({ name: '独立后端项目' });
    const session = await window.axon.agent.createSession({ projectId: project.id, runtimeId: 'pi' });
    if ((await window.axon.agent.getMessages(session.id)).length !== 0) throw new Error('新会话历史异常');
    await window.axon.settings.update({ themeMode: 'light', agentSystemPrompt: '独立后端测试' });
    return { conversationId: conversations[0].id, projectId: project.id, sessionId: session.id, channelId: channel.id };
  })()`) as { conversationId: string; projectId: string; sessionId: string; channelId: string }
  // Shell 的标签保存有防抖；先确认实际提交，再验证重载恢复，不能把未保存状态当持久化故障。
  await waitUntil(async () => await run(`(async () => (await window.axon.settings.get()).tabState?.activeTabId === ${JSON.stringify(result.conversationId)})()`) === true)
  // 重载建立新的可信页面身份，仍读取同一服务的历史和配置。
  window.webContents.reload()
  stage = '等待页面重载恢复'
  await waitUntil(() => !window.webContents.isLoadingMainFrame())
  await waitUntil(async () => {
    try { return await run(`Boolean(document.querySelector('[aria-label="消息输入"]'))`) === true }
    catch { return false }
  })
  const restored = await run(`(async () => {
    const settings = await window.axon.settings.get();
    const session = await window.axon.agent.getSession(${JSON.stringify(result.sessionId)});
    const chat = await window.axon.chat.getConversation(${JSON.stringify(result.conversationId)});
    return settings.agentSystemPrompt === '独立后端测试' && session?.projectId === ${JSON.stringify(result.projectId)} && chat?.id === ${JSON.stringify(result.conversationId)}
      && !document.body.textContent.includes('应用初始化失败');
  })()`)
  if (restored !== true) throw new Error('页面重载后状态恢复失败')
  stage = '验证加密文件与退出保存'
  const channels = readFileSync(join(directory, '.axon-dev', 'channels.json'), 'utf8')
  if (channels.includes('synthetic-desktop-key') || !channels.includes('secure:v1:')) throw new Error('凭据未按生产桥安全持久化')
  stage = '验证 MCP 真实连接与页面取消'
  await new Promise<void>((resolve, reject) => { mcp.once('error', reject); mcp.listen(0, '127.0.0.1', resolve) })
  const mcpAddress = mcp.address()
  if (!mcpAddress || typeof mcpAddress === 'string') throw new Error('本机 MCP 服务未就绪')
  const mcpBase = `http://127.0.0.1:${mcpAddress.port}`
  await run(`window.axon.mcpProjects.saveConfig(${JSON.stringify(result.projectId)}, ${JSON.stringify({ version: 1, servers: {
    local: { type: 'http', enabled: false, required: false, startupTimeoutMs: 60_000, requestTimeoutMs: 60_000, url: mcpBase + '/success' },
  } })})`)
  const clickText = async (text: string): Promise<void> => {
    const selector = `[...document.querySelectorAll('button')].find(item => item.textContent.trim() === ${JSON.stringify(text)} && item.offsetParent && !item.disabled)`
    await waitUntil(async () => await run(`Boolean(${selector})`) === true)
    await run(`${selector}.click()`)
  }
  const openMcp = async (): Promise<void> => {
    // 当前活跃 Tab 仍是 Chat；重载会恢复该 Tab，必须通过真实切换入口再打开项目。
    await clickText('Agent')
    const selector = `document.querySelector('[aria-label="管理项目 独立后端项目"]')`
    await waitUntil(async () => await run(`Boolean(${selector})`) === true)
    await run(`${selector}.click()`)
    await clickText('MCP 服务')
    await waitUntil(async () => await run(`Boolean([...document.querySelectorAll('button')].find(item => item.textContent === '测试连接' && !item.disabled))`) === true)
    // 程序化 click 能穿过透明容器，必须另外证明鼠标真正能够命中弹窗控件。
    await waitUntil(async () => await run(`(() => {
      const button = [...document.querySelectorAll('[role="dialog"] button')].find(item => item.textContent === '测试连接');
      if (!button) return false;
      for (let element = button; element; element = element.parentElement) {
        const style = getComputedStyle(element);
        if (Number(style.opacity) === 0 || style.visibility === 'hidden' || style.pointerEvents === 'none') return false;
      }
      const rect = button.getBoundingClientRect();
      return button.contains(document.elementFromPoint(rect.left + rect.width / 2, rect.top + rect.height / 2));
    })()`) === true)
  }
  await openMcp()
  await clickText('测试连接')
  await waitUntil(async () => await run(`document.querySelector('[role="dialog"]')?.textContent.includes('连接成功，发现 1 个工具')`) === true)
  if (await run(`document.querySelector('[role="dialog"] pre')?.textContent.includes('desktop_probe') && document.querySelector('[role="dialog"] pre')?.textContent.includes('inputSchema')`) !== true) {
    throw new Error('MCP 成功结果没有在页面保留完整工具定义')
  }
  await capture('mcp-tools.png')
  const startMcp = async (path: string): Promise<void> => {
    await run(`(() => {
      const input = document.querySelector('input[placeholder="https://example.com/mcp"]');
      Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value').set.call(input, ${JSON.stringify(mcpBase)} + ${JSON.stringify(path)});
      input.dispatchEvent(new Event('input', { bubbles: true }));
    })()`)
    await clickText('测试连接')
    await waitUntil(() => mcpRequests.some((entry) => entry.path === path && entry.method === 'tools/list' && !entry.closed))
    if (await run(`document.querySelector('[role="dialog"]')?.textContent.includes('正在测试…') && document.querySelector('[role="dialog"]')?.textContent.includes('取消测试')`) !== true) throw new Error('MCP 在途测试没有呈现可取消状态')
  }
  const closedMcp = (path: string): Promise<void> => waitUntil(() => mcpRequests.some((entry) => entry.path === path && entry.method === 'tools/list' && entry.closed))
  // 精确取消与关闭弹窗都必须实际断开本次 TCP；取消等待或隐藏组件本身不是证据。
  await startMcp('/cancel')
  await capture('mcp-pending.png')
  await clickText('取消测试')
  await closedMcp('/cancel')
  await waitUntil(async () => await run(`Boolean([...document.querySelectorAll('button')].find(item => item.textContent === '测试连接' && !item.disabled)) && !document.querySelector('[role="dialog"] pre') && !document.querySelector('[role="dialog"]')?.textContent.includes('取消测试')`) === true)
  await startMcp('/close')
  await run(`document.querySelector('[aria-label="关闭 MCP 配置"]').click()`)
  await closedMcp('/close')
  await waitUntil(async () => await run(`!document.querySelector('[role="dialog"]')`) === true)
  await openMcp()
  await startMcp('/reload')
  stage = '验证 MCP 重载关闭与新页面恢复'
  window.webContents.reload()
  await closedMcp('/reload')
  await waitUntil(() => !window.webContents.isLoadingMainFrame())
  await waitUntil(async () => { try { return await run(`Boolean([...document.querySelectorAll('button')].find(item => item.textContent === 'Agent'))`) === true } catch { return false } })
  await openMcp()
  if (await run(`document.querySelector('input[placeholder="https://example.com/mcp"]').value === ${JSON.stringify(mcpBase + '/success')} && !document.querySelector('[role="dialog"] pre') && !document.querySelector('[role="dialog"]')?.textContent.includes('正在测试…')`) !== true) throw new Error('重载恢复了旧 MCP 测试或未保存草稿')
  await run(`document.querySelector('[aria-label="关闭 MCP 配置"]').click()`)
  await new Promise<void>((resolve, reject) => {
    model.once('error', reject)
    model.listen(0, '127.0.0.1', () => { model.removeListener('error', reject); resolve() })
  })
  const address = model.address()
  if (!address || typeof address === 'string') throw new Error('本机目录服务未就绪')
  const input = (requestId: string) => JSON.stringify({ requestId, operation: 'models', provider: 'custom',
    channelId: result.channelId, baseUrl: `http://127.0.0.1:${address.port}/v1` })
  const pending = (requestId: string) => run(`window.axon.channels.request(${input(requestId)})`)
  const arrived = async (count: number): Promise<void> => {
    await waitUntil(() => confirmations.length === count && !confirmations[count - 1]!.completed)
    if (confirmations[count - 1]!.signal?.aborted !== false) throw new Error('原生确认没有有效取消信号')
  }
  const canceled = async (index: number): Promise<void> => {
    await waitUntil(() => confirmations[index]!.completed)
    if (!confirmations[index]!.signal?.aborted || requests !== 0) throw new Error('原生确认取消未关闭或取消后联网')
  }
  // 先等待真实 showMessageBox 已调用且未完成，再取消；不以固定睡眠推测原生弹窗就绪。
  stage = '验证原生确认精确取消'
  const first = pending('native-cancel')
  await arrived(1)
  if (await run(`window.axon.channels.cancel('native-cancel')`) !== true) throw new Error('渠道请求未被精确取消')
  const canceledResult = await first as ChannelNetworkResult
  if (canceledResult.success || canceledResult.code !== 'cancelled') throw new Error('目录请求未返回明确取消结果')
  await canceled(0)
  stage = '验证原生确认页面重载取消'
  const second = pending('native-reload').catch(() => undefined)
  await arrived(2)
  window.webContents.reload()
  await canceled(1)
  await second
  await waitUntil(() => !window.webContents.isLoadingMainFrame())
  await waitUntil(async () => {
    try { return await run(`(async () => (await window.axon.channels.list()).some(channel => channel.id === ${JSON.stringify(result.channelId)}))()`) === true }
    catch { return false }
  })
  if (confirmations.length !== 2) throw new Error('新页面恢复了旧目标确认')
  stage = '验证实际 Chat/Pi 在途流与 Agent 队列'
  await new Promise<void>((resolve, reject) => { generationModel.once('error', reject); generationModel.listen(0, '127.0.0.1', resolve) })
  const generationAddress = generationModel.address()
  if (!generationAddress || typeof generationAddress === 'string') throw new Error('本机模型服务未就绪')
  inFlight = await run(`(async () => {
    const channel = await window.axon.channels.create({ name: '真实模型退出测试', provider: 'custom', apiKey: '',
      baseUrl: ${JSON.stringify(`http://127.0.0.1:${generationAddress.port}/v1`)},
      models: [{ id: 'axon-drain-fixture', name: '本机夹具', enabled: true }] });
    const agent = await window.axon.agent.createSession({ projectId: ${JSON.stringify(result.projectId)}, runtimeId: 'pi',
      channelId: channel.id, modelId: 'axon-drain-fixture', title: '不生成标题' });
    const chat = await window.axon.chat.createConversation({ channelId: channel.id, modelId: 'axon-drain-fixture', title: '不生成标题' });
    window.desktopDrainEvents = [];
    window.axon.agent.onEvent(event => window.desktopDrainEvents.push(event));
    window.axon.chat.onEvent(event => window.desktopDrainEvents.push(event));
    // send 的 Promise 等待整条运行链，先保持它在途，再由事件和实际 TCP 证明已接管。
    void window.axon.chat.send({ conversationId: chat.id, text: '桌面退出 Chat' }).catch(() => undefined);
    void window.axon.agent.send({ sessionId: agent.id, text: '桌面退出 Agent' }).catch(() => undefined);
    return { sessionId: agent.id, conversationId: chat.id };
  })()`) as { sessionId: string; conversationId: string }
  await waitUntil(async () => generations.length === 2 && generationSockets.size === 2 && await run(`
    JSON.stringify(window.desktopDrainEvents).includes('agent 局部内容') && JSON.stringify(window.desktopDrainEvents).includes('chat 局部内容')`) === true)
  if (generations.slice().sort().join(',') !== 'agent,chat') throw new Error('未建立两种实际模型流')
  if (await run(`(async () => (await window.axon.agent.send({ sessionId: ${JSON.stringify(inFlight.sessionId)}, text: '退出时不能执行的队列' })).disposition === 'queued')()`) !== true) throw new Error('未建立真实待执行队列')
  stage = '验证 MCP 在途连接应用退出取消'
  await openMcp()
  await startMcp('/quit')
  stage = '验证原生确认应用退出取消'
  // 保持第三次原生确认在途，由生产 quit 生命周期取消，而非测试主动回答。
  void pending('native-quit').catch(() => undefined)
  await arrived(3)
  // 窗口防抖补丁尚未提交时发起真实退出，检查主入口的 flush 顺序。
  window.unmaximize()
  window.setSize(1200, 760)
  passed = true
  app.quit()
}

app.on('will-quit', () => {
  clearTimeout(timeout)
  try {
    if (!passed) return
    // 请求连接必须逐条结束；连接池可能另建空闲 TCP，不能把空闲连接误算成排队请求。
    if (!inFlight || generationSockets.size !== 0 || closedModelRequests !== 2 || generations.length !== 2) {
      throw new Error(`模型 TCP 未实际关闭或退出后执行了队列：${JSON.stringify({ open: generationSockets.size, closed: closedGenerations, closedModelRequests, generations })}`)
    }
    // will-quit 发生在生产后端 close 之后；直接检查中立文件，不能用消失的页面事件冒充落盘。
    const chat = readFileSync(join(directory, '.axon-dev', 'conversations', inFlight.conversationId + '.jsonl'), 'utf8')
      .trim().split('\n').map((line) => JSON.parse(line) as ChatMessage)
    const agent = readFileSync(join(directory, '.axon-dev', 'agent-sessions', inFlight.sessionId, 'agents', 'main', 'messages.jsonl'), 'utf8')
      .trim().split('\n').map((line) => JSON.parse(line) as SDKMessage)
    const terminals = agent.filter((message) => message.type === 'result')
    if (chat.map((message) => message.status).join(',') !== 'complete,stopped' || !JSON.stringify(chat).includes('chat 局部内容')
      || terminals.length !== 1 || !('terminal_reason' in terminals[0]!) || terminals[0]!.terminal_reason !== 'stopped'
      || !('stopped_by_user' in terminals[0]!) || terminals[0]!.stopped_by_user !== true
      || agent.filter((message) => message.type === 'user').length !== 1 || JSON.stringify(agent).includes('退出时不能执行的队列')) {
      throw new Error('退出终态/Chat 局部文本未保存，或待执行队列误写入历史')
    }
    if (confirmations.length !== 3 || confirmations.some((item) => !item.completed || !item.signal?.aborted) || requests !== 0) {
      console.error('[桌面冒烟] 原生确认退出未完整取消或发生目录请求')
      app.exit(1)
      return
    }
    if (!mcpRequests.some((entry) => entry.path === '/quit' && entry.method === 'tools/list' && entry.closed) || mcpSockets.size !== 0) {
      console.error('[桌面冒烟] MCP 退出没有实际关闭在途 TCP')
      app.exit(1)
      return
    }
    const settings = JSON.parse(readFileSync(join(directory, '.axon-dev', 'settings.json'), 'utf8')) as { mainWindowState?: { width: number; height: number } }
    if (settings.mainWindowState?.width !== 1200 || settings.mainWindowState.height !== 760) {
      console.error('[桌面冒烟] 退出窗口补丁未保存')
      app.exit(1)
      return
    }
    console.log('[桌面冒烟] 真实启动/React/原生安全存储/重载/退出保存通过；实际原生确认取消且目录请求为零；MCP 页面及取消/关闭/重载/退出 TCP 关闭通过；生产 app.quit 同时收束真实 Chat/Pi 流、MCP、原生确认，队列未启动，唯一停止终态和 Chat 局部文本落盘。截图：' + screenshots)
  } catch (error: unknown) {
    console.error('[桌面冒烟] 退出验收失败', error instanceof Error ? error.message : '未知原因')
    app.exit(1)
  } finally {
    for (const socket of generationSockets) socket.destroy()
    generationModel.close()
    model.close()
    for (const socket of mcpSockets) socket.destroy()
    mcp.close()
    dialog.showMessageBox = nativeMessageBox
    rmSync(directory, { recursive: true, force: true })
  }
})

// 动态装载保证原生目录设置先于生产主入口，不修改用户环境或正式数据。
void import('../src/main/index').then(() => app.whenReady()).then(verifyDesktop).catch(async (error: unknown) => {
  clearTimeout(timeout)
  console.error('[桌面冒烟] 验证失败阶段：' + stage, error instanceof Error ? error.message : '未知原因')
  const main = getMainWindow()
  if (main && !main.isDestroyed()) console.error('[桌面冒烟] 页面诊断', await main.webContents.executeJavaScript(`({ buttons: [...document.querySelectorAll('button')].map(item => item.getAttribute('aria-label') || item.title), text: document.body.textContent.slice(0, 600) })`))
  app.once('will-quit', () => app.exit(1))
  for (const window of BrowserWindow.getAllWindows()) window.destroy()
  app.quit()
})
