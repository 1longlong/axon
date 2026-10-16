/** CLI 父入口编排：预检 → 自有后端 → 工作流 → 正文交付/真实退出，不装配模型循环。 */
import { randomUUID } from 'node:crypto'
import type { Readable, Writable } from 'node:stream'
import { APP_SERVER_METHODS as methods } from '@axon/shared'
import type { AgentTypedError, ExecExitCode } from '@axon/shared'
import { version } from '../package.json'
import { EXEC_HELP, ExecInputError, parseExecArguments } from './arguments'
import { ExecBackendError, ExecBackendProcess } from './backend-process'
import type { ExecBackendProcessOptions } from './backend-process'
import { resolveExecConfiguration } from './config'
import { ExecOutputError, ExecOutputStream } from './output-stream'
import { checkExecCredential, createExecChildEnvironment, prepareExec, readExecStdin } from './preflight'
import { ExecRunStream, ExecStreamError } from './run-stream'
import type { ExecWorkflowSnapshot } from './run-stream'
import { prepareExecSession } from './session-target'
import { ExecOutputFile, ExecFileOutputError } from './output-file'
import { ExecOutputSchema, ExecSchemaError } from './output-schema'
import { ExecEphemeralDirectory } from './ephemeral-directory'

interface SignalSource {
  on(event: 'SIGINT' | 'SIGTERM', listener: () => void): unknown
  removeListener(event: 'SIGINT' | 'SIGTERM', listener: () => void): unknown
}
export type ExecBackendPort = Pick<ExecBackendProcess, 'start' | 'stop' | 'request' | 'signal' | 'clientId' | 'authorizeChannel'>
export interface ExecCommandContext {
  argv: string[]
  originalCwd: string
  homeDir: string
  platform: NodeJS.Platform
  environment: NodeJS.ProcessEnv
  stdin: Readable & { isTTY?: boolean }
  stdout: Writable
  stderr: Writable & { isTTY?: boolean }
  signals: SignalSource
  /** 仅可信测试/宿主组合；用户参数不能替换执行器或提供虚假沙箱声明。 */
  createBackend?: (options: ExecBackendProcessOptions) => ExecBackendPort
}
interface Failure { exitCode: Exclude<ExecExitCode, 0>; error: AgentTypedError }
function failure(exitCode: Failure['exitCode'], code: string, message: string, category: AgentTypedError['category'] = 'runtime'): Failure {
  return { exitCode, error: { code, category, message, retryable: false } }
}

/** 保留首个取消/故障原因；正常关停不误判断开，信号/总期限覆盖初始化及后台交付。 */
export async function runExecCommand(context: ExecCommandContext): Promise<ExecExitCode> {
  const begunAt = performance.now(), cancellation = new AbortController()
  let reason: Failure | undefined, backend: ExecBackendPort | undefined, collector: ExecRunStream | undefined,
    sink: ExecOutputStream | undefined, snapshot: ExecWorkflowSnapshot | undefined,
    timer: ReturnType<typeof setTimeout> | undefined, executionBegun = false, json = false, color = false, recoveryFallback = false
  let schema: ExecOutputSchema | undefined, output: ExecOutputFile | undefined
  let ephemeral: ExecEphemeralDirectory | undefined
  let backendDrained = false, ephemeralRetained = false
  const releases: Array<() => void> = []
  let unwatchBackend = (): void => {}, cleanup: 'completed' | 'failed' | 'not_started' = 'not_started'
  const interrupt = (value: Failure): void => {
    if (cancellation.signal.aborted) return
    reason ??= value
    // 取消原执行 RPC，并关闭自有输入/后端；EOF 的 core 清理仍等待实际子执行 finally。
    cancellation.abort(value.error)
    context.stdin.destroy()
    if (backend) void backend.stop().catch(() => {})
  }
  const watch = (signal: AbortSignal, value: Failure): (() => void) => {
    const abort = (): void => interrupt(value)
    signal.addEventListener('abort', abort, { once: true })
    if (signal.aborted) abort()
    return () => signal.removeEventListener('abort', abort)
  }
  const sigint = (): void => interrupt(failure(130, 'exec_sigint', '收到 SIGINT，已取消执行', 'canceled'))
  const sigterm = (): void => interrupt(failure(143, 'exec_sigterm', '收到 SIGTERM，已取消执行', 'canceled'))
  context.signals.on('SIGINT', sigint); context.signals.on('SIGTERM', sigterm)
  releases.push(() => { context.signals.removeListener('SIGINT', sigint); context.signals.removeListener('SIGTERM', sigterm) })

  /** 正常背压可等待；取消在途输出关闭本命令的 stdout，取消后诊断最多给一秒交付机会。 */
  const deliver = async (start: () => Promise<void>): Promise<void> => {
    const close = (): void => { context.stdout.destroy() }
    const grace = cancellation.signal.aborted ? setTimeout(close, 1000) : undefined
    if (!grace) cancellation.signal.addEventListener('abort', close, { once: true })
    try { await start() }
    finally { if (grace) clearTimeout(grace); cancellation.signal.removeEventListener('abort', close) }
  }

  try {
    const args = parseExecArguments(context.argv)
    json = args.flags.json
    color = args.flags.color === 'always' || args.flags.color !== 'never' && context.stderr.isTTY === true
    sink = new ExecOutputStream(context.stdout, json && !args.help && !args.version)
    releases.push(watch(sink.signal, failure(1, 'exec_output_error', '输出无法完成，未自动重跑任务')))
    if (args.help || args.version) {
      await deliver(() => sink!.writeFinal(args.help ? EXEC_HELP : `axon ${version}\n`))
      for (const release of releases) release()
      sink.dispose()
      return reason?.exitCode ?? 0
    }
    collector = new ExecRunStream({ executionId: randomUUID(), emit: (event) => {
      // 语义恢复必须在普通入口也可见；使用中立事件，不读取或猜测 Runtime 文件状态。
      if (event.type === 'agent_event' && event.event.type === 'stream' && event.event.payload.kind === 'sdk_message') {
        const message = event.event.payload.message
        if (message.type === 'system' && message.subtype === 'runtime_session_recovered') recoveryFallback = true
      }
      sink!.emit(event)
    } })
    collector.beginExecution(); executionBegun = true
    releases.push(watch(collector.signal, failure(1, 'exec_protocol_error', '后端工作流事件或结果无效，未自动重跑任务', 'protocol')))
    const childEnvironment = createExecChildEnvironment(context.environment)
    const configuration = resolveExecConfiguration(args, context.originalCwd, context.homeDir)
    if (configuration.settings.timeout !== undefined) {
      const remaining = configuration.settings.timeout * 1000 - (performance.now() - begunAt)
      const expired = (): void => interrupt(failure(124, 'exec_timeout', '达到总执行期限，已取消执行', 'canceled'))
      if (remaining <= 0) expired(); else timer = setTimeout(expired, remaining)
    }
    cancellation.signal.throwIfAborted()
    // stdin 读取也受总期限/信号约束；实际销毁输入使在途读取退出，不只 Promise.race。
    const isTTY = context.stdin.isTTY === true
    const stdin = isTTY ? undefined : await readExecStdin(context.stdin)
    cancellation.signal.throwIfAborted()
    const prepared = await prepareExec(args, { originalCwd: context.originalCwd, homeDir: context.homeDir,
      platform: context.platform, stdin, isTTY, configuration, signal: cancellation.signal })
    if (args.kind === 'exec') checkExecCredential(prepared.configuration)
    cancellation.signal.throwIfAborted()
    // schema 编译/输出路径先于业务创建；格式要求不改写原始用户 prompt。
    output = ExecOutputFile.prepare(prepared)
    if (prepared.outputSchema !== undefined) schema = await ExecOutputSchema.compile(prepared.outputSchema, cancellation.signal)
    cancellation.signal.throwIfAborted()
    // 配置/输出预检完成才分配临时业务根；原数据目录仅作容器，配置与用户输出不进入清理范围。
    if (args.flags.ephemeral) ephemeral = ExecEphemeralDirectory.create(prepared)
    const backendPrepared = ephemeral ? { ...prepared, dataDir: ephemeral.dataDir } : prepared
    backend = (context.createBackend ?? ((options) => new ExecBackendProcess(options)))({
      prepared: backendPrepared, childEnvironment,
      configurePeer: (peer) => collector!.attach(peer), finalOutputInstruction: schema?.instruction })
    await backend.start()
    cancellation.signal.throwIfAborted()
    // 启动失败会自清理并使 lifetime 失效；先保留 start 的配置/能力错误，避免误报连接故障。
    unwatchBackend = watch(backend.signal, failure(1, 'exec_backend_closed', '后端连接中断，交付状态未知，未自动重跑任务'))
    const target = await prepareExecSession(backend, backendPrepared)
    cancellation.signal.throwIfAborted()
    if (!backend.clientId) throw new ExecBackendError('closed')
    collector.bind(backend.clientId, target.session.id)
    snapshot = collector.confirm(await backend.request(methods.AGENT_EXECUTE_WORKFLOW,
      { sessionId: target.session.id, text: target.prompt }, { timeoutMs: 0, signal: cancellation.signal }))
    if (!snapshot.success) reason ??= failure(1, 'exec_workflow_failed', '工作流未正常完成；请查看会话历史或 JSONL 事件')
  } catch (error) {
    if (!reason) {
      if (error instanceof ExecInputError) reason = failure(2, 'exec_invalid_input', error.message, 'configuration')
      else if (error instanceof ExecBackendError) reason = failure(1, `exec_backend_${error.code}`, error.message)
      else if (error instanceof ExecOutputError || error instanceof ExecStreamError) reason = failure(1, 'exec_output_or_protocol_error', error.message, 'protocol')
      else reason = failure(1, 'exec_failed', '执行未完成，交付状态未知；未自动重跑任务')
    }
  } finally {
    // 自有后端真正退出后才提交正文；主动 stop 会使 lifetime 失效，须先去掉故障监听。
    unwatchBackend()
    if (backend) {
      try { await backend.stop(); backendDrained = true; cleanup = 'completed' }
      catch { cleanup = 'failed'; reason ??= failure(1, 'exec_cleanup_failed', '后端清理未正常完成') }
    }
  }

  try {
    // child 已退出才校验正文；持久历史不回滚，临时根按模式清理，不重放工具。
    try {
      if (!reason && snapshot?.success && schema) await schema.validate(snapshot.finalText, cancellation.signal)
    } finally {
      // 工作流失败也必须回收预编译线程；CLI 终态不能先于任何自有校验资源的真实退出。
      if (schema) {
        try { await schema.dispose() }
        catch { cleanup = 'failed'; reason ??= failure(1, 'exec_schema_cleanup_failed', '输出校验线程未能正常退出') }
      }
      if (ephemeral) {
        // 异常退出可能留下持有文件的后代，不能据 stop 抛错就删除业务目录；正常模型失败仍可清理。
        if (backend && !backendDrained) {
          ephemeralRetained = true
          reason ??= failure(1, 'exec_ephemeral_retained', '后端清理失败，临时业务目录已保留')
        } else {
          try { await ephemeral.dispose(); if (cleanup !== 'failed') cleanup = 'completed' }
          catch { ephemeralRetained = true; cleanup = 'failed'; reason ??= failure(1, 'exec_ephemeral_cleanup_failed', '临时业务目录未能安全清理，已保留以便检查', 'persistence') }
        }
      }
    }
    if (!reason && snapshot?.success && output) await output.write(snapshot.finalText, cancellation.signal)
    if (!reason && snapshot?.success) await deliver(() => sink!.writeFinal(snapshot!.finalText))
    else if (sink && !sink.signal.aborted) await deliver(() => sink!.flush())
    if (executionBegun && sink && !sink.signal.aborted) {
      collector!.finishExecution({ exitCode: reason?.exitCode ?? 0, cleanup, ...(reason ? { error: reason.error } : {}) })
      await deliver(() => sink!.flush())
    }
  } catch (error) {
    reason ??= error instanceof ExecSchemaError ? failure(error.kind === 'mismatch' ? 3 : 1,
      `exec_schema_${error.kind}`, error.message, error.kind === 'mismatch' ? 'protocol' : 'runtime')
      : error instanceof ExecFileOutputError ? failure(1, 'exec_file_output_error', error.message, 'persistence')
        : failure(1, 'exec_output_error', '输出无法完成，未自动重跑任务')
    // 校验/文件失败发生在后端完成后，健康的 JSONL 仍需报告唯一失败 CLI 终态。
    if (executionBegun && sink && !sink.signal.aborted) {
      try { collector!.finishExecution({ exitCode: reason.exitCode, cleanup, error: reason.error }); await deliver(() => sink!.flush()) }
      catch { /* 已发终态或坏管不能重发/冒充交付成功；实际退出码仍非零。 */ }
    }
  }

  // 诊断仅使用稳定脱敏信息；stderr 自身断管也不能留下未处理 error 或无限等待。
  if (reason || cleanup === 'failed' || recoveryFallback) {
    const recoveryNotice = '原 Runtime 历史不可用，已从应用历史语义恢复，并非无损续跑'
    const diagnostic = `Axon：${reason?.error.message ?? (recoveryFallback ? recoveryNotice : '执行未完成')}${reason && recoveryFallback ? `；${recoveryNotice}` : ''}${cleanup === 'failed' && reason?.error.code !== 'exec_cleanup_failed' ? '；执行资源清理未正常完成' : ''}${ephemeralRetained && !reason?.error.code.startsWith('exec_ephemeral_') ? '；临时业务目录已保留' : ''}。\n`
    const text = color ? `\u001b[31m${diagnostic}\u001b[0m` : diagnostic
    const diagnostics = new ExecOutputStream(context.stderr, false)
    const close = setTimeout(() => context.stderr.destroy(), 1000)
    try { await diagnostics.writeFinal(text) }
    catch { reason ??= failure(1, 'exec_diagnostic_error', '诊断无法完成') }
    finally { clearTimeout(close); diagnostics.dispose() }
  }
  if (timer) clearTimeout(timer)
  for (const release of releases) release()
  collector?.dispose(); sink?.dispose()
  return reason?.exitCode ?? 0
}
