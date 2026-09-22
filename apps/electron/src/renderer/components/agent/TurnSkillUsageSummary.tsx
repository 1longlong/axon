import * as React from 'react'
import { Sparkles } from 'lucide-react'
import type { AgentSkillActivation } from '@axon/shared'

/** 在一轮 result 后只读展示已成功加载的项目 Skills。 */
export function TurnSkillUsageSummary({
  activations,
}: {
  activations: readonly AgentSkillActivation[]
}): React.ReactElement {
  return <div className="ml-10 flex flex-wrap items-center gap-1.5 text-xs text-muted-foreground">
    <span className="mr-0.5 inline-flex items-center gap-1"><Sparkles size={12} />本轮使用</span>
    {activations.map((activation) => <span
      key={`${activation.directoryKind}:${activation.name}`}
      className="inline-flex max-w-60 items-center rounded-md bg-violet-500/10 px-2 py-1 font-medium text-violet-600 dark:text-violet-400"
      title={activation.relativeInstructionPath}
    >
      <span className="truncate">{activation.name}</span>
    </span>)}
  </div>
}
