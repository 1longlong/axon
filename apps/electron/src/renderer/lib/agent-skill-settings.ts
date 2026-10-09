/** Skills 设置投影：期望选择、实际安装和本页操作回执分别管理，不推测安装成功。 */
import type { AgentSkillInstallationFailure, AgentSkillSettingsSnapshot } from '@axon/shared'

export interface RendererSkillSettingsApi {
  agentSkills: {
    getSettings(): Promise<AgentSkillSettingsSnapshot>
    applySettings(ids: string[]): Promise<AgentSkillSettingsSnapshot>
  }
  settings: { onChanged(callback: () => void): () => void }
}
export interface RendererSkillSettingsState {
  snapshot: AgentSkillSettingsSnapshot | null
  selected: string[]
  loading: boolean
  refreshing: boolean
  readFailed: boolean
  saving: boolean
  message: string | null
  /** 最近一次本页应用的回执；刷新快照不能把逐项失败擦掉。 */
  failures: AgentSkillInstallationFailure[]
}

function sameIds(left: readonly string[], right: readonly string[]): boolean {
  return JSON.stringify([...left].sort()) === JSON.stringify([...right].sort())
}
export function skillSettingsDirty(state: RendererSkillSettingsState): boolean {
  return !sameIds(state.selected, state.snapshot?.desiredCatalogIds ?? [])
}

/** 安装失败/可用版本变化仍允许用户显式核对，不把已保存选择当作实际安装完成。 */
export function skillSettingsCanApply(state: RendererSkillSettingsState): boolean {
  if (!state.snapshot || state.saving || state.refreshing || state.readFailed) return false
  return skillSettingsDirty(state) || state.failures.length > 0
    || state.snapshot.installed.some((skill) => !state.selected.includes(skill.catalogId))
    || state.selected.some((id) => {
      const available = state.snapshot!.available.find((skill) => skill.catalogId === id)
      return available && !state.snapshot!.installed.some((skill) => skill.catalogId === id && skill.contentHash === available.contentHash && skill.version === available.version)
    })
}

export class RendererSkillSettings {
  private state: RendererSkillSettingsState = { snapshot: null, selected: [], loading: true, refreshing: false, readFailed: false, saving: false, message: null, failures: [] }
  private revision = 0
  private reading = false
  private disposed = false
  private unsubscribe: (() => void) | undefined
  constructor(private readonly api: RendererSkillSettingsApi, private readonly changed: (state: RendererSkillSettingsState) => void) {}

  /** 先订阅再读取；普通设置通知也可能来自同 ID 修复，不仅比较 desired 变化。 */
  start(): void {
    if (this.disposed || this.unsubscribe) return
    this.unsubscribe = this.api.settings.onChanged(() => this.refresh())
    this.refresh()
  }
  getSnapshot(): RendererSkillSettingsState { return this.state }
  private publish(patch: Partial<RendererSkillSettingsState>): void {
    if (this.disposed) return
    this.state = { ...this.state, ...patch }
    this.changed(this.state)
  }

  /** 合并连续通知为单个最新读取；旧快照失效后才读下一代，不积累 catalog 请求。 */
  refresh(): void {
    if (this.disposed) return
    this.revision += 1
    if (this.reading) return
    this.reading = true
    this.publish({ refreshing: true })
    void this.readLatest()
  }
  /** 顺序读取直到追上通知代次；当前代次失败只展示错误，不自动循环重试。 */
  private async readLatest(): Promise<void> {
    try {
      while (!this.disposed) {
        const revision = this.revision
        try {
          const snapshot = await this.api.agentSkills.getSettings()
          if (this.disposed) return
          if (revision !== this.revision) continue
          this.accept(snapshot)
        } catch {
          if (this.disposed) return
          if (revision !== this.revision) continue
          this.publish({ readFailed: true, message: '读取 Skills 状态失败，请刷新状态' })
        }
        if (revision !== this.revision) continue
        break
      }
    } finally {
      this.reading = false
      this.publish({ loading: false, refreshing: false })
    }
  }

  /** 新的已保存状态不覆盖脏草稿；installed 始终取后端清单，而不是勾选框。 */
  private accept(snapshot: AgentSkillSettingsSnapshot): void {
    const selected = skillSettingsDirty(this.state) ? this.state.selected : [...snapshot.desiredCatalogIds]
    this.publish({ snapshot, selected, readFailed: false, ...(this.state.message === '读取 Skills 状态失败，请刷新状态' ? { message: null } : {}) })
  }
  select(catalogId: string, checked: boolean): void {
    if (this.disposed || this.state.saving) return
    this.publish({ selected: checked ? [...new Set([...this.state.selected, catalogId])] : this.state.selected.filter((id) => id !== catalogId) })
  }

  /** 显式提交一次；新通知优先于旧响应，交付未知只重读，不自动重投或回滚。 */
  async apply(): Promise<void> {
    if (this.disposed || !skillSettingsCanApply(this.state)) return
    const revision = this.revision, ids = [...this.state.selected]
    this.publish({ saving: true, message: null, failures: [] })
    try {
      const snapshot = await this.api.agentSkills.applySettings(ids)
      if (this.disposed) return
      if (revision === this.revision) this.accept(snapshot)
      else this.refresh()
      // 回执只说明本次操作；不能用它覆盖其他入口随后保存的安装状态。
      this.publish({ failures: snapshot.failures, message: snapshot.failures.length
        ? `Skills 设置已保存，${snapshot.failures.length} 项处理失败` : 'Skills 设置已应用' })
    } catch {
      if (this.disposed) return
      this.publish({ message: '应用结果未确认，请核对刷新后的 Skills 状态' })
      this.refresh()
    } finally { this.publish({ saving: false }) }
  }
  /** 卸载先使代次失效再撤订阅，读取/保存迟到返回不能更新下一页。 */
  dispose(): void {
    if (this.disposed) return
    this.disposed = true; this.revision += 1
    this.unsubscribe?.(); this.unsubscribe = undefined
  }
}
