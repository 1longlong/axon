/** 独立 Electron 冒烟入口：验证真实 Tray 与 macOS Dock 原生 API。 */
import { app } from 'electron'
import { join } from 'node:path'
import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { createTray, destroyTray, hasTray } from '../src/main/tray'

const directory = mkdtempSync(join(tmpdir(), 'axon-desktop-smoke-'))
app.setPath('userData', join(directory, 'electron'))
const timeout = setTimeout(() => {
  console.error('桌面能力冒烟验证超时')
  app.exit(1)
}, 10_000)

void app.whenReady().then(async () => {
  const created = createTray({
    isMainWindowVisible: () => false,
    showMainWindow: () => {},
    hideMainWindow: () => {},
    listProjects: () => [{ id: 'project-smoke', name: '冒烟项目' }],
    dispatchAction: () => {},
    quit: () => {},
  })
  if (!created || !hasTray()) throw new Error('真实 Tray 创建失败')

  if (process.platform === 'darwin' && app.dock) {
    app.dock.setBadge('2')
    if (app.dock.getBadge() !== '2') throw new Error('Dock 数字角标写入失败')
    app.dock.setBadge('!')
    if (app.dock.getBadge() !== '!') throw new Error('Dock 等待角标写入失败')
    app.dock.setBadge('')
    await app.dock.hide()
    await app.dock.show()
  }

  destroyTray()
  if (hasTray()) throw new Error('Tray 销毁后仍被持有')
  clearTimeout(timeout)
  console.log('桌面能力冒烟验证通过：Tray 位图、生命周期与 Dock 角标/显隐。')
  app.quit()
}).catch((error) => {
  console.error(error)
  app.exit(1)
})
