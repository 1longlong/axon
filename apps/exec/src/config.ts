import { closeSync, constants, fstatSync, openSync, readSync } from 'node:fs'
import { join, resolve } from 'node:path'
import { isProviderType, MAX_CHANNEL_MODELS, PROVIDER_DEFAULT_URLS, resolveChannelModelsUrl } from '@axon/shared'
import type { AgentRuntimeId, AgentSandboxMode, AgentThinkingLevel, ChannelModel, ProviderType } from '@axon/shared'
import { ExecInputError } from './arguments'
import type { ExecArguments } from './arguments'

export interface ExecSettings {
  channel?: string
  model?: string
  runtime: AgentRuntimeId
  sandbox: AgentSandboxMode
  thinking?: AgentThinkingLevel
  systemPrompt: string
  timeout?: number
  skills: boolean
  mcp: boolean
  memory: boolean
  tasks: boolean
}

export interface ExecChannel {
  id: string
  name: string
  provider: ProviderType
  baseUrl: string
  enabled: boolean
  models: ChannelModel[]
  defaultModel?: string
  apiKeyRequired: boolean
  /** 仅留在 CLI 父端配置，启动渠道 DTO 不携带此字段。 */
  apiKey?: string
}

export interface ExecConfiguration {
  settings: ExecSettings
  channels: ExecChannel[]
  configPath?: string
  /** 恢复时最终渠道/模型必须从后端原会话解析；这里仅描述显式覆盖。 */
  channel?: ExecChannel
  model?: string
  runtimeExplicit: boolean
  /** resume 不采用新任务的渠道/模型默认值；profile、-c 和专用参数属于本次明确覆盖。 */
  selectionOverrides?: { channel?: string; model?: string }
}

const DEFAULTS: ExecSettings = {
  runtime: 'pi', sandbox: 'readOnly', systemPrompt: '', skills: true, mcp: true, memory: false, tasks: true,
}
const SETTING_KEYS = ['channel', 'model', 'runtime', 'sandbox', 'thinking', 'systemPrompt', 'timeout', 'skills', 'mcp', 'memory', 'tasks']
const THINKING_LEVELS: readonly AgentThinkingLevel[] = ['off', 'minimal', 'low', 'medium', 'high', 'xhigh', 'max']
const MAX_CONFIG_BYTES = 1024 * 1024

function object(value: unknown, label: string): Record<string, unknown> {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new ExecInputError(`${label}必须是 JSON 对象`)
  return value as Record<string, unknown>
}
function knownKeys(value: Record<string, unknown>, keys: readonly string[], label: string): void {
  if (Object.keys(value).some((key) => !keys.includes(key))) throw new ExecInputError(`${label}包含未知或不允许的字段`)
}
function text(value: unknown, label: string, max = 512): string {
  if (typeof value !== 'string' || !value.trim() || value.length > max || /[\x00-\x1f\x7f]/.test(value)) {
    throw new ExecInputError(`${label}必须是非空字符串且不能包含控制字符`)
  }
  return value.trim()
}
function boolean(value: unknown, label: string, fallback: boolean): boolean {
  if (value === undefined) return fallback
  if (typeof value !== 'boolean') throw new ExecInputError(`${label}必须是 boolean`)
  return value
}

/** 有界读取同一文件句柄，坏 JSON/非文件明确失败，不回显文件正文或底层异常。 */
export function readExecJson(path: string, optional = false): unknown {
  let fd: number
  // 非阻塞打开防止误填 FIFO 时卡在 open；随后只接受普通文件。
  try { fd = openSync(path, constants.O_RDONLY | constants.O_NONBLOCK) }
  catch (error) {
    if (optional && (error as NodeJS.ErrnoException).code === 'ENOENT') return undefined
    throw new ExecInputError('无法读取指定配置或 Schema 文件')
  }
  try {
    const stat = fstatSync(fd)
    if (!stat.isFile() || stat.size > MAX_CONFIG_BYTES) throw new ExecInputError('配置或 Schema 必须是最多 1 MiB 的普通文件')
    const buffer = Buffer.alloc(MAX_CONFIG_BYTES + 1)
    let length = 0
    while (length < buffer.length) {
      const size = readSync(fd, buffer, length, buffer.length - length, null)
      if (size === 0) break
      length += size
    }
    if (length > MAX_CONFIG_BYTES) throw new ExecInputError('配置或 Schema 文件过大')
    try { return JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(buffer.subarray(0, length))) as unknown }
    catch { throw new ExecInputError('配置或 Schema 必须是有效的 UTF-8 JSON') }
  } finally { closeSync(fd) }
}

/** 统一处理文件/profile/-c 的字段类型；不把任意对象透传给 Runtime。 */
function settingsPatch(value: unknown): Partial<ExecSettings> {
  const raw = object(value, '运行设置')
  knownKeys(raw, SETTING_KEYS, '运行设置')
  const patch: Partial<ExecSettings> = {}
  for (const key of ['channel', 'model'] as const) if (raw[key] !== undefined) patch[key] = text(raw[key], key)
  if (raw.runtime !== undefined) {
    if (raw.runtime !== 'pi' && raw.runtime !== 'zima') throw new ExecInputError('runtime 必须是 pi 或 zima')
    patch.runtime = raw.runtime
  }
  if (raw.sandbox !== undefined) {
    if (raw.sandbox !== 'read-only' && raw.sandbox !== 'workspace-write') throw new ExecInputError('sandbox 必须是 read-only 或 workspace-write')
    patch.sandbox = raw.sandbox === 'read-only' ? 'readOnly' : 'workspaceWrite'
  }
  if (raw.thinking !== undefined) {
    if (!THINKING_LEVELS.includes(raw.thinking as AgentThinkingLevel)) throw new ExecInputError('thinking 等级无效')
    patch.thinking = raw.thinking as AgentThinkingLevel
  }
  if (raw.systemPrompt !== undefined) {
    if (typeof raw.systemPrompt !== 'string' || raw.systemPrompt.length > 100_000 || raw.systemPrompt.includes('\0')) {
      throw new ExecInputError('systemPrompt 必须是最多 100000 字符的文本')
    }
    patch.systemPrompt = raw.systemPrompt
  }
  if (raw.timeout !== undefined) {
    if (!Number.isSafeInteger(raw.timeout) || (raw.timeout as number) < 1 || (raw.timeout as number) > 2_147_483) {
      throw new ExecInputError('timeout 必须是 1 到 2147483 的整数秒数')
    }
    patch.timeout = raw.timeout as number
  }
  for (const key of ['skills', 'mcp', 'memory', 'tasks'] as const) {
    if (raw[key] !== undefined) patch[key] = boolean(raw[key], key, false)
  }
  return patch
}

/** 校验渠道及其独立明文密钥；密钥只供父端私有桥使用，地址复用 shared 约束。 */
function channelDefinition(value: unknown): ExecChannel {
  const raw = object(value, '渠道')
  knownKeys(raw, ['id', 'name', 'provider', 'baseUrl', 'enabled', 'models', 'defaultModel', 'apiKeyRequired', 'apiKey'], '渠道')
  if (raw.apiKey !== undefined && (typeof raw.apiKey !== 'string' || raw.apiKey.length > 16_384
    || raw.apiKey !== '' && !raw.apiKey.trim() || /[\x00-\x1f\x7f]/.test(raw.apiKey as string))) {
    throw new ExecInputError('渠道 apiKey 必须是最多 16384 字符且无控制字符的字符串')
  }
  const id = text(raw.id, '渠道 id', 100)
  if (!isProviderType(raw.provider)) throw new ExecInputError('渠道 provider 无效')
  const explicit = raw.baseUrl === undefined ? PROVIDER_DEFAULT_URLS[raw.provider] : text(raw.baseUrl, 'baseUrl', 2048)
  let baseUrl: string
  try {
    resolveChannelModelsUrl(raw.provider, explicit)
    const url = new URL(explicit)
    url.pathname = url.pathname.replace(/\/+$/, '')
    baseUrl = url.toString().replace(/\/+$/, '')
  } catch { throw new ExecInputError('渠道地址必须是无凭据、查询参数及片段的 HTTP(S) URL') }
  if (!Array.isArray(raw.models) || raw.models.length === 0 || raw.models.length > MAX_CHANNEL_MODELS) {
    throw new ExecInputError('渠道需要 1 到 500 个模型定义')
  }
  const ids = new Set<string>()
  const models = raw.models.map((value): ChannelModel => {
    const model = object(value, '模型')
    knownKeys(model, ['id', 'name', 'enabled'], '模型')
    const modelId = text(model.id, '模型 id')
    if (ids.has(modelId)) throw new ExecInputError('渠道中的模型 id 不能重复')
    ids.add(modelId)
    return { id: modelId, name: model.name === undefined ? modelId : text(model.name, '模型名称'),
      enabled: boolean(model.enabled, '模型 enabled', true), source: 'manual' }
  })
  const defaultModel = raw.defaultModel === undefined ? undefined : text(raw.defaultModel, 'defaultModel')
  if (defaultModel && !models.some((model) => model.id === defaultModel && model.enabled)) throw new ExecInputError('defaultModel 必须指向启用模型')
  return { id, name: raw.name === undefined ? id : text(raw.name, '渠道名称', 80), provider: raw.provider,
    baseUrl, enabled: boolean(raw.enabled, '渠道 enabled', true), models, defaultModel,
    apiKeyRequired: boolean(raw.apiKeyRequired, 'apiKeyRequired', true),
    ...(raw.apiKey === undefined ? {} : { apiKey: raw.apiKey as string }) }
}

/** 只从可信配置入口合并运行设置；data-dir 不改变默认配置路径，专用参数优先。 */
export function resolveExecConfiguration(args: ExecArguments, originalCwd: string, homeDir: string): ExecConfiguration {
  const configPath = args.flags.configFile !== undefined ? resolve(originalCwd, args.flags.configFile)
    : args.flags.ignoreUserConfig ? undefined : join(homeDir, '.axon-exec', 'config.json')
  const loaded = configPath ? readExecJson(configPath, args.flags.configFile === undefined) : undefined
  const file = loaded === undefined ? {} : object(loaded, 'CLI 配置')
  knownKeys(file, ['defaults', 'profiles', 'channels'], 'CLI 配置')
  const defaults = settingsPatch(file.defaults ?? {})
  const profiles = object(file.profiles ?? {}, 'profiles')
  // 所选文件整体校验，未选中的预设也不能藏入密钥或未知开关。
  const parsedProfiles = new Map(Object.entries(profiles).map(([name, value]) => [text(name, 'profile 名称', 100), settingsPatch(value)]))
  if (parsedProfiles.size !== Object.keys(profiles).length) throw new ExecInputError('profile 名称不能重复')
  const profileName = args.flags.profile === undefined ? undefined : text(args.flags.profile, 'profile 名称', 100)
  if (profileName && !parsedProfiles.has(profileName)) throw new ExecInputError('所选 profile 不存在于本次配置文件')
  const profile = profileName ? parsedProfiles.get(profileName)! : {}
  let settings = { ...DEFAULTS, ...defaults, ...profile }
  const selectionOverrides: { channel?: string; model?: string } = { channel: profile.channel, model: profile.model }
  let runtimeExplicit = defaults.runtime !== undefined || profile.runtime !== undefined
  for (const override of args.overrides) {
    const separator = override.indexOf('=')
    if (separator < 1) throw new ExecInputError('-c 必须使用 key=value')
    const key = override.slice(0, separator)
    const source = override.slice(separator + 1)
    let value: unknown = source
    try { value = JSON.parse(source) as unknown } catch { /* 字符串字段允许直接填写，不接受非 JSON 布尔/数字。 */ }
    settings = { ...settings, ...settingsPatch({ [key]: value }) }
    if (key === 'channel' || key === 'model') selectionOverrides[key] = settings[key]
    if (key === 'runtime') runtimeExplicit = true
  }
  const flags = args.flags
  const flagPatch = Object.fromEntries(Object.entries({ channel: flags.channel, model: flags.model,
    runtime: flags.runtime, sandbox: flags.sandbox, timeout: flags.timeout === undefined ? undefined : Number(flags.timeout) })
    .filter(([, value]) => value !== undefined))
  if (flags.timeout !== undefined && !/^[1-9]\d*$/.test(flags.timeout)) throw new ExecInputError('--timeout 必须是正整数秒数')
  settings = { ...settings, ...settingsPatch(flagPatch) }
  if (flags.runtime !== undefined) runtimeExplicit = true
  if (flags.channel !== undefined) selectionOverrides.channel = settings.channel
  if (flags.model !== undefined) selectionOverrides.model = settings.model
  if (flags.approval !== undefined && flags.approval !== 'never') throw new ExecInputError('非交互入口仅支持 --ask-for-approval never')
  if (flags.color !== undefined && !['auto', 'always', 'never'].includes(flags.color)) throw new ExecInputError('--color 必须是 auto / always / never')
  if (file.channels !== undefined && !Array.isArray(file.channels)) throw new ExecInputError('channels 必须是数组')
  const channels = ((file.channels ?? []) as unknown[]).map(channelDefinition)
  if (new Set(channels.map((channel) => channel.id)).size !== channels.length) throw new ExecInputError('渠道 id 不能重复')
  const channel = channels.find((item) => item.id === settings.channel && item.enabled)
  if ((args.kind === 'exec' || selectionOverrides.channel !== undefined) && !channel) throw new ExecInputError('需要选择配置中存在且启用的渠道')
  const model = settings.model ?? channel?.defaultModel
  if (args.kind === 'exec' && channel && (!model || !channel.models.some((item) => item.id === model && item.enabled))) throw new ExecInputError('需要选择渠道中存在且启用的模型')
  return { settings, channels, configPath: loaded === undefined ? undefined : configPath, channel, model, runtimeExplicit, selectionOverrides }
}
