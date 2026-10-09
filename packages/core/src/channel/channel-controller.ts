/** 渠道入口入参不可信：先检查形状，再由领域层校验内容；不暴露 resolve。 */
import { isProviderType } from '@axon/shared'
import type { ChannelCreateInput, ChannelUpdateInput } from '@axon/shared'
import { ChannelManagerError } from './channel-manager'
import type { ChannelManager } from './channel-manager'
import { AsyncWorkTracker } from '../async/async-work-tracker'

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

export class ChannelController {
  private disposed = false
  private readonly work = new AsyncWorkTracker()
  constructor(private readonly manager: Pick<ChannelManager, 'list' | 'create' | 'update' | 'delete'>) {}

  list() { this.ensureOpen(); return this.manager.list() }
  /** 先收束当前 DTO，再由渠道仓储校验模型与安全持久化凭据。 */
  create(value: unknown) {
    return this.work.run(async () => {
      this.ensureOpen()
      const input = parseInput(value)
      if (typeof input.name !== 'string' || !isProviderType(input.provider) || typeof input.apiKey !== 'string') return invalid()
      return this.manager.create(input as ChannelCreateInput)
    })
  }

  /** 已接纳的凭据加密和原子保存完整执行；退出等待而非伪装成取消回滚。 */
  update(id: unknown, value: unknown) {
    return this.work.run(async () => { this.ensureOpen(); return this.manager.update(parseId(id), parseInput(value)) })
  }
  delete(id: unknown) { this.ensureOpen(); return this.manager.delete(parseId(id)) }

  private ensureOpen(): void {
    if (this.disposed) throw new ChannelManagerError('invalid_input', '渠道服务已释放')
  }
  /** 封住新配置入口；已接纳的写入仍完成，防止退出截断持久化。 */
  dispose(): void { this.disposed = true }
  /** 等待渠道创建/更新的实际凭据与保存链，不重发已接纳请求。 */
  drain(): Promise<void> { return this.work.drain() }
}
