/** 快捷会话桌面冒烟：用确定性快捷键注册器触发真实 BrowserWindow，并验证同一 Chat 历史。 */
import { app, BrowserWindow, ipcMain, screen } from 'electron'
import { mkdtempSync, writeFileSync } from 'node:fs'
import { createServer } from 'node:http'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { AGENT_IPC_CHANNELS, AGENT_PROJECT_IPC_CHANNELS } from '@axon/shared'
import { registerAttachmentIpcHandlers } from '../src/main/ipc/attachment-ipc-handlers'
import { registerChannelIpcHandlers } from '../src/main/ipc/channel-ipc-handlers'
import { registerChatIpcHandlers } from '../src/main/ipc/chat-ipc-handlers'
import { registerWindowIpcHandlers } from '../src/main/ipc/window-ipc-handlers'
import { ChatIpcController } from '../src/main/lib/chat/chat-ipc-handlers'
import { ChatService } from '../src/main/lib/chat/chat-service'
import { ConversationManager } from '../src/main/lib/chat/conversation-manager'
import { AttachmentService } from '../src/main/lib/chat/attachment-service'
import { ChannelManager } from '../src/main/lib/channel/channel-manager'
import { createChannelCredentialCodec } from '../src/main/lib/channel/channel-credential-codec'
import { QuickChatShortcutService, type ShortcutRegistrar } from '../src/main/lib/desktop/quick-chat-shortcut-service'
import { QuickChatWindowManager } from '../src/main/lib/desktop/quick-chat-window-manager'
import { SETTINGS_IPC_CHANNELS, USER_PROFILE_IPC_CHANNELS } from '../src/types'
import type { AppSettings, QuickChatShortcutBinding } from '../src/types'

class SmokeShortcutRegistrar implements ShortcutRegistrar {
  readonly callbacks = new Map<string, () => void>()

  register(accelerator: string, callback: () => void): boolean {
    if (this.callbacks.has(accelerator)) return false
    this.callbacks.set(accelerator, callback)
    return true
  }

  unregister(accelerator: string): void {
    this.callbacks.delete(accelerator)
  }

  trigger(accelerator: string): void {
    const callback = this.callbacks.get(accelerator)
    if (!callback) throw new Error(`快捷键未注册：${accelerator}`)
    callback()
  }
}

const directory = mkdtempSync(join(tmpdir(), 'axon-quick-chat-smoke-'))
app.setPath('userData', join(directory, 'electron'))
const timeout = setTimeout(() => {
  console.error('快捷会话冒烟验证超时')
  app.exit(1)
}, 60_000)

/** 为快捷浮窗提供稳定的本地 OpenAI Chat SSE，避免真实网络和用户渠道参与验收。 */
function respondWithChatStream(response: import('node:http').ServerResponse): void {
  response.writeHead(200, { 'Content-Type': 'text/event-stream; charset=utf-8' })
  response.write(`data: ${JSON.stringify({
    id: 'quick-chat-smoke',
    object: 'chat.completion.chunk',
    choices: [{ index: 0, delta: { content: '快捷回复已完成' }, finish_reason: null }],
  })}\n\n`)
  response.write(`data: ${JSON.stringify({
    id: 'quick-chat-smoke',
    object: 'chat.completion.chunk',
    choices: [{ index: 0, delta: {}, finish_reason: 'stop' }],
  })}\n\n`)
  response.end('data: [DONE]\n\n')
}

void app.whenReady().then(async () => {
  const server = createServer((request, response) => {
    request.resume()
    request.on('end', () => respondWithChatStream(response))
  })
  await new Promise<void>((done) => server.listen(0, '127.0.0.1', done))
  const address = server.address()
  if (!address || typeof address === 'string') throw new Error('本地模型服务启动失败')

  const channels = new ChannelManager({
    configPath: join(directory, 'channels.json'),
    credentialCodec: createChannelCredentialCodec(),
  })
  const channel = channels.create({
    name: '快捷验收渠道',
    provider: 'custom',
    baseUrl: `http://127.0.0.1:${address.port}/v1`,
    apiKey: 'quick-smoke-key',
    models: [{ id: 'quick-smoke-model', name: '快捷验收模型', enabled: true, source: 'manual' }],
  })
  const conversations = new ConversationManager({
    indexPath: join(directory, 'conversations.json'),
    messagesDir: join(directory, 'conversations'),
  })
  const conversation = conversations.create({
    title: '快捷验收会话',
    channelId: channel.id,
    modelId: 'quick-smoke-model',
  })
  const attachments = new AttachmentService({ attachmentsDir: join(directory, 'attachments') })
  const chat = new ChatService({
    channelManager: channels,
    conversationManager: conversations,
    userAgent: 'Axon/quick-chat-smoke',
  })

  registerChannelIpcHandlers(channels)
  registerAttachmentIpcHandlers(attachments)
  registerChatIpcHandlers(new ChatIpcController({ conversations, chat, attachments }))
  registerWindowIpcHandlers()

  const settings: AppSettings = {
    themeMode: 'light',
    gitAttributionEnabled: true,
    agentSystemPromptTemplates: [],
    agentSkillCatalogIds: [],
    quickChatShortcuts: [],
  }
  ipcMain.handle(SETTINGS_IPC_CHANNELS.GET, () => settings)
  ipcMain.handle(SETTINGS_IPC_CHANNELS.UPDATE, () => settings)
  ipcMain.handle(USER_PROFILE_IPC_CHANNELS.GET, () => ({ userName: '快捷验收用户', avatar: 'A' }))
  // QuickChatWindow 总是挂载 Agent provider；空快照足以验证 Chat，不初始化 runtime 和项目文件系统。
  ipcMain.handle(AGENT_IPC_CHANNELS.LIST_SESSIONS, () => [])
  ipcMain.handle(AGENT_IPC_CHANNELS.LIST_ACTIVE_RUNS, () => [])
  ipcMain.handle(AGENT_PROJECT_IPC_CHANNELS.LIST, () => [])

  const mainWindow = new BrowserWindow({
    width: 1200,
    height: 820,
    show: false,
    webPreferences: {
      preload: resolve('dist/preload.cjs'),
      contextIsolation: true,
      nodeIntegration: false,
      backgroundThrottling: false,
    },
  })
  const windows = new QuickChatWindowManager({ rendererFilePath: resolve('dist/renderer/index.html') })
  const registrar = new SmokeShortcutRegistrar()
  const shortcut = new QuickChatShortcutService(
    registrar,
    (item) => item.sessionType === 'chat' && item.sessionId === conversation.id,
    (item) => windows.show(item, conversation.title),
  )
  const accelerator = 'CommandOrControl+Shift+9'
  const binding: QuickChatShortcutBinding = {
    id: 'quick-smoke-binding',
    accelerator,
    sessionType: 'chat',
    sessionId: conversation.id,
  }
  shortcut.prepare([binding]).commit()

  const wait = (milliseconds: number): Promise<void> => new Promise((done) => setTimeout(done, milliseconds))
  const waitFor = async (check: () => boolean | Promise<boolean>, label: string, waitMs = 8_000): Promise<void> => {
    const started = Date.now()
    while (!(await check())) {
      if (Date.now() - started > waitMs) throw new Error(`等待失败：${label}`)
      await wait(25)
    }
  }
  const run = async (window: BrowserWindow, script: string): Promise<unknown> => window.webContents.executeJavaScript(script)
  const assert = async (window: BrowserWindow, expression: string): Promise<void> => {
    if (!(await run(window, expression))) throw new Error(`快捷会话断言失败：${expression}`)
  }

  // 确定性触发注册回调，但窗口、preload、IPC、React 和模型流都使用真实 Electron 链路。
  registrar.trigger(accelerator)
  let quickWindow: BrowserWindow | undefined
  await waitFor(() => {
    quickWindow = BrowserWindow.getAllWindows().find((item) => item !== mainWindow && item.webContents.getURL().includes('quick=1'))
    return !!quickWindow && !quickWindow.isDestroyed()
  }, '快捷浮窗创建')
  const quick = quickWindow!
  await waitFor(async () => Boolean(await run(quick, "document.querySelector('input[data-quick-composer]')")), '快捷输入框挂载')
  if (quick.getBounds().height !== 104) throw new Error('快捷浮窗初始高度不是紧凑态')
  await assert(quick, "document.body.textContent.includes('快捷验收会话')")
  await assert(quick, "document.querySelector('input[data-quick-composer]').getAttribute('placeholder') === '请输入'")
  await assert(quick, "getComputedStyle(document.querySelector('[data-quick-window-drag]')).getPropertyValue('-webkit-app-region') === 'drag'")
  // 从真实 input 发起阈值手势，验证紧凑胶囊不是只有标题可以拖动。
  const initialBounds = quick.getBounds()
  const workArea = screen.getDisplayMatching(initialBounds).workArea
  const dragDeltaX = initialBounds.x + initialBounds.width + 32 < workArea.x + workArea.width ? 24 : -24
  const inputPoint = await run(quick, `(() => {
    const bounds = document.querySelector('input[data-quick-composer]').getBoundingClientRect();
    return { x: Math.round(bounds.left + bounds.width / 2), y: Math.round(bounds.top + bounds.height / 2) };
  })()`) as { x: number; y: number }
  const pointerEvent = (type: string, clientX: number, screenX: number): string => `(() => {
    const input = document.querySelector('input[data-quick-composer]');
    input.dispatchEvent(new PointerEvent('${type}', { bubbles: true, pointerId: 7, isPrimary: true, button: 0, clientX: ${clientX}, clientY: ${inputPoint.y}, screenX: ${screenX}, screenY: 300 }));
  })()`
  await run(quick, pointerEvent('pointerdown', inputPoint.x, 400))
  await wait(20)
  await run(quick, pointerEvent('pointermove', inputPoint.x + dragDeltaX, 400 + dragDeltaX))
  await wait(20)
  await run(quick, pointerEvent('pointerup', inputPoint.x + dragDeltaX, 400 + dragDeltaX))
  await waitFor(() => quick.getBounds().x === initialBounds.x + dragDeltaX, '紧凑输入框拖动窗口')
  const draggedBounds = quick.getBounds()

  await run(quick, `(() => {
    const input = document.querySelector('input[data-quick-composer]');
    Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value').set.call(input, '来自快捷浮窗');
    input.dispatchEvent(new Event('input', { bubbles: true }));
    input.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true }));
  })()`)
  await waitFor(() => quick.getBounds().height > 300, '发送后自动展开')
  await assert(quick, "getComputedStyle(document.querySelector('[data-quick-window-drag]')).getPropertyValue('-webkit-app-region') === 'drag'")
  if (quick.getBounds().x !== draggedBounds.x) throw new Error('快捷浮窗展开后丢失横向拖拽位置')
  await waitFor(async () => Boolean(await run(quick, "document.body.textContent.includes('快捷回复已完成')")), '浮窗显示模型回复', 10_000)
  const saved = conversations.getMessages(conversation.id)
  if (saved.length !== 2 || saved[0]?.inputOrigin !== 'quick' || saved[1]?.status !== 'complete') {
    throw new Error('快捷消息来源或生成结果未正确持久化')
  }

  // 失焦取消本次唤起；再次触发必须恢复紧凑态并丢弃未发送草稿。
  await run(quick, `(() => {
    const input = document.querySelector('input[data-quick-composer]');
    Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value').set.call(input, '不应保留的草稿');
    input.dispatchEvent(new Event('input', { bubbles: true }));
  })()`)
  quick.emit('blur')
  await waitFor(() => !quick.isVisible(), '失焦隐藏浮窗')
  registrar.trigger(accelerator)
  await waitFor(() => quick.isVisible() && quick.getBounds().height === 104, '再次唤起恢复紧凑态')
  if (quick.getBounds().x !== draggedBounds.x || quick.getBounds().y !== draggedBounds.y) {
    throw new Error('快捷浮窗再次唤起后未保留拖拽位置')
  }
  await waitFor(async () => (await run(quick, "document.querySelector('input[data-quick-composer]').value")) === '', '再次唤起清空草稿')
  const compactCapture = await quick.webContents.capturePage()
  const compactBitmap = compactCapture.toBitmap()
  const compactSize = compactCapture.getSize()
  let bottomAlpha = 0
  for (let x = 0; x < compactSize.width; x += 1) {
    bottomAlpha = Math.max(bottomAlpha, compactBitmap[((compactSize.height - 1) * compactSize.width + x) * 4 + 3] ?? 0)
  }
  if (bottomAlpha > 8) throw new Error(`快捷浮窗底边仍有被裁切的可见内容：alpha=${bottomAlpha}`)
  writeFileSync(join(directory, 'quick-compact.png'), compactCapture.toPNG())

  // 展开态标题栏也可拖动；收起后以用户移动后的横向位置为准。
  await run(quick, "document.querySelector('button[aria-label=\"展开会话上下文\"]').click()")
  await waitFor(() => quick.getBounds().height > 300, '手动展开快捷浮窗')
  const expandedBeforeDrag = quick.getBounds()
  quick.setPosition(expandedBeforeDrag.x + 16, expandedBeforeDrag.y + 16)
  const expandedAfterDrag = quick.getBounds()
  await run(quick, "document.querySelector('button[aria-label=\"收起会话上下文\"]').click()")
  await waitFor(() => quick.getBounds().height === 104, '手动收起快捷浮窗')
  if (quick.getBounds().x !== expandedAfterDrag.x) throw new Error('展开态拖拽位置未传递到紧凑态')

  // 主窗口重新读取同一 JSONL，必须看见快捷入口消息及其来源图标。
  quick.hide()
  await mainWindow.loadFile(resolve('dist/renderer/index.html'))
  await waitFor(async () => Boolean(await run(mainWindow, "[...document.querySelectorAll('button')].some(item => item.textContent.trim() === '快捷验收会话')")), '主窗口会话列表')
  await run(mainWindow, `(() => {
    const button = [...document.querySelectorAll('button')].find(item => item.textContent.trim() === '快捷验收会话');
    if (!button) throw new Error('找不到快捷验收会话');
    button.click();
  })()`)
  await waitFor(async () => Boolean(await run(mainWindow, `(() => {
    const origin = document.querySelector('[aria-label="快捷输入"]');
    return document.body.textContent.includes('快捷回复已完成')
      && !document.body.textContent.includes('正在加载 Chat')
      && origin?.getClientRects().length > 0;
  })()`)), '主窗口恢复并绘制快捷消息')
  await wait(100)
  writeFileSync(join(directory, 'quick-main-history.png'), (await mainWindow.webContents.capturePage()).toPNG())

  console.log(`快捷会话冒烟验证通过：绑定触发、两种状态拖拽定位、发送展开、取消重置、来源标记与主窗口历史共享。截图目录：${directory}`)
  clearTimeout(timeout)
  shortcut.dispose()
  windows.dispose()
  mainWindow.destroy()
  server.closeAllConnections()
  server.close()
  app.exit(0)
}).catch((error: unknown) => {
  console.error(error)
  clearTimeout(timeout)
  app.exit(1)
})
