import { describe, expect, test } from 'bun:test'
import type { AppSettings, QuickChatShortcutBinding } from '@axon/shared'
import { AppServerSettingsTransaction } from './app-server-settings-transaction'
import { QuickChatShortcutService } from './quick-chat-shortcut-service'

function binding(id: string): QuickChatShortcutBinding {
  return { id, accelerator: `Command+${id}`, sessionType: 'chat', sessionId: id }
}
function settings(bindings: QuickChatShortcutBinding[] = [binding('1')]): AppSettings {
  return { themeMode: 'light', agentSkillCatalogIds: [], agentSystemPromptTemplates: [], gitAttributionEnabled: true, quickChatShortcuts: bindings }
}
function open() {
  const callbacks = new Map<string, () => void>(), rejected = new Set<string>(), triggered: string[] = []
  const shortcuts = new QuickChatShortcutService({
    register: (key, callback) => { if (rejected.has(key) || callbacks.has(key)) return false; callbacks.set(key, callback); return true },
    unregister: (key) => { callbacks.delete(key) },
  }, () => true, (item) => { triggered.push(item.id) })
  shortcuts.prepare([binding('1')]).commit()
  let persisted = settings(), readFails = false, reads = 0
  const transaction = new AppServerSettingsTransaction({ shortcuts, readSettings: async () => {
    reads++; if (readFails) throw new Error('backend unavailable'); return persisted
  } })
  return { callbacks, rejected, triggered, shortcuts, transaction, signal: new AbortController().signal,
    get persisted() { return persisted }, set persisted(value: AppSettings) { persisted = value },
    get reads() { return reads }, set readFails(value: boolean) { readFails = value } }
}

describe('独立后端设置与原生快捷键事务', () => {
  test('释放先撤销在途预注册；迟到保存和重读不复活系统键，排队补丁不保存', async () => {
    for (const mode of ['save', 'read']) {
      const f = open(), gate = Promise.withResolvers<AppSettings>()
      let writes = 0
      const transaction = mode === 'save' ? f.transaction : new AppServerSettingsTransaction({ shortcuts: f.shortcuts, readSettings: () => gate.promise })
      const operation = transaction.apply({ quickChatShortcuts: [binding('2')] }, async () => {
        writes++
        if (mode === 'read') throw new Error('lost response')
        return await gate.promise
      }, f.signal).catch((error: unknown) => error)
      const queued = transaction.apply({ quickChatShortcuts: [binding('3')] }, async () => {
        writes++; return settings([binding('3')])
      }, f.signal).catch((error: unknown) => error)
      await Promise.resolve(); await Promise.resolve()
      transaction.dispose(); transaction.dispose(); f.shortcuts.dispose()
      gate.resolve(settings([binding('2')]))
      expect(await operation).toMatchObject({ message: '设置事务已释放' })
      expect(await queued).toMatchObject({ message: '设置事务已释放' })
      expect(writes).toBe(1); expect(f.callbacks.size).toBe(0)
    }
  })

  test('prepare 先占用但不启用新回调，保存成功才提交并释放旧键', async () => {
    const f = open(), gate = Promise.withResolvers<AppSettings>()
    let saves = 0
    const operation = f.transaction.apply({ quickChatShortcuts: [binding('2')] }, () => { saves++; return gate.promise }, f.signal)
    await Promise.resolve()
    expect([...f.callbacks.keys()]).toEqual(['Command+1', 'Command+2'])
    f.callbacks.get('Command+2')?.(); f.callbacks.get('Command+1')?.()
    expect(f.triggered).toEqual(['1'])
    f.persisted = settings([binding('2')]); gate.resolve(f.persisted)
    expect(await operation).toEqual(f.persisted)
    f.callbacks.get('Command+2')?.()
    expect(f.triggered).toEqual(['1', '2'])
    expect([...f.callbacks.keys()]).toEqual(['Command+2'])
    expect(saves).toBe(1); expect(f.reads).toBe(0)
    f.shortcuts.dispose()
  })

  test('组合键占用不保存；保存失败重读旧配置并撤销预注册，旧入口不丢失', async () => {
    const f = open(); f.rejected.add('Command+3')
    let saves = 0
    await expect(f.transaction.apply({ quickChatShortcuts: [binding('2'), binding('3')] }, async () => {
      saves++; return f.persisted
    }, f.signal)).rejects.toThrow('占用')
    expect(saves).toBe(0); expect([...f.callbacks.keys()]).toEqual(['Command+1'])
    await expect(f.transaction.apply({ quickChatShortcuts: [binding('2')] }, async () => {
      saves++; throw new Error('受控保存失败')
    }, f.signal)).rejects.toThrow('受控保存失败')
    expect(saves).toBe(1); expect(f.reads).toBe(1)
    expect([...f.callbacks.keys()]).toEqual(['Command+1'])
    f.shortcuts.dispose()
  })

  test('保存已生效但响应丢失：可信重读核对全补丁后提交，不重新保存', async () => {
    const f = open(), cancel = new AbortController()
    let saves = 0
    const patch = { quickChatShortcuts: [binding('2')], themeMode: 'dark' as const }
    const result = await f.transaction.apply(patch, async () => {
      saves++; f.persisted = { ...f.persisted, ...patch }; cancel.abort(); throw new Error('response canceled')
    }, cancel.signal)
    expect(result).toEqual(f.persisted)
    expect(saves).toBe(1); expect(f.reads).toBe(1)
    expect([...f.callbacks.keys()]).toEqual(['Command+2'])
    f.shortcuts.dispose()
  })

  test('重读失败不猜测；撤销预注册并阻止下一次写入，恢复后先同步实际配置', async () => {
    const f = open(); f.readFails = true
    let saves = 0
    await expect(f.transaction.apply({ quickChatShortcuts: [binding('2')] }, async () => {
      saves++; f.persisted = settings([binding('2')]); throw new Error('disconnected')
    }, f.signal)).rejects.toThrow('无法确认')
    expect([...f.callbacks.keys()]).toEqual(['Command+1'])
    const save = async () => { saves++; f.persisted = settings([binding('3')]); return f.persisted }
    await expect(f.transaction.apply({ quickChatShortcuts: [binding('3')] }, save, f.signal)).rejects.toThrow('尚未核对')
    expect(saves).toBe(1)
    f.readFails = false
    await f.transaction.apply({ quickChatShortcuts: [binding('3')] }, save, f.signal)
    expect(saves).toBe(2); expect([...f.callbacks.keys()]).toEqual(['Command+3'])
    expect(f.reads).toBe(3)
    f.shortcuts.dispose()
  })

  test('同一注册器保存按顺序提交；排队期间取消的补丁不会预注册或写入', async () => {
    const f = open(), first = Promise.withResolvers<AppSettings>(), canceled = new AbortController()
    let secondSaves = 0
    const one = f.transaction.apply({ quickChatShortcuts: [binding('2')] }, () => first.promise, f.signal)
    const two = f.transaction.apply({ quickChatShortcuts: [binding('3')] }, async () => {
      secondSaves++; return settings([binding('3')])
    }, canceled.signal).catch((error: unknown) => error)
    const three = f.transaction.apply({ quickChatShortcuts: [binding('4')] }, async () => {
      expect([...f.callbacks.keys()]).toEqual(['Command+2', 'Command+4'])
      return settings([binding('4')])
    }, f.signal)
    await Promise.resolve(); canceled.abort(); first.resolve(settings([binding('2')]))
    await one
    expect(await two).toBeInstanceOf(Error)
    await three
    expect(secondSaves).toBe(0); expect([...f.callbacks.keys()]).toEqual(['Command+4'])
    f.shortcuts.dispose()
  })

  test('只确认部分字段不是保存成功；原生状态仍按实际快照同步，后续保存可继续', async () => {
    const f = open()
    await expect(f.transaction.apply({ quickChatShortcuts: [binding('2')], themeMode: 'dark' }, async () => {
      f.persisted = settings([binding('2')]); throw new Error('mixed update unconfirmed')
    }, f.signal)).rejects.toThrow('mixed update unconfirmed')
    expect([...f.callbacks.keys()]).toEqual(['Command+2'])
    await expect(f.transaction.apply({ themeMode: 'dark' }, async () => {
      f.persisted = { ...f.persisted, themeMode: 'dark' }; return f.persisted
    }, f.signal)).resolves.toMatchObject({ themeMode: 'dark' })
    f.shortcuts.dispose()
  })
})
