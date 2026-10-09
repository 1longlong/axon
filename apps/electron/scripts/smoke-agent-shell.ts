/** 宿主模块桌面冒烟父入口只选择随应用执行器；实际 Shell/Seatbelt 在独立测试 child。 */
import { app } from 'electron'
import { spawn } from 'node:child_process'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'

const directory = mkdtempSync(join(tmpdir(), 'axon-shell-desktop-smoke-'))
app.setPath('userData', join(directory, 'electron'))

/** 启动隔离模块测试并等待实际 close；父端不创建业务或宿主执行器，不操作正式实例。 */
void app.whenReady().then(() => {
  const child = spawn(process.execPath, [resolve('dist/shell-smoke-backend.mjs')], {
    env: { ...process.env, ELECTRON_RUN_AS_NODE: '1', NODE_OPTIONS: undefined, NODE_PATH: undefined },
    stdio: ['ignore', 'pipe', 'pipe'],
  })
  child.stdout.pipe(process.stdout, { end: false })
  child.stderr.pipe(process.stderr, { end: false })
  let timedOut = false, spawnFailed = false
  // 超时只终止本次直接创建的测试 child；真实 close 前不退出父端。
  const timeout = setTimeout(() => { timedOut = true; child.kill('SIGTERM') }, 40_000)
  const terminate = setTimeout(() => { timedOut = true; child.kill('SIGKILL') }, 45_000)
  child.once('error', () => { spawnFailed = true; console.error('Shell 测试子进程启动失败') })
  child.once('close', (code) => {
    clearTimeout(timeout); clearTimeout(terminate)
    rmSync(directory, { recursive: true, force: true })
    app.exit(timedOut || spawnFailed || code !== 0 ? 1 : 0)
  })
}).catch(() => { console.error('Shell 桌面测试初始化失败'); app.exit(1) })
