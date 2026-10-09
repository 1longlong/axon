import type { RpcJsonValue } from '@axon/shared'

/** 将后端 DTO 编码为协议 JSON：只省略对象的可选 undefined，其他非 JSON 值明确拒绝。 */
export function toWireValue(value: unknown, depth = 0): RpcJsonValue {
  if (depth > 64) throw new Error('应用 DTO 嵌套过深')
  if (value === null || typeof value === 'string' || typeof value === 'boolean') return value
  if (typeof value === 'number' && Number.isFinite(value)) return value
  if (Array.isArray(value)) return Array.from(value, (item) => toWireValue(item, depth + 1))
  if (value && typeof value === 'object' && [Object.prototype, null].includes(Object.getPrototypeOf(value))) {
    const entries = Object.entries(value).filter(([, item]) => item !== undefined)
    return Object.fromEntries(entries.map(([key, item]) => [key, toWireValue(item, depth + 1)]))
  }
  throw new Error('应用 DTO 包含不能传输的值')
}
