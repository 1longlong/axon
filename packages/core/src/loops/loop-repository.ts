/** 单 Loop 日志是权威记录；同步提交守住单进程读改写，缓存不能把失败写入变成成功。 */
import { randomUUID } from 'node:crypto'
import { closeSync, constants, existsSync, fstatSync, fsyncSync, ftruncateSync, lstatSync, mkdirSync, openSync,
  readFileSync, readdirSync, renameSync, writeFileSync, writeSync } from 'node:fs'
import { join, resolve } from 'node:path'
import type { LoopLifecycleState } from '@axon/loop-engine'
import type { LoopDefinition, LoopPreparationState, LoopRunSummary, LoopRunTrigger, RpcJsonValue } from '@axon/shared'
import { loopId, loopObject, LoopServiceError, parseStoredLoopDefinition } from './loop-input'

const MAX_JOURNAL = 128 * 1024 * 1024
// 定义、查询和终态均分别有界；容量须覆盖最大合法中文输入的一次整体结算。
const MAX_EVENT = 2 * 1024 * 1024
export interface LoopDocument {
  definition: LoopDefinition
  preparation: LoopPreparationState
  runAfterPreparation: boolean
  lifecycle: LoopLifecycleState
  cursor: RpcJsonValue
  runCount: number
  totalCostUsd: number
  failureStreak: number
  lastScheduledAt: number | null
  nextRunAt: number | null
  nextTrigger: LoopRunTrigger | null
  evolveDue: boolean
  evolveTrigger: 'auto_evolve' | 'manual_evolve' | null
  editRequest: string | null
  lastEvolveAt: number | null
  evolvedRunCount: number
  deleted: boolean
}
interface LoopJournalEvent { version: 1; sequence: number; at: number; document: LoopDocument; run?: LoopRunSummary }
interface StoredLoop { sequence: number; document: LoopDocument; runs: Map<string, LoopRunSummary>; failed?: string }

export function cloneLoop<T>(value: T): T { return structuredClone(value) }

/** 数据根和直接子目录不跟随链接；工作区产物另有独立的路径规则。 */
export function ensureLoopDirectory(path: string): void {
  if (!existsSync(path)) mkdirSync(path, { recursive: true, mode: 0o700 })
  const info = lstatSync(path)
  if (!info.isDirectory() || info.isSymbolicLink()) throw new LoopServiceError('storage_error', 'Loop 数据目录不可用')
}

export class LoopRepository {
  private readonly records = new Map<string, StoredLoop>()
  private readonly failures = new Map<string, string>()
  private disposed = false
  readonly directory: string

  /** 装配期间恢复已提交事件；坏中间行封口，未提交尾片段保留后修复，不借缓存猜数据。 */
  constructor(directory: string, private readonly options: { segmentBytes?: number } = {}) {
    this.directory = resolve(directory)
    ensureLoopDirectory(this.directory)
    for (const entry of readdirSync(this.directory, { withFileTypes: true })) {
      if (!entry.isDirectory() || !/^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/.test(entry.name)) continue
      this.restore(entry.name)
    }
  }

  private restore(id: string): void {
    const directory = join(this.directory, id)
    let stored: StoredLoop | undefined
    try {
      // 已关闭段按末序号排序；最后的活动段可不存在（轮换 rename 后恰好退出）。
      const archives = readdirSync(directory).filter((name) => /^journal-\d{16}\.jsonl$/.test(name)).sort()
      const files = [...archives, ...(existsSync(join(directory, 'journal.jsonl')) ? ['journal.jsonl'] : [])]
      if (!files.length) return
      for (const name of files) {
        const active = name === 'journal.jsonl'
        const fd = openSync(join(directory, name), (active ? constants.O_RDWR : constants.O_RDONLY) | constants.O_NOFOLLOW | constants.O_NONBLOCK)
        let text: string
        let brokenClosedTail = false
        try {
          const info = fstatSync(fd)
          if (!info.isFile() || info.size > Math.max(MAX_JOURNAL, this.options.segmentBytes ?? 0, MAX_EVENT)) throw new Error('日志类型或长度无效')
          const bytes = readFileSync(fd)
          const last = bytes.lastIndexOf(10)
          if (last !== bytes.length - 1) {
            // 只修复活动段未提交尾片段；已关闭段损坏必须封口，不能静默丢失历史。
            if (!active) brokenClosedTail = true
            else {
              writeFileSync(join(directory, `journal-tail-${randomUUID()}.bin`), bytes.subarray(last + 1), { mode: 0o600, flag: 'wx' })
              ftruncateSync(fd, last + 1); fsyncSync(fd)
            }
          }
          text = bytes.subarray(0, last + 1).toString('utf8')
        } finally { closeSync(fd) }
        for (const line of text.split('\n')) {
          if (!line) continue
          if (Buffer.byteLength(line) > MAX_EVENT) throw new Error('事件长度超限')
          const event = loopObject(JSON.parse(line))
          if (event.version !== 1 || event.sequence !== (stored?.sequence ?? 0) + 1) throw new Error('事件序号无效')
          const document = this.parseDocument(event.document, id)
          const runs: Map<string, LoopRunSummary> = stored?.runs ?? new Map<string, LoopRunSummary>()
          if (event.run !== undefined) {
            const run = this.parseRun(event.run, id)
            runs.set(run.id, run)
          }
          stored = { sequence: event.sequence as number, document, runs }
        }
        if (brokenClosedTail || !active && stored?.sequence !== Number(name.slice(8, -6))) throw new Error('日志段不完整或末序号无效')
      }
      if (!stored) throw new Error('日志没有有效初始事件')
    } catch {
      this.failures.set(id, 'Loop 日志损坏，已停止此任务；请检查数据文件')
      if (stored) stored.failed = 'Loop 日志损坏，已停止此任务；请检查数据文件'
      console.warn('[Loop] 任务日志恢复失败', id)
    }
    if (stored) this.records.set(id, stored)
  }

  private parseDocument(value: unknown, id: string): LoopDocument {
    const input = loopObject(value)
    const definition = parseStoredLoopDefinition(input.definition)
    const lifecycle = loopObject(input.lifecycle)
    if (definition.id !== id || lifecycle.loopId !== id || lifecycle.definitionRevision !== definition.executionRevision
      || lifecycle.goal !== definition.goal || lifecycle.enabled !== definition.enabled
      || typeof input.deleted !== 'boolean' || typeof input.evolveDue !== 'boolean'
      || typeof input.preparation !== 'string' || !['pending', 'ready', 'failed'].includes(input.preparation) || typeof input.runAfterPreparation !== 'boolean'
      || !Number.isSafeInteger(input.runCount) || (input.runCount as number) < 0
      || !Number.isFinite(input.totalCostUsd) || (input.totalCostUsd as number) < 0 || !Number.isSafeInteger(input.failureStreak) || (input.failureStreak as number) < 0
      || !Number.isSafeInteger(input.evolvedRunCount) || (input.evolvedRunCount as number) < 0) throw new Error('任务状态无效')
    for (const key of ['lastScheduledAt', 'nextRunAt', 'lastEvolveAt'] as const) {
      if (input[key] !== null && !Number.isFinite(input[key])) throw new Error('任务时间无效')
    }
    if (input.editRequest !== null && typeof input.editRequest !== 'string') throw new Error('编辑请求无效')
    if (input.preparation !== 'pending' && input.runAfterPreparation) throw new Error('准备后的执行意图无效')
    if ((input.nextRunAt === null) !== (input.nextTrigger === null) || input.nextTrigger !== null && !isTrigger(input.nextTrigger)
      || input.evolveDue !== (input.evolveTrigger !== null) || input.evolveTrigger !== null && !['auto_evolve', 'manual_evolve'].includes(String(input.evolveTrigger))) throw new Error('执行来源无效')
    if (lifecycle.activeRun !== null) {
      const run = loopObject(lifecycle.activeRun)
      if (run.loopId !== id || typeof run.phase !== 'string' || !['pending', 'running'].includes(run.phase)
        || typeof run.role !== 'string' || !['exec', 'evolve', 'edit', 'setup'].includes(run.role) || !Number.isSafeInteger(run.definitionRevision)
        || !Number.isFinite(run.queuedAt) || run.goal !== null && typeof run.goal !== 'string') throw new Error('活跃执行无效')
      loopId(run.runId)
      if (run.role === 'setup' ? input.preparation !== 'pending' : input.preparation !== 'ready') throw new Error('准备状态与活跃执行不一致')
    }
    if (lifecycle.completion !== null) {
      const completion = loopObject(lifecycle.completion)
      if (definition.goal === null || definition.enabled || !Number.isFinite(completion.completedAt) || typeof completion.reason !== 'string') throw new Error('完成状态无效')
      loopId(completion.runId)
    }
    return { ...input, definition } as unknown as LoopDocument
  }

  private parseRun(value: unknown, id: string): LoopRunSummary {
    const run = loopObject(value)
    loopId(run.id)
    if (run.loopId !== id || typeof run.phase !== 'string' || !['pending', 'running', 'done', 'error', 'canceled', 'interrupted'].includes(run.phase)
      || typeof run.role !== 'string' || !['exec', 'evolve', 'edit', 'setup'].includes(run.role) || !Number.isSafeInteger(run.definitionRevision) || (run.definitionRevision as number) < 1
      || !Number.isFinite(run.queuedAt) || typeof run.ts !== 'string' || !Number.isFinite(Date.parse(run.ts))
      || !isTrigger(run.trigger) || run.running !== (run.phase === 'running') || run.queued !== (run.phase === 'pending')) throw new Error('执行记录无效')
    for (const key of ['startedAt', 'finishedAt', 'durationMs'] as const) {
      if (run[key] !== null && (!Number.isFinite(run[key]) || (run[key] as number) < 0)) throw new Error('执行时间无效')
    }
    for (const [key, limit] of [['message', 16000], ['error', 4000], ['finalText', 32000], ['query', 64000], ['instruction', 16000]] as const) {
      if (run[key] !== undefined && (typeof run[key] !== 'string' || (run[key] as string).length > limit)) throw new Error('执行内容无效')
    }
    if (run.sessionId !== undefined) loopId(run.sessionId)
    if (run.workflowId !== undefined) loopId(run.workflowId)
    if (run.costUsd !== undefined && (!Number.isFinite(run.costUsd) || (run.costUsd as number) < 0)) throw new Error('执行费用无效')
    return run as unknown as LoopRunSummary
  }

  list(): LoopDocument[] { return [...this.records.values()].filter((record) => !record.document.deleted).map((record) => cloneLoop(record.document)) }
  read(id: string): LoopDocument {
    const record = this.records.get(loopId(id))
    if (!record || record.document.deleted) throw new LoopServiceError('not_found', 'Loop 不存在')
    return cloneLoop(record.document)
  }
  runs(id: string): LoopRunSummary[] {
    this.read(id)
    return [...this.records.get(id)!.runs.values()].sort((a, b) => b.queuedAt - a.queuedAt).map((run) => cloneLoop(run))
  }
  failure(id: string): string | undefined { return this.failures.get(id) ?? this.records.get(id)?.failed }

  /** 单条事件同时包含计划状态与执行终态；fsync 成功才发布内存，失败封口避免重复序号。 */
  commit(document: LoopDocument, run?: LoopRunSummary): void {
    if (this.disposed) throw new LoopServiceError('unavailable', 'Loop 存储已关闭')
    const id = loopId(document.definition.id)
    const previous = this.records.get(id)
    const failure = this.failure(id)
    if (failure) throw new LoopServiceError('storage_error', failure)
    this.parseDocument(document, id)
    if (run) this.parseRun(run, id)
    const event: LoopJournalEvent = { version: 1, sequence: (previous?.sequence ?? 0) + 1, at: Date.now(), document, ...(run ? { run } : {}) }
    const bytes = Buffer.from(JSON.stringify(event) + '\n')
    if (bytes.length > MAX_EVENT) throw new LoopServiceError('invalid_input', 'Loop 事件过大')
    const directory = join(this.directory, id)
    ensureLoopDirectory(this.directory); ensureLoopDirectory(directory)
    try {
      const path = join(directory, 'journal.jsonl')
      if (existsSync(path)) {
        const info = lstatSync(path)
        if (!info.isFile() || info.isSymbolicLink()) throw new Error('活动日志不是普通文件')
        if (info.size > 0 && info.size + bytes.length > (this.options.segmentBytes ?? MAX_JOURNAL)) {
          if (!previous) throw new Error('日志没有对应内存状态')
          const archive = join(directory, `journal-${String(previous.sequence).padStart(16, '0')}.jsonl`)
          if (existsSync(archive)) throw new Error('日志段名称已占用，不覆盖既有文件')
          // rename 只移动已提交段；新事件仍从原全局序号继续，任意断点都可重放。
          renameSync(path, archive)
          this.syncDirectory(directory)
        }
      }
      const fd = openSync(path, constants.O_WRONLY | constants.O_CREAT | constants.O_APPEND | constants.O_NOFOLLOW, 0o600)
      try {
        const info = fstatSync(fd)
        if (!info.isFile() || info.size + bytes.length > Math.max(MAX_JOURNAL, MAX_EVENT, this.options.segmentBytes ?? 0)) throw new Error('Loop 日志段容量无效')
        let offset = 0
        while (offset < bytes.length) offset += writeSync(fd, bytes, offset, bytes.length - offset)
        fsyncSync(fd)
      } finally { closeSync(fd) }
      this.syncDirectory(directory)
    } catch {
      if (previous) previous.failed = 'Loop 日志写入结果未知，已停止后续写入，请重启检查'
      throw new LoopServiceError('storage_error', 'Loop 状态未确认保存，不得重投执行')
    }
    const runs = previous?.runs ?? new Map<string, LoopRunSummary>()
    if (run) runs.set(run.id, cloneLoop(run))
    this.records.set(id, { sequence: event.sequence, document: cloneLoop(document), runs })
    // 快照只是缓存；失败不能把已成功提交的权威事件报告成未提交。
    const temporary = join(directory, `snapshot-${randomUUID()}.tmp`)
    try {
      writeFileSync(temporary, JSON.stringify({ version: 1, sequence: event.sequence, document }), { flag: 'wx', mode: 0o600 })
      renameSync(temporary, join(directory, 'snapshot.json'))
    } catch { console.warn('[Loop] 派生快照暂未更新', id) }
  }

  /** 先固定段名称与新文件的目录项，再向上游发布提交成功。 */
  private syncDirectory(directory: string): void {
    const fd = openSync(directory, constants.O_RDONLY)
    try { fsyncSync(fd) } finally { closeSync(fd) }
  }

  dispose(): void { this.disposed = true }
}

function isTrigger(value: unknown): value is LoopRunTrigger {
  return typeof value === 'string' && ['scheduled', 'manual', 'rescheduled', 'catchup', 'auto_evolve', 'manual_evolve', 'user_edit', 'initial_setup'].includes(value)
}
