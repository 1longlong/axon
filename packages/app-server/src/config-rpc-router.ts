/** 全局配置命令与已保存快照通知；凭据和模型目录诊断只通过 core 的受控入口。 */
import { AgentSkillInstallationError, ChannelManagerError } from '@axon/core'
import { APP_SERVER_METHODS as methods, APP_SERVER_NOTIFICATIONS as notices } from '@axon/shared'
import type { AppServerClient, AppSettings, RpcJsonObject } from '@axon/shared'
import { configObject, parseSettingsUpdate, parseUserProfileUpdate } from './config-input'
import { RpcConnectionError, RpcFault } from './json-rpc-peer'
import type { JsonRpcPeer } from './json-rpc-peer'
import type { AppServerCommandContext, ResolveAppServerClient } from './rpc-command-context'
import { toWireValue } from './wire-value'

export class ConfigRpcRouter {
  /** 请求先验证连接身份与固定字段，写入成功后才广播；不开放内部 resolve/解密方法。 */
  constructor(private readonly peer: JsonRpcPeer, resolve: ResolveAppServerClient,
    private readonly getClients: () => Iterable<AppServerClient>) {
    const handle = (method: string, fields: readonly string[], action: (
      context: AppServerCommandContext, signal: AbortSignal,
    ) => unknown | Promise<unknown>): void => {
      peer.handle(method, async (params, { signal }) => {
        const context = resolve(params, fields)
        signal.throwIfAborted()
        try { return toWireValue(await action(context, signal)) }
        catch (error) {
          if (error instanceof ChannelManagerError) throw new RpcFault(-32022, '渠道命令失败', { code: error.code })
          if (error instanceof AgentSkillInstallationError && error.code === 'invalid_selection') {
            throw new RpcFault(-32602, 'Skill 选择无效')
          }
          if (signal.aborted || error instanceof Error && error.name === 'AbortError') throw new RpcFault(-32800, '配置请求已取消')
          throw error
        }
      })
    }
    // 原生预注册前只读校验；真正保存时重做，防止等待期间绑定会话已删除。
    const settingsPatch = (context: AppServerCommandContext): Partial<AppSettings> => {
      const patch = parseSettingsUpdate(context.input)
      for (const binding of patch.quickChatShortcuts ?? []) {
        const session = binding.sessionType === 'chat' ? context.backend.conversations.get(binding.sessionId)
          : context.backend.sessions.get(binding.sessionId)
        if (!session || 'parentSessionId' in session && session.parentSessionId) {
          throw new RpcFault(-32602, '快捷键绑定的会话不存在或不是主会话')
        }
      }
      return patch
    }
    handle(methods.VALIDATE_SETTINGS, ['input'], settingsPatch)
    handle(methods.UPDATE_SETTINGS, ['input'], (context) => {
      const settings = context.backend.settings.update(settingsPatch(context))
      this.broadcast(context, notices.SETTINGS_UPDATED, { settings: toWireValue(settings) })
      return settings
    })
    handle(methods.UPDATE_USER_PROFILE, ['input'], (context) => {
      const profile = context.backend.userProfile.update(parseUserProfileUpdate(context.input))
      this.broadcast(context, notices.USER_PROFILE_UPDATED, { profile: toWireValue(profile) })
      return profile
    })
    const skillsSignal = ({ backend, client }: AppServerCommandContext, signal: AbortSignal): AbortSignal => {
      const owner = backend.clients.getSignal(client.clientId)
      if (!owner) throw new RpcFault(-32004, '客户端已断开')
      return AbortSignal.any([signal, owner])
    }
    handle(methods.SKILLS_GET_SETTINGS, [], (context, signal) => context.backend.skills.getSnapshot(skillsSignal(context, signal)))
    handle(methods.SKILLS_APPLY_SETTINGS, ['input'], async (context, signal) => {
      const previous = context.backend.settings.get().agentSkillCatalogIds
      let reconciled = false
      try {
        const snapshot = await context.backend.skills.apply(context.input, skillsSignal(context, signal))
        reconciled = true
        return snapshot
      } finally {
        // 安装可能在保存期望集合后失败；通知真实已保存状态，不能假装整个操作回滚。
        const settings = context.backend.settings.get()
        if (reconciled || JSON.stringify(previous) !== JSON.stringify(settings.agentSkillCatalogIds)) {
          this.broadcast(context, notices.SETTINGS_UPDATED, { settings: toWireValue(settings) })
        }
      }
    })
    handle(methods.CHANNEL_LIST, [], ({ backend }) => backend.channelController.list())
    handle(methods.CHANNEL_CREATE, ['input'], async (context) => {
      const channel = await context.backend.channelController.create(context.input)
      this.channelsChanged(context)
      return channel
    })
    handle(methods.CHANNEL_UPDATE, ['input'], async (context) => {
      const input = configObject(context.input, ['channelId', 'update'])
      const channel = await context.backend.channelController.update(input.channelId, input.update)
      this.channelsChanged(context)
      return channel
    })
    handle(methods.CHANNEL_DELETE, ['input'], (context) => {
      const channel = context.backend.channelController.delete(context.input)
      this.channelsChanged(context)
      return channel
    })
    handle(methods.CHANNEL_REQUEST, ['input'], ({ backend, client, input }, signal) =>
      backend.channelNetwork.request(client.clientId, input, signal))
    handle(methods.CHANNEL_CANCEL, ['input'], ({ backend, client, input }) => {
      if (typeof input !== 'string' || !input) throw new RpcFault(-32602, '渠道取消标识无效')
      return backend.channelNetwork.cancel(client.clientId, input)
    })
  }

  private channelsChanged(context: AppServerCommandContext): void {
    this.broadcast(context, notices.CHANNELS_CHANGED, { channels: toWireValue(context.backend.channelController.list()) })
  }
  /** 配置是连接内共享只读状态；只给仍有效的入口发安全 DTO，不授予运行或审批权限。 */
  private broadcast(context: AppServerCommandContext, method: string, payload: RpcJsonObject): void {
    if (this.peer.closed) return
    try {
      for (const client of this.getClients()) if (context.backend.clients.has(client.clientId)) {
        this.peer.notify(method, { clientId: client.clientId, ...payload })
      }
    } catch { this.peer.close(new RpcConnectionError('protocol', '配置事件无法传输')) }
  }
}
