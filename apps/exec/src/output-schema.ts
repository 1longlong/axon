/** CLI 的一次 schema 编译/最终校验；可取消的线程不执行工具，也不构成 OS 内存沙箱。 */
import { Worker } from 'node:worker_threads'
import { ExecInputError } from './arguments'
declare const AXON_EXEC_COMPILED: boolean

export class ExecSchemaError extends Error {
  constructor(readonly kind: 'mismatch' | 'unavailable') {
    super(kind === 'mismatch' ? '最终回复不是满足指定 Schema 的 JSON；未自动重跑任务' : '最终输出校验无法完成；未自动重跑任务')
    this.name = 'ExecSchemaError'
  }
}

/** 尺寸和深度只约束资源输入；实际语义由 Ajv 编译检查，不能只检查外壳就声称 schema 有效。 */
function assertSchema(value: unknown): asserts value is boolean | Record<string, unknown> {
  if (typeof value !== 'boolean' && (!value || typeof value !== 'object' || Array.isArray(value))) throw new ExecInputError('输出 Schema 必须是 JSON 对象或 boolean')
  const pending: Array<{ value: unknown; depth: number }> = [{ value, depth: 0 }]
  while (pending.length) {
    const item = pending.pop()!
    if (item.depth > 100) throw new ExecInputError('输出 Schema 超过 100 层深度限制')
    if (item.value !== null && typeof item.value === 'object') {
      for (const value of Object.values(item.value)) pending.push({ value, depth: item.depth + 1 })
    }
  }
  if (Buffer.byteLength(JSON.stringify(value)) > 1024 * 1024) throw new ExecInputError('输出 Schema 超过 1 MiB 限制')
}

/** 编译先于业务创建；同一线程保留函数，最后完整正文只校验一次，失败/取消等待真实线程退出。 */
export class ExecOutputSchema {
  private readonly worker: Worker
  private readonly exited: Promise<void>
  private closing?: Promise<void>
  private used = false
  private ended = false
  private constructor(schema: boolean | Record<string, unknown>, readonly instruction: string) {
    // 编译产物的内嵌入口是 .js；源码保留 .ts，均从本模块位置解析，不从工作区加载线程。
    const compiled = typeof AXON_EXEC_COMPILED !== 'undefined' && AXON_EXEC_COMPILED
    this.worker = new Worker(new URL(compiled ? './schema-worker.js' : './schema-worker.ts', import.meta.url), { workerData: { schema } })
    // 永久错误监听防止取消后迟到 error 无人消费；每次请求另负责将故障交给原调用方。
    this.worker.on('error', () => {})
    this.exited = new Promise((resolve) => this.worker.once('exit', () => { this.ended = true; resolve() }))
  }

  static async compile(schema: unknown, signal: AbortSignal): Promise<ExecOutputSchema> {
    signal.throwIfAborted(); assertSchema(schema)
    const instruction = ['[最终输出要求]',
      '仅主 Agent 的工作流最终回复必须是满足下面 JSON Schema 的一个完整 JSON 值。不要在最终 JSON 前后添加解释、Markdown 代码围栏或其他文字。',
      '工具调用、思考和子 Agent 的正常执行流程不受此格式限制；不能为满足格式跳过权限和任务约束。', JSON.stringify(schema)].join('\n')
    const compiled = new ExecOutputSchema(schema, instruction)
    try {
      const packet = await compiled.wait(signal)
      if (packet.type !== 'ready') throw new Error()
      return compiled
    } catch {
      await compiled.dispose()
      signal.throwIfAborted()
      throw new ExecInputError('输出 Schema 无效、引用不可解析或编译未在 5 秒内完成；支持 draft-07/2019-09/2020-12，不读取外部引用')
    }
  }

  async validate(text: string, signal: AbortSignal): Promise<void> {
    signal.throwIfAborted()
    if (this.used || this.closing || this.ended) throw new ExecSchemaError('unavailable')
    this.used = true
    try {
      const response = this.wait(signal)
      this.worker.postMessage(text)
      const packet = await response
      if (packet.type !== 'validation' || typeof packet.valid !== 'boolean') throw new ExecSchemaError('unavailable')
      if (!packet.valid) throw new ExecSchemaError('mismatch')
    } catch (error) {
      signal.throwIfAborted()
      if (error instanceof ExecSchemaError) throw error
      throw new ExecSchemaError('unavailable')
    } finally { await this.dispose() }
  }

  /** 每次等待最多五秒；父线程可处理总期限/信号，再 terminate 真正退出卡住的校验线程。 */
  private wait(signal: AbortSignal): Promise<{ type: string; valid?: unknown }> {
    return new Promise((resolve, reject) => {
      const failure = (): void => finish(() => reject(new ExecSchemaError('unavailable')))
      const message = (value: unknown): void => finish(() => {
        if (!value || typeof value !== 'object' || !('type' in value) || typeof value.type !== 'string') reject(new ExecSchemaError('unavailable'))
        else resolve(value as { type: string; valid?: unknown })
      })
      const timer = setTimeout(failure, 5000)
      const finish = (action: () => void): void => {
        clearTimeout(timer); signal.removeEventListener('abort', failure)
        this.worker.removeListener('error', failure); this.worker.removeListener('exit', failure); this.worker.removeListener('message', message)
        action()
      }
      this.worker.once('message', message); this.worker.once('error', failure); this.worker.once('exit', failure)
      signal.addEventListener('abort', failure, { once: true })
      if (signal.aborted || this.ended || this.closing) failure()
    })
  }

  /** 先封口，再等待实际 Worker exit；不会把取消等待当线程已结束。 */
  dispose(): Promise<void> {
    return this.closing ??= (async () => { if (!this.ended) await this.worker.terminate(); await this.exited })()
  }
}
