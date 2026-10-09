import { describe, expect, test } from 'bun:test'
import type { QuickChatShortcutBinding } from '@axon/shared'
import { QuickChatShortcutService, type ShortcutRegistrar } from './quick-chat-shortcut-service'

class FakeRegistrar implements ShortcutRegistrar {
  readonly callbacks = new Map<string, () => void>()
  readonly rejected = new Set<string>()

  register(accelerator: string, callback: () => void): boolean {
    if (this.rejected.has(accelerator) || this.callbacks.has(accelerator)) return false
    this.callbacks.set(accelerator, callback)
    return true
  }

  unregister(accelerator: string): void {
    this.callbacks.delete(accelerator)
  }
}

function binding(id: string, accelerator: string, sessionId = id): QuickChatShortcutBinding {
  return { id, accelerator, sessionType: 'chat', sessionId }
}

describe('全局快捷会话注册事务', () => {
  test('异步查询后复核改绑和注销，规范化组合键不误判仍生效的绑定', () => {
    const service = new QuickChatShortcutService(new FakeRegistrar(), () => true, () => {})
    const original = binding('original', 'CommandOrControl+Shift+1')
    service.prepare([original]).commit()
    expect(service.isCurrent({ ...original, accelerator: ' commandorcontrol+shift+1 ' })).toBe(true)
    const next = binding('next', original.accelerator)
    service.prepare([next]).commit()
    expect(service.isCurrent(original)).toBe(false)
    expect(service.isCurrent({ ...next, sessionType: 'agent' })).toBe(false)
    expect(service.isCurrent(next)).toBe(true)
    service.dispose()
    expect(service.isCurrent(next)).toBe(false)
  })

  test('提交后触发当前绑定，改绑同一组合键无需重复注册', () => {
    const registrar = new FakeRegistrar()
    const triggered: string[] = []
    const service = new QuickChatShortcutService(registrar, () => true, (item) => triggered.push(item.sessionId))

    service.prepare([binding('first', 'CommandOrControl+Shift+1')]).commit()
    service.prepare([binding('second', 'CommandOrControl+Shift+1')]).commit()
    registrar.callbacks.get('CommandOrControl+Shift+1')?.()

    expect(triggered).toEqual(['second'])
    expect(registrar.callbacks.size).toBe(1)
  })

  test('新增组合键被占用时回滚本批注册并保留旧入口', () => {
    const registrar = new FakeRegistrar()
    const service = new QuickChatShortcutService(registrar, () => true, () => {})
    service.prepare([binding('old', 'CommandOrControl+Shift+1')]).commit()
    registrar.rejected.add('CommandOrControl+Shift+3')

    expect(() => service.prepare([
      binding('old', 'CommandOrControl+Shift+1'),
      binding('new', 'CommandOrControl+Shift+2'),
      binding('blocked', 'CommandOrControl+Shift+3'),
    ])).toThrow('已被系统或其他应用占用')
    expect([...registrar.callbacks.keys()]).toEqual(['CommandOrControl+Shift+1'])
  })

  test('拒绝不存在会话和规范化后重复的组合键', () => {
    const registrar = new FakeRegistrar()
    const service = new QuickChatShortcutService(registrar, (item) => item.sessionId !== 'missing', () => {})
    expect(() => service.prepare([binding('missing', 'CommandOrControl+1', 'missing')])).toThrow('会话不存在')
    expect(() => service.prepare([
      binding('one', ' CommandOrControl+Shift+1 '),
      binding('two', 'commandorcontrol+shift+1'),
    ])).toThrow('组合重复')
  })
})
