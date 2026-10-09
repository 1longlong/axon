import { describe, expect, test } from 'bun:test'
import { mkdirSync, mkdtempSync, rmSync } from 'node:fs'
import { createRequire } from 'node:module'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { APP_SERVER_METHODS as methods } from '@axon/shared'
import { createFixtureCredentialCodec } from '../../../../../../packages/core/test-support/credential-codec'
import { buildAppServer } from '../../../../scripts/build-app-server'
import { createDesktopAppServerLaunch } from './app-server-launch'
import { AppServerProcess } from './app-server-process'
import { AppServerDesktopSettings } from './app-server-desktop-settings'
import { AppServerEvents } from './app-server-events'

describe('随桌面提供的独立后端启动', () => {
  test('开发和打包路径明确，复用应用执行器且保持模型/代理配置，不继承 Node 注入参数', () => {
    const input = { executable: '/application/Axon', mainDirectory: '/application/dist', resourcesDirectory: '/application/resources',
      dataDir: '/data/axon', homeDir: '/user', applicationVersion: '0.1.3',
      environment: { PATH: '/system', HTTPS_PROXY: 'http://localhost:1234', AXON_ZIMA_PYTHON: '/controlled/python', NODE_OPTIONS: '--import=unknown', NODE_PATH: '/unknown' } }
    for (const packaged of [false, true]) {
      const value = createDesktopAppServerLaunch({ ...input, packaged })
      expect(value.executable).toBe(input.executable)
      expect(value.entryArgs).toEqual([packaged ? '/application/resources/app.asar.unpacked/dist/app-server.mjs' : '/application/dist/app-server.mjs'])
      expect(value.environment).toMatchObject({ PATH: '/system', HTTPS_PROXY: input.environment.HTTPS_PROXY, ELECTRON_RUN_AS_NODE: '1' })
      expect(value.environment?.NODE_OPTIONS).toBeUndefined(); expect(value.environment?.NODE_PATH).toBeUndefined()
      expect(value.zimaPython).toBe('/controlled/python')
    }
  })

  test('真实 Electron Node 执行器运行生产构建入口：宿主设置、菜单快照、快捷会话查询与确认', async () => {
    const dist = join(import.meta.dir, '../../../../dist')
    mkdirSync(dist, { recursive: true })
    const buildDirectory = mkdtempSync(join(dist, 'axon-backend-launch-')), directory = mkdtempSync(join(tmpdir(), 'axon-native-backend-'))
    const executable = createRequire(import.meta.url)('electron') as string
    let desktop!: AppServerDesktopSettings, events: AppServerEvents | undefined
    const backend = new AppServerProcess({ launch: createDesktopAppServerLaunch({ executable, packaged: false,
      mainDirectory: buildDirectory, resourcesDirectory: directory, dataDir: join(directory, 'data'), homeDir: directory,
      applicationVersion: '0.1.3', environment: { ...process.env, AXON_ZIMA_PYTHON: '' } }),
    credentialCodec: createFixtureCredentialCodec(), stopTimeoutMs: 100,
    configurePeer: (peer) => { events = new AppServerEvents(peer, { clients: { find: () => undefined, matches: () => false, getClientSignal: () => undefined }, desktopSettings: desktop }) } })
    desktop = new AppServerDesktopSettings({ backend })
    try {
      await buildAppServer(join(buildDirectory, 'app-server.mjs'))
      await backend.start()
      expect(backend.pid).not.toBe(process.pid)
      expect(await desktop.readSettings()).toMatchObject({ quickChatShortcuts: [] })
      expect(await desktop.listProjects()).toEqual([])
      expect(await desktop.listActiveRuns()).toEqual([])
      const owner = await backend.registerClient('main')
      const chat = await backend.request(owner.clientId, methods.CHAT_CREATE_CONVERSATION, { title: '快捷测试' }) as { id: string }
      const binding = { id: 'shortcut', accelerator: 'Command+1', sessionType: 'chat' as const, sessionId: chat.id }
      expect(await desktop.getShortcutTitle(binding)).toBe('快捷测试')
      await desktop.validateShortcut(binding)
      await expect(desktop.validateShortcut({ ...binding, sessionId: 'not-found' })).rejects.toThrow()
      await backend.request(owner.clientId, methods.UPDATE_SETTINGS, { themeMode: 'light', quickChatShortcuts: [binding] })
      expect(desktop.settings).toMatchObject({ themeMode: 'light', quickChatShortcuts: [binding] })
      await backend.request(owner.clientId, methods.CHAT_DELETE_CONVERSATION, chat.id)
      expect(await desktop.getShortcutTitle(binding)).toBeUndefined()
    } finally {
      events?.dispose(); await desktop.dispose(); await backend.stop()
      rmSync(buildDirectory, { recursive: true, force: true }); rmSync(directory, { recursive: true, force: true })
    }
  }, 30_000)
})
