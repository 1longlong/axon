/** Axon Loop 展示组件与纯计算；第三方许可见 THIRD_PARTY_NOTICES.md。 */
import type { RunSummary } from '../types'

/** Axon Loop 界面：按输入数据渲染并管理本地交互，不访问后端实现。 */
export function mergeRuns(primary: RunSummary[], secondary: RunSummary[]): RunSummary[] {
  const seen = new Set<string>()
  const out: RunSummary[] = []
  for (const r of [...primary, ...secondary]) {
    if (seen.has(r.id)) continue
    seen.add(r.id)
    out.push(r)
  }
  out.sort((a, b) => (a.ts < b.ts ? -1 : a.ts > b.ts ? 1 : 0))
  return out
}
