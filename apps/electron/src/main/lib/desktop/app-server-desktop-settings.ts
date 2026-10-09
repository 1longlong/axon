/** 原生桌面的设置入口；只持有后端快照，不读取或写入配置文件。 */
import { APP_SERVER_METHODS as methods } from '@axon/shared'
import type { AgentActiveRun, AgentProject, AppServerClient, AppSettings, MainWindowState, QuickChatShortcutBinding, RpcJsonValue } from '@axon/shared'
import { toWireValue } from '@axon/app-server'
import type { AppServerProcess } from './app-server-process'

export interface AppServerDesktopSettingsOptions {
  backend: Pick<AppServerProcess, 'registerClient' | 'detachClient' | 'getClientSignal' | 'request'>
}

function settingsValue(value: unknown): AppSettings {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error('后端设置响应无效')
  const settings = value as Partial<AppSettings>
  if (!['light', 'dark', 'system'].includes(settings.themeMode ?? '')
    || !Array.isArray(settings.quickChatShortcuts) || !Array.isArray(settings.agentSkillCatalogIds)
    || !Array.isArray(settings.agentSystemPromptTemplates) || typeof settings.gitAttributionEnabled !== 'boolean') {
    throw new Error('后端设置响应无效')
  }
  return structuredClone(settings as AppSettings)
}

/** 宿主身份与页面身份分离；页面重载不取消核对，后端断开或宿主释放仍立即失效。 */
export class AppServerDesktopSettings {
  private readonly lifetime = new AbortController()
  private registration?: Promise<AppServerClient>
  private client?: AppServerClient
  private snapshot?: AppSettings
  private revision = 0
  private requestSequence = 0
  private appliedSequence = 0
  private closing?: Promise<void>

  constructor(private readonly options: AppServerDesktopSettingsOptions) {}

  /** 原生菜单通知只认可本宿主，身份不交给 renderer，也不授予运行控制权。 */
  ownsClient(clientId: string): boolean {
    const signal = this.options.backend.getClientSignal(clientId)
    return !this.lifetime.signal.aborted && this.client?.clientId === clientId && !!signal && !signal.aborted
  }

  /** 快捷键触发时重新查询真实主会话；不缓存会话存在性或在桌面复制业务管理器。 */
  async getShortcutTitle(binding: QuickChatShortcutBinding): Promise<string | undefined> {
    const client = await this.getClient()
    const value = await this.request(client, binding.sessionType === 'chat' ? methods.CHAT_GET_CONVERSATION : methods.AGENT_GET_SESSION, binding.sessionId)
    if (value === null) return undefined
    if (!value || typeof value !== 'object' || Array.isArray(value) || typeof value.title !== 'string') throw new Error('后端会话响应无效')
    return binding.sessionType === 'agent' && value.parentSessionId ? undefined : value.title
  }

  /** 启动恢复仅验证快捷键补丁；实际占用在父端，保存仍由正式事务再次核对。 */
  async validateShortcut(binding: QuickChatShortcutBinding): Promise<void> {
    const client = await this.getClient()
    await this.request(client, methods.VALIDATE_SETTINGS, toWireValue({ quickChatShortcuts: [binding] }))
  }

  /** 启动读取只读项目/运行快照，供原生托盘和 Dock 初始化；不获得运行所有权。 */
  async listProjects(): Promise<AgentProject[]> {
    const value = await this.request(await this.getClient(), methods.PROJECT_LIST)
    if (!Array.isArray(value)) throw new Error('后端项目响应无效')
    return value as unknown as AgentProject[]
  }
  async listActiveRuns(): Promise<AgentActiveRun[]> {
    const value = await this.request(await this.getClient(), methods.AGENT_LIST_ACTIVE_RUNS)
    if (!Array.isArray(value)) throw new Error('后端运行响应无效')
    return value as unknown as AgentActiveRun[]
  }

  /** 仅用于原生窗口初始化；没有可信快照时明确拒绝，不读本地文件或伪造默认配置。 */
  get settings(): AppSettings {
    this.assertAvailable()
    if (!this.snapshot) throw new Error('桌面设置尚未初始化')
    return structuredClone(this.snapshot)
  }

  /** 由固定事件桥调用；只消费本宿主的通知，不能把其他页面事件当作宿主身份。 */
  receive(clientId: string, value: unknown): void {
    if (this.lifetime.signal.aborted || this.client?.clientId !== clientId) return
    const signal = this.options.backend.getClientSignal(clientId)
    if (!signal || signal.aborted) return
    this.snapshot = settingsValue(value)
    this.revision++
  }

  /** 新请求读取后端已保存状态，供启动和未知保存核对；迟到响应不能覆盖新通知。 */
  async readSettings(): Promise<AppSettings> {
    const client = await this.getClient(), revision = this.revision, sequence = ++this.requestSequence
    const value = await this.request(client, methods.GET_SETTINGS)
    const settings = settingsValue(value)
    if (revision === this.revision && sequence > this.appliedSequence) { this.snapshot = settings; this.appliedSequence = sequence }
    return this.settings
  }

  /** 原生窗口只发送自己的状态补丁；后端合并其他设置，不在父端写整份快照。 */
  async saveWindowState(mainWindowState: MainWindowState): Promise<void> {
    const client = await this.getClient(), revision = this.revision, sequence = ++this.requestSequence
    try {
      const value = await this.request(client, methods.UPDATE_SETTINGS, toWireValue({ mainWindowState }))
      const settings = settingsValue(value)
      if (revision === this.revision && sequence > this.appliedSequence) { this.snapshot = settings; this.appliedSequence = sequence }
    } catch (error) {
      // 响应丢失不重发写入；仅重读确认该补丁是否已经保存。
      const current = await this.readSettings()
      if (!current.mainWindowState || !Object.entries(mainWindowState).every(([key, value]) =>
        current.mainWindowState![key as keyof MainWindowState] === value)) throw error
    }
  }

  /** 同一宿主只登记一次；释放中的迟到登记由进程管理器回收，不复活本地快照。 */
  private async getClient(): Promise<AppServerClient> {
    this.lifetime.signal.throwIfAborted()
    this.registration ??= this.options.backend.registerClient('external', this.lifetime.signal).then(async (client) => {
      // 登记函数已返回但本回调尚未运行时也可能退出，必须回收刚登记的身份。
      if (this.lifetime.signal.aborted) {
        await this.options.backend.detachClient(client.clientId)
        this.lifetime.signal.throwIfAborted()
      }
      this.client = client
      return client
    })
    const client = await this.registration
    this.assertAvailable()
    return client
  }

  private assertAvailable(): void {
    this.lifetime.signal.throwIfAborted()
    if (this.client) {
      const signal = this.options.backend.getClientSignal(this.client.clientId)
      if (!signal || signal.aborted) throw new Error('桌面后端入口已失效')
    }
  }

  private async request(client: AppServerClient, method: typeof methods.GET_SETTINGS | typeof methods.UPDATE_SETTINGS | typeof methods.VALIDATE_SETTINGS
    | typeof methods.CHAT_GET_CONVERSATION | typeof methods.AGENT_GET_SESSION | typeof methods.PROJECT_LIST | typeof methods.AGENT_LIST_ACTIVE_RUNS, input?: RpcJsonValue): Promise<RpcJsonValue> {
    this.assertAvailable()
    const value = await this.options.backend.request(client.clientId, method, input, { signal: this.lifetime.signal, timeoutMs: 30_000 })
    this.assertAvailable()
    return value
  }

  /** 先撤销等待和快照，再释放自有身份；不注销任何主窗口或快捷页面。 */
  dispose(): Promise<void> {
    if (this.closing) return this.closing
    this.lifetime.abort()
    this.snapshot = undefined
    const registration = this.registration
    this.closing = (async () => {
      if (!registration) return
      let client: AppServerClient
      try { client = await registration } catch { return }
      await this.options.backend.detachClient(client.clientId)
    })()
    return this.closing
  }
}
