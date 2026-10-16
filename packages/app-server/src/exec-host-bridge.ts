/** 非交互可信宿主桥：启动配置无密钥，运行凭据仅按确切渠道目标交付。 */
import { APP_SERVER_HOST_METHODS as methods, isProviderType, MAX_CHANNEL_MODELS } from '@axon/shared'
import type { AppServerExecBootstrap, AppServerRuntimeCredentialTarget, RpcParams, RuntimeChannelDefinition } from '@axon/shared'
import type { ChannelManagerOptions } from '@axon/core'
import { RpcFault } from './json-rpc-peer'
import type { JsonRpcPeer } from './json-rpc-peer'
import { toWireValue } from './wire-value'

export interface ExecHostBridgeOptions {
  bootstrap: AppServerExecBootstrap
  /** 入口还须绑定当前选定渠道；不能把一份 API Key 自动用于全部配置。 */
  resolveCredential: (target: AppServerRuntimeCredentialTarget) => string | Promise<string>
}
export interface ExecHostPorts {
  bootstrap: AppServerExecBootstrap
  resolveRuntimeCredential: NonNullable<ChannelManagerOptions['resolveRuntimeCredential']>
}

function object(value: unknown, keys: readonly string[]): Record<string, unknown> {
  if (!value || typeof value !== 'object' || Array.isArray(value)
    || Object.keys(value).some((key) => !keys.includes(key))) throw new Error()
  return value as Record<string, unknown>
}
function text(value: unknown, max = 512): string {
  if (typeof value !== 'string' || !value.trim() || value !== value.trim()
    || value.length > max || /[\x00-\x1f\x7f]/.test(value)) throw new Error()
  return value
}
function boolean(value: unknown): boolean {
  if (typeof value !== 'boolean') throw new Error()
  return value
}
function baseUrl(value: unknown): string {
  const url = new URL(text(value, 2048))
  if (!['http:', 'https:'].includes(url.protocol) || url.username || url.password || url.search || url.hash) throw new Error()
  return url.href.replace(/\/+$/, '')
}

/** 私有边界也严格解析，不能让陌生字段、密钥或可变引用进入后端装配。 */
function parseBootstrap(value: unknown): AppServerExecBootstrap {
  try {
    const input = object(value, ['channels', 'agent'])
    if (!Array.isArray(input.channels) || input.channels.length > 500) throw new Error()
    const seen = new Set<string>()
    const channels: RuntimeChannelDefinition[] = input.channels.map((value: unknown) => {
      const channel = object(value, ['id', 'name', 'provider', 'baseUrl', 'models', 'enabled'])
      const id = text(channel.id)
      if (seen.has(id) || !isProviderType(channel.provider) || !Array.isArray(channel.models)
        || !channel.models.length || channel.models.length > MAX_CHANNEL_MODELS) throw new Error()
      seen.add(id)
      const modelIds = new Set<string>()
      const models = channel.models.map((value: unknown) => {
        const model = object(value, ['id', 'name', 'enabled', 'source'])
        const id = text(model.id)
        if (modelIds.has(id) || model.source !== undefined && model.source !== 'manual' && model.source !== 'fetched') throw new Error()
        modelIds.add(id)
        return { id, name: text(model.name), enabled: boolean(model.enabled),
          ...(model.source === undefined ? {} : { source: model.source as 'manual' | 'fetched' }) }
      })
      return { id, name: text(channel.name, 80), provider: channel.provider,
        baseUrl: baseUrl(channel.baseUrl), models, enabled: boolean(channel.enabled) }
    })
    const agent = object(input.agent, ['systemPrompt', 'finalOutputInstruction', 'features', 'generateTitle'])
    if (typeof agent.systemPrompt !== 'string' || agent.systemPrompt.length > 100_000 || agent.systemPrompt.includes('\0')) throw new Error()
    if (agent.finalOutputInstruction !== undefined && (typeof agent.finalOutputInstruction !== 'string'
      || Buffer.byteLength(agent.finalOutputInstruction) > 1024 * 1024 + 2048 || agent.finalOutputInstruction.includes('\0'))) throw new Error()
    const flags = object(agent.features, ['skills', 'mcp', 'memory', 'tasks'])
    return { channels, agent: { systemPrompt: agent.systemPrompt,
      ...(agent.finalOutputInstruction === undefined ? {} : { finalOutputInstruction: agent.finalOutputInstruction as string }),
      generateTitle: boolean(agent.generateTitle), features: {
      skills: boolean(flags.skills), mcp: boolean(flags.mcp), memory: boolean(flags.memory), tasks: boolean(flags.tasks),
    } } }
  } catch { throw new Error('非交互宿主启动配置无效') }
}

function credentialTarget(params: RpcParams): AppServerRuntimeCredentialTarget {
  try {
    const input = object(params, ['channelId', 'provider', 'baseUrl'])
    if (!isProviderType(input.provider)) throw new Error()
    return { channelId: text(input.channelId), provider: input.provider, baseUrl: baseUrl(input.baseUrl) }
  } catch { throw new RpcFault(-32602, '运行凭据目标无效') }
}

/** 父入口握手前登记；取配置不交付密钥，凭据请求同时校验渠道、协议和规范化地址。 */
export function registerExecHostBridge(peer: JsonRpcPeer, options: ExecHostBridgeOptions): void {
  const bootstrap = parseBootstrap(options.bootstrap)
  peer.handle(methods.GET_EXEC_BOOTSTRAP, (params, { signal }) => {
    if (Array.isArray(params) || Object.keys(params).length) throw new RpcFault(-32602, '启动配置请求无效')
    signal.throwIfAborted()
    return toWireValue(bootstrap)
  })
  peer.handle(methods.RESOLVE_RUNTIME_CREDENTIAL, async (params, { signal }) => {
    const target = credentialTarget(params)
    const channel = bootstrap.channels.find((item) => item.id === target.channelId)
    if (!channel?.enabled || channel.provider !== target.provider || channel.baseUrl !== target.baseUrl) {
      throw new RpcFault(-32010, '运行凭据目标未授权')
    }
    try {
      signal.throwIfAborted()
      const key = await options.resolveCredential(target)
      signal.throwIfAborted()
      if (typeof key !== 'string' || key.length > 16_384 || /[\x00-\x1f\x7f]/.test(key)) throw new Error()
      return key
    } catch { throw new RpcFault(-32010, '读取运行凭据失败') }
  })
}

/** 仅可信 exec 装配调用；缺桥、坏响应和管道中断明确失败，不回退桌面密文。 */
export async function createExecHostPorts(peer: JsonRpcPeer, signal: AbortSignal): Promise<ExecHostPorts> {
  signal.throwIfAborted()
  let bootstrap: AppServerExecBootstrap
  try { bootstrap = parseBootstrap(await peer.request(methods.GET_EXEC_BOOTSTRAP, {}, { signal })) }
  catch { throw new Error('无法读取非交互宿主启动配置') }
  signal.throwIfAborted()
  return { bootstrap, async resolveRuntimeCredential(channel) {
    try {
      const value = await peer.request(methods.RESOLVE_RUNTIME_CREDENTIAL,
        { channelId: channel.id, provider: channel.provider, baseUrl: channel.baseUrl }, { signal })
      if (typeof value !== 'string' || value.length > 16_384 || /[\x00-\x1f\x7f]/.test(value)) throw new Error()
      return value
    } catch { throw new Error('读取运行凭据失败') }
  } }
}
