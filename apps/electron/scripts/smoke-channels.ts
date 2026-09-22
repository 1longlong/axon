/** 独立 Electron 冒烟入口：真实渠道 IPC/preload/UI，所有文件隔离到临时目录。 */
import { app, BrowserWindow, ipcMain } from 'electron'
import { mkdtempSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { createServer } from 'node:http'
import { registerChannelIpcHandlers } from '../src/main/ipc/channel-ipc-handlers'
import { ChannelManager } from '../src/main/lib/channel/channel-manager'
import { ChannelNetworkService } from '../src/main/lib/channel/channel-network-service'
import { createChannelCredentialCodec } from '../src/main/lib/channel/channel-credential-codec'
import { CHAT_IPC_CHANNELS } from '@axon/shared'
import { SETTINGS_IPC_CHANNELS, USER_PROFILE_IPC_CHANNELS, WINDOW_IPC_CHANNELS } from '../src/types'

const directory = mkdtempSync(join(tmpdir(), 'axon-channel-smoke-'))
app.setPath('userData', join(directory, 'electron'))
const timeout = setTimeout(() => { console.error('渠道冒烟验证超时'); app.exit(1) }, 30000)

void app.whenReady().then(async () => {
  // 仅使用虚构密钥；冒烟不调用 Keychain，也不访问用户的真实渠道文件。
  const configPath = join(directory, 'channels.json')
  const manager = new ChannelManager({ configPath, credentialCodec: createChannelCredentialCodec() })
  let responseMode: 'ok' | 'unauthorized' | 'redirect' | 'slow' = 'ok'
  let allowTarget = false
  let requestCount = 0
  let redirectCount = 0
  const server = createServer((request, response) => {
    requestCount += 1
    if (request.url === '/redirect-target') redirectCount += 1
    if (request.headers.authorization !== 'Bearer synthetic-smoke-key') {
      response.writeHead(401).end('错误凭据')
      return
    }
    if (responseMode === 'slow') return
    if (responseMode === 'redirect') {
      response.writeHead(302, { Location: '/redirect-target' }).end()
      return
    }
    if (responseMode === 'unauthorized') {
      response.writeHead(401).end('不能回显 synthetic-smoke-key')
      return
    }
    response.writeHead(200, { 'Content-Type': 'application/json' }).end(JSON.stringify({ data: [
      { id: 'smoke-model', display_name: '不应覆盖手动别名' }, { id: 'fetched-model', display_name: '目录模型' },
    ] }))
  })
  await new Promise<void>((done) => server.listen(0, '127.0.0.1', done))
  const address = server.address()
  if (!address || typeof address === 'string') throw new Error('本地测试服务启动失败')
  const baseUrl = `http://127.0.0.1:${address.port}/v1`
  const network = new ChannelNetworkService({ manager, timeoutMs: 1000, confirmTarget: async (_owner, url) => {
    if (url !== `${baseUrl}/models`) throw new Error('测试不允许访问外部服务')
    return allowTarget
  } })
  registerChannelIpcHandlers(manager, network)
  // 渠道窗口仍会启动全局 Chat 状态；返回空索引，避免无关的未注册 IPC 噪音。
  ipcMain.handle(CHAT_IPC_CHANNELS.LIST_CONVERSATIONS, () => [])
  ipcMain.handle(SETTINGS_IPC_CHANNELS.GET, () => ({ themeMode: 'light' }))
  ipcMain.handle(SETTINGS_IPC_CHANNELS.UPDATE, (_event, value: unknown) => value)
  ipcMain.handle(USER_PROFILE_IPC_CHANNELS.GET, () => ({ userName: '测试用户', avatar: '🧪' }))
  ipcMain.handle(WINDOW_IPC_CHANNELS.IS_MAXIMIZED, () => false)
  const win = new BrowserWindow({ width: 1100, height: 780, show: false, webPreferences: {
    preload: resolve('dist/preload.cjs'), contextIsolation: true, nodeIntegration: false, backgroundThrottling: false,
  } })
  const run = (script: string): Promise<unknown> => win.webContents.executeJavaScript(script)
  const waitFor = async (expression: string): Promise<void> => {
    const started = Date.now()
    while (!(await run(expression))) {
      if (Date.now() - started > 4000) throw new Error(`等待界面失败：${expression}`)
      await new Promise((done) => setTimeout(done, 25))
    }
  }
  const click = (text: string): Promise<unknown> => run(`(() => {
    const button = [...document.querySelectorAll('button')].find(item => item.textContent.trim() === ${JSON.stringify(text)});
    if (!button || button.disabled) throw new Error('按钮不可用'); button.click();
  })()`)
  const fill = (selector: string, value: string): Promise<unknown> => run(`(() => {
    const input = document.querySelector(${JSON.stringify(selector)});
    Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value').set.call(input, ${JSON.stringify(value)});
    input.dispatchEvent(new Event('input', { bubbles: true }));
  })()`)
  const assert = async (expression: string): Promise<void> => {
    if (!(await run(expression))) throw new Error(`渠道冒烟断言失败：${expression}`)
  }

  await win.loadFile(resolve('dist/renderer/index.html'))
  await waitFor("[...document.querySelectorAll('button')].some(item => item.textContent.trim() === '设置')")
  await click('设置')
  await click('模型渠道')
  await waitFor("document.body.textContent.includes('还没有配置任何模型')")
  await click('添加配置')
  await fill('input[maxlength]', '冒烟渠道')
  await fill('input[type=password]', 'synthetic-smoke-key')
  await fill('input[type=url]', baseUrl)
  await fill('[aria-label="新模型 ID"]', ' smoke-model ')
  await assert("document.querySelector('button[type=submit]').disabled")
  await run("document.querySelector('[aria-label=\"添加模型\"]').click()")
  await assert("document.querySelector('[aria-label=\"模型显示名称 smoke-model\"]').value === 'smoke-model'")
  await fill('[aria-label="新模型 ID"]', 'smoke-model')
  await run("document.querySelector('[aria-label=\"添加模型\"]').click()")
  await assert("document.body.textContent.includes('该模型 ID 已存在')")
  await fill('[aria-label="新模型 ID"]', '')
  await click('测试目录连接')
  await waitFor("document.body.textContent.includes('请求已取消')")
  if (requestCount !== 0) throw new Error('拒绝确认后仍然发送了请求')
  allowTarget = true
  await click('测试目录连接')
  await waitFor("document.body.textContent.includes('模型目录连接正常')")
  await assert("!document.querySelector('[aria-label=\"模型显示名称 fetched-model\"]')")
  await click('从供应商获取')
  await waitFor("!!document.querySelector('[aria-label=\"模型显示名称 fetched-model\"]')")
  await assert("!document.querySelector('[aria-label=\"启用模型 fetched-model\"]').checked")
  await assert("document.querySelector('[aria-label=\"模型显示名称 smoke-model\"]').value === 'smoke-model'")
  if (manager.list().length !== 0) throw new Error('拉取结果在创建前提前落盘')
  responseMode = 'unauthorized'
  await click('从供应商获取')
  await waitFor("document.body.textContent.includes('鉴权失败')")
  await assert("!!document.querySelector('[aria-label=\"模型显示名称 fetched-model\"]') && !document.body.textContent.includes('synthetic-smoke-key')")
  responseMode = 'redirect'
  await click('测试目录连接')
  await waitFor("document.body.textContent.includes('已阻止重定向')")
  if (redirectCount !== 0) throw new Error('重定向被跟随')
  responseMode = 'slow'
  await click('从供应商获取')
  await waitFor("document.body.textContent.includes('取消请求')")
  await click('取消请求')
  await waitFor("document.body.textContent.includes('请求已取消') && !document.body.textContent.includes('取消请求')")
  await click('测试目录连接')
  await waitFor("document.body.textContent.includes('请求超时')")
  responseMode = 'ok'
  // 对话框响应仅在这个隔离测试窗口注入，产品代码仍使用原生确认。
  await run('void (window.confirm = () => false)')
  await click('外观设置')
  await assert("!!document.querySelector('form')")
  await run("window.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape' }))")
  await assert("!!document.querySelector('form')")
  await click('创建')
  await waitFor("document.body.textContent.includes('冒烟渠道') && !document.querySelector('form')")
  await assert("window.axon.channels.list().then(items => items.length === 1 && items[0].hasApiKey && !('apiKey' in items[0]) && !('encryptedCredential' in items[0]))")
  await assert("window.axon.channels.list().then(items => items[0].models.length === 2 && items[0].models[0].source === 'manual')")
  await run("document.querySelector('[aria-label=\"编辑 冒烟渠道\"]').click()")
  await assert("document.querySelector('input[type=password]').value === ''")
  await click('测试目录连接')
  await waitFor("document.body.textContent.includes('模型目录连接正常')")
  await fill('input[maxlength]', '冒烟渠道已编辑')
  await fill('[aria-label="模型显示名称 smoke-model"]', '模型别名')
  await run("document.querySelector('[aria-label=\"启用模型 smoke-model\"]').click()")
  await click('保存')
  await waitFor("document.body.textContent.includes('冒烟渠道已编辑') && !document.querySelector('form')")
  const saved = manager.list()[0]!
  if (manager.resolve(saved.id).apiKey !== 'synthetic-smoke-key') throw new Error('空密钥保存覆盖了原凭据')
  if (saved.models[0]?.name !== '模型别名' || saved.models[0]?.enabled !== false) throw new Error('模型编辑未保存')
  await run("document.querySelector('[role=switch]').click()")
  await waitFor("!document.querySelector('[role=switch]').checked && !document.querySelector('[role=switch]').disabled")
  const reopened = new ChannelManager({ configPath, credentialCodec: createChannelCredentialCodec() })
  if (reopened.list()[0]?.enabled !== false) throw new Error('启停状态未持久化')
  win.webContents.reload()
  await waitFor("[...document.querySelectorAll('button')].some(item => item.textContent.trim() === '设置')")
  await click('设置')
  await click('模型渠道')
  await waitFor("document.body.textContent.includes('冒烟渠道已编辑')")
  writeFileSync(join(directory, 'channels.png'), (await win.webContents.capturePage()).toPNG())
  await run("document.querySelector('[aria-label=\"编辑 冒烟渠道已编辑\"]').click()")
  await assert("document.querySelector('[aria-label=\"模型显示名称 smoke-model\"]').value === '模型别名'")
  await assert("!document.querySelector('[aria-label=\"启用模型 smoke-model\"]').checked")
  await assert("document.querySelector('[aria-label=\"模型显示名称 fetched-model\"]').value === '目录模型'")
  // 只有待添加输入也应触发离开保护；确认放弃不应修改磁盘。
  await fill('[aria-label="新模型显示名称"]', '尚未添加')
  await run('void (window.confirm = () => false)')
  await run("document.querySelector('[aria-label=\"返回渠道列表\"]').click()")
  await assert("!!document.querySelector('form')")
  await run('void (window.confirm = () => true)')
  await run("document.querySelector('[aria-label=\"返回渠道列表\"]').click()")
  await waitFor("!document.querySelector('form')")
  await run("document.querySelector('[aria-label=\"编辑 冒烟渠道已编辑\"]').click()")
  await assert("document.querySelector('[aria-label=\"新模型显示名称\"]').value === ''")
  await run("document.querySelector('[aria-label=\"新模型 ID\"]').scrollIntoView({ block: 'center' })")
  // 等待隐藏窗口绘制新帧，避免截图仍停留在上一次表单状态。
  await run('new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(() => resolve(true))))')
  writeFileSync(join(directory, 'models.png'), (await win.webContents.capturePage()).toPNG())
  await run('void (window.confirm = () => false)')
  await run("document.querySelector('[aria-label=\"删除模型 smoke-model\"]').click()")
  await assert("!!document.querySelector('[aria-label=\"模型显示名称 smoke-model\"]')")
  await run('void (window.confirm = () => true)')
  await run("document.querySelector('[aria-label=\"删除模型 smoke-model\"]').click()")
  await assert("!document.querySelector('[aria-label=\"模型显示名称 smoke-model\"]')")
  await run("document.querySelector('[aria-label=\"删除模型 fetched-model\"]').click()")
  if (manager.get(saved.id)?.models.length !== 2) throw new Error('模型删除在保存前提前落盘')
  await click('保存')
  await waitFor("!document.querySelector('form')")
  if (manager.get(saved.id)?.models.length !== 0) throw new Error('模型清空未持久化')
  await run('void (window.confirm = () => false)')
  await run("document.querySelector('[aria-label=\"删除 冒烟渠道已编辑\"]').click()")
  await assert("window.axon.channels.list().then(items => items.length === 1)")
  await run('void (window.confirm = () => true)')
  await run("document.querySelector('[aria-label=\"删除 冒烟渠道已编辑\"]').click()")
  await waitFor("document.body.textContent.includes('还没有配置任何模型')")
  if (manager.list().length !== 0) throw new Error('删除未持久化')
  console.log(`渠道冒烟验证通过：CRUD、模型管理、目录连接与拉取、目标拒绝、鉴权错误、重定向阻止、取消、超时和重载恢复。截图目录：${directory}`)
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
