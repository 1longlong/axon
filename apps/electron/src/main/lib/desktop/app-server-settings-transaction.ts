/** 只协调跨进程设置保存与原生组合键，不在 Electron 读写业务配置。 */
import type { AppSettings } from '@axon/shared'
import type { QuickChatShortcutService, ShortcutChange } from './quick-chat-shortcut-service'

export interface AppServerSettingsTransactionOptions {
  shortcuts: Pick<QuickChatShortcutService, 'prepare'>
  /** 使用可信宿主入口重读，不继承某个已重载页面的取消信号；调用自身须有界。 */
  readSettings: () => Promise<AppSettings>
}

function sameBindings(left: AppSettings['quickChatShortcuts'], right: AppSettings['quickChatShortcuts']): boolean {
  return JSON.stringify(left) === JSON.stringify(right)
}
function matchesPatch(settings: AppSettings, patch: Partial<AppSettings>): boolean {
  return Object.entries(patch).every(([key, value]) => JSON.stringify(settings[key as keyof AppSettings]) === JSON.stringify(value))
}

export class AppServerSettingsTransaction {
  private tail: Promise<unknown> = Promise.resolve()
  private needsReconciliation = false
  private disposed = false
  private currentChange?: ShortcutChange

  constructor(private readonly options: AppServerSettingsTransactionOptions) {}

  /** 补丁已由后端完整校验；同一注册器的保存顺序化，避免重叠 prepare 操作互相释放组合键。 */
  apply(patch: Partial<AppSettings>, save: () => Promise<AppSettings>, signal: AbortSignal): Promise<AppSettings> {
    const operation = this.tail.then(async () => {
      this.assertAvailable()
      signal.throwIfAborted()
      if (this.needsReconciliation) await this.reconcile()
      this.assertAvailable()
      signal.throwIfAborted()
      const change = patch.quickChatShortcuts === undefined ? undefined : this.options.shortcuts.prepare(patch.quickChatShortcuts)
      this.currentChange = change
      try {
        // prepare 期间取消也不能启动写入；新键回调在 commit 前保持不可用。
        signal.throwIfAborted()
        const saved = await save()
        this.assertAvailable()
        if (change && !sameBindings(saved.quickChatShortcuts, patch.quickChatShortcuts!)) {
          throw new Error('后端返回的快捷键保存结果不一致')
        }
        change?.commit()
        return saved
      } catch (error) {
        return await this.recover(patch, change, error)
      } finally { if (this.currentChange === change) this.currentChange = undefined }
    })
    this.tail = operation.catch(() => {})
    return operation
  }

  /** 交付未知时只读核对实际设置；没有读到可信状态就撤销预注册，并阻止下一次保存。 */
  private async recover(patch: Partial<AppSettings>, change: ShortcutChange | undefined, error: unknown): Promise<AppSettings> {
    this.assertAvailable()
    let current: AppSettings
    try { current = await this.options.readSettings() }
    catch {
      change?.rollback()
      if (change) this.needsReconciliation = true
      throw new Error('设置保存结果无法确认，请待后端恢复后重新读取设置')
    }
    this.assertAvailable()
    if (change) {
      if (sameBindings(current.quickChatShortcuts, patch.quickChatShortcuts!)) change.commit()
      else {
        change.rollback()
        // 可能已有其他可信入口修改配置；以重读结果重建，而不是推测旧值或再次保存。
        this.needsReconciliation = true
        try { this.options.shortcuts.prepare(current.quickChatShortcuts).commit(); this.needsReconciliation = false }
        catch { throw new Error('设置已重新读取，但系统快捷键未能同步，请检查组合键占用') }
      }
    }
    if (matchesPatch(current, patch)) return current
    throw error
  }

  /** 后端恢复后在下一次写入前核对；失败保持阻塞，不重发旧用户补丁。 */
  private async reconcile(): Promise<void> {
    try {
      const current = await this.options.readSettings()
      this.assertAvailable()
      this.options.shortcuts.prepare(current.quickChatShortcuts).commit()
      this.needsReconciliation = false
    } catch { throw new Error('系统快捷键状态尚未核对，请待后端恢复并检查组合键占用') }
  }

  private assertAvailable(): void { if (this.disposed) throw new Error('设置事务已释放') }

  /** 先撤销尚未提交的原生预注册；迟到保存/重读不能在应用退出后重新注册组合键。 */
  dispose(): void {
    if (this.disposed) return
    this.disposed = true
    this.currentChange?.rollback()
    this.currentChange = undefined
  }
}
