/** 明确指定现有渠道的 Zima 诊断；父端仅复制密文、提供 safeStorage 和管理独立 child。 */
import { app } from 'electron'
import { chmodSync, copyFileSync, mkdirSync, mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { AppServerProcess } from '../src/main/lib/desktop/app-server-process'
import { createDesktopAppServerLaunch } from '../src/main/lib/desktop/app-server-launch'
import { getDesktopBackendPaths } from '../src/main/lib/desktop/backend-paths'
import { createElectronCredentialCodec } from '../src/main/lib/channel/electron-channel-credential-codec'

interface LiveReport {
  runtime: string
  provider: string
  model: string
  result: string
  answer: string
}
// 保持安全存储的应用身份；测试不覆盖正式 HOME，也不写入正式配置。
app.setName('@axon/electron')

/** 只读快照现有密文到隔离数据目录；实际解密/查询由后端经私有父桥处理。 */
void app.whenReady().then(async () => {
  const python = process.env.AXON_ZIMA_PYTHON, channelId = process.env.AXON_ZIMA_LIVE_CHANNEL_ID
  if (!python || !channelId) throw new Error('必须指定受控 Python 和明确的本机渠道 ID')
  const directory = mkdtempSync(join(tmpdir(), 'axon-zima-live-model-'))
  const dataDir = join(directory, 'backend'), homeDir = join(directory, 'home')
  mkdirSync(dataDir, { mode: 0o700 }); mkdirSync(homeDir, { mode: 0o700 })
  const backend = new AppServerProcess({
    launch: { ...createDesktopAppServerLaunch({
      executable: process.execPath, packaged: false, mainDirectory: resolve('dist'),
      resourcesDirectory: process.resourcesPath, dataDir, homeDir, applicationVersion: app.getVersion(),
      environment: { ...process.env, AXON_ZIMA_PYTHON: python },
    }), entryArgs: [resolve('dist/zima-live-backend.mjs')] },
    credentialCodec: createElectronCredentialCodec(), stopTimeoutMs: 10_000,
  })
  const abort = new AbortController()
  let timer: ReturnType<typeof setTimeout> | undefined
  try {
    const snapshot = join(dataDir, 'channels.json')
    copyFileSync(join(getDesktopBackendPaths().dataDir, 'channels.json'), snapshot)
    chmodSync(snapshot, 0o600)
    await backend.start()
    if (backend.pid === process.pid) throw new Error('诊断未使用独立进程')
    timer = setTimeout(() => abort.abort(), 45_000)
    const report = await backend.readyPeer().request('axon/test/zima/live', {
      channelId, ...(process.env.AXON_ZIMA_LIVE_MODEL_ID ? { modelId: process.env.AXON_ZIMA_LIVE_MODEL_ID } : {}),
    }, { signal: abort.signal, timeoutMs: 0 }) as unknown as LiveReport
    console.log(JSON.stringify(report))
    if (report.result !== 'success') throw new Error('真实模型诊断未成功')
  } finally {
    if (timer) clearTimeout(timer)
    try { await backend.stop() } finally { rmSync(directory, { recursive: true, force: true }) }
  }
  app.exit(0)
}).catch(() => { console.error('Zima 独立模型诊断失败；请检查明确指定的渠道、模型和受控 Python'); app.exit(1) })
