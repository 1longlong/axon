/** 页面数据适配；所有业务仍由固定 preload 调用完成，没有原 Web 服务依赖。 */
import type { LoopArtifact, LoopRunSummary, LoopSummary } from '@axon/shared'
import type { ArtifactSummary, JobSummary, RunSummary } from '../types'

export function toRun(run: LoopRunSummary): RunSummary {
  return { ...run, outcome: run.phase === 'interrupted' ? 'interrupted' : run.outcome ?? null,
    status: run.status ?? null, canceled: run.phase === 'canceled' }
}
export function toJob(job: LoopSummary): JobSummary {
  return { ...job, completedAt: job.completedAt === null ? null : new Date(job.completedAt).toISOString(),
    runs: job.recentRuns.map(toRun).reverse(), nextRun: job.nextFire === null ? null : new Date(job.nextFire).toISOString(), kind: 'Agent · Pi' }
}
export function toArtifact(file: LoopArtifact, runId?: string): ArtifactSummary {
  return { path: file.path, size: file.size, updatedAt: new Date(file.modifiedAt).toISOString(), binary: file.mediaType.startsWith('image/') || file.mediaType === 'application/octet-stream',
    oversize: false, meta: file.meta ?? null, ...(runId ? { runId } : {}) }
}
export async function getArtifacts({ data }: { data: { loopId: string; runId?: string } }): Promise<ArtifactSummary[]> {
  return (await window.axon.loops.artifacts(data.loopId, data.runId)).map((file) => toArtifact(file, data.runId))
}
export async function loadOlderRuns({ data }: { data: { loopId: string; beforeTs?: string; beforeRunId?: string; limit?: number } }): Promise<RunSummary[]> {
  return (await window.axon.loops.runs(data.loopId, data.beforeRunId, data.limit ?? 16)).map(toRun).reverse()
}
