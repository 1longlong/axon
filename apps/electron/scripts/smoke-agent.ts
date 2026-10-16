/** Agent 独立后端桌面冒烟：真实固定桥/工厂/存储，模型事件只在测试子进程模拟。 */
import { app, BrowserWindow } from 'electron'
import { execFileSync } from 'node:child_process'
import { createServer } from 'node:http'
import { mkdirSync, mkdtempSync, realpathSync, writeFileSync } from 'node:fs'
import { join, resolve } from 'node:path'
import { tmpdir } from 'node:os'
import { QuickChatWindowManager } from '../src/main/lib/desktop/quick-chat-window-manager'
import { isQuickChatWindowOwner } from '../src/main/lib/desktop/quick-chat-window-owner'
import type { AgentSessionMeta, AgentProject, Channel, SDKMessage, SDKUserMessage, AgentDelegation, McpProjectConfig } from '@axon/shared'
import type { JsonRpcPeer } from '@axon/app-server'
import { startDesktopSmokeBackend } from '../test-support/desktop-smoke-backend'
import type { DesktopSmokeBackend } from '../test-support/desktop-smoke-backend'
import { setMainWindow } from '../src/main/lib/desktop/main-window-store'

interface QueryReport {
  model: string | null
  thinkingLevel: string | null
  cwd: string
  credentialMatched: boolean
  toolNames: string[]
  projectInstructionIncluded: boolean
  memoryIncluded: boolean
}
const directory = mkdtempSync(join(tmpdir(), 'axon-agent-smoke-'))
app.setPath('userData', join(directory, 'electron'))
app.on('window-all-closed', () => {})
let bridge: DesktopSmokeBackend | undefined, win: BrowserWindow | undefined
let quickWindows: QuickChatWindowManager | undefined
let modelServer: ReturnType<typeof createServer> | undefined
let testPeer: JsonRpcPeer | undefined
let finishing: Promise<void> | undefined
let acceptanceStep = '初始化'
const timeout = setTimeout(() => { void finish(1, 'Agent 冒烟验证超时') }, 120_000)
// 冒烟主进程异常也走失败清理，避免默认原生错误弹窗阻塞诊断和退出。
process.on('uncaughtException', (error) => { void finish(1, error) })

/** 页面先销毁，后撤固定入口并等待自有后端退出；不影响正式实例或测试目录外的数据。 */
function finish(code: number, error?: unknown): Promise<void> {
  return finishing ??= (async () => {
    clearTimeout(timeout)
    if (error) {
      console.error(error)
      console.error('Agent 冒烟阶段', acceptanceStep, '证据目录', directory)
      if (win && !win.isDestroyed()) {
        console.error('Agent 冒烟页面诊断', await win.webContents.executeJavaScript('document.body.textContent.slice(-1400)').catch(() => '页面不可读'))
        console.error('Agent 冒烟对话框诊断', await win.webContents.executeJavaScript("[...document.querySelectorAll('[role=dialog]')].map(item => ({label: item.getAttribute('aria-label'), text: item.textContent}))").catch(() => '对话框不可读'))
        let captureDeadline: ReturnType<typeof setTimeout> | undefined
        try {
          // 图形诊断不是资源清理前提；原生截图无回应时仍销毁窗口并等待自有后端退出。
          const screenshot = await Promise.race([win.webContents.capturePage(), new Promise<never>((_resolve, reject) => {
            captureDeadline = setTimeout(() => reject(new Error('失败截图超时')), 2000)
          })])
          writeFileSync(join(directory, 'agent-failed.png'), screenshot.toPNG())
        } catch { console.error('Agent 冒烟失败截图不可用，继续清理') }
        finally { clearTimeout(captureDeadline) }
      }
    }
    quickWindows?.dispose()
    win?.destroy()
    try { await bridge?.close() } catch (cleanupError) { console.error('Agent 冒烟清理失败', cleanupError); code = 1 }
    modelServer?.closeAllConnections()
    modelServer?.close()
    app.exit(code)
  })()
}

void app.whenReady().then(async () => {
  // Zima 冒烟只连接本机临时模型端点，不使用开发配置中的真实渠道或密钥。
  const zimaPython = process.env.AXON_ZIMA_PYTHON
  modelServer = zimaPython ? createServer((request, response) => {
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
  const server = modelServer
  if (server) await new Promise<void>((resolveListen) => server.listen(0, '127.0.0.1', resolveListen))
  const modelAddress = modelServer?.address()
  const modelBaseUrl = modelAddress && typeof modelAddress !== 'string'
    ? `http://127.0.0.1:${modelAddress.port}/v1` : 'http://127.0.0.1:1/v1'
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
  win = new BrowserWindow({
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
  const page = win
  const startBridge = () => startDesktopSmokeBackend({
    directory, mainWindow: page, entry: resolve('dist/agent-smoke-backend.mjs'), zimaPython,
    quickWindowKind: (sender) => isQuickChatWindowOwner(sender.id),
    configurePeer: (peer) => { testPeer = peer },
    pickLocalWorkspace: async () => ({ canceled: false, path: directory, suggestedName: 'Agent 本地项目' }),
  })
  bridge = await startBridge()
  const run = async (script: string): Promise<unknown> => {
    try { return await page.webContents.executeJavaScript(script) }
    catch { throw new Error(`页面执行失败：${script.slice(0, 300)}`) }
  }
  const waitFor = async (expression: string): Promise<void> => {
    const started = Date.now()
    while (!(await run(expression))) {
      if (Date.now() - started > 8_000) throw new Error(`等待界面失败：${expression}`)
      await new Promise((done) => setTimeout(done, 30))
    }
  }
  const clickText = async (text: string): Promise<unknown> => {
    // 跨进程加载完成才允许点击；不能把异步禁用态误当产品故障。
    await waitFor(`[...document.querySelectorAll('button')].some(item => item.offsetParent && !item.disabled && item.textContent.trim() === ${JSON.stringify(text)})`)
    return run(`(() => {
    const button = [...document.querySelectorAll('button')].find(item => item.offsetParent && item.textContent.trim() === ${JSON.stringify(text)});
    if (!button || button.disabled) throw new Error('按钮不可用：${text}'); button.click();
  })()`)
  }
  const clickAria = async (label: string): Promise<unknown> => {
    await waitFor(`[...document.querySelectorAll('[aria-label=${JSON.stringify(label)}]')].some(item => item.offsetParent && !item.disabled)`)
    return run(`(() => {
    const target = [...document.querySelectorAll('[aria-label=${JSON.stringify(label)}]')].find(item => item.offsetParent);
    if (!target || target.disabled) throw new Error('控件不可用：${label}'); target.click();
  })()`)
  }
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
  const fillTextarea = async (label: string, value: string): Promise<unknown> => {
    await waitFor(`!!document.querySelector('textarea[aria-label=${JSON.stringify(label)}]')`)
    return run(`(() => {
    const input = document.querySelector('textarea[aria-label=${JSON.stringify(label)}]');
    if (!input) throw new Error('文本框不可用：${label}');
    const setter = Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, 'value').set;
    setter.call(input, ${JSON.stringify(value)});
    input.dispatchEvent(new Event('input', { bubbles: true }));
  })()`)
  }
  const assert = async (expression: string): Promise<void> => {
    if (!(await run(expression))) throw new Error(`Agent 冒烟断言失败：${expression}`)
  }

  /** 先展开所属活动组，再操作原工具详情，避免对隐藏 DOM 的点击伪装成真实交互。 */
  const expandToolActivity = async (name: string): Promise<void> => {
    await run(`(() => {
      const tool = document.querySelector(${JSON.stringify(`summary[aria-label="工具调用 ${name}"]`)});
      const toggle = tool?.closest('section[aria-label="执行活动组"]')?.querySelector('button[aria-expanded]');
      if (!toggle) throw new Error('缺少工具活动组');
      if (toggle.getAttribute('aria-expanded') === 'false') toggle.click();
    })()`)
    await waitFor(`!!document.querySelector('summary[aria-label=${JSON.stringify(`工具调用 ${name}`)}]')?.offsetParent`)
  }

  await page.loadFile(resolve('dist/renderer/index.html'))
  // 所有业务创建通过真实 preload；父端只负责测试工作区文件和原生交互。
  const channel = await run(`window.axon.channels.create(${JSON.stringify({
    name: 'Agent 本地测试渠道', provider: 'custom', baseUrl: modelBaseUrl, apiKey: 'synthetic-agent-key',
    models: [{ id: 'gpt-5.6-smoke', name: 'Agent 冒烟模型', enabled: true, source: 'manual' }],
  })})`) as Channel
  const smokeProject = await run("window.axon.agentProjects.create({ name: 'Agent 冒烟项目', workspace: { kind: 'managed' } })") as AgentProject
  page.webContents.reload()
  await waitFor("[...document.querySelectorAll('button')].some(item => item.textContent.trim() === 'Agent')")
  await clickText('Agent')
  await waitFor("!!document.querySelector('[aria-label=\"项目 Agent 冒烟项目\"]')")
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
  writeFileSync(join(directory, 'runtime-menu.png'), (await page.webContents.capturePage()).toPNG())
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
  await waitFor("document.querySelector('[role=\"dialog\"][aria-label$=\" 的 MCP 服务\"]')?.textContent.includes('filesystem')")
  await clickText('保存')
  await waitFor("document.querySelector('[role=\"dialog\"][aria-label$=\" 的 MCP 服务\"]')?.textContent.includes('配置已保存')")
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
  page.webContents.sendInputEvent({ type: 'mouseMove', ...projectHoverPoint })
  await waitFor("document.querySelector('[role=tooltip][aria-label=\"项目 Agent 本地项目 信息\"]')?.textContent.includes('工作区 · 本地目录')")
  await assert("(() => { const rect = document.querySelector('[role=tooltip][aria-label=\"项目 Agent 本地项目 信息\"]').getBoundingClientRect(); return rect.left >= 0 && rect.right <= innerWidth })()")
  writeFileSync(join(directory, 'project-hover.png'), (await page.webContents.capturePage()).toPNG())
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
  await assert("[...document.querySelectorAll('button[aria-label=\"打开文件面板\"]')].find(item => item.offsetParent).getAttribute('aria-pressed') === 'true'")
  // 没有打开文件时只弹出文件树，不占右栏；选择和关闭文件驱动实际布局。
  await assert("![...document.querySelectorAll('[aria-label=\"文件预览\"]')].find(item => item.offsetParent) && !document.querySelector('[aria-label=\"调整右侧栏宽度\"]')")
  await assert("(() => { const tree = [...document.querySelectorAll('[aria-label=\"工作区文件树\"]')].find(item => item.offsetParent); const button = [...document.querySelectorAll('[aria-label=\"打开文件面板\"]')].find(item => item.offsetParent); const rect = tree.getBoundingClientRect(); const anchor = button.getBoundingClientRect(); const pointer = tree.querySelector('.workspace-file-tree-pointer').getBoundingClientRect(); return rect.right < anchor.left && anchor.left - rect.right < 24 && Math.abs((pointer.top + pointer.bottom) / 2 - (anchor.top + anchor.bottom) / 2) < 2 && getComputedStyle(tree).backgroundColor.includes('0.72') })()")
  await clickAria('预览 workspace-tree-marker.txt')
  await waitFor("[...document.querySelectorAll('[aria-label=\"文件预览\"]')].find(item => item.offsetParent)?.textContent.includes('workspace tree smoke')")
  await clickAria('关闭文件 workspace-tree-marker.txt')
  await waitFor("![...document.querySelectorAll('[aria-label=\"文件预览\"]')].find(item => item.offsetParent) && !document.querySelector('[aria-label=\"调整右侧栏宽度\"]')")
  await clickAria('预览 workspace-tree-marker.txt')
  await waitFor("!!document.querySelector('[aria-label=\"调整右侧栏宽度\"]')")
  const rightWidth = await run("[...document.querySelectorAll('[aria-label=\"工作区文件面板\"]')].find(item => item.offsetParent).getBoundingClientRect().width") as number
  await run("document.querySelector('[aria-label=\"调整右侧栏宽度\"]').dispatchEvent(new KeyboardEvent('keydown', { key: 'ArrowLeft', bubbles: true }))")
  await waitFor(`[...document.querySelectorAll('[aria-label="工作区文件面板"]')].find(item => item.offsetParent).getBoundingClientRect().width === ${rightWidth + 16}`)
  await clickAria('收起右侧栏')
  await waitFor("!!document.querySelector('[aria-label=\"展开右侧栏\"]') && ![...document.querySelectorAll('[aria-label=\"文件预览\"]')].find(item => item.offsetParent)")
  await clickAria('打开文件面板')
  await waitFor("document.body.textContent.includes('workspace-tree-marker.txt')")
  await assert("[...document.querySelectorAll('[aria-label=\"文件预览\"]')].find(item => item.offsetParent)?.textContent.includes('workspace tree smoke')")
  // 缓存中的后台会话不能修改前台布局；空会话收栏，返回后恢复已打开文件。
  await run("document.querySelector('[aria-label=\"项目 Agent 冒烟项目\"] [aria-label^=\"删除 Agent 会话\"]').previousElementSibling.click()")
  await waitFor("![...document.querySelectorAll('[aria-label=\"文件预览\"]')].find(item => item.offsetParent) && !document.querySelector('[aria-label=\"调整右侧栏宽度\"]')")
  await run("document.querySelector('[aria-label=\"项目 Agent 本地项目\"] [aria-label^=\"删除 Agent 会话\"]').previousElementSibling.click()")
  await waitFor("[...document.querySelectorAll('[aria-label=\"文件预览\"]')].find(item => item.offsetParent)?.textContent.includes('workspace tree smoke')")
  writeFileSync(join(directory, 'auto-refresh-marker.txt'), 'watcher smoke')
  await waitFor("document.body.textContent.includes('auto-refresh-marker.txt')")
  await clickAria('打开终端面板')
  await waitFor("document.querySelector('[aria-label=\"终端面板\"]')?.textContent.includes('后续阶段接入')")
  await clickAria('打开浏览器面板')
  await waitFor("document.querySelector('[aria-label=\"浏览器面板\"]')?.textContent.includes('后续阶段接入')")
  await clickAria('打开文件面板')
  await waitFor("document.body.textContent.includes('auto-refresh-marker.txt')")
  await clickAria('预览 auto-refresh-marker.txt')
  await waitFor("[...document.querySelectorAll('[aria-label=\"文件预览\"]')].find(item => item.offsetParent)?.textContent.includes('watcher smoke')")
  // 文件树浮层收起只改变可见性，已选预览和监听刷新仍然有效。
  await clickAria('收起工作区文件树')
  await waitFor("![...document.querySelectorAll('[aria-label=\"工作区文件树\"]')].some(item => item.offsetParent)")
  await assert("[...document.querySelectorAll('[aria-label=\"文件预览\"]')].find(item => item.offsetParent)?.textContent.includes('watcher smoke')")
  await assert("document.activeElement?.getAttribute('aria-label') === '打开文件面板'")
  writeFileSync(join(directory, 'auto-refresh-marker.txt'), 'watcher smoke after hiding tree')
  await waitFor("[...document.querySelectorAll('[aria-label=\"文件预览\"]')].find(item => item.offsetParent)?.textContent.includes('watcher smoke after hiding tree')")
  await clickAria('打开文件面板')
  await waitFor("[...document.querySelectorAll('[aria-label=\"工作区文件树\"]')].some(item => item.offsetParent)")
  await assert("document.querySelector('button[aria-label=\"预览 auto-refresh-marker.txt\"]')?.getAttribute('aria-pressed') === 'true'")
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
  await clickAria('发送消息')
  await waitFor("document.body.textContent.includes('正在处理') && [...document.querySelectorAll('button[aria-label=\"暂停 Agent\"]')].some(item => item.offsetParent)")
  await assert("[...document.querySelectorAll('button[aria-label=\"发送消息\"], button[aria-label=\"暂停 Agent\"], button[aria-label=\"继续 Agent\"]')].filter(item => item.offsetParent).length === 1")
  await assert("document.querySelector('button[aria-label=\"暂停 Agent\"]')?.textContent === ''")
  await waitFor("document.body.textContent.includes('Agent 请求扩展沙箱权限：Bash') && document.body.textContent.includes('网络访问')")
  await assert("document.body.textContent.includes('命令可能已产生部分本地副作用') && document.body.textContent.includes('批准后只携带本项权限重试当前工具一次')")
  await assert("[...document.querySelectorAll('button')].some(item => item.offsetParent && item.textContent.trim() === '当前会话允许')")
  await clickText('本次允许')
  await waitFor("document.querySelector('summary[aria-label=\"工具调用 Bash\"] svg.animate-spin') !== null && document.querySelector('summary[aria-label=\"工具调用 Bash\"]')?.closest('section[aria-label=\"执行活动组\"]')?.querySelector('button[aria-expanded]')?.getAttribute('aria-expanded') === 'true'")
  await assert("document.querySelectorAll('summary[aria-label=\"工具调用 Bash\"]').length === 1")
  await waitFor("document.body.textContent.includes('Agent 正常回答') && !document.body.textContent.includes('Agent 运行中')")
  await waitFor("document.querySelector('summary[aria-label=\"工具调用 Bash\"]')?.closest('section[aria-label=\"执行活动组\"]')?.querySelector('button[aria-expanded]')?.getAttribute('aria-expanded') === 'false'")
  writeFileSync(join(directory, 'agent-activity-collapsed.png'), (await page.webContents.capturePage()).toPNG())
  await assert("document.querySelector('summary[aria-label=\"工具调用 Bash\"]')?.textContent.includes('Bash · bun test')")
  await assert("document.querySelectorAll('summary[aria-label=\"工具调用 Bash\"]').length === 1")
  await assert("[...document.querySelectorAll('summary')].some(item => item.textContent.includes('思考过程'))")
  await expandToolActivity('Bash')
  await run("document.querySelector('summary[aria-label=\"工具调用 Bash\"]').click()")
  await waitFor("document.body.textContent.includes('测试通过')")
  await assert("document.querySelector('summary[aria-label=\"工具调用 Bash\"]').nextElementSibling.getBoundingClientRect().height < 224")
  await waitFor("window.axon.agent.listActiveRuns().then(runs => runs.length === 0)")
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
  writeFileSync(join(directory, 'agent-complete.png'), (await page.webContents.capturePage()).toPNG())
  const session = (await run("window.axon.agent.listSessions()") as AgentSessionMeta[]).find((item) => !item.parentSessionId && item.runtimeSessionFile)
  const capturedQuery = await testPeer!.request('axon/test/query/report') as unknown as QueryReport
  const selectedProject = session?.projectId ? await run(`window.axon.agentProjects.get(${JSON.stringify(session.projectId)})`) as AgentProject : undefined
  const expectedProjectRoot = realpathSync(directory)
  const savedMcp = (await run(`window.axon.mcpProjects.getConfig(${JSON.stringify(smokeProject.id)})`) as McpProjectConfig).servers.filesystem
  const expectedMcpRoot = smokeProject.workspace.kind === 'local' ? smokeProject.workspace.path : join(directory, 'backend', 'agent-projects', smokeProject.slug, 'workspace-files')
  if (savedMcp?.type !== 'stdio' || savedMcp.args?.at(-1) !== expectedMcpRoot) {
    throw new Error(`MCP UI 工作区物化不一致：实际 ${savedMcp?.type === 'stdio' ? JSON.stringify(savedMcp.args) : '非 stdio'}，预期 ${expectedMcpRoot}`)
  }
  if (!session || session.channelId !== channel.id || session.modelId !== 'gpt-5.6-smoke' || session.thinkingLevel !== 'high' || selectedProject?.workspace.kind !== 'local' || selectedProject.workspace.path !== expectedProjectRoot) {
    throw new Error('Agent UI 未把项目归属、渠道、模型和思考等级写入会话')
  }
  if (capturedQuery?.model !== 'gpt-5.6-smoke' || capturedQuery.thinkingLevel !== 'high' || !capturedQuery.credentialMatched) {
    throw new Error('AgentService 未把安全解析后的模型、思考等级与连接交给 adapter')
  }
  if (capturedQuery.cwd !== expectedProjectRoot) {
    throw new Error('AgentService 未把工作区解析为可信 cwd')
  }
  if (!capturedQuery.projectInstructionIncluded) {
    throw new Error('AgentService 未把项目根 AGENTS.md 注入系统提示词')
  }
  if (!capturedQuery.toolNames.includes('SkillRead')) {
    throw new Error('AgentService 未注入统一 SkillRead 工具')
  }
  if (!capturedQuery.memoryIncluded) {
    throw new Error('AgentService 未把最新 MEMORY.md 追加到系统提示词末尾')
  }
  if (!capturedQuery.toolNames.includes('MemoryRead')
    || !capturedQuery.toolNames.includes('MemoryWrite')) {
    throw new Error('AgentService 未给已启用项目注入记忆工具')
  }
  const messages = await run(`window.axon.agent.getMessages(${JSON.stringify(session.id)})`) as SDKMessage[]
  const messageKinds = messages.map((message) => `${message.type}:${'subtype' in message ? String(message.subtype) : ''}`).join(',')
  if (messageKinds !== 'user:,system:init,assistant:,user:,assistant:,user:,result:success') {
    throw new Error(`Agent JSONL 终态不完整：${messageKinds}`)
  }
  const childTask = (await run(`window.axon.agentTasks.list(${JSON.stringify(session.id)})`) as AgentDelegation[])[0]
  if (!childTask || childTask.status !== 'completed' || childTask.resultSummary !== '子 Agent 已完成检查') {
    throw new Error('子任务终态未正确聚合到 state.json')
  }
  if ((await run(`window.axon.agent.getSession(${JSON.stringify(childTask.childSessionId)})`) as AgentSessionMeta)?.thinkingLevel !== 'high') {
    throw new Error('子 Agent 未继承父会话思考等级')
  }
  const childKinds = (await run(`window.axon.agentTasks.getMessages(${JSON.stringify(session.id)}, ${JSON.stringify(childTask.id)})`) as SDKMessage[])
    .map((message) => `${message.type}:${'subtype' in message ? String(message.subtype) : ''}`)
    .join(',')
  if (childKinds !== 'user:,system:init,assistant:,result:success') {
    throw new Error(`子 Agent JSONL 终态不完整：${childKinds}`)
  }
  if (session.sdkSessionId !== 'runtime-smoke' || !session.runtimeSessionFile?.endsWith('runtime-smoke.jsonl')) {
    throw new Error('Agent runtime resume 凭据未回写')
  }

  // 等实际标签补丁落盘，卸载页面后停止唯一写入者，再用新 PID 验证磁盘恢复。
  await waitFor(`window.axon.settings.get().then(settings => settings.tabState?.tabs.some(tab => tab.sessionId === ${JSON.stringify(session.id)} && tab.id === settings.tabState.activeTabId))`)
  const previousPid = bridge.backend.pid
  await page.loadURL('about:blank')
  await bridge.close()
  bridge = await startBridge()
  if (bridge.backend.pid === previousPid) throw new Error('Agent 恢复未使用新的后端进程')
  await page.loadFile(resolve('dist/renderer/index.html'))
  await waitFor("document.body.textContent.includes('Agent 正常回答') && !!document.querySelector('.ProseMirror[contenteditable=true]')")
  await assert("document.body.textContent.includes('执行本地 Agent 冒烟任务')")
  await waitFor("!!document.querySelector('[aria-label=\"查看子任务 检查子流程\"]')")
  await clickAria('查看子任务 检查子流程')
  await waitFor("document.querySelector('[role=\"dialog\"][aria-label=\"子任务：检查子流程\"]')?.textContent.includes('子 Agent 已完成检查')")
  await clickAria('关闭子任务详情')
  await assert("document.body.textContent.includes('本轮使用') && document.body.textContent.includes('review-code')")
  await assert(`document.querySelector('[aria-label="左侧会话栏"]').getBoundingClientRect().width === ${leftWidth + 16}`)
  await assert("![...document.querySelectorAll('[aria-label=\"文件预览\"]')].find(item => item.offsetParent) && !document.querySelector('[aria-label=\"调整右侧栏宽度\"]')")
  await clickAria('打开文件面板')
  await clickAria('预览 auto-refresh-marker.txt')
  await waitFor(`[...document.querySelectorAll('[aria-label="工作区文件面板"]')].find(item => item.offsetParent).getBoundingClientRect().width === ${rightWidth + 16}`)
  await assert(`[...document.querySelectorAll('select[aria-label="选择 Agent 思考等级"]')].find(item => item.offsetParent)?.value === 'high'`)

  // 用真实流式投影检查滚动位置，而不是只断言 CSS 类名或组件内部状态。
  await typeEditor('验证消息阅读体验')
  await clickAria('发送消息')
  await waitFor("document.body.textContent.includes('阅读验证段落 60')")
  const readingScroller = "[...document.querySelectorAll('main .overflow-y-auto')].find(item => item.offsetParent && item.querySelector('article'))"
  await assert(`(() => { const element = ${readingScroller}; return element.scrollHeight - element.scrollTop - element.clientHeight < 2 })()`)
  const readingPosition = await run(`(() => {
    const element = ${readingScroller};
    element.scrollTop = element.scrollHeight / 3;
    element.dispatchEvent(new Event('scroll'));
    return element.scrollTop;
  })()`)
  if (typeof readingPosition !== 'number' || readingPosition <= 0) throw new Error('消息阅读验证未进入暂停输出状态')
  await waitFor("[...document.querySelectorAll('button')].some(item => item.offsetParent && item.textContent.trim() === '回到最新')")
  await testPeer!.request('axon/test/reading/resume')
  await waitFor("document.body.textContent.includes('阅读验证新增输出一')")
  await assert(`Math.abs((${readingScroller}).scrollTop - ${readingPosition}) < 2`)
  writeFileSync(join(directory, 'agent-reading-history.png'), (await page.webContents.capturePage()).toPNG())
  await clickText('回到最新')
  await assert(`(() => { const element = ${readingScroller}; return element.scrollHeight - element.scrollTop - element.clientHeight < 2 })()`)
  await waitFor("![...document.querySelectorAll('button')].some(item => item.offsetParent && item.textContent.trim() === '回到最新')")
  await testPeer!.request('axon/test/reading/resume')
  await waitFor("document.body.textContent.includes('阅读验证新增输出二') && !document.body.textContent.includes('Agent 运行中')")
  await assert(`(() => { const element = ${readingScroller}; return element.scrollHeight - element.scrollTop - element.clientHeight < 2 })()`)
  await expandToolActivity('Read')
  await run("document.querySelector('summary[aria-label=\"工具调用 Read\"]').click()")
  await assert("(() => { const detail = document.querySelector('summary[aria-label=\"工具调用 Read\"]').nextElementSibling; return detail.clientHeight <= 224 && detail.scrollHeight > detail.clientHeight })()")
  writeFileSync(join(directory, 'agent-reading-long-output.png'), (await page.webContents.capturePage()).toPNG())

  // 单独保持队列验证轮，不把窗口聚焦/输入手势混入只观察输出的阅读位置测试。
  await typeEditor('验证消息排队')
  await clickAria('发送消息')
  await waitFor("document.body.textContent.includes('排队验证正在等待')")
  // 原轮仍等待时从真实编辑器提交；只出现队列胶囊，不提前写作下一轮用户历史。
  acceptanceStep = '运行中 Enter 排队与胶囊'
  page.show(); page.focus()
  await waitFor('document.hasFocus()')
  for (const text of ['验证排队消息一', '验证排队消息二']) {
    await typeEditor(text)
    // 等输入状态提交后使用原生键事件，不能用缺 keyCode 的合成事件代替编辑器输入链。
    await run('new Promise(resolve => requestAnimationFrame(() => resolve(true)))')
    page.webContents.sendInputEvent({ type: 'keyDown', keyCode: 'Enter' })
    page.webContents.sendInputEvent({ type: 'keyUp', keyCode: 'Enter' })
    await waitFor(`document.querySelector('[aria-label="等待发送的消息"]')?.textContent.includes(${JSON.stringify(text)})`)
  }
  await assert("document.querySelectorAll('[data-queued-message]').length === 2 && ![...document.querySelectorAll('button')].some(item => item.textContent.trim() === '排队')")
  await assert("(() => { const items = [...document.querySelectorAll('[data-queued-message]')].filter(item => item.offsetParent); const editor = [...document.querySelectorAll('.ProseMirror')].find(item => item.offsetParent); return items[0].getBoundingClientRect().top === items[1].getBoundingClientRect().top && items[0].getBoundingClientRect().bottom < editor.getBoundingClientRect().top })()")
  await assert(`window.axon.agent.getMessages(${JSON.stringify(session.id)}).then(messages => !messages.some(message => message.type === 'user' && message.message.content.some(block => block.type === 'text' && block.text.startsWith('验证排队消息'))))`)
  // 模型没有再发 delta；真实主窗聚焦重读后，读取前的正文仍必须在 UI 中。
  await waitFor("document.body.textContent.includes('排队验证正在等待')")
  await run("window.dispatchEvent(new Event('focus')); true")
  await assert(`window.axon.agent.getMessages(${JSON.stringify(session.id)}).then(messages => !JSON.stringify(messages).includes('排队验证正在等待'))`)
  await waitFor("document.body.textContent.includes('排队验证正在等待')")
  writeFileSync(join(directory, 'agent-queued-pills.png'), (await page.webContents.capturePage()).toPNG())
  acceptanceStep = '队列自动进入下一轮'
  await testPeer!.request('axon/test/reading/resume')
  await waitFor("document.body.textContent.includes('队列回复：验证排队消息一') && document.body.textContent.includes('队列回复：验证排队消息二') && !document.querySelector('[data-queued-message]')")
  await waitFor("window.axon.agent.listActiveRuns().then(runs => runs.length === 0)")
  const queueHistory = await run(`window.axon.agent.getMessages(${JSON.stringify(session.id)})`) as SDKMessage[]
  const queuedInputs = queueHistory.filter((message) => message.type === 'user' && (message as SDKUserMessage).message?.content?.some((block) => block.type === 'text' && typeof block.text === 'string' && block.text.startsWith('验证排队消息')))
  if (queuedInputs.length !== 2 || !JSON.stringify(queuedInputs[0]).includes('验证排队消息一') || !JSON.stringify(queuedInputs[1]).includes('验证排队消息二')) throw new Error('排队消息未按顺序作为独立用户轮落盘')

  // 同一轮工具追问经子进程反向请求回到原窗口，答复不生成新用户轮次。
  await waitFor("window.axon.agent.listActiveRuns().then(runs => runs.length === 0)")
  const beforeQuestion = await run(`window.axon.agent.getMessages(${JSON.stringify(session.id)})`) as SDKMessage[]
  await typeEditor('验证追问链路')
  await clickAria('发送消息')
  await waitFor("document.body.textContent.includes('Agent 需要你的回答') && document.body.textContent.includes('请选择测试方案')")
  await clickText('方案一')
  await clickText('提交回答')
  await waitFor("document.body.textContent.includes('已收到方案一，继续本轮任务。') && !document.body.textContent.includes('Agent 需要你的回答')")
  await waitFor("window.axon.agent.listActiveRuns().then(runs => runs.length === 0)")
  const questionMessages = (await run(`window.axon.agent.getMessages(${JSON.stringify(session.id)})`) as SDKMessage[]).slice(beforeQuestion.length)
  if (questionMessages.map((message) => message.type).join(',') !== 'user,assistant,user,assistant,result') throw new Error('追问未在原轮中交付，或历史重复')

  // 暂停等实际收束/检查点落盘后才开放继续；继续启动新轮，不重投旧任务。
  await typeEditor('验证停止链路')
  await clickAria('发送消息')
  await waitFor("document.body.textContent.includes('停止验证正在等待')")
  await clickAria('暂停 Agent')
  await waitFor("window.axon.agent.listActiveRuns().then(runs => runs.length === 0)")
  const stoppedMessages = (await run(`window.axon.agent.getMessages(${JSON.stringify(session.id)})`) as SDKMessage[]).slice(beforeQuestion.length + questionMessages.length)
  const stoppedResults = stoppedMessages.filter((message) => message.type === 'result')
  if (stoppedResults.length !== 1 || stoppedResults[0]?.type !== 'result' || stoppedResults[0].terminal_reason !== 'stopped' || !stoppedResults[0].stopped_by_user) throw new Error('停止轮次缺失唯一取消终态')
  await waitFor("[...document.querySelectorAll('button[aria-label=\"继续 Agent\"]')].some(item => item.offsetParent && !item.disabled)")
  await assert("[...document.querySelectorAll('button[aria-label=\"发送消息\"], button[aria-label=\"暂停 Agent\"], button[aria-label=\"继续 Agent\"]')].filter(item => item.offsetParent).length === 1")
  await assert("document.querySelector('button[aria-label=\"继续 Agent\"]')?.textContent === ''")
  const paused = await run(`window.axon.agent.getPause(${JSON.stringify(session.id)})`) as { state?: string; pauseId?: string; turnId?: string }
  if (paused.state !== 'paused' || !paused.pauseId) throw new Error('暂停按钮没有后端继续凭据')
  if (paused.turnId !== (stoppedMessages.find((message) => message.type === 'user') as SDKUserMessage | undefined)?.uuid) throw new Error('暂停没有保存原用户轮次身份')
  if (!stoppedMessages.some((message) => message.type === 'assistant' && message.isPartial === true)) throw new Error('暂停未保存停止前部分输出')
  await assert("!document.body.textContent.includes('Agent 执行已停止') && document.body.textContent.includes('停止验证正在等待')")
  await assert("[...document.querySelectorAll('section[aria-label=\"执行活动组\"]')].find(item => item.textContent.includes('停止前思考'))?.querySelector('button[aria-expanded]')?.getAttribute('aria-expanded') === 'true'")
  // 卸载页面并等待旧后端退出；新身份只能从磁盘 marker 恢复暂停，不继承旧 owner。
  acceptanceStep = '暂停后重启后端及页面'
  const pausedPid = bridge.backend.pid
  await page.loadURL('about:blank')
  await bridge.close()
  bridge = await startBridge()
  if (bridge.backend.pid === pausedPid) throw new Error('暂停恢复没有实际重启后端')
  await page.loadFile(resolve('dist/renderer/index.html'))
  await waitFor("!!document.querySelector('button[aria-label=\"继续 Agent\"]:not(:disabled)') && document.body.textContent.includes('停止验证正在等待')")
  await assert(`window.axon.agent.getPause(${JSON.stringify(session.id)}).then(value => value?.pauseId === ${JSON.stringify(paused.pauseId)} && value.state === 'paused')`)
  await assert(`window.axon.agent.getOwnedRun(${JSON.stringify(session.id)}).then(value => value === null)`)
  writeFileSync(join(directory, 'agent-paused.png'), (await page.webContents.capturePage()).toPNG())
  // 第二页面只能显式接管已暂停会话；运行观察不授予旧入口控制权。
  quickWindows = new QuickChatWindowManager({ rendererFilePath: resolve('dist/renderer/index.html') })
  acceptanceStep = '快捷浮窗读取暂停凭据'
  quickWindows.show({ id: 'pause-smoke', accelerator: 'CommandOrControl+Shift+8', sessionType: 'agent', sessionId: session.id }, session.title)
  let quickPage: BrowserWindow | undefined
  const quickWait = async (expression: string): Promise<void> => {
    const start = Date.now()
    while (!quickPage || !(await quickPage.webContents.executeJavaScript(expression))) {
      quickPage = BrowserWindow.getAllWindows().find((item) => item !== page && item.webContents.getURL().includes('quick=1'))
      if (Date.now() - start > 8000) throw new Error(`快捷 Agent 暂停验收未就绪：${expression}`)
      await new Promise<void>((done) => setTimeout(done, 30))
    }
  }
  await quickWait("!!document.querySelector('button[aria-label=\"继续 Agent\"]:not(:disabled)')")
  acceptanceStep = '快捷浮窗启动继续'
  await quickPage!.webContents.executeJavaScript("document.querySelector('button[aria-label=\"继续 Agent\"]').click()")
  await quickWait("document.body.textContent.includes('继续阶段正在等待') && !!document.querySelector('button[aria-label=\"暂停 Agent\"]')")
  // 浮窗使用同一控制器；其 focus 重读也不能覆盖只有首段 delta 的回复。
  await quickPage!.webContents.executeJavaScript("window.dispatchEvent(new Event('focus')); true")
  await quickPage!.webContents.executeJavaScript(`window.axon.agent.getMessages(${JSON.stringify(session.id)})`)
  await quickWait("document.body.textContent.includes('继续阶段正在等待')")
  await quickWait("!document.body.textContent.includes('继续刚才被暂停的任务；先确认中断处的实际状态，再推进剩余工作。') && !document.body.textContent.includes('Agent 执行已停止')")
  acceptanceStep = '主窗口观察快捷运行'
  await waitFor("document.body.textContent.includes('其他入口运行中') && !document.querySelector('button[aria-label=\"暂停 Agent\"]')")
  await assert(`window.axon.agent.getOwnedRun(${JSON.stringify(session.id)}).then(value => value === null)`)
  acceptanceStep = '快捷运行截图'
  writeFileSync(join(directory, 'agent-quick-running.png'), (await quickPage!.webContents.capturePage()).toPNG())
  acceptanceStep = '快捷浮窗再次暂停'
  await quickPage!.webContents.executeJavaScript("[...document.querySelectorAll('section[aria-label=\"执行活动组\"]')].find(item => item.textContent.includes('继续阶段思考')).querySelector('button[aria-expanded]').click()")
  await quickPage!.webContents.executeJavaScript("document.querySelector('button[aria-label=\"暂停 Agent\"]').click()")
  await quickWait("!!document.querySelector('button[aria-label=\"继续 Agent\"]:not(:disabled)')")
  await quickWait("[...document.querySelectorAll('section[aria-label=\"执行活动组\"]')].find(item => item.textContent.includes('继续阶段思考'))?.querySelector('button[aria-expanded]')?.getAttribute('aria-expanded') === 'false'")
  await waitFor("!!document.querySelector('button[aria-label=\"继续 Agent\"]:not(:disabled)')")
  acceptanceStep = '主窗口再次继续'
  await clickAria('继续 Agent')
  await waitFor("!!document.querySelector('button[aria-label=\"暂停 Agent\"]')")
  await testPeer!.request('axon/test/reading/resume')
  acceptanceStep = '主窗口继续终态'
  await waitFor("document.body.textContent.includes('已在原轮次继续完成任务。')")
  await assert("!document.body.textContent.includes('继续刚才被暂停的任务；先确认中断处的实际状态，再推进剩余工作。') && !document.body.textContent.includes('Agent 执行已停止')")
  await waitFor(`window.axon.agent.getPause(${JSON.stringify(session.id)}).then(value => value === null)`)
  writeFileSync(join(directory, 'agent-continued.png'), (await page.webContents.capturePage()).toPNG())
  const sharedHistory = await run(`window.axon.agent.getMessages(${JSON.stringify(session.id)})`) as SDKMessage[]
  if (!sharedHistory.some((message) => message.type === 'system' && message.subtype === 'axon_continued'
    && message.input_origin === 'quick' && message.turn_id === paused.turnId)) throw new Error('快捷继续没有保存原轮次及内部入口')
  if (sharedHistory.some((message) => message.type === 'user' && message.isSynthetic === true
    && (message as SDKUserMessage).message?.content?.some((block) => block.type === 'text' && String(block.text).includes('继续刚才')))) throw new Error('继续仍新增隐藏用户消息')
  await assert("[...document.querySelectorAll('article')].some(item => item.textContent.includes('停止验证正在等待') && item.textContent.includes('已在原轮次继续完成任务。') && item.querySelectorAll('time').length === 1)")
  const quickWebContentsId = quickPage!.webContents.id
  quickWindows.dispose(); quickWindows = undefined
  if (!quickPage!.isDestroyed() || isQuickChatWindowOwner(quickWebContentsId)) throw new Error('快捷浮窗销毁未完成或未注销原身份')
  await waitFor("!!document.querySelector('button[aria-label=\"发送消息\"]')")

  if (zimaPython) {
    await clickAria('在 Agent 本地项目 中新建会话')
    await clickText('Zima')
    await waitFor("!!document.querySelector('.ProseMirror[contenteditable=true]') && document.body.textContent.includes('Runtime: Zima')")
    await assert("![...document.querySelectorAll('select[aria-label=\"选择 Agent 思考等级\"]')].some(item => item.offsetParent)")
    await typeEditor('Zima 桌面冒烟')
    await clickAria('发送消息')
    await waitFor("document.body.textContent.includes('Zima 回复：Zima 桌面冒烟') && !document.body.textContent.includes('Agent 运行中')")
    await assert("document.querySelector('[role=img][aria-label*=\"上下文窗口 128K\"]') !== null")
    writeFileSync(join(directory, 'zima-complete.png'), (await page.webContents.capturePage()).toPNG())
    const zimaSession = (await run('window.axon.agent.listSessions()') as AgentSessionMeta[]).find((item) => item.runtimeId === 'zima')
    if (!zimaSession || !zimaSession.runtimeSessionFile || !zimaSession.runtimeSessionFile.endsWith('state.json')) {
      throw new Error('Zima 桌面会话未保存 runtime 恢复凭据')
    }
    const zimaKinds = (await run(`window.axon.agent.getMessages(${JSON.stringify(zimaSession.id)})`) as SDKMessage[]).map((message) => message.type)
    if (zimaKinds.join(',') !== 'user,system,assistant,result') {
      throw new Error(`Zima 桌面会话 JSONL 消息异常：${zimaKinds.join(',')}`)
    }
    page.webContents.reload()
    await waitFor("document.body.textContent.includes('Zima 回复：Zima 桌面冒烟') && !!document.querySelector('.ProseMirror[contenteditable=true]')")
    if (!(await run('window.axon.agent.listSessions()') as AgentSessionMeta[]).some((item) => item.runtimeId === 'pi')) throw new Error('Pi 会话在 Zima 创建后丢失')
  }

  console.log(`Agent 独立后端冒烟通过：项目工作区、思考等级、项目指令、Skills、MCP 配置、记忆刷新与草稿保护、精确 Grant 交付、子任务卡与详情、双侧栏/文件监听、用量、变更/Diff、完整 JSONL/新 PID 恢复、阅读与工具长结果、同轮追问、部分历史/暂停凭据重启恢复、主窗与浮窗交替继续及来源标记${zimaPython ? '、Zima 创建/发送/恢复及 Pi 并存' : ''}。模型/工具事件为中立夹具，不代表真实 Pi SDK 或 Seatbelt 执行验收。截图目录：${directory}`)
  await finish(0)
}).catch((error: unknown) => { void finish(1, error) })
