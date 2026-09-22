import * as React from 'react'
import type { SDKMessage } from '@axon/shared'
import { getAgentContextWindowUsage } from '@/lib/agent-session-usage'

const RADIUS = 7
const CIRCUMFERENCE = 2 * Math.PI * RADIUS

function formatTokensInK(tokens: number): string {
  const value = tokens / 1_000
  return `${value >= 100 || Number.isInteger(value) ? value.toFixed(0) : value.toFixed(1)}K`
}

/** 输入区圆环用最近模型调用估算下一次请求占用，详细数字只在悬停提示中展示。 */
export function ContextUsageIndicator({ messages, draft }: {
  messages: readonly SDKMessage[]
  draft: string
}): React.ReactElement {
  const usage = React.useMemo(() => getAgentContextWindowUsage(messages, draft), [draft, messages])
  const visibleRatio = Math.min(1, Math.max(0, usage.ratio ?? 0))
  const percentage = usage.ratio === null ? null : Math.round(usage.ratio * 100)
  const label = usage.limitTokens === null
    ? '上下文窗口占用将在首次模型调用后显示'
    : `上下文窗口 ${formatTokensInK(usage.limitTokens)}，已用 ${formatTokensInK(usage.usedTokens)}，占比 ${percentage}%`
  const tone = visibleRatio >= 0.9
    ? 'text-destructive'
    : visibleRatio >= 0.7 ? 'text-amber-500' : 'text-muted-foreground'

  return <span aria-label={label} role="img" className={`group relative inline-flex size-6 items-center justify-center ${tone}`}>
    <svg width="20" height="20" viewBox="0 0 20 20" aria-hidden="true" className="-rotate-90">
      <circle cx="10" cy="10" r={RADIUS} fill="none" stroke="currentColor" strokeOpacity="0.18" strokeWidth="2.2" />
      <circle cx="10" cy="10" r={RADIUS} fill="none" stroke="currentColor" strokeWidth="2.2" strokeLinecap="round"
        strokeDasharray={CIRCUMFERENCE} strokeDashoffset={CIRCUMFERENCE * (1 - visibleRatio)} />
    </svg>
    <span role="tooltip" className="pointer-events-none invisible absolute bottom-full left-0 z-50 mb-2 w-44 rounded-md border bg-popover p-2 text-[11px] font-normal leading-5 text-popover-foreground opacity-0 shadow-md transition-opacity group-hover:visible group-hover:opacity-100">
      {usage.limitTokens === null ? '完成一次模型调用后显示上下文窗口信息' : <>
        <span className="flex justify-between"><span>上下文窗口</span><span>{formatTokensInK(usage.limitTokens)}</span></span>
        <span className="flex justify-between"><span>已用</span><span>{formatTokensInK(usage.usedTokens)}</span></span>
        <span className="flex justify-between"><span>占比</span><span>{percentage}%</span></span>
      </>}
    </span>
  </span>
}
