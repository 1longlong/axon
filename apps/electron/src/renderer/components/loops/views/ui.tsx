/** Axon Loop 展示组件与纯计算；第三方许可见 THIRD_PARTY_NOTICES.md。 */
import type { ReactNode } from 'react'
import { useSyncExternalStore } from 'react'
import type { RunSummary } from '../types'
import { dotColor, dotLabel } from '../lib/format'

const noopSubscribe = () => () => {}
export const useHydrated = (): boolean =>
  useSyncExternalStore(
    noopSubscribe,
    () => true,
    () => false,
  )

export const focusRing = 'focus-visible:outline-none focus-visible:shadow-focus'
const btnBase = `inline-flex cursor-pointer items-center gap-1.5 rounded-full px-4 py-2 text-body font-medium transition-colors duration-150 disabled:cursor-default disabled:opacity-40 ${focusRing}`
export const btn = `${btnBase} border border-wire bg-surface text-primary hover:bg-raised`
export const btnPrimary = `${btnBase} border border-display bg-display text-paper hover:opacity-85`
export const btnDanger = `${btnBase} border border-transparent bg-rubik-red text-white hover:opacity-85`

export const btnCost = `${btnBase} border border-display bg-transparent text-display hover:bg-[color:var(--color-display)]/8`

export const btnSm = `inline-flex shrink-0 cursor-pointer items-center gap-1 rounded-full border border-wire bg-surface px-3 py-1 text-label font-medium text-primary transition-colors duration-150 hover:bg-raised disabled:cursor-default disabled:opacity-40 ${focusRing}`

export const btnPrimaryPill = `inline-flex shrink-0 cursor-pointer items-center gap-1.5 rounded-full border border-display bg-display px-4 py-2 text-body font-medium text-paper transition-colors duration-150 hover:opacity-85 disabled:cursor-default disabled:opacity-40 ${focusRing}`

export const btnQuiet =
  'inline-flex cursor-pointer items-center gap-1.5 border-none bg-transparent p-0 text-meta font-medium text-secondary transition-colors hover:text-display'

export const sectionHeadCls = 'text-label font-semibold text-secondary'

export const labelCls = 'mb-1.5 mt-3 block text-label font-medium text-secondary'
export const inputCls = `w-full rounded-control border border-wire bg-surface px-3 py-2.5 text-sm text-primary outline-none transition-shadow focus:border-transparent focus:shadow-focus`

export const selectCls = `${inputCls} lp-select cursor-pointer`

export const runPulseAnim = { animation: 'runPulse 1.1s ease-in-out infinite' } as const

export const runPulseStyle = {
  background: 'var(--color-rubik-yellow)',
  ...runPulseAnim,
} as const

/** Axon Loop 界面：按输入数据渲染并管理本地交互，不访问后端实现。 */
export function ErrorBanner({
  message,
  onDismiss,
  className = 'mb-2',
}: {
  message: string
  onDismiss?: () => void
  className?: string
}) {
  return (
    <div className={`flex items-start gap-2 text-body text-accent ${className}`}>
      <span className="mt-[5px] size-2 shrink-0 rounded-full bg-rubik-red" aria-hidden />
      <span>{message}</span>
      {onDismiss && (
        <button
          type="button"
          onClick={onDismiss}
          className="ml-auto shrink-0 cursor-pointer border-none bg-transparent p-0 text-label text-secondary transition-colors hover:text-display"
        >
          Dismiss
        </button>
      )}
    </div>
  )
}

/** Axon Loop 界面：按输入数据渲染并管理本地交互，不访问后端实现。 */
export function Pre({ children }: { children: ReactNode }) {
  return (
    <pre className="max-h-[300px] overflow-auto whitespace-pre-wrap rounded-control border border-hairline bg-raised px-4 py-3.5 font-mono text-meta leading-relaxed text-secondary">
      {children}
    </pre>
  )
}

/** Axon Loop 界面：按输入数据渲染并管理本地交互，不访问后端实现。 */
export function ArtifactList({ artifacts }: { artifacts: NonNullable<RunSummary['artifacts']> }) {
  return (
    <ul className="space-y-1">
      {artifacts.map((a) => (
        <li key={a.path} className="flex items-baseline gap-2">
          <span
            className={`shrink-0 text-caption font-medium ${a.kind === 'created' ? 'text-success' : 'text-secondary'}`}
          >
            {a.kind === 'created' ? 'new' : 'edit'}
          </span>
          <span className="break-all font-mono text-meta text-primary">{a.path}</span>
        </li>
      ))}
    </ul>
  )
}

const PILL_TONES = {
  neutral: 'bg-raised text-secondary',
  ink: 'bg-raised text-primary',
  outline: 'border border-hairline text-secondary',
  running: 'bg-running-soft text-running',
  success: 'bg-success-soft text-success',
  accent: 'bg-accent-soft text-accent',
  warn: 'bg-warn-soft text-warn',
} as const

/** Axon Loop 界面：按输入数据渲染并管理本地交互，不访问后端实现。 */
export function Pill({
  tone = 'neutral',
  dot,
  title,
  children,
}: {
  tone?: keyof typeof PILL_TONES

  dot?: 'pulse' | 'green'
  title?: string
  children: ReactNode
}) {
  return (
    <span
      title={title}
      className={`inline-flex h-[22px] items-center gap-1.5 rounded-full px-2.5 text-caption font-medium ${PILL_TONES[tone]}`}
    >
      {dot && (
        <span
          className="size-1.5 rounded-full"
          style={dot === 'pulse' ? runPulseStyle : { background: 'var(--color-rubik-green)' }}
        />
      )}
      {children}
    </span>
  )
}

/** Axon Loop 界面：按输入数据渲染并管理本地交互，不访问后端实现。 */
export function Loading({ className = '' }: { className?: string }) {
  return <div className={`text-body text-disabled ${className}`}>Loading…</div>
}

/** Axon Loop 界面：按输入数据渲染并管理本地交互，不访问后端实现。 */
export function StatusPill({ run, colorText }: { run: RunSummary; colorText?: boolean }) {
  return (
    <span
      className="inline-flex items-center gap-1.5 font-medium"
      style={colorText ? { color: dotColor(run) } : undefined}
    >
      <span className="size-2 rounded-full" style={{ background: dotColor(run) }} />
      {dotLabel(run)}
    </span>
  )
}
