import * as React from 'react'
import type { SDKMessage } from '@axon/shared'
import { getAgentContextWindowUsage } from '@/lib/agent-session-usage'
import { cn } from '@/lib/utils'

const RADIUS = 7
const CIRCUMFERENCE = 2 * Math.PI * RADIUS

interface ContextUsageIndicatorProps {
  messages: readonly SDKMessage[]
  draft: string
  appearance?: 'compact' | 'workbench'
}

function formatTokensInK(tokens: number): string {
  const value = tokens / 1_000
  return `${value >= 100 || Number.isInteger(value) ? value.toFixed(0) : value.toFixed(1)}K`
}

/** 最近模型调用与草稿估算下一次请求占用；主输入展示比例，快捷浮窗保留紧凑圆环。 */
export function ContextUsageIndicator({ messages, draft, appearance = 'compact' }: ContextUsageIndicatorProps): React.ReactElement {
  const usage = React.useMemo(() => getAgentContextWindowUsage(messages, draft), [draft, messages])
  const visibleRatio = Math.min(1, Math.max(0, usage.ratio ?? 0))
  const percentage = usage.ratio === null ? null : Math.round(usage.ratio * 100)
  const label = usage.limitTokens === null
    ? '上下文窗口占用将在首次模型调用后显示'
    : `上下文窗口 ${formatTokensInK(usage.limitTokens)}，已用 ${formatTokensInK(usage.usedTokens)}，占比 ${percentage}%`
  const tone = visibleRatio >= 0.9
    ? 'text-destructive'
    : visibleRatio >= 0.7 ? 'text-amber-500' : appearance === 'workbench' ? 'text-indigo-500 dark:text-indigo-400' : 'text-muted-foreground'

  return <span aria-label={label} role="img" className={cn('group relative inline-flex items-center justify-center', appearance === 'workbench' ? 'h-7 shrink-0 gap-1.5 rounded px-1.5 hover:bg-muted/60' : 'size-6', tone)}>
    <svg width={appearance === 'workbench' ? 16 : 20} height={appearance === 'workbench' ? 16 : 20} viewBox="0 0 20 20" aria-hidden="true" className="shrink-0 -rotate-90">
      <circle cx="10" cy="10" r={RADIUS} fill="none" stroke="currentColor" strokeOpacity="0.18" strokeWidth="2.2" />
      <circle cx="10" cy="10" r={RADIUS} fill="none" stroke="currentColor" strokeWidth="2.2" strokeLinecap="round"
        strokeDasharray={CIRCUMFERENCE} strokeDashoffset={CIRCUMFERENCE * (1 - visibleRatio)} />
    </svg>
    {appearance === 'workbench' && percentage !== null && <span className={cn('font-mono text-[11px] font-medium', visibleRatio < 0.7 && 'text-muted-foreground')}>{percentage}%</span>}
    <span role="tooltip" className={cn('pointer-events-none invisible absolute bottom-full left-0 z-50 mb-2 w-44 rounded-md border bg-popover p-2 text-[11px] font-normal leading-5 text-popover-foreground opacity-0 shadow-md transition-opacity group-hover:visible group-hover:opacity-100', appearance === 'workbench' && 'font-mono shadow-xs')}>
      {usage.limitTokens === null ? '完成一次模型调用后显示上下文窗口信息' : <>
        <span className="flex justify-between"><span>上下文窗口</span><span>{formatTokensInK(usage.limitTokens)}</span></span>
        <span className="flex justify-between"><span>已用</span><span>{formatTokensInK(usage.usedTokens)}</span></span>
        <span className="flex justify-between"><span>占比</span><span>{percentage}%</span></span>
      </>}
    </span>
  </span>
}
