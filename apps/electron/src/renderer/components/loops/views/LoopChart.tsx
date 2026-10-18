/** Axon Loop 展示组件与纯计算；第三方许可见 THIRD_PARTY_NOTICES.md。 */
import { useId } from 'react'
import {
  Area,
  AreaChart,
  CartesianGrid,
  Line,
  LineChart,
  ResponsiveContainer,
  Tooltip,
  XAxis,
  YAxis,
} from 'recharts'
import type { StateField } from '../types'
import { seriesRows, type SeriesPoint } from '../lib/stats'
import { fnum, md, tsShort } from '../lib/format'

const STROKES = [
  'var(--color-chart-1)',
  'var(--color-chart-2)',
  'var(--color-chart-3)',
  'var(--color-chart-4)',
  'var(--color-chart-5)',
]

const HEIGHT = 190
const INITIAL = { width: 640, height: HEIGHT }

const TICK = { fontSize: 10, fontFamily: 'var(--font-mono)', fill: 'var(--color-secondary)' }

const TOOLTIP_STYLE = {
  background: 'var(--color-surface)',
  border: '1px solid var(--color-wire)',
  borderRadius: 8,
  boxShadow: 'none',
  padding: '6px 10px',
  fontFamily: 'var(--font-mono)',
  fontSize: 11,
} as const

const withUnit = (v: number, unit: string): string => (unit === '$' ? `$${fnum(v)}` : `${fnum(v)}${unit}`)

/** Axon Loop 界面：按输入数据渲染并管理本地交互，不访问后端实现。 */
export function LoopChart({
  data,
  series,
}: {
  data: Record<string, SeriesPoint[]>
  series: StateField[]
}) {
  const gradientId = useId()
  if (!series.length) return null


  const plotted = series
    .map((f) => ({ field: f, pts: data[f.key] ?? [] }))
    .filter((s) => s.pts.length >= 1)
  if (!plotted.length) return null

  const keys = plotted.map((s) => s.field.key)
  const rows = seriesRows(data, keys)
  const single = plotted.length === 1
  const unitOf = new Map(plotted.map((s) => [s.field.key, s.field.unit ?? '']))

  const xAxis = (
    <XAxis
      dataKey="__t"
      tickLine={false}
      axisLine={false}
      tickMargin={8}
      minTickGap={28}
      interval="preserveStartEnd"
      tick={TICK}
      tickFormatter={(t: string) => md(t)}
    />
  )
  const yAxis = (
    <YAxis
      width={34}
      tickCount={4}
      tickLine={false}
      axisLine={false}
      tick={TICK}
      tickFormatter={(v: number) => fnum(v)}
    />
  )
  const grid = <CartesianGrid vertical={false} stroke="var(--color-hairline)" />
  const tooltip = (
    <Tooltip








      isAnimationActive={false}
      cursor={{ stroke: 'var(--color-wire)', strokeDasharray: '3 3' }}
      contentStyle={TOOLTIP_STYLE}
      labelStyle={{ color: 'var(--color-secondary)', marginBottom: 2 }}
      itemStyle={{ color: 'var(--color-primary)', padding: '1px 0' }}
      labelFormatter={(t) => tsShort(String(t))}
      formatter={(v, name, item) => [
        withUnit(Number(v), unitOf.get(String(item?.dataKey)) ?? ''),
        String(name),
      ]}
    />
  )




  const seriesProps = (s: (typeof plotted)[number], idx: number) => {
    const color = STROKES[idx % STROKES.length]!
    return {
      dataKey: s.field.key,
      name: s.field.label ?? s.field.key,
      type: 'monotone' as const,
      stroke: color,
      strokeWidth: 1.5,
      dot: s.pts.length === 1 ? { r: 3.5, strokeWidth: 0, fill: color } : false,
      activeDot: { r: 3, strokeWidth: 0, fill: color },
      connectNulls: true,
      isAnimationActive: false,
    }
  }

  const margin = { top: 6, right: 12, left: 0, bottom: 0 }

  return (
    <figure className="my-2 min-w-0">
      <div className="min-w-0" style={{ height: HEIGHT }}>
        <ResponsiveContainer width="100%" height="100%" initialDimension={INITIAL}>
          {single ? (
            <AreaChart data={rows} margin={margin}>
              <defs>
                <linearGradient id={gradientId} x1="0" y1="0" x2="0" y2="1">
                  <stop offset="5%" stopColor={STROKES[0]} stopOpacity={0.28} />
                  <stop offset="95%" stopColor={STROKES[0]} stopOpacity={0.02} />
                </linearGradient>
              </defs>
              {grid}
              {xAxis}
              {yAxis}
              {tooltip}
              <Area {...seriesProps(plotted[0]!, 0)} fill={`url(#${gradientId})`} />
            </AreaChart>
          ) : (
            <LineChart data={rows} margin={margin}>
              {grid}
              {xAxis}
              {yAxis}
              {tooltip}
              {plotted.map((s, idx) => (
                <Line {...seriesProps(s, idx)} key={s.field.key} />
              ))}
            </LineChart>
          )}
        </ResponsiveContainer>
      </div>
      <figcaption className="mt-1 flex flex-wrap gap-x-4 gap-y-1 text-label text-[var(--color-secondary)]">
        {plotted.map((s, idx) => {
          const last = s.pts[s.pts.length - 1]
          if (!last) return null
          return (
            <span key={s.field.key} className="inline-flex items-center gap-1.5">
              <span
                className="inline-block h-[2px] w-3 align-middle"
                style={{ background: STROKES[idx % STROKES.length] }}
              />
              {s.field.label ?? s.field.key}
              <span className="text-[var(--color-display)]">{withUnit(last.v, s.field.unit ?? '')}</span>
            </span>
          )
        })}
      </figcaption>
    </figure>
  )
}
