/** Axon Loop 展示组件与纯计算；第三方许可见 THIRD_PARTY_NOTICES.md。 */
import type { Json, RunSummary } from '../types'

export interface SeriesPoint {
  t: string
  v: number
}

/** Axon Loop 界面：按输入数据渲染并管理本地交互，不访问后端实现。 */
export function numericSeries(runsNewestFirst: RunSummary[]): Record<string, SeriesPoint[]> {
  const chron = (runsNewestFirst ?? []).slice().reverse()
  const series: Record<string, SeriesPoint[]> = {}
  for (const r of chron) {
    const obj =
      r.state && typeof r.state === 'object' && !Array.isArray(r.state)
        ? (r.state as Record<string, Json>)
        : {}
    for (const k in obj) {
      const v = obj[k]
      if (typeof v === 'number' && isFinite(v)) (series[k] ??= []).push({ t: r.ts, v })
    }
  }
  return series
}

export interface SeriesRow {
  __t: string
  [key: string]: string | number
}

/** Axon Loop 界面：按输入数据渲染并管理本地交互，不访问后端实现。 */
export function seriesRows(data: Record<string, SeriesPoint[]>, keys: string[]): SeriesRow[] {
  const ts = new Set<string>()
  for (const k of keys) for (const p of data[k] ?? []) ts.add(p.t)
  const sorted = [...ts].sort()
  const idx = new Map(sorted.map((t, i) => [t, i]))
  const rows: SeriesRow[] = sorted.map((t) => ({ __t: t }))
  for (const k of keys) for (const p of data[k] ?? []) rows[idx.get(p.t)!]![k] = p.v
  return rows
}
