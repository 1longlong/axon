/** 附件源码桌面验收：生产 Pi/独立后端与真实工具，本机 SSE 只固定模型决策。 */
import { app, BrowserWindow } from 'electron'
import { createServer } from 'node:http'
import type { ServerResponse } from 'node:http'
import { mkdirSync, mkdtempSync, realpathSync, unlinkSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import sharp from 'sharp'
import type { AgentSessionMeta, AgentSendResult, SDKMessage, SDKUserMessage } from '@axon/shared'
import { pdfFixture, docxFixture } from '../../../packages/core/test-support/document-fixtures'
import { startDesktopSmokeBackend } from '../test-support/desktop-smoke-backend'
import type { DesktopSmokeBackend } from '../test-support/desktop-smoke-backend'
import { QuickChatWindowManager } from '../src/main/lib/desktop/quick-chat-window-manager'
import { isQuickChatWindowOwner } from '../src/main/lib/desktop/quick-chat-window-owner'

interface ModelMessage { role: string; content: unknown; tool_calls?: unknown[] }
interface ModelRequest { messages: ModelMessage[]; tools?: Array<{ function: { name: string } }> }
const directory = realpathSync(mkdtempSync(join(tmpdir(), 'axon-attachments-desktop-')))
app.setPath('userData', join(directory, 'electron'))
app.on('window-all-closed', () => {})
let backend: DesktopSmokeBackend | undefined, main: BrowserWindow | undefined, windows: QuickChatWindowManager | undefined
let server: ReturnType<typeof createServer> | undefined, closing: Promise<void> | undefined
let step = '初始化', imageRequests = 0, documentExecuted = false, selectedBodyReceived = false
let orderedSkillReceived = false
let pendingPicker: (() => void) | undefined
let heldResponse: ServerResponse | undefined, heldOnce = false, fallbackImageSeen = false
const requests: ModelRequest[] = []
const deadline = setTimeout(() => void finish(1, new Error(`附件验收超时：${step}`)), 120_000)

/** 只回收本脚本的窗口/连接，证据目录保留；实际后端退出后才终止桌面父进程。 */
function finish(code: number, error?: unknown): Promise<void> {
  return closing ??= (async () => {
    clearTimeout(deadline)
    if (error) {
      console.error('附件验收失败', step, error, directory)
      if (main && !main.isDestroyed()) console.error(await main.webContents.executeJavaScript('document.body.textContent.slice(-1800)').catch(() => '页面不可读'))
      for (const window of BrowserWindow.getAllWindows().filter((item) => item !== main)) {
        console.error('浮窗诊断', window.isVisible(), await window.webContents.executeJavaScript("({text:document.body.textContent.slice(-1500),editor:document.querySelector('[data-quick-composer]')?.outerHTML})").catch(() => '页面不可读'))
      }
    }
    pendingPicker?.(); windows?.dispose(); main?.destroy()
    try { await backend?.close() } catch (cleanupError) { console.error(cleanupError); code = 1 }
    server?.closeAllConnections(); server?.close(); app.exit(code)
  })()
}
process.on('uncaughtException', (error) => void finish(1, error))
process.on('unhandledRejection', (error: unknown) => void finish(1, error))
function assert(value: unknown, message: string): asserts value { if (!value) throw new Error(message) }
function isHuman(message: SDKMessage): message is SDKUserMessage {
  const user = message.type === 'user' ? message as SDKUserMessage : undefined
  return Boolean(user?.message?.content?.some((block) => block.type !== 'tool_result'))
}
async function wait(check: () => unknown | Promise<unknown>, label: string, limit = 15_000): Promise<void> {
  const start = Date.now()
  while (!await check()) {
    if (Date.now() - start > limit) throw new Error(`等待失败：${label}`)
    await new Promise<void>((done) => setTimeout(done, 30))
  }
}
/** 截图只是诊断证据；原生抓图无回应不能阻塞后端退出验收。 */
async function capture(window: BrowserWindow, name: string): Promise<void> {
  let timeout: ReturnType<typeof setTimeout> | undefined
  try {
    const image = await Promise.race([window.webContents.capturePage(), new Promise<never>((_done, reject) => {
      timeout = setTimeout(() => reject(new Error('截图未返回')), 2_000)
    })])
    writeFileSync(join(directory, name), image.toPNG())
  } catch { console.warn('附件验收截图不可用', name) }
  finally { clearTimeout(timeout) }
}
function respond(response: ServerResponse, delta: object, reason = 'stop', inputTokens = 400): void {
  response.writeHead(200, { 'Content-Type': 'text/event-stream' })
  for (const packet of [{ choices: [{ index: 0, delta, finish_reason: null }] },
    { choices: [{ index: 0, delta: {}, finish_reason: reason }], usage: { prompt_tokens: inputTokens, completion_tokens: 30, total_tokens: inputTokens + 30 } }]) {
    response.write(`data: ${JSON.stringify({ id: 'axon-attachment-fixture', model: 'attachment-fixture', ...packet })}\n\n`)
  }
  response.end('data: [DONE]\n\n')
}

void app.whenReady().then(async () => {
  writeFileSync(join(directory, 'fixture.pdf'), pdfFixture())
  writeFileSync(join(directory, 'fixture.docx'), docxFixture())
  mkdirSync(join(directory, 'fixture-folder'))
  const png = await sharp({ create: { width: 320, height: 160, channels: 4, background: '#4070c080' } }).png().toBuffer()
  mkdirSync(join(directory, '.axon/skills/review-smoke'), { recursive: true })
  writeFileSync(join(directory, '.axon/skills/review-smoke/SKILL.md'), '---\nname: review-smoke\ndescription: 附件验收用指引\n---\nAXON_EXPLICIT_SKILL_BODY\n')
  server = createServer((request, response) => {
    const chunks: Buffer[] = []
    request.on('data', (chunk: Buffer) => chunks.push(chunk))
    request.on('end', () => {
      try {
        const payload = JSON.parse(Buffer.concat(chunks).toString()) as ModelRequest
        requests.push(payload)
        if (!payload.tools?.length) { respond(response, { content: '附件验收会话' }); return }
        const lastUser = payload.messages.findLastIndex((message) => message.role === 'user')
        const user = JSON.stringify(payload.messages[lastUser]?.content)
        if (user.includes('AXON_EXPLICIT_SKILL_BODY')) selectedBodyReceived = true
        const body = payload.messages[lastUser]?.content
        const text = typeof body === 'string' ? body : Array.isArray(body)
          ? (body as Array<{ type?: string; text?: string }>).filter((item) => item.type === 'text').map((item) => item.text ?? '').join('') : ''
        if (text.startsWith('前文 【Skill ') && text.includes('"name":"review-smoke"}】 后文')) orderedSkillReceived = true
        const imageBlocks = payload.messages.slice(lastUser).flatMap((message) => Array.isArray(message.content) ? message.content as Array<{ type?: string; image_url?: { url?: string } }> : [])
          .filter((item) => item.type === 'image_url' && item.image_url?.url?.startsWith('data:image/'))
        if (imageBlocks.length) imageRequests += 1
        if (user.includes('FALLBACK_SMOKE')) fallbackImageSeen = JSON.stringify(payload.messages).includes('data:image/')
        if (user.includes('HOLD_SMOKE') && !heldOnce) {
          heldOnce = true; heldResponse = response
          response.writeHead(200, { 'Content-Type': 'text/event-stream' })
          response.write(`data: ${JSON.stringify({ id: 'axon-held', choices: [{ index: 0, delta: { content: '暂停前可见部分' }, finish_reason: null }] })}\n\n`)
          response.once('close', () => { heldResponse = undefined })
          return
        }
        if (user.includes('COMPACT_SMOKE')) {
          // 自有长回复及阈值用量仅用于触发真实 SDK 压缩，不调用或替换私有方法。
          respond(response, { content: '压缩验收正文0123456789 '.repeat(12_000) }, 'stop', 198_000)
          return
        }
        if (user.includes('DOCS_SMOKE')) {
          const results = payload.messages.slice(lastUser + 1).filter((message) => message.role === 'tool')
          if (!results.length) {
            const tool = payload.tools.find((item) => item.function.name.toLowerCase() === 'bash')
            assert(tool, 'Pi 请求缺少 Bash 定义')
            respond(response, { tool_calls: [{ index: 0, id: 'docs-call', type: 'function', function: { name: tool.function.name,
              arguments: JSON.stringify({ command: 'axon-doc extract --input fixture.pdf && axon-doc extract --input fixture.docx', workdir: directory }) } }] }, 'tool_calls')
            return
          }
          const output = JSON.stringify(results)
          documentExecuted = output.includes('Axon first page') && output.includes('Axon 正文') && output.includes('末尾段落')
          respond(response, { content: documentExecuted ? 'DOCS_OK' : `DOCS_FAILED ${output.slice(0, 2000)}` }); return
        }
        respond(response, { content: 'ATTACHMENTS_OK' })
      } catch (error) { response.destroy(); void finish(1, error) }
    })
  })
  await new Promise<void>((done) => server!.listen(0, '127.0.0.1', done))
  const address = server.address(); assert(address && typeof address !== 'string', '本机模型未启动')
  main = new BrowserWindow({ width: 1280, height: 850, show: true, webPreferences: {
    preload: resolve('dist/preload.cjs'), contextIsolation: true, nodeIntegration: false, backgroundThrottling: false,
  } })
  const page = main
  windows = new QuickChatWindowManager({ rendererFilePath: resolve('dist/renderer/index.html') })
  backend = await startDesktopSmokeBackend({ directory, mainWindow: page, quickWindowKind: (sender) => isQuickChatWindowOwner(sender.id),
    // 仅选择结果为夹具；生产 picker 调用的持有/失焦/原页面校验链仍由 main 执行。
    pickAttachments: async (sender) => {
      const window = BrowserWindow.fromWebContents(sender)
      window?.emit('blur')
      await new Promise<void>((done) => { pendingPicker = done })
      pendingPicker = undefined
      return [join(directory, 'fixture.pdf'), join(directory, 'fixture.docx'), join(directory, 'fixture-folder')]
    } })
  await page.loadFile(resolve('dist/renderer/index.html'))
  const run = (script: string): Promise<unknown> => page.webContents.executeJavaScript(script)
  const session = await run(`(async () => {
    const channel = await window.axon.channels.create({ name: '附件验收渠道', provider: 'custom', baseUrl: ${JSON.stringify(`http://127.0.0.1:${address.port}/v1`)}, apiKey: 'fixture-key', models: [{id:'attachment-fixture', name:'附件验收模型', enabled:true, source:'manual'}] });
    const project = await window.axon.agentProjects.create({name:'附件验收项目', workspace:{kind:'local',path:${JSON.stringify(directory)}}});
    return window.axon.agent.createSession({projectId:project.id, title:'附件验收', channelId:channel.id, modelId:'attachment-fixture'});
  })()`) as AgentSessionMeta
  const history = async (): Promise<SDKMessage[]> => await run(`window.axon.agent.getMessages(${JSON.stringify(session.id)})`) as SDKMessage[]
  const click = async (win: BrowserWindow, selector: string): Promise<void> => {
    await wait(() => win.webContents.executeJavaScript(`!!document.querySelector(${JSON.stringify(selector)})`), selector)
    await win.webContents.executeJavaScript(`document.querySelector(${JSON.stringify(selector)}).click()`)
  }
  const key = (win: BrowserWindow, selector: string, name: string, extra: Record<string, boolean> = {}): Promise<unknown> =>
    win.webContents.executeJavaScript(`document.querySelector(${JSON.stringify(selector)}).dispatchEvent(new KeyboardEvent('keydown',{key:${JSON.stringify(name)},bubbles:true,cancelable:true,...${JSON.stringify(extra)}}))`)
  /** 通过编辑器真实快捷键替换内容；不从页面暴露编辑器或绕过组件内部状态。 */
  const type = (win: BrowserWindow, text: string): Promise<unknown> => win.webContents.executeJavaScript(`(() => {
    const editor=document.querySelector('.agent-composer-editor');editor.focus();
    editor.dispatchEvent(new KeyboardEvent('keydown',{key:'a',metaKey:true,bubbles:true,cancelable:true}));
    editor.dispatchEvent(new KeyboardEvent('keydown',{key:'Backspace',bubbles:true,cancelable:true}));
    ${text ? `document.execCommand('insertText',false,${JSON.stringify(text)})` : ''}
  })()`)
  await page.reload()
  /** 核对真实可见性和容器边界，不能把 DOM 存在但被遮住的候选算作通过。 */
  const checkSlashMenu = async (win: BrowserWindow): Promise<void> => {
    await wait(() => win.webContents.executeJavaScript(`(() => {
      const list=document.querySelector('[aria-label="本地命令"]');
      const surface=document.querySelector('[data-agent-composer-surface]');
      const option=list?.querySelector('[role=option]');
      if(!list||!surface||!option)return false;
      const menu=list.getBoundingClientRect(),input=surface.getBoundingClientRect(),row=option.getBoundingClientRect();
      const hit=document.elementFromPoint(row.left+10,row.top+10);
      return menu.height>0&&menu.top>=0&&menu.bottom<=input.top-6&&Math.abs(menu.width-input.width)<2&&option.contains(hit);
    })()`), '候选实际可见、位于整个输入框上方且等宽')
  }
  await click(page, '[aria-label="Agent 模块"]')
  await wait(() => run("[...document.querySelectorAll('button')].some(b=>b.textContent.trim()==='附件验收')"), '会话侧栏')
  await run("[...document.querySelectorAll('button')].find(b=>b.textContent.trim()==='附件验收').click()")
  await wait(() => run("!!document.querySelector('.ProseMirror')"), '主输入')
  assert(await run("!!document.querySelector('[aria-label=\"添加附件\"]') && !document.querySelector('[aria-label=\"添加附件目录\"]')"), '主窗附件入口没有合并')

  step = '主窗本地命令、IME、未知输入与键盘 Skill 选择'
  const beforeCommands = requests.length
  await type(page, '')
  await page.webContents.insertText('/')
  await wait(() => run("!!document.querySelector('[aria-label=\"本地命令\"]')"), '斜杠菜单')
  await wait(() => run("document.querySelector('[aria-label=\"本地命令\"]').textContent.includes('review-smoke')"), '斜杠直接展示 Skill')
  await checkSlashMenu(page)
  await capture(page, 'slash-main.png')
  const firstCommand = await run("document.querySelector('.agent-composer-editor').getAttribute('aria-activedescendant')")
  await key(page, '.agent-composer-editor', 'ArrowDown')
  assert(await run("document.querySelector('.agent-composer-editor').getAttribute('aria-activedescendant')") !== firstCommand, '方向键未切换命令候选')
  await key(page, '.agent-composer-editor', 'Escape')
  await wait(() => run("!document.querySelector('[aria-label=\"本地命令\"]')"), 'Esc 只关命令菜单')
  await type(page, '/re')
  await wait(() => run("document.querySelectorAll('[aria-label=\"本地命令\"] [role=option]').length===1 && document.querySelector('[aria-label=\"本地命令\"]').textContent.includes('review-smoke')"), '输入前缀动态过滤 Skill')
  await page.webContents.insertText('view')
  await wait(() => run("document.querySelector('.agent-composer-editor').textContent==='/review'"), '逐字输入继续过滤')
  await click(page, '[aria-label="本地命令"] [role=option]')
  await wait(() => run("!!document.querySelector('[data-agent-inline-skill]') && !document.querySelector('[data-agent-context-dialog]')"), '点击 Skill 直接插入胶囊而非打开弹窗')
  assert(await run("!document.querySelector('.agent-composer-editor').textContent.includes('/review')"), '直接选择未移除命令前缀')
  await type(page, '/skills')
  await key(page, '.agent-composer-editor', 'Enter', { isComposing: true })
  assert(await run("!document.querySelector('[data-agent-context-dialog]')"), 'IME 确认误执行命令')
  // 粘贴仅更新草稿，不自动执行；正文跟在命令后，点击发送也只分发本地动作。
  await type(page, '')
  await run("(() => {const data=new DataTransfer();data.setData('text/plain','/skills\\n保留正文');document.querySelector('.agent-composer-editor').dispatchEvent(new ClipboardEvent('paste',{bubbles:true,cancelable:true,clipboardData:data}))})()")
  assert(await run("!document.querySelector('[data-agent-context-dialog]')"), '粘贴自动执行了命令')
  await click(page, '[aria-label="发送消息"]')
  await wait(() => run("!!document.querySelector('[aria-label=\"搜索 Skills\"]')"), '发送按钮分发本地命令')
  await wait(() => run("document.querySelectorAll('[aria-label=\"可用 Skills\"] [role=option]').length>=2"), 'Skill 键盘列表')
  const firstActive = await run("document.querySelector('[aria-label=\"搜索 Skills\"]').getAttribute('aria-activedescendant')")
  await key(page, '[aria-label="搜索 Skills"]', 'ArrowDown')
  await wait(async () => await run("document.querySelector('[aria-label=\"搜索 Skills\"]').getAttribute('aria-activedescendant')") !== firstActive, 'Skill 下移')
  await run("(() => {const input=document.querySelector('[aria-label=\"搜索 Skills\"]');Object.getOwnPropertyDescriptor(HTMLInputElement.prototype,'value').set.call(input,'review-smoke');input.dispatchEvent(new Event('input',{bubbles:true}))})()")
  await key(page, '[aria-label="搜索 Skills"]', 'Enter')
  await wait(() => run("!document.querySelector('[data-agent-context-dialog]') && !!document.querySelector('[data-agent-inline-skill]')"), '键盘选择进入行内')
  assert(await run("document.querySelector('.agent-composer-editor').textContent.includes('保留正文') && !document.querySelector('.agent-composer-editor').textContent.includes('/skills')"), '命令删除损坏了原正文')
  await type(page, '/unknown')
  await key(page, '.agent-composer-editor', 'Enter')
  await wait(() => run("document.body.textContent.includes('未知本地命令 /unknown')"), '未知命令提示')
  assert(await run("document.querySelector('.agent-composer-editor').textContent==='/unknown'"), '未知命令丢失草稿')
  await type(page, '/sk')
  await wait(() => run("!!document.querySelector('[aria-label=\"本地命令\"]')"), '前缀补全')
  await key(page, '.agent-composer-editor', 'Tab')
  await wait(() => run("!!document.querySelector('[data-agent-context-dialog]')"), 'Tab 打开选择器')
  await key(page, '[aria-label="搜索 Skills"]', 'Escape')
  await wait(() => run("!document.querySelector('[data-agent-context-dialog]')"), 'Esc 关闭选择器')
  await type(page, '/Users/example/file.ts')
  assert(await run("!document.querySelector('[aria-label=\"本地命令\"]')"), '路径误识别为命令')
  await type(page, '')
  assert(requests.length === beforeCommands && (await history()).filter(isHuman).length === 0, '本地命令意外调用模型或增加用户历史')

  step = '主窗粘贴图片和长文本、选择 Skill、图片预览'
  await run(`(() => {const editor=document.querySelector('.ProseMirror'); const data=new DataTransfer(); data.items.add(new File([Uint8Array.from(atob(${JSON.stringify(png.toString('base64'))}),c=>c.charCodeAt(0))],'smoke.png',{type:'image/png'})); editor.dispatchEvent(new ClipboardEvent('paste',{bubbles:true,cancelable:true,clipboardData:data}));})()`)
  await wait(() => run("!!document.querySelector('[aria-label=\"预览图片 smoke.png\"]') && !document.querySelector('[aria-label=\"正在准备附件\"]')"), '图片准备及缩略图')
  await click(page, '[aria-label="预览图片 smoke.png"]')
  await wait(() => run("!!document.querySelector('[role=dialog] img[src^=\"blob:\"]')"), '完整图片预览')
  await click(page, '[aria-label="关闭图片预览"]')
  const pasted = '附件长文本原文\n'.repeat(1200)
  await run(`(() => {const data=new DataTransfer();data.setData('text/plain',${JSON.stringify(pasted)});document.querySelector('.ProseMirror').dispatchEvent(new ClipboardEvent('paste',{bubbles:true,cancelable:true,clipboardData:data}));})()`)
  await wait(() => run("document.querySelectorAll('[aria-label=\"消息附件\"] [aria-label^=\"移除附件\"]').length===2"), '长粘贴文件')
  await run(`(() => {const editor=document.querySelector('.ProseMirror');editor.focus();document.execCommand('insertText',false,'前文  后文');const text=editor.querySelector('p').firstChild;const range=document.createRange();range.setStart(text,3);range.collapse(true);const selection=window.getSelection();selection.removeAllRanges();selection.addRange(range);document.dispatchEvent(new Event('selectionchange'));})()`)
  await new Promise<void>((done) => setTimeout(done, 50))
  await click(page, '[aria-label="添加 Skill"]')
  assert(await run("!document.querySelector('[aria-label=\"片段正文\"]') && !document.querySelector('[aria-label=\"片段来源\"]')"), '仍有独立文本片段表单')
  await wait(() => run("[...document.querySelectorAll('[data-agent-context-dialog] button')].some(b=>b.textContent.includes('review-smoke'))"), '项目 Skill')
  await run("[...document.querySelectorAll('[data-agent-context-dialog] button')].find(b=>b.textContent.includes('review-smoke')).click()")
  await wait(() => run("!document.querySelector('[data-agent-context-dialog]') && !!document.querySelector('.ProseMirror [data-agent-inline-skill]') && document.querySelectorAll('[aria-label=\"消息附件\"] [aria-label^=\"移除附件\"]').length===2"), 'Skill 行内胶囊')
  assert(await run("(() => {const p=document.querySelector('.ProseMirror p');return p.firstChild.textContent==='前文 ' && p.lastChild.textContent===' 后文' && p.querySelector('[data-agent-inline-skill]')})()"), 'Skill 未插入原光标位置')
  await capture(page, 'inline-skill.png')
  await run("(async () => {const p=document.querySelector('.ProseMirror p');for(let i=0;i<2;i++){const text=[...p.childNodes].find(n=>n.nodeType===Node.TEXT_NODE);const range=document.createRange();range.selectNodeContents(text);const selection=window.getSelection();selection.removeAllRanges();selection.addRange(range);document.dispatchEvent(new Event('selectionchange'));await new Promise(r=>setTimeout(r,30));p.dispatchEvent(new KeyboardEvent('keydown',{key:'Backspace',code:'Backspace',keyCode:8,bubbles:true,cancelable:true}))}})()")
  // 已选 Skill 可删、可撤销；删除不会提前改变后端草稿，发送才同步最终选择。
  await new Promise<void>((done) => setTimeout(done, 550))
  await click(page, '[aria-label="移除 Skill review-smoke"]')
  await wait(() => run("!document.querySelector('.ProseMirror [data-agent-inline-skill]')"), '删除行内 Skill')
  await run("document.querySelector('.ProseMirror').focus(); document.querySelector('.ProseMirror').dispatchEvent(new KeyboardEvent('keydown',{key:'z',code:'KeyZ',metaKey:true,bubbles:true,cancelable:true}))")
  await wait(() => run("!!document.querySelector('.ProseMirror [data-agent-inline-skill]')"), '撤销恢复 Skill')
  await run("(async () => {const editor=document.querySelector('.agent-composer-editor');editor.focus();const selection=window.getSelection();for(const before of [true,false]){const chip=editor.querySelector('[data-agent-inline-skill]');const range=document.createRange();if(before)range.setStartBefore(chip);else range.setStartAfter(chip);range.collapse(true);selection.removeAllRanges();selection.addRange(range);document.dispatchEvent(new Event('selectionchange'));await new Promise(r=>setTimeout(r,30));document.execCommand('insertText',false,before?'前文 ':' 后文')}})()")
  await run("const consent=document.querySelector('input[type=checkbox]');if(consent&&!consent.checked)consent.click()")
  await wait(() => run("!document.querySelector('[aria-label=\"发送消息\"]').disabled"), '仅附件发送启用')
  await click(page, '[aria-label="发送消息"]')
  await wait(async () => (await history()).some((message) => message.type === 'result'), '首轮落盘')
  let users = (await history()).filter(isHuman)
  assert(users.length === 1 && users[0]!.attachments?.length === 3 && imageRequests > 0 && selectedBodyReceived, '图片/Skill 未进入真实请求或用户消息重复')
  assert(!JSON.stringify(users).includes(png.toString('base64')), '应用历史混入图片 Base64')
  assert(users[0]!.message?.content?.length === 1 && JSON.stringify(users[0]!.message.content).includes('"text":"前文  后文"'), '行内 Skill 改写原始正文')
  const firstParts = users[0]!.inputParts
  assert(firstParts?.length === 3 && firstParts[0]?.type === 'text' && firstParts[0].text === '前文 '
    && firstParts[1]?.type === 'skill' && firstParts[2]?.type === 'text' && firstParts[2].text === ' 后文' && orderedSkillReceived, '中立历史或真实模型请求丢失行内顺序')
  await wait(() => run("!!document.querySelector('[data-agent-input-body] [data-agent-skill-reference]')"), '历史行内 Skill')
  writeFileSync(join(directory, '.axon/skills/review-smoke/SKILL.md'), '---\nname: review-smoke\ndescription: 附件验收用指引\n---\n后续修改，不得改写原轮正文\n')
  await wait(() => run("!document.querySelector('.ProseMirror [data-agent-inline-skill]')"), '接纳后清空胶囊')
  await run("document.querySelector('.ProseMirror').focus(); document.querySelector('.ProseMirror').dispatchEvent(new KeyboardEvent('keydown',{key:'z',code:'KeyZ',metaKey:true,bubbles:true,cancelable:true}))")
  assert(await run("!document.querySelector('.ProseMirror [data-agent-inline-skill]')"), '撤销恢复了已发送 Skill')

  step = '浮窗 picker 失焦持有与取消重开'
  const binding = { id: 'attachment-shortcut', accelerator: 'Command+9', sessionType: 'agent' as const, sessionId: session.id }
  windows.show(binding, '附件验收')
  await wait(() => BrowserWindow.getAllWindows().length === 2, '浮窗创建')
  const quick = BrowserWindow.getAllWindows().find((window) => window !== page)!
  const qrun = (script: string): Promise<unknown> => quick.webContents.executeJavaScript(script).catch(() => { throw new Error(`浮窗脚本失败：${script.slice(0, 250)}`) })
  step = '浮窗本地命令与 Esc 分层取消'
  await wait(() => qrun("!!document.querySelector('[data-quick-composer][contenteditable=true]')"), '快捷编辑器')
  await type(quick, '/')
  await wait(async () => Boolean(await qrun("!!document.querySelector('[aria-label=\"本地命令\"]')")) && quick.getBounds().height > 300, '浮窗命令菜单自动展开')
  await wait(() => qrun("document.querySelector('[aria-label=\"本地命令\"]').textContent.includes('review-smoke')"), '浮窗斜杠直接展示 Skill')
  await checkSlashMenu(quick)
  await capture(quick, 'slash-quick.png')
  await key(quick, '[data-quick-composer]', 'Escape')
  await wait(() => qrun("!document.querySelector('[aria-label=\"本地命令\"]')"), '浮窗首个 Esc 关闭菜单')
  assert(quick.isVisible(), '关闭菜单错误取消了整个唤起')
  await type(quick, '/review')
  await wait(() => qrun("document.querySelectorAll('[aria-label=\"本地命令\"] [role=option]').length===1"), '浮窗实时过滤 Skill')
  await key(quick, '[data-quick-composer]', 'Enter')
  await wait(() => qrun("!!document.querySelector('[data-agent-inline-skill]') && !document.querySelector('[data-agent-context-dialog]')"), '浮窗 Enter 直接插入 Skill')
  await type(quick, '/skills')
  await key(quick, '[data-quick-composer]', 'Enter')
  await wait(() => qrun("!!document.querySelector('[data-agent-context-dialog]')"), '浮窗本地分发')
  await key(quick, '[aria-label="搜索 Skills"]', 'Escape')
  await wait(() => qrun("!document.querySelector('[data-agent-context-dialog]')"), '浮窗 Esc 关闭选择器')
  assert(quick.isVisible() && (await history()).filter(isHuman).length === 1, '浮窗命令产生消息或关闭了唤起')
  await type(quick, '/')
  await wait(() => qrun("!!document.querySelector('[aria-label=\"本地命令\"]')"), '浮窗再次打开菜单')
  await key(quick, '[data-quick-composer]', 'Escape')
  await wait(() => qrun("!document.querySelector('[aria-label=\"本地命令\"]')"), '浮窗二次菜单关闭')
  let escapeBlurred = false
  quick.once('blur', () => { escapeBlurred = true })
  await key(quick, '[data-quick-composer]', 'Escape')
  // 隐藏的原生 blur 实际送达后再模拟下一次用户唤起，不把两次动作挤在同一个原生周期。
  await wait(() => !quick.isVisible() && escapeBlurred, '浮窗第二个 Esc 取消唤起')
  windows.show(binding, '附件验收')
  await wait(async () => Boolean(await qrun("document.querySelector('[data-quick-composer]').textContent===''") ) && quick.isVisible(), '命令取消后重新唤起为空')
  step = '浮窗 picker 失焦持有与取消重开'
  await click(quick, '[aria-label="添加快捷会话附件"]')
  assert(await qrun("!document.querySelector('[aria-label=\"添加快捷会话目录\"]')"), '浮窗附件入口没有合并')
  await wait(() => pendingPicker !== undefined, 'picker 在途')
  assert(quick.isVisible(), '原生 picker 的失焦错误隐藏浮窗')
  pendingPicker!()
  await wait(() => qrun("document.querySelectorAll('[aria-label=\"移除附件 fixture.pdf\"]').length===1"), '原生文件引用')
  // 用真实窗口焦点切换取消，手工 emit 后再 hide 会产生迟到的第二次原生 blur。
  page.focus(); await wait(() => !quick.isVisible(), '取消唤起')
  windows.show(binding, '附件验收')
  await wait(() => qrun("!document.querySelector('[aria-label^=\"移除附件\"]') && document.querySelector('[data-quick-composer]').textContent===''") , '重开丢弃草稿')

  step = '浮窗文档附件、真实 Pi Bash 沙箱提取、双入口历史'
  await click(quick, '[aria-label="添加快捷会话附件"]')
  await wait(() => pendingPicker !== undefined, '第二次 picker'); pendingPicker!()
  await wait(() => qrun("!!document.querySelector('[aria-label=\"移除附件 fixture.docx\"]')"), '两份文档')
  assert(await qrun("!!document.querySelector('[aria-label=\"移除附件 fixture-folder\"]')"), '同一选择器未接收目录')
  await click(quick, '[aria-label="添加 Skill"]')
  await wait(() => qrun("[...document.querySelectorAll('[data-agent-context-dialog] button')].some(b=>b.textContent.includes('review-smoke'))"), '浮窗 Skill 目录')
  await qrun("[...document.querySelectorAll('[data-agent-context-dialog] button')].find(b=>b.textContent.includes('review-smoke')).click()")
  await wait(() => qrun("!!document.querySelector('[data-quick-composer] [data-agent-inline-skill]') && !document.querySelector('[data-agent-context-dialog]')"), '浮窗行内 Skill')
  await capture(quick, 'quick-inline-skill.png')
  await click(quick, '[aria-label="移除 Skill review-smoke"]')
  await wait(() => qrun("!document.querySelector('[data-quick-composer] [data-agent-inline-skill]')"), '浮窗删除 Skill')
  await qrun(`(() => {const t=document.querySelector('[data-quick-composer]');t.focus();document.execCommand('insertText',false,${JSON.stringify('DOCS_SMOKE\n请提取文档')});})()`)
  await new Promise<void>((done) => setTimeout(done, 50))
  await qrun("document.querySelector('[data-quick-composer]').dispatchEvent(new KeyboardEvent('keydown',{key:'Enter',bubbles:true}))")
  await wait(() => quick.getBounds().height > 300, '发送立即上拉')
  await wait(async () => {
    await qrun("[...document.querySelectorAll('button')].filter(b=>b.textContent.trim()==='本次允许').forEach(b=>b.click())")
    return (await history()).filter((message) => message.type === 'result').length === 2
  }, '真实文档工具结束', 30_000)
  assert(documentExecuted, '受管文档命令未在真实沙箱中成功提取 PDF/DOCX')
  users = (await history()).filter(isHuman)
  assert(users.length === 2 && users[1]!.inputOrigin === 'quick' && users[1]!.attachments?.length === 3 && users[1]!.attachments[2]?.kind === 'directory', '入口历史或文件/目录分类不一致')
  await wait(() => qrun("document.body.textContent.includes('DOCS_OK')"), '浮窗回复')
  await capture(quick, 'quick.png')
  page.focus()
  await page.reload()
  await wait(() => run("document.body.textContent.includes('DOCS_OK')"), '主窗重载历史')
  await capture(page, 'main.png')
  step = '后端退出与新 PID 恢复'
  const firstPid = backend.backend.pid
  windows.dispose(); await backend.close()
  backend = await startDesktopSmokeBackend({ directory, mainWindow: page })
  assert(firstPid !== backend.backend.pid, '未实际换后端 PID')
  await page.reload()
  await wait(() => run("document.body.textContent.includes('DOCS_OK')"), '新 PID 历史恢复')
  assert((await history()).filter(isHuman).length === 2, '重启重复输入')
  const restored = (await history()).filter(isHuman)[0]!
  assert(JSON.stringify(restored.inputParts) === JSON.stringify(firstParts) && restored.attachmentContext?.includes('AXON_EXPLICIT_SKILL_BODY'), '重启未保留顺序或当时 Skill 正文')
  await wait(() => run("!!document.querySelector('[data-agent-input-body] [data-agent-skill-reference]')"), '新 PID 行内历史显示')
  step = '精确 artifact 图片续跑及丢失后的有界图片恢复'
  await run(`(async () => {
    const draft=await window.axon.agent.attachmentCommand({action:'createDraft',sessionId:${JSON.stringify(session.id)}});
    const upload=await window.axon.agent.attachmentCommand({action:'beginUpload',draftId:draft.id,name:'restart.png',mediaType:'image/png',size:${png.length},kind:'image'});
    await window.axon.agent.attachmentCommand({action:'uploadChunk',uploadId:upload.id,offset:0,data:${JSON.stringify(png.toString('base64'))}});
    await window.axon.agent.attachmentCommand({action:'finishUpload',uploadId:upload.id});
    return window.axon.agent.send({sessionId:${JSON.stringify(session.id)},text:'AFTER_RESTART_SMOKE',attachmentDraftId:draft.id,imageModelConsent:{channelId:${JSON.stringify(session.channelId)},modelId:${JSON.stringify(session.modelId)}}});
  })()`)
  assert((await history()).filter(isHuman).length === 3, '精确恢复重复输入')
  const stored = await run(`window.axon.agent.getSession(${JSON.stringify(session.id)})`) as AgentSessionMeta
  assert(stored.runtimeSessionFile && realpathSync(stored.runtimeSessionFile).startsWith(`${directory}/backend/runtime/`), 'artifact 不在隔离目录')
  await backend.close()
  // 仅删除此脚本创建的确切 Runtime artifact，应用历史和托管原件全部保留。
  unlinkSync(stored.runtimeSessionFile)
  backend = await startDesktopSmokeBackend({ directory, mainWindow: page })
  await page.reload()
  await wait(() => run("document.body.textContent.includes('DOCS_OK')"), '降级入口恢复')
  await run(`window.axon.agent.send({sessionId:${JSON.stringify(session.id)},text:'FALLBACK_SMOKE'})`)
  assert(fallbackImageSeen, 'artifact 丢失后未将最近历史图片恢复到实际请求')

  step = '流式暂停、重启保留暂停状态、无输入继续'
  await run(`void window.axon.agent.send({sessionId:${JSON.stringify(session.id)},text:'HOLD_SMOKE'}).catch(()=>{})`)
  await wait(() => heldResponse !== undefined, '半途流式输出')
  const queued = await run(`(async () => {
    let draft=await window.axon.agent.attachmentCommand({action:'createDraft',sessionId:${JSON.stringify(session.id)}});
    const choices=await window.axon.agent.attachmentCommand({action:'listSkills',sessionId:${JSON.stringify(session.id)}});
    draft=await window.axon.agent.attachmentCommand({action:'addSkill',draftId:draft.id,sourceId:choices.skills.find(s=>s.name==='review-smoke').sourceId});
    const id=draft.attachments.find(a=>a.kind==='skill').id;
    const invalid=await window.axon.agent.send({sessionId:${JSON.stringify(session.id)},text:'队列前后',attachmentDraftId:draft.id,inputParts:[{type:'text',text:'队列前后'},{type:'skill',attachmentId:'foreign'}]});
    if(invalid.success||invalid.code!=='invalid_input')throw new Error('伪造引用被接纳');
    return window.axon.agent.send({sessionId:${JSON.stringify(session.id)},text:'队列前后',attachmentDraftId:draft.id,inputParts:[{type:'text',text:'队列前'},{type:'skill',attachmentId:id},{type:'text',text:'后'}]});
  })()`) as AgentSendResult
  assert(queued.success && queued.disposition === 'queued', '有序 Skill 消息未入队')
  await wait(() => run("!!document.querySelector('[data-queued-message] [data-agent-skill-reference]')"), '排队顺序胶囊')
  await run(`window.axon.agent.cancelQueuedMessage({sessionId:${JSON.stringify(session.id)},messageId:${JSON.stringify(queued.queuedMessage!.id)}})`)
  await wait(() => run("!document.querySelector('[data-queued-message]')"), '取消有序排队消息')
  const control = await run(`window.axon.agent.getOwnedRun(${JSON.stringify(session.id)})`) as { sessionId: string; runId: string }
  assert(control?.runId, '没有当前入口的控制凭据')
  await run(`window.axon.agent.pause(${JSON.stringify({ sessionId: session.id, runId: control.runId })})`)
  await wait(() => !heldResponse, '暂停关闭模型连接')
  await backend.close()
  backend = await startDesktopSmokeBackend({ directory, mainWindow: page })
  await page.reload()
  await wait(() => run("!!document.querySelector('[aria-label=\"继续 Agent\"]')"), '新进程暂停 UI')
  const paused = await run(`window.axon.agent.getPause(${JSON.stringify(session.id)})`) as { state: string; pauseId: string; turnId: string }
  assert(paused.state === 'paused', '重启丢失暂停状态')
  const humanCount = (await history()).filter(isHuman).length
  await run(`window.axon.agent.continue({sessionId:${JSON.stringify(session.id)},pauseId:${JSON.stringify(paused.pauseId)}})`)
  assert((await history()).filter(isHuman).length === humanCount, '继续新增人类消息')
  await click(page, '[aria-label="预览图片 restart.png"]')
  await wait(() => run("!!document.querySelector('[role=dialog] img[src^=\"blob:\"]')"), '降级/暂停/新 PID 后图片仍可预览')
  await click(page, '[aria-label="关闭图片预览"]')
  step = '真实 SDK 压缩后应用历史和图片仍完整'
  await run(`window.axon.agent.send({sessionId:${JSON.stringify(session.id)},text:'COMPACT_SMOKE'})`)
  await wait(async () => (await history()).some((message) => message.type === 'system' && message.subtype === 'compact_boundary' && message.compact_result === 'success'), 'SDK 成功压缩', 30_000)
  assert((await history()).filter(isHuman).length === humanCount + 1, '压缩删除了原始用户消息')
  await backend.close()
  backend = await startDesktopSmokeBackend({ directory, mainWindow: page })
  await page.reload()
  await wait(() => run("!!document.querySelector('[aria-label=\"预览图片 restart.png\"]')"), '压缩后新 PID 历史')
  await click(page, '[aria-label="预览图片 restart.png"]')
  await wait(() => run("!!document.querySelector('[role=dialog] img[src^=\"blob:\"]')"), '压缩后原图预览')
  await click(page, '[aria-label="关闭图片预览"]')
  assert(JSON.stringify((await history()).filter(isHuman)[0]?.inputParts) === JSON.stringify(firstParts), '压缩后重启丢失行内顺序')
  writeFileSync(join(directory, 'evidence.json'), JSON.stringify({ imageRequests, selectedBodyReceived, orderedSkillReceived, orderedQueueValidated: true, documentExecuted, fallbackImageSeen, pauseRestored: true,
    compactionPreserved: true, userMessages: humanCount + 1, requests: requests.length, firstPid, restartedPid: backend.backend.pid }, null, 2))
  console.log('附件真实源码桌面验收通过', directory)
  await finish(0)
}).catch((error: unknown) => void finish(1, error))
