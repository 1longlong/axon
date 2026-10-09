import { describe, expect, test } from 'bun:test'
import { toWireValue } from '@axon/app-server'
import { APP_SERVER_METHODS as methods } from '@axon/shared'
import type { AppServerClient, AppSettings, RpcJsonValue } from '@axon/shared'
import { AppServerDesktopSettings } from './app-server-desktop-settings'
import type { AppServerDesktopSettingsOptions } from './app-server-desktop-settings'

function settings(): AppSettings {
  return { themeMode: 'system', agentSkillCatalogIds: [], agentSystemPromptTemplates: [], gitAttributionEnabled: true, quickChatShortcuts: [] }
}
const windowState = { width: 1400, height: 900, x: 10, y: 20, isMaximized: false }

function open() {
  const owner = new AbortController(), calls: Array<{ method: string; input?: RpcJsonValue }> = []
  let registrations = 0, detaches = 0, current = settings()
  const backend: AppServerDesktopSettingsOptions['backend'] = {
    registerClient: async (kind) => { registrations++; return { clientId: 'desktop', kind } },
    detachClient: async (id) => { expect(id).toBe('desktop'); detaches++; owner.abort(); return true },
    getClientSignal: (id) => id === 'desktop' ? owner.signal : undefined,
    request: async (id, method, input, options) => {
      expect(id).toBe('desktop'); expect(options?.timeoutMs).toBe(30_000)
      options?.signal?.throwIfAborted()
      calls.push({ method, input })
      if (method === methods.UPDATE_SETTINGS) current = { ...current, ...input as Partial<AppSettings> }
      return toWireValue(current)
    },
  }
  const desktop = new AppServerDesktopSettings({ backend })
  return { desktop, backend, owner, calls, get registrations() { return registrations }, get detaches() { return detaches },
    get current() { return current }, set current(value: AppSettings) { current = value } }
}

describe('原生桌面独立设置身份', () => {
  test('并发读取只登记一个外部身份；窗口仅提交补丁，快照副本不可被原生调用者篡改', async () => {
    const f = open()
    expect(() => f.desktop.settings).toThrow('尚未初始化')
    await Promise.all([f.desktop.readSettings(), f.desktop.readSettings()])
    expect(f.registrations).toBe(1)
    f.current = { ...f.current, agentSystemPrompt: '保留' }
    await f.desktop.saveWindowState(windowState)
    expect(f.calls.filter((call) => call.method === methods.UPDATE_SETTINGS)).toEqual([
      { method: methods.UPDATE_SETTINGS, input: { mainWindowState: windowState } },
    ])
    const copy = f.desktop.settings
    copy.themeMode = 'dark'; copy.agentSystemPromptTemplates.push({ id: 'not-saved', name: '测试', content: '' })
    expect(f.desktop.settings).toMatchObject({ themeMode: 'system', agentSystemPrompt: '保留', mainWindowState: windowState, agentSystemPromptTemplates: [] })
    await f.desktop.dispose(); await f.desktop.dispose()
    expect(f.detaches).toBe(1)
  })

  test('只消费自己的通知；更新通知优先于旧读取和旧保存响应', async () => {
    const f = open()
    await f.desktop.readSettings()
    f.desktop.receive('page', { ...settings(), themeMode: 'dark' })
    expect(f.desktop.settings.themeMode).toBe('system')
    for (const mode of ['read', 'save']) {
      const gate = Promise.withResolvers<RpcJsonValue>(), arrived = Promise.withResolvers<void>()
      f.backend.request = async () => { arrived.resolve(); return await gate.promise }
      const pending = mode === 'read' ? f.desktop.readSettings() : f.desktop.saveWindowState(windowState)
      await arrived.promise
      f.desktop.receive('desktop', { ...settings(), themeMode: 'dark', mainWindowState: windowState })
      gate.resolve(toWireValue(settings()))
      await pending
      expect(f.desktop.settings).toMatchObject({ themeMode: 'dark', mainWindowState: windowState })
    }
    await f.desktop.dispose()
  })

  test('窗口保存响应丢失只重读一次，不重发；补丁不匹配或后端失效不能确认成功', async () => {
    for (const mode of ['saved', 'not-saved', 'disconnected']) {
      const f = open()
      await f.desktop.readSettings()
      let writes = 0, reads = 0
      f.backend.request = async (_id, method) => {
        if (method === methods.UPDATE_SETTINGS) {
          writes++
          // core 可按固定顺序重建 DTO；确认值相同，不依赖对象属性插入顺序。
          if (mode === 'saved') f.current = { ...f.current, mainWindowState: {
            isMaximized: false, y: 20, x: 10, height: 900, width: 1400,
          } }
          if (mode === 'disconnected') f.owner.abort()
          throw new Error('响应丢失')
        }
        reads++
        return toWireValue(f.current)
      }
      const pending = f.desktop.saveWindowState(windowState)
      if (mode === 'saved') await pending
      else await expect(pending).rejects.toThrow(mode === 'not-saved' ? '响应丢失' : '已失效')
      expect(writes).toBe(1); expect(reads).toBe(mode === 'disconnected' ? 0 : 1)
      await f.desktop.dispose()
    }
  })

  test('无通知的连续读取也按请求代次更新，旧读取不阻止新快照或覆盖新响应', async () => {
    for (const reverse of [false, true]) {
      const f = open()
      await f.desktop.readSettings()
      const gates = [Promise.withResolvers<RpcJsonValue>(), Promise.withResolvers<RpcJsonValue>()]
      const arrived = Promise.withResolvers<void>()
      let requests = 0
      f.backend.request = () => {
        const gate = gates[requests++]!
        if (requests === 2) arrived.resolve()
        return gate.promise
      }
      const first = f.desktop.readSettings(), second = f.desktop.readSettings()
      await arrived.promise
      if (reverse) {
        gates[1]!.resolve(toWireValue({ ...settings(), themeMode: 'dark' })); await second
        gates[0]!.resolve(toWireValue(settings())); await first
      } else {
        gates[0]!.resolve(toWireValue(settings())); await first
        gates[1]!.resolve(toWireValue({ ...settings(), themeMode: 'dark' })); await second
      }
      expect(f.desktop.settings.themeMode).toBe('dark')
      await f.desktop.dispose()
    }
  })

  test('释放/物理断开先失效缓存；迟到通知和读返回不复活，也不会重新登记', async () => {
    for (const mode of ['dispose', 'disconnect']) {
      const f = open()
      await f.desktop.readSettings()
      const gate = Promise.withResolvers<RpcJsonValue>(), arrived = Promise.withResolvers<void>()
      f.backend.request = async () => { arrived.resolve(); return await gate.promise }
      const pending = f.desktop.readSettings().catch((error: unknown) => error)
      await arrived.promise
      if (mode === 'dispose') await f.desktop.dispose()
      else f.owner.abort()
      f.desktop.receive('desktop', { ...settings(), themeMode: 'dark' })
      gate.resolve(toWireValue(settings()))
      expect(await pending).toBeInstanceOf(Error)
      expect(() => f.desktop.settings).toThrow()
      await expect(f.desktop.readSettings()).rejects.toThrow()
      expect(f.registrations).toBe(1)
      await f.desktop.dispose()
    }
  })

  test('登记响应抵达宿主回调前释放，精确回收迟到身份且不发起设置读取', async () => {
    const f = open(), registered = Promise.withResolvers<AppServerClient>()
    f.backend.registerClient = () => registered.promise
    const pending = f.desktop.readSettings().catch((error: unknown) => error)
    registered.resolve({ clientId: 'desktop', kind: 'external' })
    const disposed = f.desktop.dispose()
    await disposed
    expect(await pending).toBeInstanceOf(Error)
    expect(f.detaches).toBe(1); expect(f.calls).toEqual([])
  })

  test('读取失败/畸形响应不伪造默认成功，不自动重新登记或循环重试', async () => {
    for (const value of [null, {}, { ...settings(), themeMode: 'unknown' }]) {
      const f = open()
      f.backend.request = async () => value as RpcJsonValue
      await expect(f.desktop.readSettings()).rejects.toThrow('响应无效')
      expect(() => f.desktop.settings).toThrow('尚未初始化')
      expect(f.registrations).toBe(1)
      await f.desktop.dispose()
    }
  })
})
