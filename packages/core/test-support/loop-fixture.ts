/** 仅供集中验收的隔离任务数据；没有生产配置或定时执行。 */
import { createLoopLifecycle } from '@axon/loop-engine'
import { join } from 'node:path'
import type { LoopDefinition, LoopRunSummary } from '@axon/shared'
import type { LoopDocument } from '../src/loops/loop-repository'

export function loopDocument(workspacePath: string): LoopDocument {
  const definition: LoopDefinition = { id: 'loop-fixture', revision: 1, executionRevision: 1, runtimeId: 'pi', name: '隔离验收',
    channelId: 'channel', modelId: 'model', task: '检查任务', cron: '0 0 1 1 *', timezone: 'Asia/Shanghai', goal: null,
    enabled: true, allowControl: true, notify: 'auto', sandboxMode: 'workspaceWrite', workflow: null, ui: null, stateSchema: [],
    workspacePath, taskFile: join(workspacePath, 'axon-loops', 'loop-fixture', 'task.md'), createdAt: 1000, updatedAt: 1000 }
  return { definition, preparation: 'ready', runAfterPreparation: false, lifecycle: createLoopLifecycle({ loopId: definition.id }), cursor: null, runCount: 0,
    totalCostUsd: 0, failureStreak: 0, lastScheduledAt: null, nextRunAt: null, nextTrigger: null, evolveDue: false, evolveTrigger: null, editRequest: null,
    lastEvolveAt: null, evolvedRunCount: 0, deleted: false }
}
export function loopRun(document: LoopDocument, index: number): LoopRunSummary {
  return { id: `run-${index}`, loopId: document.definition.id, definitionRevision: document.definition.executionRevision,
    role: 'exec', trigger: 'manual', phase: 'done', ts: new Date(index + 1000).toISOString(), queuedAt: index + 1000,
    startedAt: index + 1000, finishedAt: index + 1001, durationMs: 1, running: false, queued: false, message: '历史结果' }
}
