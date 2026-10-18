/** Loop 边界校验；持久化记录和 IPC 使用同一现行格式，不读取旧字段。 */
import { isAbsolute, join } from 'node:path'
import { canonicalizeAgentWorkspace } from '../agent/agent-execution-context'
import { validateLoopSchedule } from '@axon/loop-engine'
import type { LoopCreateInput, LoopDefinition, LoopMetricField, LoopUpdateInput, RpcJsonValue } from '@axon/shared'

export class LoopServiceError extends Error {
  constructor(readonly code: 'invalid_input' | 'not_found' | 'busy' | 'forbidden' | 'storage_error' | 'unavailable', message: string) {
    super(message); this.name = 'LoopServiceError'
  }
}
export function loopObject(value: unknown, fields?: readonly string[]): Record<string, unknown> {
  if (!value || typeof value !== 'object' || Array.isArray(value)
    || (fields && Object.keys(value).some((key) => !fields.includes(key)))) throw new LoopServiceError('invalid_input', 'Loop 参数无效')
  return value as Record<string, unknown>
}
export function loopText(value: unknown, label: string, max = 200, empty = false): string {
  if (typeof value !== 'string' || (!empty && !value.trim()) || value.length > max || value.includes('\0')) {
    throw new LoopServiceError('invalid_input', `${label}无效`)
  }
  return value
}
export function loopId(value: unknown): string {
  if (typeof value !== 'string' || !/^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/.test(value)) throw new LoopServiceError('invalid_input', 'Loop 标识无效')
  return value
}
export function loopJson(value: unknown, max = 64 * 1024): RpcJsonValue {
  const text = JSON.stringify(value)
  if (text === undefined || Buffer.byteLength(text) > max) throw new LoopServiceError('invalid_input', 'Loop 状态过大或无法序列化')
  return JSON.parse(text) as RpcJsonValue
}
export function loopMetrics(value: unknown): Record<string, number | string> {
  const record = loopObject(value)
  if (Object.keys(record).length > 64) throw new LoopServiceError('invalid_input', '指标数量超限')
  for (const [key, item] of Object.entries(record)) {
    if (!/^[A-Za-z][A-Za-z0-9_]{0,63}$/.test(key)
      || !(typeof item === 'number' && Number.isFinite(item) || typeof item === 'string' && item.length <= 2000)) {
      throw new LoopServiceError('invalid_input', '指标名称或数值无效')
    }
  }
  return loopJson(record, 16 * 1024) as Record<string, number | string>
}

export function assertLoopSchedule(cron: string, timezone: string): void {
  try { validateLoopSchedule(cron, timezone) }
  catch { throw new LoopServiceError('invalid_input', 'Cron 或时区无效，请使用有未来执行时间的五字段 Cron') }
}

const FIELDS = ['name', 'workspacePath', 'channelId', 'modelId', 'task', 'cron', 'timezone', 'goal', 'enabled',
  'allowControl', 'notify', 'sandboxMode', 'thinkingLevel', 'workflow', 'ui', 'stateSchema', 'precheckNetworkAccess', 'allowedMcpTools'] as const

/** 创建可选择目录；保存后不能改绑，来源、角色与执行凭据不能由页面自报。 */
export function parseLoopInput(value: unknown, partial = false): LoopCreateInput | LoopUpdateInput {
  const input = loopObject(value, partial ? FIELDS.filter((key) => key !== 'workspacePath') : FIELDS)
  const result: Record<string, unknown> = {}
  for (const key of ['name', 'channelId', 'modelId', 'task', 'cron'] as const) {
    if (!partial || input[key] !== undefined) result[key] = loopText(input[key], key, key === 'task' ? 32_000 : 200)
  }
  if (!partial) {
    result.workspacePath = loopText(input.workspacePath, '工作目录', 4096)
    if (!isAbsolute(String(result.workspacePath))) throw new LoopServiceError('invalid_input', '工作目录必须是绝对路径')
  }
  for (const key of ['enabled', 'allowControl', 'precheckNetworkAccess'] as const) {
    if (input[key] !== undefined) {
      if (typeof input[key] !== 'boolean') throw new LoopServiceError('invalid_input', `${key} 必须为布尔值`)
      result[key] = input[key]
    }
  }
  if (input.allowedMcpTools !== undefined) {
    if (!Array.isArray(input.allowedMcpTools) || input.allowedMcpTools.length > 128) throw new LoopServiceError('invalid_input', '预检 MCP 白名单无效')
    result.allowedMcpTools = [...new Set(input.allowedMcpTools.map((value) => loopText(value, 'MCP 工具名', 200)))]
  }
  for (const key of ['goal', 'workflow', 'ui'] as const) {
    if (input[key] !== undefined) result[key] = input[key] === null ? null : loopText(input[key], key, key === 'goal' ? 4000 : 64_000, true).trim() || null
  }
  if (input.timezone !== undefined) {
    const timezone = loopText(input.timezone, '时区', 100)
    try { new Intl.DateTimeFormat('en', { timeZone: timezone }).format(0) }
    catch { throw new LoopServiceError('invalid_input', '时区无效') }
    result.timezone = timezone
  }
  if (input.notify !== undefined) {
    if (typeof input.notify !== 'string' || !['auto', 'always', 'never'].includes(input.notify)) throw new LoopServiceError('invalid_input', '通知策略无效')
    result.notify = input.notify
  }
  if (input.sandboxMode !== undefined) {
    if (typeof input.sandboxMode !== 'string' || !['readOnly', 'workspaceWrite'].includes(input.sandboxMode)) throw new LoopServiceError('invalid_input', '沙箱模式无效')
    result.sandboxMode = input.sandboxMode
  }
  if (input.thinkingLevel !== undefined) {
    if (typeof input.thinkingLevel !== 'string' || !['off', 'minimal', 'low', 'medium', 'high', 'xhigh', 'max'].includes(input.thinkingLevel)) throw new LoopServiceError('invalid_input', '思考等级无效')
    result.thinkingLevel = input.thinkingLevel
  }
  if (input.stateSchema !== undefined) {
    if (!Array.isArray(input.stateSchema) || input.stateSchema.length > 32) throw new LoopServiceError('invalid_input', '指标定义无效')
    const seen = new Set<string>()
    result.stateSchema = input.stateSchema.map((entry): LoopMetricField => {
      const field = loopObject(entry, ['key', 'label', 'unit'])
      const key = loopText(field.key, '指标名称', 64)
      if (!/^[A-Za-z][A-Za-z0-9_]*$/.test(key) || seen.has(key)) throw new LoopServiceError('invalid_input', '指标名称无效或重复')
      seen.add(key)
      return { key, label: loopText(field.label, '指标标签', 100), ...(field.unit === undefined ? {} : { unit: loopText(field.unit, '指标单位', 32, true) }) }
    })
  }
  if (!partial) assertLoopSchedule(String(result.cron), String(result.timezone ?? 'Asia/Shanghai'))
  return result as unknown as LoopCreateInput | LoopUpdateInput
}

/** 只规范化真实存在的目录，不创建、不回退 cwd；已有根在执行前必须保持原路径。 */
export function resolveLoopWorkspace(value: string, pinned = false): string {
  try {
    const path = canonicalizeAgentWorkspace(value)
    if (pinned && path !== value) throw new Error('目录已改指向')
    return path
  } catch { throw new LoopServiceError('invalid_input', 'Loop 工作目录不存在、不是文件夹或已改指向') }
}

/** 磁盘定义保留固定真实目录；不读取或迁移旧项目字段。 */
export function parseStoredLoopDefinition(value: unknown): LoopDefinition {
  const source = loopObject(value)
  if ('projectId' in source) throw new LoopServiceError('invalid_input', 'Loop 定义含无效字段')
  const input = Object.fromEntries(FIELDS.filter((field) => source[field] !== undefined).map((field) => [field, source[field]]))
  const parsed = parseLoopInput(input) as LoopCreateInput
  const id = loopId(source.id)
  if (source.runtimeId !== 'pi' || !Number.isSafeInteger(source.revision) || (source.revision as number) < 1
    || !Number.isSafeInteger(source.executionRevision) || (source.executionRevision as number) < 1 || (source.executionRevision as number) > (source.revision as number)
    || !Number.isFinite(source.createdAt) || !Number.isFinite(source.updatedAt)) throw new LoopServiceError('invalid_input', 'Loop 持久化定义无效')
  const workspacePath = loopText(source.workspacePath, '工作区', 4096)
  const taskFile = loopText(source.taskFile, '任务文件', 4096)
  if (!isAbsolute(workspacePath) || !isAbsolute(taskFile) || taskFile !== join(workspacePath, 'axon-loops', id, 'task.md')) throw new LoopServiceError('invalid_input', 'Loop 任务目录格式无效')
  return { ...parsed, id, runtimeId: 'pi', revision: source.revision as number, executionRevision: source.executionRevision as number, workspacePath, taskFile,
    timezone: parsed.timezone ?? 'Asia/Shanghai', enabled: parsed.enabled ?? true, goal: parsed.goal ?? null,
    allowControl: parsed.allowControl ?? true, notify: parsed.notify ?? 'auto', sandboxMode: parsed.sandboxMode ?? 'workspaceWrite',
    workflow: parsed.workflow ?? null, ui: parsed.ui ?? null, stateSchema: parsed.stateSchema ?? [],
    createdAt: source.createdAt as number, updatedAt: source.updatedAt as number }
}
