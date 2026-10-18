/** Axon Loop 展示组件与纯计算；第三方许可见 THIRD_PARTY_NOTICES.md。 */
import type { JobSummary, RunOutcome, RunStatus, RunSummary } from '../types'
import type { LoopRunRole, LoopRunTrigger } from '@axon/shared'

export const roleLabel: Record<LoopRunRole, string> = { exec: '任务执行', evolve: '优化任务', edit: '应用修改', setup: '准备配置' }
export const triggerLabel: Record<LoopRunTrigger, string> = { scheduled: '定时执行', manual: '手动执行', rescheduled: '临时安排',
  catchup: '补一次漏跑', auto_evolve: '自动优化', manual_evolve: '手动优化', user_edit: '用户要求修改', initial_setup: '创建配置' }

export const fmt = (t: string | null | undefined): string =>
  t ? new Date(t).toLocaleString() : '—'

export const rel = (t: string | null | undefined): string => {
  if (!t) return ''
  const s = Math.round((Date.now() - Date.parse(t)) / 1000)
  if (s < 60) return `${s}s ago`
  const m = Math.round(s / 60)
  if (m < 60) return `${m}m ago`
  const h = Math.round(m / 60)
  if (h < 24) return `${h}h ago`
  return `${Math.round(h / 24)}d ago`
}

const DOW = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat']

/** Axon Loop 界面：按输入数据渲染并管理本地交互，不访问后端实现。 */
export function cronText(cron: string): string {
  const p = (cron || '').trim().split(/\s+/)
  if (p.length !== 5) return cron
  const [mi, ho, dom, mon, dow] = p as [string, string, string, string, string]
  const dateWild = dom === '*' && mon === '*'
  const everyH = ho.match(/^\*\/(\d+)$/)
  if (everyH && dateWild && dow === '*') return `every ${everyH[1]}h`
  const everyM = mi.match(/^\*\/(\d+)$/)
  if (everyM && ho === '*' && dateWild && dow === '*') return `every ${everyM[1]}m`
  if (ho === '*' && /^\d+$/.test(mi) && dateWild && dow === '*')
    return `hourly :${mi.padStart(2, '0')}`
  if (/^\d+$/.test(mi) && /^\d+$/.test(ho) && dateWild) {
    const hhmm = `${ho.padStart(2, '0')}:${mi.padStart(2, '0')}`
    if (dow === '*') return `daily ${hhmm}`

    if (/^[0-7]$/.test(dow)) return `${DOW[Number(dow) % 7]} ${hhmm}`
    const set = dowSet(dow)
    if (set) return `${set} ${hhmm}`
  }
  return cron
}

function dowSet(dow: string): string | null {
  const parts = dow.split(',')
  if (parts.length < 2 || !parts.every((p) => /^[0-7]$/.test(p))) return null

  const days = [...new Set(parts.map((p) => Number(p) % 7))].sort((a, b) => a - b)
  if (days.length === 7) return 'daily'
  if (days.length === 5 && !days.includes(0) && !days.includes(6)) return 'weekdays'
  if (days.length === 2 && days.includes(0) && days.includes(6)) return 'weekends'
  return days.map((d) => DOW[d]).join('/')
}

export const until = (t: string | null | undefined): string => {
  if (!t) return ''
  const s = Math.round((Date.parse(t) - Date.now()) / 1000)
  if (s <= 0) return 'due'
  const m = Math.round(s / 60)
  if (m < 60) return `in ${m}m`
  const h = Math.round(m / 60)
  if (h < 24) return `in ${h}h`
  return `in ${Math.round(h / 24)}d`
}

export const md = (t: string | number): string => {
  const d = new Date(t)
  return `${d.getMonth() + 1}/${d.getDate()}`
}

export const tsShort = (t: string | null | undefined): string => {
  if (!t) return '—'
  const d = new Date(t)
  const p = (n: number) => String(n).padStart(2, '0')
  return `${p(d.getMonth() + 1)}/${p(d.getDate())} ${p(d.getHours())}:${p(d.getMinutes())}`
}

export const fnum = (n: number): string =>
  Math.abs(n) >= 1000 ? `${Math.round(n / 100) / 10}k` : `${Math.round(n * 100) / 100}`

export const dur = (ms: number | null | undefined): string => {
  if (!ms) return ''
  const s = Math.round(ms / 1000)
  if (s < 60) return `${s}s`
  const m = Math.floor(s / 60)
  if (m < 60) return `${m}m ${s % 60}s`
  return `${Math.floor(m / 60)}h ${m % 60}m`
}

export const money = (usd: number | null | undefined): string => {
  if (usd == null) return ''
  if (usd > 0 && usd < 0.01) return `$${usd.toFixed(3)}`
  return `$${usd.toFixed(2)}`
}

/** Axon Loop 界面：按输入数据渲染并管理本地交互，不访问后端实现。 */
export function humanBytes(n: number): string {
  const abs = Math.abs(n)
  if (abs < 1024) return `${abs} B`
  if (abs < 1024 * 1024) return `${(abs / 1024).toFixed(1)} KB`
  return `${(abs / (1024 * 1024)).toFixed(1)} MB`
}

export interface StatusMeta {
  c: string
  label: string
}

export const ST = {
  'nothing-new': { c: 'var(--color-secondary)', label: 'No update' },
  new: { c: 'var(--color-display)', label: 'New' },
  resolved: { c: 'var(--color-success)', label: 'Resolved' },
  error: { c: 'var(--color-accent)', label: 'Error' },
  silent: { c: 'var(--color-disabled)', label: 'Silent' },
  evolve: { c: 'var(--color-interactive)', label: 'Evolved' },
} satisfies Record<string, StatusMeta>

const lookup = (k: string | null | undefined): StatusMeta | undefined =>
  k ? (ST as Record<string, StatusMeta>)[k] : undefined

const OUTCOME_LABEL: Record<string, string> = {
  direct: 'Reported',
  agent: 'Reported',
  exec: 'Ran',
}

const titleCase = (s: string): string =>
  s ? s.charAt(0).toUpperCase() + s.slice(1).replace(/-/g, ' ') : s

export type RunLike = {
  running?: boolean
  queued?: boolean
  canceled?: boolean
  role?: string
  outcome: RunOutcome | string | null
  status: RunStatus | string | null
}

/** Axon Loop 界面：按输入数据渲染并管理本地交互，不访问后端实现。 */
export function dotColor(r: RunLike): string {

  if (r.running) return r.role === 'evolve' ? ST.evolve.c : ST.new.c



  if (r.queued) return ST['nothing-new'].c
  if (r.canceled) return ST.silent.c
  if (r.outcome === 'error') return ST.error.c
  if (r.outcome === 'evolve') return ST.evolve.c
  if (r.outcome === 'silent') return ST.silent.c
  return (lookup(r.status) ?? ST['nothing-new']).c
}

/** Axon Loop 界面：按输入数据渲染并管理本地交互，不访问后端实现。 */
export function dotLabel(r: RunLike): string {
  if (r.running) return r.role === 'evolve' ? 'Evolving…' : 'Running…'



  if (r.queued) return 'Queued'


  if (r.outcome === 'skipped') return 'Skipped'
  if (r.canceled) return 'Canceled'
  if (r.outcome === 'error') return ST.error.label
  if (r.outcome === 'evolve') return ST.evolve.label
  if (r.outcome === 'silent') return ST.silent.label

  if (r.outcome == null) return 'Scheduled'


  return lookup(r.status)?.label ?? OUTCOME_LABEL[r.outcome] ?? titleCase(r.outcome)
}

export const lastRunOf = (j: JobSummary): RunSummary | null => {
  const a = j.runs ?? []
  return a.length ? a[a.length - 1]! : null
}

/** Axon Loop 界面：按输入数据渲染并管理本地交互，不访问后端实现。 */
export function isCompleted(j: JobSummary): boolean {
  return j.completedAt != null
}

/** Axon Loop 界面：按输入数据渲染并管理本地交互，不访问后端实现。 */
export function isClosed(j: JobSummary): boolean {
  return j.goal != null && j.goal !== ''
}
