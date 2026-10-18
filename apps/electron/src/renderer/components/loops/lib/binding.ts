/** Axon Loop 展示组件与纯计算；第三方许可见 THIRD_PARTY_NOTICES.md。 */
import type { Json, RunSummary, StateField } from '../types'
import { fnum } from './format'

/** Axon Loop 界面：按输入数据渲染并管理本地交互，不访问后端实现。 */
export function parseSeries(attr?: string): StateField[] {
  if (!attr) return []
  return attr
    .split(',')
    .map((s) => {
      const [key, label, unit] = s.split(':').map((x) => x.trim())
      return { key: key ?? '', ...(label ? { label } : {}), ...(unit ? { unit } : {}) }
    })
    .filter((f) => f.key)
}

export interface BindingContext {
  latest: Record<string, string>
}

/** Axon Loop 界面：按输入数据渲染并管理本地交互，不访问后端实现。 */
export function buildBindingContext(runs: RunSummary[]): BindingContext {

  const latest: Record<string, string> = {}
  for (const r of runs) {
    if (r.state && typeof r.state === 'object' && !Array.isArray(r.state)) {
      for (const k in r.state) {
        if (!(k in latest)) {
          const v = (r.state as Record<string, Json>)[k]
          if (typeof v === 'number') latest[k] = fnum(v)
          else if (typeof v === 'string') latest[k] = v
        }
      }
    }
  }
  return { latest }
}

const TOKEN = /\{\{\s*([a-zA-Z0-9_.]+)\s*\}\}/g

const escapeHtml = (s: string): string =>
  s.replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c] ?? c)

/** Axon Loop 界面：按输入数据渲染并管理本地交互，不访问后端实现。 */
export function resolveBindings(html: string, ctx: BindingContext): string {
  return html.replace(TOKEN, (_m, path: string) => {
    const v = lookup(ctx, path)
    return v == null ? '—' : escapeHtml(v)
  })
}

function lookup(ctx: BindingContext, path: string): string | undefined {
  const parts = path.split('.')
  if (parts[0] === 'latest' && parts[1]) return ctx.latest[parts[1]]
  return undefined
}
