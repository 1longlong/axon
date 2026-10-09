import { describe, expect, test } from 'bun:test'
import { EventEmitter } from 'node:events'
import { createRequire } from 'node:module'
import type { MainWindowState } from '@axon/shared'
import type { MainWindowController, MainWindowControllerOptions } from './main-window-controller'

interface WindowFixtureOptions { width: number; height: number; x?: number; y?: number }
class WindowFixture extends EventEmitter {
  destroyed = false
  readonly webContents = Object.assign(new EventEmitter(), {
    send: () => {}, setWindowOpenHandler: () => {}, openDevTools: () => {}, isLoadingMainFrame: () => false,
  })
  constructor(readonly options: WindowFixtureOptions) { super() }
  isDestroyed(): boolean { return this.destroyed }
  isMaximized(): boolean { return false }
  isFullScreen(): boolean { return false }
  getBounds() { return { width: this.options.width, height: this.options.height, x: this.options.x ?? 0, y: this.options.y ?? 0 } }
  getNormalBounds() { return this.getBounds() }
  setMenuBarVisibility(): void {}
  async loadFile(): Promise<void> {}
  async loadURL(): Promise<void> {}
  destroy(): void { this.destroyed = true; this.emit('closed') }
}

/** 单独装载真实窗口类，原生 API 为夹具；不污染其他测试的 Electron 模块注册表。 */
async function loadController() {
  const windows: WindowFixture[] = [], require = createRequire(import.meta.url)
  const result = await Bun.build({ entrypoints: [`${import.meta.dir}/main-window-controller.ts`], target: 'node', format: 'cjs', external: ['electron'] })
  if (!result.success) throw new Error('窗口测试入口构建失败')
  const screen = { getAllDisplays: () => [{ workArea: { width: 1920, height: 1080, x: 0, y: 0 } }],
    getPrimaryDisplay: () => ({ workArea: { width: 1920, height: 1080, x: 0, y: 0 } }) }
  const electron = {
    app: { isPackaged: true }, screen, shell: {}, nativeImage: { createFromPath: () => ({}) },
    BrowserWindow: class extends WindowFixture {
      constructor(options: WindowFixtureOptions) { super(options); windows.push(this) }
    },
  }
  const module = { exports: {} as { MainWindowController: new (options: MainWindowControllerOptions) => MainWindowController } }
  const run = new Function('require', 'module', 'exports', '__dirname', 'process', await result.outputs[0]!.text())
  run((name: string) => name === 'electron' ? electron : require(name), module, module.exports, import.meta.dir,
    { platform: process.platform, resourcesPath: import.meta.dir })
  return { Controller: module.exports.MainWindowController, windows }
}

describe('主窗口注入设置入口', () => {
  test('启动页不读业务设置；正式窗口使用注入状态且保留最小宽度', async () => {
    const f = await loadController()
    let reads = 0
    const state: MainWindowState = { width: 1280, height: 720, x: 10, y: 20, isMaximized: false }
    const controller = new f.Controller({ hasTray: () => false, onAttentionAcknowledged: () => {},
      getWindowState: () => { reads++; return state }, saveWindowState: () => {} })
    controller.createStartupSplashWindow()
    expect(reads).toBe(0)
    expect(f.windows[0]?.options).toMatchObject({ width: 1400, height: 900 })
    controller.createMainWindow()
    expect(reads).toBe(1)
    expect(f.windows[1]?.options).toMatchObject({ width: 1280, height: 720, x: 10, y: 20, minWidth: 1080 })
    controller.dispose()
    expect(f.windows[1]?.destroyed).toBe(true)
    expect(controller.getMainWindow()).toBeNull()
  })

  test('退出前 flush 提交未到期防抖状态，并等待真实保存 Promise；失败不形成未处理拒绝', async () => {
    for (const fails of [false, true]) {
      const f = await loadController(), saved = Promise.withResolvers<void>()
      const patches: MainWindowState[] = []
      const controller = new f.Controller({ hasTray: () => false, onAttentionAcknowledged: () => {}, getWindowState: () => undefined,
        saveWindowState: (state) => { patches.push(state); return saved.promise } })
      controller.createMainWindow()
      const window = f.windows[0]!
      window.emit('resize')
      window.emit('move')
      expect(patches).toEqual([])
      let done = false
      const pending = controller.flushWindowState().then(() => { done = true })
      await Promise.resolve()
      expect(patches).toEqual([{ width: 1400, height: 900, x: 0, y: 0, isMaximized: false }])
      expect(done).toBe(false)
      if (fails) saved.reject(new Error('fixture failure'))
      else saved.resolve()
      await pending
      expect(done).toBe(true)
      controller.dispose(); window.destroy()
    }
  })
})
