import * as React from 'react'
import type { useAgentImageCapability } from '@/hooks/useAgentImageCapability'

/** 能力未知不是支持；用户可以明确尝试，但已知不支持不提供绕过。 */
export function AgentImageCapabilityNotice({ state, disabled }: { state: ReturnType<typeof useAgentImageCapability>; disabled: boolean }): React.ReactElement | null {
  if (state.loading) return <p className="pb-2 text-xs text-muted-foreground">正在核对模型图片能力…</p>
  if (state.failed) return <p className="pb-2 text-xs text-destructive">图片能力查询失败。<button type="button" disabled={disabled} className="ml-1 underline" onClick={state.retry}>重新查询</button></p>
  if (state.capability?.support === 'unsupported') return <p className="pb-2 text-xs text-destructive">当前模型不支持图片，请更换模型或移除图片。</p>
  if (state.capability?.support === 'unknown') return <label className="flex items-center gap-2 pb-2 text-xs text-muted-foreground">
    <input type="checkbox" disabled={disabled} checked={state.confirmed} onChange={(event) => state.setConfirmed(event.target.checked)} className="accent-primary" />
    此模型的图片能力未知，我仍要尝试发送。
  </label>
  return null
}
