import type { QuickChatShortcutBinding } from '../../../types'

export interface ShortcutRegistrar {
  register(accelerator: string, callback: () => void): boolean
  unregister(accelerator: string): void
}

export interface ShortcutChange {
  commit(): void
  rollback(): void
}

function shortcutKey(accelerator: string): string {
  return accelerator.trim().toLowerCase()
}

/** 管理应用拥有的组合键；回调始终读取当前绑定，改绑会话不必重复注册同一组合键。 */
export class QuickChatShortcutService {
  private active = new Map<string, QuickChatShortcutBinding>()

  constructor(
    private readonly registrar: ShortcutRegistrar,
    private readonly sessionExists: (binding: QuickChatShortcutBinding) => boolean,
    private readonly onTrigger: (binding: QuickChatShortcutBinding) => void,
  ) {}

  /** 先占用新增组合键；写盘成功后 commit，失败时 rollback，旧绑定始终可恢复。 */
  prepare(bindings: readonly QuickChatShortcutBinding[]): ShortcutChange {
    const next = new Map<string, QuickChatShortcutBinding>()
    for (const binding of bindings) {
      if (!this.sessionExists(binding)) throw new Error('快捷键绑定的会话不存在')
      const key = shortcutKey(binding.accelerator)
      if (next.has(key)) throw new Error('快捷键组合重复')
      next.set(key, binding)
    }

    const added: QuickChatShortcutBinding[] = []
    try {
      for (const [key, binding] of next) {
        if (this.active.has(key)) continue
        const registered = this.registrar.register(binding.accelerator, () => {
          const current = this.active.get(key)
          if (current && this.sessionExists(current)) this.onTrigger(current)
        })
        if (!registered) throw new Error(`快捷键 ${binding.accelerator} 已被系统或其他应用占用`)
        added.push(binding)
      }
    } catch (error) {
      for (const binding of added) this.registrar.unregister(binding.accelerator)
      throw error
    }

    let settled = false
    return {
      commit: () => {
        if (settled) return
        settled = true
        // 新键已注册且设置已落盘；此刻再释放旧键，避免替换失败时失去原有入口。
        for (const [key, binding] of this.active) {
          if (!next.has(key)) this.registrar.unregister(binding.accelerator)
        }
        this.active = next
      },
      rollback: () => {
        if (settled) return
        settled = true
        for (const binding of added) this.registrar.unregister(binding.accelerator)
      },
    }
  }

  /** 启动恢复逐项尝试；系统占用某一组合键不应阻断其他绑定和主窗口启动。 */
  restore(bindings: readonly QuickChatShortcutBinding[]): void {
    for (const binding of bindings) {
      try {
        this.prepare([...this.active.values(), binding]).commit()
      } catch (error) {
        console.warn(`[快捷键] ${binding.accelerator} 恢复失败:`, error)
      }
    }
  }

  dispose(): void {
    for (const binding of this.active.values()) this.registrar.unregister(binding.accelerator)
    this.active.clear()
  }
}
