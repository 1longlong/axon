/** 展示适配类型；原组件只依赖这一层，不导入后端或 Runtime。 */
import type { LoopRunSummary, LoopSummary, RpcJsonValue } from '@axon/shared'
export type Json = RpcJsonValue
export type RunOutcome = string
export type RunStatus = string
export interface StateField { key: string; label?: string; unit?: string }
export interface RunSummary extends Omit<LoopRunSummary, 'outcome' | 'status'> {
  outcome: string | null
  status: string | null
  canceled: boolean
  artifacts?: Array<{ path: string; kind: 'created' | 'edited' }>
}
export interface JobSummary extends Omit<LoopSummary, 'completedAt'> {
  completedAt: string | null
  runs: RunSummary[]
  nextRun: string | null
  kind: string
  graduation?: string
}
export interface ArtifactMeta { type?: string; title?: string; date?: string }
export interface ArtifactSummary {
  path: string
  size: number | null
  updatedAt: string
  binary: boolean
  oversize: boolean
  meta: ArtifactMeta | null
  runId?: string
}
export interface RunDiffFile {
  path: string
  status: 'added' | 'modified' | 'removed'
  binary: boolean
  tooLarge?: boolean
  sizeDelta: number | null
  diff?: string
}
