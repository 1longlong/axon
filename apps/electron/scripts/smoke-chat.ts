/** 独立 Chat 冒烟入口：用本地 SSE 服务验证真实 Electron 全链路，数据只写临时目录。 */
import { app, BrowserWindow, ipcMain } from 'electron'
import { mkdtempSync, writeFileSync, existsSync, readdirSync } from 'node:fs'
import { createServer } from 'node:http'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { registerAttachmentIpcHandlers } from '../src/main/ipc/attachment-ipc-handlers'
import { registerChannelIpcHandlers } from '../src/main/ipc/channel-ipc-handlers'
import { registerChatIpcHandlers } from '../src/main/ipc/chat-ipc-handlers'
import { AttachmentService } from '../src/main/lib/chat/attachment-service'
import { ChannelManager } from '../src/main/lib/channel/channel-manager'
import { createChannelCredentialCodec } from '../src/main/lib/channel/channel-credential-codec'
import { ChatIpcController } from '../src/main/lib/chat/chat-ipc-handlers'
import { ChatService } from '../src/main/lib/chat/chat-service'
import { ConversationManager } from '../src/main/lib/chat/conversation-manager'
import {
  SETTINGS_IPC_CHANNELS,
  USER_PROFILE_IPC_CHANNELS,
  WINDOW_IPC_CHANNELS,
} from '../src/types'
import type { AppSettings } from '../src/types'

interface CapturedProviderRequest {
  url: string
  method: string
  authorization: string
  body: Record<string, unknown>
}

const directory = mkdtempSync(join(tmpdir(), 'axon-chat-smoke-'))
app.setPath('userData', join(directory, 'electron'))
const timeout = setTimeout(() => {
  console.error('Chat 冒烟验证超时')
  app.exit(1)
}, 60000)

/** 给 UI 自动化保留可观察的分片间隔，同时保持供应商 SSE 帧格式真实。 */
function sendCompletedStream(response: import('node:http').ServerResponse): void {
  const chunks = [
    '## 流式回答\n\n',
    '| 项目 | 状态 |\n| --- | --- |\n| Chat | 正常 |\n\n',
    '```ts\nconst value = 42\n```',
  ]
  response.writeHead(200, { 'Content-Type': 'text/event-stream; charset=utf-8' })
  let index = 0
  const sendNext = (): void => {
    if (response.destroyed) return
    if (index < chunks.length) {
      response.write(`data: ${JSON.stringify({
        id: 'chatcmpl-smoke',
        object: 'chat.completion.chunk',
        choices: [{ index: 0, delta: { content: chunks[index] }, finish_reason: null }],
      })}\n\n`)
      index += 1
      setTimeout(sendNext, 70)
      return
    }
    response.write(`data: ${JSON.stringify({
      id: 'chatcmpl-smoke',
      object: 'chat.completion.chunk',
      choices: [{ index: 0, delta: {}, finish_reason: 'stop' }],
    })}\n\n`)
    response.write(`data: ${JSON.stringify({
      id: 'chatcmpl-smoke',
      object: 'chat.completion.chunk',
      choices: [],
      usage: { prompt_tokens: 8, completion_tokens: 16, total_tokens: 24 },
    })}\n\n`)
    response.end('data: [DONE]\n\n')
  }
  setTimeout(sendNext, 140)
}

/** 摘要请求返回独立的多分片 SSE 流，验证自动摘要链路的真实协议编码。 */
function sendSummaryStream(response: import('node:http').ServerResponse): void {
  response.writeHead(200, { 'Content-Type': 'text/event-stream; charset=utf-8' })
  response.write(`data: ${JSON.stringify({
    id: 'chatcmpl-summary',
    object: 'chat.completion.chunk',
    choices: [{ index: 0, delta: { content: '这是旧对话' }, finish_reason: null }],
  })}\n\n`)
  response.write(`data: ${JSON.stringify({
    id: 'chatcmpl-summary',
    object: 'chat.completion.chunk',
    choices: [{ index: 0, delta: { content: '的摘要。' }, finish_reason: null }],
  })}\n\n`)
  response.write(`data: ${JSON.stringify({
    id: 'chatcmpl-summary',
    object: 'chat.completion.chunk',
    choices: [{ index: 0, delta: {}, finish_reason: 'stop' }],
  })}\n\n`)
  response.write(`data: ${JSON.stringify({
    id: 'chatcmpl-summary',
    object: 'chat.completion.chunk',
    choices: [],
    usage: { prompt_tokens: 900, completion_tokens: 10, total_tokens: 910 },
  })}\n\n`)
  response.end('data: [DONE]\n\n')
}

void app.whenReady().then(async () => {
  const captured: CapturedProviderRequest[] = []
  let generationCount = 0
  // 摘要请求由 ChatService 用固定中文指令发起；OpenAI 系线协议把它编码为 messages[0] 的 system 消息。
  const isSummaryRequest = (body: Record<string, unknown>): boolean => {
    const messages = Array.isArray(body.messages) ? body.messages : []
    const first = messages[0] as { role?: string; content?: unknown } | undefined
    return first?.role === 'system' && typeof first.content === 'string' && first.content.startsWith('请把以下对话压缩')
  }
  const server = createServer((request, response) => {
    const bodyChunks: Buffer[] = []
    request.on('data', (chunk: Buffer) => bodyChunks.push(chunk))
    request.on('end', () => {
      const parsed = JSON.parse(Buffer.concat(bodyChunks).toString('utf8')) as Record<string, unknown>
      captured.push({
        url: request.url ?? '',
        method: request.method ?? '',
        authorization: request.headers.authorization ?? '',
        body: parsed,
      })

      if (isSummaryRequest(parsed)) {
        sendSummaryStream(response)
        return
      }

      generationCount += 1
      if (generationCount === 1) {
        sendCompletedStream(response)
        return
      }

      // 第二轮只发送局部正文并保持连接，用于验证 AbortSignal 到 stopped JSONL 的链路。
      response.writeHead(200, { 'Content-Type': 'text/event-stream; charset=utf-8' })
      response.write(`data: ${JSON.stringify({
        id: 'chatcmpl-stop',
        object: 'chat.completion.chunk',
        choices: [{ index: 0, delta: { content: '这是一段会被停止的内容' }, finish_reason: null }],
      })}\n\n`)
    })
  })
  await new Promise<void>((done) => server.listen(0, '127.0.0.1', done))
  const address = server.address()
  if (!address || typeof address === 'string') throw new Error('本地 Chat 服务启动失败')

  const channelManager = new ChannelManager({
    configPath: join(directory, 'channels.json'),
    credentialCodec: createChannelCredentialCodec(),
  })
  const baseUrl = `http://127.0.0.1:${address.port}/v1`
  const channel = channelManager.create({
    name: '本地冒烟渠道',
    provider: 'custom',
    baseUrl,
    apiKey: 'synthetic-chat-key',
    models: [{ id: 'smoke-model', name: '冒烟模型', enabled: true, source: 'manual' }],
  })
  const conversationManager = new ConversationManager({
    indexPath: join(directory, 'conversations.json'),
    messagesDir: join(directory, 'messages'),
  })
  // 预置一个达到自动摘要阈值的大型会话：前 4 条各 2 万字符，供摘要请求压缩。
  const conversation = conversationManager.create({
    channelId: channel.id,
    modelId: 'smoke-model',
    title: '预置摘要会话',
  })
  for (let index = 1; index <= 12; index += 1) {
    conversationManager.appendMessage(conversation.id, {
      id: `seed-${index}`,
      role: index % 2 === 1 ? 'user' : 'assistant',
      content: [{ type: 'text', text: index <= 4 ? `旧对话第${index}条：${'甲'.repeat(20_000)}` : `普通消息${index}` }],
      createdAt: index,
      status: 'complete',
    })
  }
  const chatService = new ChatService({
    channelManager,
    conversationManager,
    userAgent: 'Axon/0.1.0-smoke',
    readAttachmentData: (localPath) => {
      try {
        return attachmentService.readAsBase64(localPath)
      } catch {
        return undefined
      }
    },
    // 冒烟用等价的文本直读替代完整解析器（PDF/DOCX 为 external 依赖，不在冒烟 bundle 内）。
    extractDocumentText: async (attachment) => {
      try {
        const data = attachmentService.readAsBase64(attachment.localPath)
        return Buffer.from(data, 'base64').toString('utf8')
      } catch {
        return undefined
      }
    },
  })
  const attachmentService = new AttachmentService({ attachmentsDir: join(directory, 'attachments') })
  registerChannelIpcHandlers(channelManager)
  registerAttachmentIpcHandlers(attachmentService)
  registerChatIpcHandlers(new ChatIpcController({ conversations: conversationManager, chat: chatService, attachments: attachmentService }))

  let settings: AppSettings = { themeMode: 'light' }
  ipcMain.handle(SETTINGS_IPC_CHANNELS.GET, () => settings)
  ipcMain.handle(SETTINGS_IPC_CHANNELS.UPDATE, (_event, updates: unknown) => {
    if (updates && typeof updates === 'object' && !Array.isArray(updates)) {
      settings = { ...settings, ...(updates as Partial<AppSettings>) }
    }
    return settings
  })
  ipcMain.handle(USER_PROFILE_IPC_CHANNELS.GET, () => ({ userName: '测试用户', avatar: '🧪' }))
  ipcMain.handle(WINDOW_IPC_CHANNELS.IS_MAXIMIZED, () => false)

  const win = new BrowserWindow({
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
  const run = async (script: string): Promise<unknown> => {
    try {
      return await win.webContents.executeJavaScript(script)
    } catch (error) {
      const detail = error instanceof Error ? error.message : '未知错误'
      throw new Error(`页面脚本执行失败：${script.slice(0, 120)}；${detail}`)
    }
  }
  const waitFor = async (expression: string, waitMs = 6000): Promise<void> => {
    const started = Date.now()
    while (!(await run(expression))) {
      if (Date.now() - started > waitMs) throw new Error(`等待界面失败：${expression}`)
      await new Promise((done) => setTimeout(done, 25))
    }
  }
  const assert = async (expression: string): Promise<void> => {
    if (!(await run(expression))) throw new Error(`Chat 冒烟断言失败：${expression}`)
  }
  const clickText = (text: string): Promise<unknown> => run(`(() => {
    const button = [...document.querySelectorAll('button')].find(item => item.textContent.trim() === ${JSON.stringify(text)});
    if (!button || button.disabled) throw new Error('按钮不可用：${text}'); button.click();
  })()`)
  const clickAria = (label: string): Promise<unknown> => run(`(() => {
    const button = document.querySelector('button[aria-label=${JSON.stringify(label)}]');
    if (!button || button.disabled) throw new Error('按钮不可用：${label}'); button.click();
  })()`)
  const fillInput = (selector: string, value: string): Promise<unknown> => run(`(() => {
    const input = document.querySelector(${JSON.stringify(selector)});
    if (!input) throw new Error('找不到输入框');
    Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value').set.call(input, ${JSON.stringify(value)});
    input.dispatchEvent(new Event('input', { bubbles: true }));
  })()`)
  const typeEditor = (value: string): Promise<unknown> => run(`(() => {
    const editor = document.querySelector('.ProseMirror[contenteditable=true]');
    if (!editor) throw new Error('富文本编辑器不可用');
    editor.focus();
    if (!document.execCommand('insertText', false, ${JSON.stringify(value)})) throw new Error('输入失败');
  })()`)

  // 真实页面打开预置的大型会话并修改元数据，再从 TipTap 发起第一轮生成。
  await win.loadFile(resolve('dist/renderer/index.html'))
  await waitFor("[...document.querySelectorAll('button')].some(item => item.textContent.trim() === '新建对话' && !item.disabled)")
  await assert("!document.querySelector('[role=\"tablist\"]')")
  await waitFor("[...document.querySelectorAll('button')].some(item => item.textContent.trim() === '预置摘要会话')")
  await clickText('预置摘要会话')
  await waitFor("!!document.querySelector('.ProseMirror[contenteditable=true]')")
  await assert("document.querySelector('[aria-label=\"选择渠道和模型\"]').value !== ''")
  await assert("!document.querySelector('header [aria-label=\"选择渠道和模型\"]')")
  await assert("document.querySelector('[aria-label=\"选择渠道和模型\"]').getBoundingClientRect().top >= document.querySelector('.ProseMirror').getBoundingClientRect().bottom")
  await assert("!document.body.textContent.includes('Shift + Enter')")
  await clickAria('编辑标题')
  await fillInput('header input', '冒烟对话')
  await clickAria('保存标题')
  await waitFor("document.body.textContent.includes('冒烟对话')")
  // 用 DataTransfer 向隐藏文件输入注入合成图片与文本，验证附件草稿 → 落盘 → 元数据 → 图片块 + file 块进请求。
  await run(`(() => {
    const png = Uint8Array.from(atob('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg=='), c => c.charCodeAt(0));
    const transfer = new DataTransfer();
    transfer.items.add(new File([png], '冒烟图片.png', { type: 'image/png' }));
    transfer.items.add(new File(['冒烟说明的正文内容'], '冒烟说明.txt', { type: 'text/plain' }));
    const input = document.querySelector('input[type=file]');
    if (!input) throw new Error('找不到附件输入');
    input.files = transfer.files;
    input.dispatchEvent(new Event('change', { bubbles: true }));
  })()`)
  await waitFor("!!document.querySelector('button[aria-label=\"移除附件 冒烟图片.png\"]')")
  await waitFor("!!document.querySelector('button[aria-label=\"移除附件 冒烟说明.txt\"]')")
  // 图片附件在草稿中直接用 data URL 缩略图。
  await assert("!!document.querySelector('img[alt=\"冒烟图片.png\"]')")
  await typeEditor('第一轮请求')
  await waitFor("!document.querySelector('button[aria-label=\"发送消息\"]').disabled")
  await clickAria('发送消息')
  await waitFor("document.body.textContent.includes('正在连接模型')")
  await assert("document.querySelector('.ProseMirror').getAttribute('contenteditable') === 'false'")
  await assert("document.querySelector('.ProseMirror').textContent === ''")
  await waitFor("document.body.textContent.includes('const value = 42') && !document.body.textContent.includes('生成中')", 10000)
  await assert("document.querySelector('.ProseMirror').textContent === ''")
  await assert("!!document.querySelector('table') && !!document.querySelector('pre code')")

  // 摘要请求与生成请求按 systemPrompt 特征分流；用函数现算，保证第二轮取到新捕获的请求。
  const summaryRequests = (): CapturedProviderRequest[] => captured.filter((item) => isSummaryRequest(item.body))
  const generationRequests = (): CapturedProviderRequest[] => captured.filter((item) => !isSummaryRequest(item.body))
  const summary = summaryRequests()[0]
  if (!summary || summary.url !== '/v1/chat/completions' || summary.method !== 'POST') {
    throw new Error('自动摘要请求未按预期发起')
  }
  if (summary.authorization !== 'Bearer synthetic-chat-key') throw new Error('摘要请求鉴权头不正确')
  const summaryMessages = summary.body.messages
  if (!Array.isArray(summaryMessages) || summaryMessages.length !== 2) {
    throw new Error('摘要请求历史编码不正确')
  }
  const summaryContent = (summaryMessages[1] as { content?: unknown }).content
  if (
    typeof summaryContent !== 'string'
    || summaryContent.length < 80_000
    || !summaryContent.includes('旧对话第4条：')
    || summaryContent.includes('普通消息5')
    || summaryContent.includes('第一轮请求')
  ) {
    throw new Error('摘要请求未正确压缩候选旧消息')
  }

  const first = generationRequests()[0]
  if (!first || first.url !== '/v1/chat/completions' || first.method !== 'POST') {
    throw new Error('Provider 生成端点或方法不正确')
  }
  if (first.authorization !== 'Bearer synthetic-chat-key') throw new Error('Provider 鉴权头不正确')
  const firstMessages = first.body.messages
  if (!Array.isArray(firstMessages) || firstMessages.length !== 10) throw new Error('第一轮历史编码不正确')
  const firstSystem = firstMessages[0] as { role?: string; content?: unknown }
  if (firstSystem.role !== 'system' || firstSystem.content !== '以下是更早对话的摘要：\n这是旧对话的摘要。') {
    throw new Error(`摘要未合并进生成请求：${String(firstSystem.content)}`)
  }
  const firstHistory = JSON.stringify(firstMessages)
  if (firstHistory.includes('旧对话第')) throw new Error('被摘要覆盖的旧消息仍进入生成请求')
  if ((firstMessages[1] as { content?: unknown }).content !== '普通消息5') {
    throw new Error('第一轮历史起点不正确')
  }
  const firstUser = firstMessages.at(-1) as Record<string, unknown>
  if (firstUser.role !== 'user' || !Array.isArray(firstUser.content)) {
    throw new Error('输入文本或图片部件未正确进入请求')
  }
  const userParts = firstUser.content as Array<Record<string, unknown>>
  if (userParts[0]?.type !== 'text' || userParts[0]?.text !== '第一轮请求') {
    throw new Error(`输入文本未正确进入请求：${String(userParts[0]?.text)}`)
  }
  const imagePart = userParts[1] as { type?: string; image_url?: { url?: string } }
  if (imagePart?.type !== 'image_url' || !imagePart.image_url?.url?.startsWith('data:image/png;base64,')) {
    throw new Error('图片附件未编码为 OpenAI data URL 部件')
  }
  const filePart = userParts[2] as { type?: string; text?: string }
  if (filePart?.type !== 'text' || filePart.text !== '<file name="冒烟说明.txt">\n冒烟说明的正文内容\n</file>') {
    throw new Error(`文本附件未以 file 块注入：${String(filePart?.text)}`)
  }

  // 剪贴板在测试窗口内替换为记录器，避免修改用户系统剪贴板。
  await run(`Object.defineProperty(navigator, 'clipboard', { configurable: true, value: {
    writeText: async value => { window.__axonCopiedText = value }
  } })`)
  await run("document.querySelector('pre').parentElement.querySelector('button').click()")
  await waitFor("window.__axonCopiedText === 'const value = 42'")
  await run("[...document.querySelectorAll('button[aria-label=\"复制消息\"]')].at(-1).click()")
  await waitFor("window.__axonCopiedText.includes('流式回答') && window.__axonCopiedText.includes('const value = 42')")
  // 用户消息的复制文本应列出附件名与大小；种子会话中它在助手回复之前（倒数第二个）。
  await run("[...document.querySelectorAll('button[aria-label=\"复制消息\"]')].at(-2).click()")
  await waitFor("window.__axonCopiedText.includes('第一轮请求') && window.__axonCopiedText.includes('附件：冒烟图片.png') && window.__axonCopiedText.includes('附件：冒烟说明.txt')")
  writeFileSync(join(directory, 'chat-complete.png'), (await win.webContents.capturePage()).toPNG())

  const savedConversation = conversationManager.list()[0]
  if (!savedConversation || savedConversation.channelId !== channel.id || savedConversation.title !== '冒烟对话') {
    throw new Error('会话元数据未正确落盘')
  }
  if (savedConversation.contextSummary?.coveredMessageIds.join(',') !== 'seed-1,seed-2,seed-3,seed-4') {
    throw new Error('摘要元数据未正确落盘')
  }
  const completedMessages = conversationManager.getMessages(savedConversation.id)
  if (completedMessages.length !== 14 || completedMessages[13]?.status !== 'complete') {
    throw new Error('第一轮完整消息未正确落盘')
  }
  if (completedMessages[13]?.usage?.totalTokens !== 24) throw new Error('Provider 用量未正确落盘')
  // 附件元数据随用户消息落盘，二进制进入会话附件目录，UI 展示附件芯片。
  // 用户消息位于 12 条种子消息之后、助手回复之前（倒数第二）。
  const userAttachments = completedMessages.at(-2)?.attachments
  if (!userAttachments || userAttachments.length !== 2 || userAttachments[0]?.filename !== '冒烟图片.png' || userAttachments[1]?.filename !== '冒烟说明.txt') {
    throw new Error('附件元数据未随用户消息落盘')
  }
  const conversationAttachmentDir = join(directory, 'attachments', conversation.id)
  const attachmentFiles = existsSync(conversationAttachmentDir) ? readdirSync(conversationAttachmentDir) : []
  if (attachmentFiles.length !== 2) {
    throw new Error('附件二进制未按会话目录落盘')
  }
  await assert("!!document.querySelector('span[title=\"冒烟图片.png\"]')")
  // 摘要请求不产生用户可见消息，摘要文本也不允许进入消息 JSONL。
  if (JSON.stringify(completedMessages).includes('这是旧对话的摘要。')) {
    throw new Error('摘要文本污染了消息历史')
  }

  // 重载 renderer 后只依赖 settings + JSONL 恢复，再发第二轮并主动停止。
  await new Promise((done) => setTimeout(done, 260))
  win.webContents.reload()
  await waitFor("document.body.textContent.includes('流式回答') && !!document.querySelector('.ProseMirror[contenteditable=true]')", 10000)
  await typeEditor('第二轮停止请求')
  await clickAria('发送消息')
  await waitFor("document.body.textContent.includes('这是一段会被停止的内容') && [...document.querySelectorAll('button')].some(item => item.textContent.trim() === '停止')")
  await clickText('停止')
  await waitFor("document.body.textContent.includes('生成已停止') && !document.body.textContent.includes('生成中') && ![...document.querySelectorAll('button')].some(item => item.textContent.trim() === '停止') && !!document.querySelector('.ProseMirror[contenteditable=true]')", 10000)
  await assert("document.querySelector('.ProseMirror').textContent === ''")
  await new Promise((done) => setTimeout(done, 100))
  writeFileSync(join(directory, 'chat-stopped.png'), (await win.webContents.capturePage()).toPNG())

  const second = generationRequests()[1]
  const secondMessages = second?.body.messages
  if (!second || !Array.isArray(secondMessages) || secondMessages.length !== 12) {
    throw new Error('第二轮多轮历史编码不正确')
  }
  const secondSystem = secondMessages[0] as { role?: string; content?: unknown }
  if (secondSystem.role !== 'system' || secondSystem.content !== '以下是更早对话的摘要：\n这是旧对话的摘要。') {
    throw new Error('第二轮未继续使用已有摘要')
  }
  const roles = secondMessages.slice(1).map((item) => (item as Record<string, unknown>).role).join(',')
  if (roles !== 'user,assistant,user,assistant,user,assistant,user,assistant,user,assistant,user') {
    throw new Error(`第二轮角色顺序不正确：${roles}`)
  }
  const persisted = conversationManager.getMessages(savedConversation.id)
  if (persisted.length !== 16 || persisted[15]?.status !== 'stopped') {
    throw new Error('停止后的助手终态未正确写入 JSONL')
  }

  console.log(`Chat 冒烟验证通过：纯文本输入、真实 IPC/Provider SSE、自动摘要压缩、多轮历史、GFM/Shiki、复制、停止与重载恢复。截图目录：${directory}`)
  clearTimeout(timeout)
  win.destroy()
  server.closeAllConnections()
  server.close()
  app.exit(0)
}).catch((error: unknown) => {
  console.error(error)
  clearTimeout(timeout)
  app.exit(1)
})
