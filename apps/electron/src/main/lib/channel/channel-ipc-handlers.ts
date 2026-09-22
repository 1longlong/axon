/** IPC 入参不可信：先检查形状，再由领域层校验内容；不暴露 resolve。 */
import { isProviderType } from '@axon/shared'
import type { ChannelCreateInput, ChannelUpdateInput } from '@axon/shared'
import { ChannelManagerError } from './channel-manager'
import type { ChannelManager } from './channel-manager'

function invalid(): never {
  throw new ChannelManagerError('invalid_input', '渠道请求格式无效')
}

function parseInput(value: unknown): ChannelUpdateInput {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return invalid()
  const input = value as Record<string, unknown>
  const allowed = ['name', 'provider', 'baseUrl', 'apiKey', 'models', 'enabled']
  if (Object.keys(input).some((key) => !allowed.includes(key))) return invalid()
  for (const key of ['name', 'baseUrl', 'apiKey']) {
    if (input[key] !== undefined && typeof input[key] !== 'string') return invalid()
  }
  if (input.provider !== undefined && !isProviderType(input.provider)) return invalid()
  if (input.enabled !== undefined && typeof input.enabled !== 'boolean') return invalid()
  if (input.models !== undefined && !Array.isArray(input.models)) return invalid()
  // 模型成员与 URL/名称的语义检查统一在 ChannelManager 中完成。
  return input as ChannelUpdateInput
}

function parseId(value: unknown): string {
  if (typeof value !== 'string' || !value.trim()) return invalid()
  return value
}

export function createChannelIpcHandlers(manager: Pick<ChannelManager, 'list' | 'create' | 'update' | 'delete'>) {
  return {
    list: () => manager.list(),
    create: (value: unknown) => {
      const input = parseInput(value)
      if (typeof input.name !== 'string' || !isProviderType(input.provider) || typeof input.apiKey !== 'string') return invalid()
      return manager.create(input as ChannelCreateInput)
    },
    update: (id: unknown, value: unknown) => manager.update(parseId(id), parseInput(value)),
    delete: (id: unknown) => manager.delete(parseId(id)),
  }
}
