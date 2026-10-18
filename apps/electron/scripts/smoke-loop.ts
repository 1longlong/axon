/** Loop 源码桌面闭环：生产后端/真实 Pi 与 Seatbelt，仅模型 SSE 为本机夹具。 */
import { app, BrowserWindow } from 'electron'
import { createServer } from 'node:http'
import { mkdirSync, mkdtempSync, realpathSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import type { LoopRunDetail, LoopSummary } from '@axon/shared'
import { startDesktopSmokeBackend } from '../test-support/desktop-smoke-backend'
import type { DesktopSmokeBackend } from '../test-support/desktop-smoke-backend'
import { setMainWindow } from '../src/main/lib/desktop/main-window-store'

const directory = realpathSync(mkdtempSync(join(tmpdir(), 'axon-loop-desktop-')))
const workspace = join(directory, 'workspace')
mkdirSync(workspace)
app.setPath('userData', join(directory, 'electron'))
app.on('window-all-closed', () => {})
process.env.ZDOTDIR = directory
for (const key of ['HTTP_PROXY', 'HTTPS_PROXY', 'ALL_PROXY', 'http_proxy', 'https_proxy', 'all_proxy']) delete process.env[key]
process.env.NO_PROXY = '127.0.0.1,localhost'
let bridge: DesktopSmokeBackend | undefined, win: BrowserWindow | undefined
let finishing: Promise<void> | undefined
let stage = '初始化', requests = 0, toolResults = '', held = false, canceledConnection = false
const dashboard = '<section><h3>验收面板</h3><axon-chart series="count"></axon-chart><axon-tabs tabs="内容,日历,看板"><section><axon-embed match="*.md"></axon-embed></section><section><axon-calendar></axon-calendar></section><section><axon-kanban columns="report,done"></axon-kanban></section></axon-tabs></section>'
const quote = (value: string): string => `'${value.replaceAll("'", "'\\''")}'`
const model = createServer((request, response) => {
  const chunks: Buffer[] = []
  request.on('data', (chunk: Buffer) => chunks.push(chunk))
  request.on('end', () => {
    try {
      if (request.url === '/mcp') {
        const rpc = JSON.parse(Buffer.concat(chunks).toString('utf8')) as { id?: number; method?: string }
        if (rpc.id === undefined) { response.writeHead(202).end(); return }
        const result = rpc.method === 'initialize' ? { protocolVersion: '2025-03-26', capabilities: { tools: {} }, serverInfo: { name: 'axon-loop-fixture', version: '1' } }
          : rpc.method === 'tools/list' ? { tools: [{ name: 'lookup', description: '独立 Loop 测试工具', inputSchema: { type: 'object', properties: {} } }] }
          : { content: [{ type: 'text', text: '本机 MCP 回报' }] }
        response.writeHead(200, { 'content-type': 'application/json' }).end(JSON.stringify({ jsonrpc: '2.0', id: rpc.id, result }))
        return
      }
      requests++
      if (requests > 14) throw new Error('请求次数超限')
      const body = JSON.parse(Buffer.concat(chunks).toString('utf8')) as {
        messages: Array<{ role: string; content: unknown }>
        tools?: Array<{ function: { name: string } }>
      }
      const tool = body.tools?.find((item) => item.function.name.toLowerCase() === 'bash')
      const delegate = body.tools?.find((item) => item.function.name === 'Agent')
      const results = body.messages.filter((message) => message.role === 'tool')
      const result = results.at(-1)
      if (result) toolResults = JSON.stringify(result.content)
      const prompt = body.messages.filter((message) => message.role === 'user').map((message) => typeof message.content === 'string' ? message.content : JSON.stringify(message.content)).join('\n')
      const frame = (value: unknown): string => `data: ${JSON.stringify(value)}\n\n`
      const preparing = prompt.includes('这是首次配置准备轮')
      if (prompt.includes('名称：取消验收') && !preparing) {
        held = true
        response.on('close', () => { canceledConnection = true })
        response.writeHead(200, { 'content-type': 'text/event-stream' })
        response.write(frame({ id: 'loop-cancel', model: 'axon-loop-fixture', choices: [{ index: 0, delta: { role: 'assistant', content: '执行中，等待取消。' }, finish_reason: null }] }))
        return
      }
      const task = /任务文档：([^\n]+)/.exec(prompt)?.[1]
      const artifact = task ? join(task.slice(0, task.lastIndexOf('/')), 'result.md') : ''
      const editing = prompt.includes('这是用户明确要求的编辑轮')
      const command = preparing ? `axon loop set-schema --body ${quote('[{"key":"count","label":"数量","unit":"个"}]')} && axon loop set-ui --body ${quote(dashboard)} && axon loop report --status resolved --message ${quote('指标和持续面板已自动生成')}`
        : editing ? `axon loop set-task --body ${quote('修改后的任务规范')} && axon loop report --status resolved --message ${quote('已按用户要求修改任务')}`
        : `printf '%s\\n' ${quote('---\ntype: report\ntitle: 验收产物\ndate: 2026-10-17\n---\n# 本次结果\n真实工具写入的历史产物。')} > ${quote(artifact)} && axon loop finish --message ${quote('Loop 桌面闭环完成')} --reason ${quote('已生成产物并通过 CLI 回报')} --state ${quote('{"count":1}')}`
      // 根会话先真实委派一个前台子任务，子会话独立返回，再由根写产物和 CLI 回报。
      const delta = (editing || preparing) && tool && !result
        ? { role: 'assistant', tool_calls: [{ index: 0, id: 'loop-edit-bash', type: 'function', function: { name: tool.function.name, arguments: JSON.stringify({ command, workdir: workspace }) } }] }
        : !editing && !preparing && delegate && !result && task
        ? { role: 'assistant', tool_calls: [{ index: 0, id: 'loop-smoke-agent', type: 'function', function: { name: delegate.function.name,
          arguments: JSON.stringify({ description: '子任务验收', prompt: '这是 Loop 验收子任务。只回复子任务已完成。', subagent_type: 'coder' }) } }] }
        : !editing && !preparing && tool && results.length === 1 && task
        ? { role: 'assistant', tool_calls: [{ index: 0, id: 'loop-smoke-bash', type: 'function', function: { name: tool.function.name, arguments: JSON.stringify({ command, workdir: workspace }) } }] }
        : { role: 'assistant', content: 'Loop 执行完成。' }
      response.writeHead(200, { 'content-type': 'text/event-stream' })
      response.end(frame({ id: 'loop-smoke', model: 'axon-loop-fixture', choices: [{ index: 0, delta, finish_reason: null }] })
        + frame({ id: 'loop-smoke', model: 'axon-loop-fixture', choices: [{ index: 0, delta: {}, finish_reason: 'tool_calls' in delta ? 'tool_calls' : 'stop' }], usage: { prompt_tokens: 200, completion_tokens: 20, total_tokens: 220 } }) + 'data: [DONE]\n\n')
    } catch { response.writeHead(400); response.end('本机夹具请求无效') }
  })
})
const deadline = setTimeout(() => void finish(1, new Error(`Loop 桌面验收超时：${stage}`)), 120_000)

/** 只关闭测试自有窗口、后端和回环服务，保留截图/隔离数据供核验。 */
function finish(code: number, cause?: unknown): Promise<void> {
  return finishing ??= (async () => {
    clearTimeout(deadline)
    if (cause) {
      console.error('[Loop 桌面] 失败阶段', stage, cause, '目录', directory, '工具结果', toolResults.slice(0, 2000))
      if (win && !win.isDestroyed()) {
        console.error(await win.webContents.executeJavaScript('document.body.innerText.slice(-2000)').catch(() => '页面不可读'))
        console.error('[页面弹窗]', await win.webContents.executeJavaScript(`Array.from(document.querySelectorAll('[role="dialog"]'), item => ({ label:item.getAttribute('aria-label'), visible:item.getClientRects().length > 0, text:item.textContent.slice(0,300) }))`).catch(() => '弹窗不可读'))
        try { writeFileSync(join(directory, 'failed.png'), (await win.webContents.capturePage()).toPNG()) } catch { /* 不阻挡资源收束。 */ }
      }
    }
    win?.destroy()
    try { await bridge?.close() } catch { code = 1 }
    model.closeAllConnections(); model.close()
    console.log('[Loop 桌面] 证据目录', directory, '模型请求', requests)
    app.exit(code)
  })()
}

void app.whenReady().then(async () => {
  await new Promise<void>((done) => model.listen(0, '127.0.0.1', done))
  const address = model.address()
  if (!address || typeof address === 'string') throw new Error('模型回环未就绪')
  const page = new BrowserWindow({ width: 1420, height: 940, show: false, webPreferences: {
    preload: resolve('dist/preload.cjs'), contextIsolation: true, nodeIntegration: false, backgroundThrottling: false,
  } })
  win = page; setMainWindow(page)
  page.webContents.on('console-message', (_event, level, message) => { if (level >= 3) console.error('[页面]', message) })
  const run = <T>(script: string): Promise<T> => page.webContents.executeJavaScript(script) as Promise<T>
  const wait = async (check: () => Promise<boolean>): Promise<void> => {
    const end = Date.now() + 25000
    while (Date.now() < end) { if (await check()) return; await new Promise<void>((done) => setTimeout(done, 70)) }
    throw new Error(`页面未就绪：${stage}`)
  }
  const click = async (text: string): Promise<void> => {
    const expression = `[...document.querySelectorAll('button')].find(item => item.offsetParent && !item.disabled && (item.textContent.trim() === ${JSON.stringify(text)} || item.getAttribute('aria-label') === ${JSON.stringify(text)}))`
    await wait(() => run(`Boolean(${expression})`)); await run(`${expression}.click()`)
  }
  const fill = async (label: string, value: string): Promise<void> => {
    await run(`(() => { const label = [...document.querySelectorAll('label')].find(item => item.textContent.trim().startsWith(${JSON.stringify(label)})); const input = label?.querySelector('input,textarea'); if (!input) throw new Error('字段不存在'); const proto = input.tagName === 'TEXTAREA' ? HTMLTextAreaElement.prototype : HTMLInputElement.prototype; Object.getOwnPropertyDescriptor(proto,'value').set.call(input,${JSON.stringify(value)}); input.dispatchEvent(new Event('input',{bubbles:true})); })()`)
  }
  const capture = async (name: string): Promise<void> => {
    page.show(); page.focus()
    await run('new Promise(done => requestAnimationFrame(() => requestAnimationFrame(done)))')
    writeFileSync(join(directory, name), (await page.webContents.capturePage()).toPNG())
  }
  bridge = await startDesktopSmokeBackend({ directory, mainWindow: page,
    pickLocalWorkspace: async () => ({ canceled: false, path: workspace, suggestedName: '独立 Loop 工作目录' }) })
  await page.loadFile(resolve('dist/renderer/index.html'))
  stage = '新建项目渠道与 Loop 表单'
  await wait(() => run('Boolean(window.axon?.loops)'))
  await run(`(async () => {
    const project = await window.axon.agentProjects.create({name:'Loop 验收项目',workspace:{kind:'local',path:${JSON.stringify(workspace)}}});
    const channel = await window.axon.channels.create({name:'本机 Loop 模型',provider:'custom',baseUrl:${JSON.stringify(`http://127.0.0.1:${address.port}/v1`)},apiKey:'synthetic-loop-key',models:[{id:'axon-loop-fixture',name:'Loop 模型',enabled:true}]});
    await window.axon.agent.createSession({projectId:project.id,channelId:channel.id,modelId:'axon-loop-fixture',title:'导航保留会话一'});
    await window.axon.agent.createSession({projectId:project.id,channelId:channel.id,modelId:'axon-loop-fixture',title:'导航保留会话二'});
    window.dispatchEvent(new Event('focus'));
  })()`)
  stage = '三模块入口与表单导航保护'
  await click('Agent')
  await click('导航保留会话一')
  await wait(() => run(`Boolean(document.querySelector('[aria-label="消息输入"]'))`))
  // 保存实际 DOM 身份，证明切换模块没有卸载当前会话输入框。
  await run(`window.navigationInput = document.querySelector('[aria-label="消息输入"]'); void 0`)
  await click('Loop')
  await wait(() => run(`Boolean(document.querySelector('nav[aria-label="Loop 任务导航"]'))`))
  if (!await run(`(() => { const side = document.querySelector('aside[aria-label="左侧导航栏"]'); return side.querySelectorAll('[aria-pressed="true"]').length === 1 && side.querySelector('[aria-label="Loop 模块"][aria-pressed="true"]') && !side.textContent.includes('项目与会话') && !side.textContent.includes('导航保留会话'); })()`)) throw new Error('Loop 仍混有会话导航或高亮重复')
  await click('收起侧栏')
  if (!await run(`document.querySelectorAll('[aria-label="应用模块"] button').length === 3`)) throw new Error('收起后缺少模块入口')
  await wait(() => run(`document.body.innerText.includes('让任务持续推进')`))
  await capture('navigation-collapsed.png')
  await click('展开侧栏')
  await click('Agent')
  await wait(() => run(`window.navigationInput === document.querySelector('[aria-label="消息输入"]') && window.navigationInput.offsetParent !== null`))
  if (!await run(`Boolean([...document.querySelectorAll('aside [aria-current="page"]')].find(item => item.textContent.trim() === '导航保留会话一'))`)) throw new Error('未恢复最近实际选择的会话')
  await click('Loop')
  await wait(() => run(`document.body.innerText.includes('让任务持续推进')`))
  if (!await run(`(() => { const buttons = [...document.querySelectorAll('.axon-loop-ui button, nav[aria-label="Loop 任务导航"] button')].filter(item => item.textContent.trim() === '新建 Loop' || item.textContent.trim() === '创建一个 Loop →'); return buttons.length === 3 && buttons.every(item => { const style = getComputedStyle(item); return parseFloat(style.borderTopLeftRadius) >= item.getBoundingClientRect().height / 2 && parseFloat(style.borderTopRightRadius) >= item.getBoundingClientRect().height / 2; }); })()`)) throw new Error('Loop 按钮没有使用完整半圆胶囊')
  await capture('pill-buttons.png')
  await click('新建 Loop')
  await wait(() => run(`document.querySelector('form select')?.options.length > 1`))
  await fill('名称', '尚未保存的输入')
  // 页面内的函数仅供本次确认分支使用，不能作为跨进程返回值传给 Electron。
  await run(`window.originalConfirm = window.confirm; window.confirm = () => false; void 0`)
  await click('Chat')
  if (!await run(`document.querySelector('form input')?.value === '尚未保存的输入' && Boolean(document.querySelector('[aria-label="Loop 模块"][aria-pressed="true"]'))`)) throw new Error('取消离开后表单丢失')
  await click('任务总览')
  if (!await run(`document.querySelector('form input')?.value === '尚未保存的输入'`)) throw new Error('页内导航绕过未保存保护')
  await run(`window.confirm = () => true; void 0`)
  await click('Chat')
  await click('Loop')
  await wait(() => run(`!document.querySelector('.axon-loop-ui form')`))
  await run(`window.confirm = window.originalConfirm; void 0`)
  await click('新建 Loop')
  await wait(() => run(`document.querySelector('form select')?.options.length > 1`))
  await fill('名称', '桌面验收 Loop')
  stage = '不选目录也能配置 MCP，测试条件有明确提示'
  await run(`document.querySelector('.axon-loop-ui details').open = true`)
  await click('配置 MCP')
  await click('添加服务器')
  if (!await run(`(() => { const dialog = document.querySelector('[aria-label="配置 桌面验收 Loop 的 MCP 服务"]'); const button = [...dialog.querySelectorAll('button')].find(item => item.textContent.trim() === '测试连接'); return button.disabled && dialog.textContent.includes('请先在创建页选择工作目录'); })()`)) throw new Error('未选目录的 MCP 测试缺少明确禁用提示')
  await capture('loop-mcp-no-workspace.png')
  await click('关闭 MCP 配置')
  await click('选择文件夹')
  if (!await run(`document.querySelector('[data-testid="loop-workspace-path"]').textContent === ${JSON.stringify(workspace)} && !document.querySelector('section[aria-labelledby="loop-workspace-label"] input')`)) throw new Error('Loop 目录选择仍有输入框或未接收目录')
  await fill('每次执行的任务', '生成一份 Markdown 产物，并通过 CLI 声明目标完成。')
  await fill('完成目标', '生成产物并完成回报')
  await fill('Cron', '0 0 1 1 *')
  if (!await run(`(() => { const form = document.querySelector('.axon-loop-ui form'); return form.querySelectorAll('textarea').length === 2 && !form.textContent.includes('指标定义 JSON') && !form.textContent.includes('生成式面板 HTML') && !form.textContent.includes('JS 预检'); })()`)) throw new Error('创建仍要求填写技术配置')
  stage = '新建 Loop MCP 草稿与真实连接测试'
  await run(`document.querySelector('.axon-loop-ui details').open = true`)
  await click('配置 MCP')
  await click('添加服务器')
  await run(`(() => { const dialog = document.querySelector('[aria-label="配置 桌面验收 Loop 的 MCP 服务"]'); const select = dialog.querySelector('select'); Object.getOwnPropertyDescriptor(HTMLSelectElement.prototype,'value').set.call(select,'http'); select.dispatchEvent(new Event('change',{bubbles:true})); })()`)
  await fill('Streamable HTTP URL', `http://127.0.0.1:${address.port}/mcp`)
  await click('测试连接')
  await wait(() => run(`document.querySelector('[aria-label="配置 桌面验收 Loop 的 MCP 服务"] pre')?.textContent.includes('lookup') === true`))
  await click('保存')
  await wait(() => run(`document.querySelector('[aria-label="配置 桌面验收 Loop 的 MCP 服务"]')?.textContent.includes('配置已保存') === true`))
  await capture('loop-mcp-draft.png')
  await click('关闭 MCP 配置')
  await click('刷新工具列表')
  await wait(() => run(`document.querySelector('.axon-loop-ui form').textContent.includes('mcp__server__lookup')`))
  await run(`(() => { const label = [...document.querySelectorAll('.axon-loop-ui form label')].find(item => item.querySelector('code')?.textContent === 'mcp__server__lookup'); label.querySelector('input').click(); })()`)
  await capture('agent-compose.png')
  await click('创建后立即执行')
  await wait(() => run(`Boolean([...document.querySelectorAll('h1')].find(item=>item.textContent==='桌面验收 Loop'))`))
  const jobs = await run<LoopSummary[]>('window.axon.loops.list()')
  const job = jobs[0]
  if (!job || job.name !== '桌面验收 Loop') throw new Error('表单未保存到真实后端')
  if ('projectId' in job || job.workspacePath !== workspace) throw new Error('Loop 仍绑定项目')
  const mcpConfig = await run<{ servers: Record<string, { type: string }> }>(`window.axon.loops.getMcpConfig(${JSON.stringify(job.id)})`)
  if (mcpConfig.servers.server?.type !== 'http') throw new Error('Loop MCP 草稿未独立保存')
  stage = '真实 Pi / Bash / CLI / Seatbelt'
  await wait(async () => {
    const value = await run<LoopSummary[]>(`window.axon.loops.list()`)
    return !!value.find((item) => item.id === job.id)?.completedAt
  })
  const updated = (await run<LoopSummary[]>('window.axon.loops.list()'))[0]!
  if (updated.preparation !== 'ready' || updated.ui !== dashboard || updated.stateSchema[0]?.key !== 'count'
    || !updated.recentRuns.some((item) => item.role === 'setup' && item.phase === 'done')) throw new Error('初始配置没有通过真实 Agent/CLI 创作')
  // 列表展示最新活动而不保证展示回报正文；按本次真实角色/来源选记录，并等待合并刷新。
  await wait(() => run(`Boolean([...document.querySelectorAll('li button')].find(item => item.offsetParent && item.textContent.includes('手动执行 · 任务执行')))`))
  await run(`[...document.querySelectorAll('li button')].find(item => item.offsetParent && item.textContent.includes('手动执行 · 任务执行')).click()`)
  await wait(() => run(`Boolean([...document.querySelectorAll('h1')].find(item=>item.textContent==='Run · 桌面验收 Loop'))`))
  const detail = await run<LoopRunDetail>(`window.axon.loops.runDetail(${JSON.stringify(job.id)},${JSON.stringify(updated.latestRun!.id)})`)
  if (detail.run.phase !== 'done' || detail.run.state?.count !== 1 || !detail.artifacts.some((file) => file.path === 'result.md' && file.meta?.title === '验收产物')) throw new Error('真实结算/指标/历史产物不完整')
  const messages = await run<Array<{ type: string }>>(`window.axon.agent.getMessages(${JSON.stringify(detail.run.sessionId)})`)
  if (!messages.some((message) => message.type === 'assistant') || !detail.query.includes('任务文档')) throw new Error('执行过程引用丢失')
  const tasks = await run<Array<{ status: string; childSessionId: string }>>(`window.axon.agentTasks.list(${JSON.stringify(detail.run.sessionId)})`)
  if (tasks.length !== 1 || tasks[0]?.status !== 'completed' || (detail.run.usage?.input_tokens ?? 0) < 800) throw new Error('真实子任务未收束或用量未汇总')
  await wait(() => run(`document.body.innerText.includes('Loop 桌面闭环完成')`))
  await wait(() => run(`!document.body.innerText.includes('停止本次执行') && document.body.innerText.includes('input_tokens')`))
  await wait(() => run(`Boolean(document.querySelector('button[aria-label="查看子任务 子任务验收"]'))`))
  stage = '查看实际子任务弹窗'
  await run(`[...document.querySelectorAll('button[aria-label="查看子任务 子任务验收"]')].find(item => item.offsetParent).click()`)
  // 已缓存的 Agent 文件树也有 dialog 角色，必须定位本次真正打开的子任务弹窗。
  await wait(() => run(`document.querySelector('[role="dialog"][aria-label="子任务：子任务验收"]')?.textContent.includes('Loop 执行完成。') === true`))
  await capture('child-task.png')
  await run(`document.querySelector('button[aria-label="关闭子任务详情"]').click()`)
  await capture('run-light.png')
  stage = '任务面板与主题'
  await click('← 返回')
  await wait(() => run(`document.body.innerText.includes('验收面板')`))
  await capture('detail-light.png')
  stage = 'Loop 任务导航、搜索及阅读位置保留'
  await wait(() => run(`Boolean(document.querySelector('button[aria-label="查看 Loop 桌面验收 Loop"]'))`))
  await run(`(() => { const input = document.querySelector('[aria-label="搜索 Loop 任务"]'); Object.getOwnPropertyDescriptor(HTMLInputElement.prototype,'value').set.call(input,'不匹配的名称'); input.dispatchEvent(new Event('input',{bubbles:true})); })()`)
  await wait(() => run(`document.querySelector('nav[aria-label="Loop 任务导航"]').textContent.includes('没有匹配的任务')`))
  await run(`(() => { const input = document.querySelector('[aria-label="搜索 Loop 任务"]'); Object.getOwnPropertyDescriptor(HTMLInputElement.prototype,'value').set.call(input,''); input.dispatchEvent(new Event('input',{bubbles:true})); const root = document.querySelector('.axon-loop-ui.h-full'); root.scrollTop = 160; window.loopScroll = root.scrollTop; })()`)
  await click('Chat')
  await click('Loop')
  await wait(() => run(`document.querySelector('.axon-loop-ui.h-full').scrollTop === window.loopScroll && document.body.innerText.includes('验收面板')`))
  await capture('navigation-expanded.png')
  stage = '任务面板与历史产物弹窗'
  await run(`(() => { const scroller = document.querySelector('.axon-loop-ui.h-full'); scroller.scrollTop += document.querySelector('.loopview').getBoundingClientRect().top - 80; })()`)
  await click('日历')
  await wait(() => run(`Boolean(document.querySelector('.loopview button[title="result.md"]'))`))
  await capture('calendar.png')
  await click('看板')
  await wait(() => run(`document.querySelector('.loopview')?.textContent.includes('report') === true && !document.querySelector('.loopview')?.textContent.includes('needs columns')`))
  await capture('kanban.png')
  await run(`[...document.querySelectorAll('.loopview button')].find(item=>item.textContent.includes('验收产物')).click()`)
  await wait(() => run(`document.querySelector('.axon-loop-ui[role="dialog"]')?.textContent.includes('真实工具写入') === true`))
  await capture('artifact-modal.png')
  await run(`document.querySelector('.axon-loop-ui[role="dialog"] [aria-label="Close"]').click()`)
  stage = '模板脚本与样式净化'
  await run(`window.axon.loops.update(${JSON.stringify(job.id)},{ui:${JSON.stringify('<section id="loop-security-probe" style="position:fixed;background-image:url(https://example.invalid/leak)"><script>window.loopUnsafe=true</script><img src="https://example.invalid/leak" onerror="window.loopUnsafe=true"><a href="javascript:window.loopUnsafe=true" onclick="window.loopUnsafe=true">安全验收标记</a></section>')}})`)
  await wait(() => run(`document.querySelector('.loopview')?.textContent.includes('安全验收标记') === true`))
  if (!await run(`(() => { const root = document.querySelector('.loopview'); return !window.loopUnsafe && !root.querySelector('script,[onclick],[onerror],img[src],a[href^="javascript:"]') && !root.innerHTML.includes('position: fixed') && !root.innerHTML.includes('background-image'); })()`)) throw new Error('模板净化边界失效')
  await run(`window.axon.loops.update(${JSON.stringify(job.id)},{ui:${JSON.stringify(updated.ui)}})`)
  await wait(() => run(`document.body.innerText.includes('验收面板')`))
  await run(`window.axon.settings.update({themeMode:'dark'})`)
  await wait(() => run(`document.documentElement.classList.contains('dark')`))
  // 等颜色过渡真实落定，不能把切换过程中的白色按钮截成最终深色界面。
  await wait(() => run(`(() => { const root = document.querySelector('.axon-loop-ui.h-full'); const button = [...root.querySelectorAll('button')].find(item => item.textContent === '手动设置'); return getComputedStyle(button).backgroundColor === getComputedStyle(root).backgroundColor; })()`))
  await capture('detail-dark.png')
  stage = '明确编辑及完成反馈'
  await run(`window.axon.loops.update(${JSON.stringify(job.id)},{enabled:true})`)
  await wait(() => run(`Boolean([...document.querySelectorAll('button')].find(item=>item.textContent==='暂停计划'))`))
  await click('让 Agent 修改')
  await run(`(() => { const input = document.querySelector('textarea[aria-label="修改要求"]'); Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype,'value').set.call(input,'将任务规范改为修改后的任务规范'); input.dispatchEvent(new Event('input',{bubbles:true})); })()`)
  await click('提交修改')
  await wait(() => run(`document.body.innerText.includes('应用修改 · 已完成') && document.body.innerText.includes('已按用户要求修改任务') && document.body.innerText.includes('用户要求修改')`))
  const afterEdit = (await run<LoopSummary[]>('window.axon.loops.list()')).find((item) => item.id === job.id)!
  if (afterEdit.task !== '修改后的任务规范' || afterEdit.runCount !== 3) throw new Error('编辑结果未保存或错误地追加自动优化')
  await run(`document.querySelector('.axon-loop-ui.h-full').scrollTop = 0`)
  await capture('edit-feedback.png')
  stage = '基本设置不覆盖 Agent 生成配置'
  await click('手动设置')
  await wait(() => run(`Boolean(document.querySelector('.axon-loop-ui form'))`))
  await click('保存')
  await wait(() => run(`!document.querySelector('.axon-loop-ui form') && document.body.innerText.includes('验收面板')`))
  const preserved = (await run<LoopSummary[]>('window.axon.loops.list()')).find((item) => item.id === job.id)!
  if (preserved.ui !== updated.ui || JSON.stringify(preserved.stateSchema) !== JSON.stringify(updated.stateSchema)) throw new Error('基本设置覆盖生成配置')
  await click('暂停计划')
  stage = '真实模型流取消与实际资源退出'
  const cancelJob = await run<LoopSummary>(`window.axon.loops.create(${JSON.stringify({ name: '取消验收', workspacePath: job.workspacePath,
    channelId: job.channelId, modelId: job.modelId, task: '等待取消', goal: '不会完成', cron: '0 0 1 1 *', notify: 'never', runImmediately: true })})`)
  await wait(async () => held)
  const cancelRun = { runId: (await run<LoopSummary[]>('window.axon.loops.list()')).find((item) => item.id === cancelJob.id)!.latestRun!.id }
  await click('Chat')
  if (!(await run<LoopSummary[]>('window.axon.loops.list()')).find((item) => item.id === cancelJob.id)?.running) throw new Error('切换模块错误地停止了后台 Loop')
  await click('Loop')
  await click('Axon · Loop'); await click('取消验收')
  await wait(() => run(`Boolean([...document.querySelectorAll('button')].find(item=>item.textContent==='删除' && item.disabled))`))
  if (!await run(`window.axon.loops.stop(${JSON.stringify(cancelJob.id)},${JSON.stringify(cancelRun.runId)})`)) throw new Error('确切取消未被接受')
  await wait(async () => canceledConnection && !(await run<LoopSummary[]>('window.axon.loops.list()')).find((item) => item.id === cancelJob.id)?.running)
  const canceled = await run<LoopRunDetail>(`window.axon.loops.runDetail(${JSON.stringify(cancelJob.id)},${JSON.stringify(cancelRun.runId)})`)
  if (canceled.run.phase !== 'canceled' || canceled.job.completedAt) throw new Error('取消冒充完成')
  await run(`window.axon.loops.delete(${JSON.stringify(cancelJob.id)})`)
  stage = '删除同目录项目不影响独立 Loop'
  await run(`(async () => {
    const project = (await window.axon.agentProjects.list()).find(item => item.workspace.path === ${JSON.stringify(workspace)});
    if (!project) throw new Error('同目录项目不存在');
    for (const session of await window.axon.agent.listSessions()) if (session.projectId === project.id) await window.axon.agent.deleteSession(session.id);
    await window.axon.agentProjects.delete(project.id);
    const loop = await window.axon.loops.get(${JSON.stringify(job.id)});
    if (loop.job.workspacePath !== ${JSON.stringify(workspace)} || loop.taskFileError) throw new Error('项目删除影响了 Loop 目录');
  })()`)
  stage = '独立后端重启与历史恢复'
  const firstPid = bridge.backend.pid
  await page.loadURL('about:blank'); await bridge.close()
  bridge = await startDesktopSmokeBackend({ directory, mainWindow: page })
  if (!bridge.backend.pid || bridge.backend.pid === firstPid) throw new Error('没有重建独立服务进程')
  await page.loadFile(resolve('dist/renderer/index.html'))
  await click('Loop')
  await wait(() => run(`document.body.innerText.includes('桌面验收 Loop')`))
  const restored = (await run<LoopSummary[]>('window.axon.loops.list()')).find((item) => item.id === job.id)!
  if (restored.completedAt !== null || restored.runCount !== 3 || restored.enabled || restored.task !== '修改后的任务规范' || restored.preparation !== 'ready') throw new Error('重启后计划/编辑结果不一致')
  const restoredMcp = await run<{ servers: Record<string, { type: string }> }>(`window.axon.loops.getMcpConfig(${JSON.stringify(job.id)})`)
  if (restoredMcp.servers.server?.type !== 'http' || 'projectId' in restored) throw new Error('重启后独立 MCP 或目录归属不一致')
  const artifact = await run<{ content: string }>(`window.axon.loops.readArtifact(${JSON.stringify(job.id)},'result.md',${JSON.stringify(updated.latestRun!.id)})`)
  if (!artifact.content.includes('真实工具写入')) throw new Error('历史产物未恢复')
  await capture('restored.png')
  console.log('[Loop 桌面] 独立目录选择/MCP 草稿与真实测试/加密保存/同目录项目删除隔离/Agent 创作/真实 Pi/子任务/CLI/取消/面板/历史/新 PID 与独立 MCP 恢复完成')
  await finish(0)
}).catch((cause: unknown) => void finish(1, cause))
