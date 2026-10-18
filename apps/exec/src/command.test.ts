import { afterEach, describe, expect, test } from 'bun:test'
import { EventEmitter } from 'node:events'
import { existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, realpathSync, renameSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { PassThrough, Writable } from 'node:stream'
import { JsonRpcPeer, toWireValue } from '@axon/app-server'
import { APP_SERVER_METHODS as methods, APP_SERVER_NOTIFICATIONS as notices } from '@axon/shared'
import type { AgentCompletionPayload, AgentWorkflowResult, AppServerInitializeResult, ExecEvent } from '@axon/shared'
import { runExecCommand } from './command'
import { ExecInputError } from './arguments'
import { version } from '../package.json'
import type { ExecBackendPort, ExecCommandContext } from './command'

const cleanups: Array<() => Promise<void>> = []
afterEach(async () => { for (const cleanup of cleanups.splice(0).reverse()) await cleanup() })
function aborting(signal: AbortSignal): Promise<void> {
  return signal.aborted ? Promise.resolve() : new Promise((resolve) => signal.addEventListener('abort', () => resolve(), { once: true }))
}
/** 真实 peer/流验证命令生命周期；后台端口不装配 core，也不假称通过 OS/SDK 验收。 */
function fixture(options: { json?: boolean; hold?: boolean; startup?: boolean; cleanupFailure?: boolean;
  modelFailure?: boolean; missingFinish?: boolean; output?: Writable; pipe?: boolean; timeout?: boolean; holdShutdown?: boolean;
  unsupportedCapability?: boolean; finalText?: string; beforeFinish?: () => void; recovery?: boolean } = {}) {
  const directory = realpathSync(mkdtempSync(join(tmpdir(), 'axon-exec-command-'))), cwd = join(directory, 'project'), homeDir = join(directory, 'home')
  mkdirSync(cwd); mkdirSync(homeDir); mkdirSync(join(homeDir, '.axon-exec'))
  writeFileSync(join(homeDir, '.axon-exec/config.json'), JSON.stringify({ defaults: { channel: 'selected', skills: false,
    mcp: false, memory: false, tasks: false, ...(options.timeout ? { timeout: 1 } : {}) }, channels: [{ id: 'selected', provider: 'custom',
      baseUrl: 'http://localhost:8123/v1', apiKey: 'fixture-secret', defaultModel: 'fixture', models: [{ id: 'fixture' }] }] }))
  const signals = new EventEmitter(), stdin = Object.assign(new PassThrough(), { isTTY: !options.pipe })
  const chunks: string[] = [], errors: string[] = []
  const stdout = options.output ?? new Writable({ write(chunk: Buffer, _encoding, done) { chunks.push(chunk.toString()); done() } })
  const stderr = new Writable({ write(chunk: Buffer, _encoding, done) { errors.push(chunk.toString()); done() } })
  const up = new PassThrough(), down = new PassThrough(), parent = new JsonRpcPeer(down, up), child = new JsonRpcPeer(up, down)
  const lifetime = new AbortController(), entered = Promise.withResolvers<void>(), aborted = Promise.withResolvers<void>(),
    modelCleanup = Promise.withResolvers<void>(), stopEntered = Promise.withResolvers<void>(), shutdown = Promise.withResolvers<void>()
  const active = new Set<Promise<unknown>>()
  let creations = 0, executions = 0, stopped = 0, stopping: Promise<void> | undefined, prompt = '', childKey: string | undefined,
    instruction: string | undefined, backendDataDir: string | undefined
  if (!options.hold) modelCleanup.resolve()
  if (!options.holdShutdown) shutdown.resolve()
  const project = { id: 'project', slug: 'project', name: '隔离项目', workspace: { kind: 'local', path: cwd }, createdAt: 1, updatedAt: 1, memoryEnabled: false }
  const session = { id: 'root', title: '任务', runtimeId: 'pi', channelId: 'selected', modelId: 'fixture', projectId: 'project',
    creationOrigin: 'exec', creationWorkspacePath: cwd,
    sandboxMode: 'readOnly', approvalPolicy: 'never', approvalReviewer: 'user', userInputPolicy: 'reject', createdAt: 1, updatedAt: 1 }
  const workflow = { workflowId: 'workflow', sessionId: session.id, startedAt: 1 }, run = { sessionId: session.id, runId: 'run', runStartedAt: 2 }
  const completion: AgentCompletionPayload = { terminalReason: 'completed', resultSubtype: options.modelFailure ? 'error' : 'success',
    stoppedByUser: false, persisted: true, usage: { input_tokens: 1 }, completedAt: 3, durationMs: 1 }
  child.handle(methods.PROJECT_LIST, () => [])
  child.handle(methods.PROJECT_CREATE, () => toWireValue(project))
  child.handle(methods.AGENT_CREATE_SESSION, () => { creations++; return toWireValue(session) })
  child.handle(methods.AGENT_EXECUTE_WORKFLOW, (params, request) => {
    const actual = (async () => {
      executions++
      const packet = params as { input: { text: string } }; prompt = packet.input.text
      child.notify(notices.AGENT_WORKFLOW, { clientId: 'external', event: { type: 'workflow_started', workflow } })
      const event = (payload: unknown) => child.notify(notices.AGENT_RUN, { clientId: 'external', event: toWireValue({ run, visibleSessionId: session.id, event: payload }) })
      event({ type: 'run_started', sessionId: session.id, runStartedAt: 2, source: 'external' })
      if (options.recovery) event({ type: 'stream', sessionId: session.id, runStartedAt: 2, source: 'external',
        payload: { kind: 'sdk_message', message: { type: 'system', subtype: 'runtime_session_recovered', uuid: 'recovery' } } })
      entered.resolve()
      if (options.hold) {
        await aborting(request.signal); aborted.resolve(); await modelCleanup.promise
        throw new Error('fixture-secret-model-cleanup')
      }
      event({ type: 'stream', sessionId: session.id, runStartedAt: 2, source: 'external', payload: { kind: 'sdk_message',
        message: { type: 'assistant', uuid: 'answer', parent_tool_use_id: null, message: { content: [{ type: 'text', text: options.finalText ?? '  最终正文\n\n' }] } } } })
      event({ type: 'stream', sessionId: session.id, runStartedAt: 2, source: 'external', payload: { kind: 'sdk_message',
        message: { type: 'result', subtype: completion.resultSubtype, usage: completion.usage } } })
      event({ type: 'run_finished', sessionId: session.id, runStartedAt: 2, source: 'external', completion })
      const result: AgentWorkflowResult = { workflow, status: options.modelFailure ? 'failed' : 'completed', lastRun: run, completion,
        ...(options.modelFailure ? { error: { code: 'provider_error', category: 'provider' as const, message: '模型失败', retryable: false } } : {}) }
      options.beforeFinish?.()
      if (!options.missingFinish) child.notify(notices.AGENT_WORKFLOW, { clientId: 'external', event: { type: 'workflow_finished', result: toWireValue(result) } })
      return toWireValue(result)
    })()
    active.add(actual); void actual.then(() => active.delete(actual), () => active.delete(actual))
    return actual
  })
  const context: ExecCommandContext = { argv: ['exec', '--skip-git-repo-check', ...(options.json ? ['--json'] : []), '  原始任务\n'],
    originalCwd: cwd, homeDir, platform: 'darwin', environment: { ...process.env, AXON_API_KEY: 'fixture-secret' },
    stdin, stdout, stderr, signals,
    createBackend: (configuration) => {
      backendDataDir = configuration.prepared.dataDir
      configuration.configurePeer!(parent)
      childKey = configuration.childEnvironment.AXON_API_KEY
      instruction = configuration.finalOutputInstruction
      const port: ExecBackendPort = { signal: lifetime.signal, clientId: 'external',
        authorizeChannel() {},
        async start() {
          if (options.startup) { entered.resolve(); await aborting(lifetime.signal); throw new Error('fixture-secret-startup') }
          if (options.unsupportedCapability) {
            lifetime.abort()
            throw new ExecInputError('真实宿主沙箱不支持所选模式')
          }
          return { protocolVersion: 1, connectionId: 'fixture', applicationVersion: '0.1.4', dataDirectory: configuration.prepared.dataDir,
            capabilities: { runtimes: [], credentialStorage: 'unavailable', channelTargetConfirmation: false } } satisfies AppServerInitializeResult
        },
        request: (method, input, request = {}) => parent.request(method, { clientId: 'external', ...(input === undefined ? {} : { input }) }, request),
        stop() {
          if (stopping) return stopping
          stopped++; lifetime.abort(); parent.close(); child.close(); stopEntered.resolve()
          stopping = (async () => {
            await Promise.allSettled([...active]); await shutdown.promise
            if (options.cleanupFailure) throw new Error('fixture-secret-shutdown')
          })()
          return stopping
        },
      }
      return port
    },
  }
  cleanups.push(async () => { modelCleanup.resolve(); shutdown.resolve(); parent.close(); child.close(); stdin.destroy(); stdout.destroy(); stderr.destroy();
    up.destroy(); down.destroy(); rmSync(directory, { recursive: true, force: true }) })
  return { context, signals, stdin, chunks, errors, entered, aborted, modelCleanup, stopEntered, shutdown, cwd,
    get backendDataDir() { return backendDataDir },
    get creations() { return creations }, get executions() { return executions }, get stopped() { return stopped }, get prompt() { return prompt },
    get childKey() { return childKey }, get instruction() { return instruction } }
}

describe('exec 实际命令编排与退出', () => {
  test('普通输出的语义恢复提示不污染正文；后续工作流失败也仍明确提示降级', async () => {
    for (const modelFailure of [false, true]) {
      const f = fixture({ recovery: true, modelFailure })
      expect(await runExecCommand(f.context)).toBe(modelFailure ? 1 : 0)
      expect(f.errors.join('')).toContain('语义恢复')
      expect(f.chunks.join('')).toBe(modelFailure ? '' : '  最终正文\n\n')
    }
  })
  test('帮助/版本不读配置/输入/凭据或启动后端，退出后移除信号监听', async () => {
    for (const option of ['--help', '--version']) {
      const f = fixture({ pipe: true }); f.context.argv = ['--json', option]
      expect(await runExecCommand(f.context)).toBe(0)
      expect(f.creations).toBe(0); expect(f.stopped).toBe(0)
      expect(f.chunks.join('')).toContain(option === '--help' ? '用法：axon exec' : `axon ${version}`)
      expect(f.chunks.join('')).not.toContain('exec_started')
      expect(f.signals.listenerCount('SIGINT')).toBe(0); expect(f.signals.listenerCount('SIGTERM')).toBe(0)
    }
  })

  test('普通正文/JSONL 是同一工作流；真实退出后才交付正文/CLI 唯一终态，凭据不进输出', async () => {
    for (const json of [false, true]) {
      const f = fixture({ json })
      expect(await runExecCommand(f.context)).toBe(0)
      expect(f.executions).toBe(1); expect(f.stopped).toBe(1); expect(f.prompt).toBe('  原始任务\n')
      expect(f.childKey).toBeUndefined(); expect(f.context.environment.AXON_API_KEY).toBeUndefined()
      expect(f.errors).toEqual([])
      if (!json) expect(f.chunks.join('')).toBe('  最终正文\n\n')
      else {
        const events = f.chunks.map((line) => JSON.parse(line) as ExecEvent)
        expect(events[0]?.type).toBe('exec_started')
        expect(events.at(-1)).toMatchObject({ type: 'exec_finished', completion: { exitCode: 0, cleanup: 'completed' } })
        expect(events.filter((event) => event.type === 'exec_finished')).toHaveLength(1)
        expect(events.map((event) => event.sequence)).toEqual(events.map((_, index) => index + 1))
        expect(f.chunks.every((line) => line.endsWith('\n') && line.split('\n').length === 2)).toBe(true)
      }
      expect(f.chunks.join('')).not.toContain('fixture-secret'); expect(f.chunks.join('')).not.toContain('clientId')
      expect(f.signals.listenerCount('SIGINT')).toBe(0)
    }
  })

  test('模型错误、缺工作流完成通知或 child 清理失败均非零，不交付成功正文、不重跑', async () => {
    for (const options of [{ modelFailure: true }, { missingFinish: true }, { cleanupFailure: true }]) {
      const f = fixture(options)
      expect(await runExecCommand(f.context)).toBe(1)
      expect(f.executions).toBe(1); expect(f.chunks).toEqual([]); expect(f.stopped).toBe(1)
      expect(f.errors.join('')).not.toContain('fixture-secret')
    }
    const json = fixture({ json: true, cleanupFailure: true })
    expect(await runExecCommand(json.context)).toBe(1)
    expect(JSON.parse(json.chunks.at(-1)!)).toMatchObject({ type: 'exec_finished', completion: { exitCode: 1, cleanup: 'failed' } })
  })

  test('已收到工作流成功仍等实际 child 清理；此前不交付正文或 exec_finished', async () => {
    for (const json of [false, true]) {
      const f = fixture({ json, holdShutdown: true })
      let finished = false
      const pending = runExecCommand(f.context).then((code) => { finished = true; return code })
      try {
        await f.stopEntered.promise
        expect(finished).toBe(false)
        if (json) {
          expect(f.chunks.some((line) => JSON.parse(line).type === 'exec_finished')).toBe(false)
        } else expect(f.chunks).toEqual([])
        f.shutdown.resolve()
        expect(await pending).toBe(0)
        if (json) expect(f.chunks.some((line) => JSON.parse(line).type === 'workflow_finished')).toBe(true)
        else expect(f.chunks.join('')).toBe('  最终正文\n\n')
      } finally { f.shutdown.resolve(); await pending }
    }
  })

  test('SIGINT 在模型运行期间取消原 RPC，等真实 finally；SIGTERM 在初始化期间不启动任务', async () => {
    for (const startup of [false, true]) {
      const f = fixture({ json: true, hold: !startup, startup })
      let completed = false
      const pending = runExecCommand(f.context).then((code) => { completed = true; return code })
      try {
        await f.entered.promise; f.signals.emit(startup ? 'SIGTERM' : 'SIGINT')
        if (!startup) {
          await f.aborted.promise
          expect(completed).toBe(false); f.modelCleanup.resolve()
        }
        expect(await pending).toBe(startup ? 143 : 130)
        expect(f.executions).toBe(startup ? 0 : 1)
        expect(f.stopped).toBe(1); expect(f.stdin.destroyed).toBe(true)
        expect(JSON.parse(f.chunks.at(-1)!)).toMatchObject({ type: 'exec_finished', completion: { exitCode: startup ? 143 : 130, cleanup: 'completed' } })
        expect(f.errors.join('')).not.toContain('fixture-secret')
        expect(f.signals.listenerCount('SIGTERM')).toBe(0)
      } finally { f.modelCleanup.resolve(); await pending }
    }
  })

  test('配置中的总期限覆盖 stdin、初始化及模型；停止等待后仍等待实际模型清理', async () => {
    for (const mode of ['stdin', 'startup', 'model']) {
      const f = fixture({ json: true, timeout: true, pipe: mode === 'stdin', startup: mode === 'startup', hold: mode === 'model' })
      let finished = false
      const pending = runExecCommand(f.context).then((code) => { finished = true; return code })
      try {
        if (mode === 'model') { await f.aborted.promise; expect(finished).toBe(false); f.modelCleanup.resolve() }
        expect(await pending).toBe(124)
        expect(f.executions).toBe(mode === 'model' ? 1 : 0)
        expect(JSON.parse(f.chunks.at(-1)!)).toMatchObject({ type: 'exec_finished', completion: { exitCode: 124, cleanup: mode === 'stdin' ? 'not_started' : 'completed' } })
        expect(f.signals.listenerCount('SIGINT')).toBe(0)
      } finally { f.modelCleanup.resolve(); await pending }
    }
  }, 10000)

  test('stdout EPIPE 或期限内不消费正文不能挂住，也不输出底层原始错误', async () => {
    const pipe = new Writable({ write(_chunk, _encoding, done) { done(Object.assign(new Error('fixture-secret-pipe'), { code: 'EPIPE' })) } })
    const f = fixture({ output: pipe })
    expect(await runExecCommand(f.context)).toBe(1)
    expect(f.executions).toBe(1); expect(f.stopped).toBe(1)
    expect(f.errors.join('')).not.toContain('fixture-secret')
    const stalled = fixture({ timeout: true, output: new Writable({ write() {} }) })
    expect(await runExecCommand(stalled.context)).toBe(124)
    expect(stalled.context.stdout.destroyed).toBe(true)
  }, 5000)

  test('JSON 配置预检失败保持终态与顺序；不支持的参数组合不登记执行', async () => {
    for (const args of [['exec', '--model', 'missing', '任务']]) {
      const f = fixture({ json: true }); f.context.argv = [...args, '--json']
      expect(await runExecCommand(f.context)).toBe(2)
      expect(f.creations).toBe(0); expect(f.executions).toBe(0); expect(f.stopped).toBe(0)
      expect(f.chunks.map((line) => JSON.parse(line).type)).toEqual(['exec_started', 'exec_finished'])
      expect(JSON.parse(f.chunks.at(-1)!)).toMatchObject({ completion: { exitCode: 2, cleanup: 'not_started' } })
      expect(f.signals.listenerCount('SIGINT')).toBe(0)
    }
    const invalid = fixture({ json: true }); invalid.context.argv = ['exec', 'resume', 'root', '--ephemeral', '--json', '任务']
    expect(await runExecCommand(invalid.context)).toBe(2)
    expect(invalid.chunks).toEqual([]); expect(invalid.creations).toBe(0)
  })

  test('ephemeral 等实际后端退出才删除临时业务根，最终输出/配置/既有数据保留', async () => {
    const f = fixture({ json: true, holdShutdown: true })
    f.context.argv.push('--ephemeral', '-o', 'answer.txt')
    const parent = join(f.context.homeDir, '.axon-exec'), config = readFileSync(join(parent, 'config.json'), 'utf8')
    writeFileSync(join(parent, 'existing.json'), 'original')
    const pending = runExecCommand(f.context)
    try {
      await f.stopEntered.promise
      expect(f.backendDataDir).toStartWith(join(parent, '.axon-ephemeral-'))
      expect(existsSync(f.backendDataDir!)).toBe(true); expect(existsSync(join(f.cwd, 'answer.txt'))).toBe(false)
      expect(f.chunks.some((line) => JSON.parse(line).type === 'exec_finished')).toBe(false)
      f.shutdown.resolve(); expect(await pending).toBe(0)
      expect(existsSync(f.backendDataDir!)).toBe(false)
      expect(readFileSync(join(f.cwd, 'answer.txt'), 'utf8')).toBe('  最终正文\n\n')
      expect(readFileSync(join(parent, 'config.json'), 'utf8')).toBe(config)
      expect(readFileSync(join(parent, 'existing.json'), 'utf8')).toBe('original')
      expect(JSON.parse(f.chunks.at(-1)!)).toMatchObject({ completion: { exitCode: 0, cleanup: 'completed' } })
    } finally { f.shutdown.resolve(); await pending }
  })

  test('ephemeral 模型失败、Schema 不合格和取消仍清理；后端失败或目录被替换则保留并非零', async () => {
    const model = fixture({ modelFailure: true, json: true }); model.context.argv.push('--ephemeral')
    expect(await runExecCommand(model.context)).toBe(1); expect(existsSync(model.backendDataDir!)).toBe(false)
    const schema = fixture({ finalText: '{}', json: true })
    writeFileSync(join(schema.cwd, 'schema.json'), '{"required":["count"],"type":"object"}')
    schema.context.argv.push('--ephemeral', '--output-schema', 'schema.json')
    expect(await runExecCommand(schema.context)).toBe(3); expect(existsSync(schema.backendDataDir!)).toBe(false)
    const canceled = fixture({ json: true, hold: true }); canceled.context.argv.push('--ephemeral')
    const pending = runExecCommand(canceled.context)
    try {
      await canceled.entered.promise; canceled.signals.emit('SIGINT'); await canceled.aborted.promise
      expect(existsSync(canceled.backendDataDir!)).toBe(true)
      canceled.modelCleanup.resolve(); expect(await pending).toBe(130); expect(existsSync(canceled.backendDataDir!)).toBe(false)
    } finally { canceled.modelCleanup.resolve(); await pending }
    const failed = fixture({ cleanupFailure: true, json: true }); failed.context.argv.push('--ephemeral')
    expect(await runExecCommand(failed.context)).toBe(1); expect(existsSync(failed.backendDataDir!)).toBe(true)
    expect(failed.errors.join('')).toContain('临时业务目录已保留')
    const changed = fixture({ json: true, holdShutdown: true }); changed.context.argv.push('--ephemeral')
    const changing = runExecCommand(changed.context)
    try {
      await changed.stopEntered.promise
      renameSync(changed.backendDataDir!, `${changed.backendDataDir}-original`); mkdirSync(changed.backendDataDir!)
      writeFileSync(join(changed.backendDataDir!, 'do-not-delete'), 'keep')
      changed.shutdown.resolve(); expect(await changing).toBe(1)
      expect(readFileSync(join(changed.backendDataDir!, 'do-not-delete'), 'utf8')).toBe('keep')
      expect(changed.errors.join('')).toContain('未能安全清理')
      expect(JSON.parse(changed.chunks.at(-1)!)).toMatchObject({ completion: { exitCode: 1, cleanup: 'failed' } })
    } finally { changed.shutdown.resolve(); await changing }
  })

  test('ephemeral 无效预检不创建临时目录', async () => {
    const f = fixture({ json: true }); f.context.argv.push('--ephemeral', '--model', 'missing')
    expect(await runExecCommand(f.context)).toBe(2); expect(f.backendDataDir).toBeUndefined()
    expect(readdirSync(join(f.context.homeDir, '.axon-exec'))).toEqual(['config.json'])
  })

  test('Schema 先编译；最终原文校验/原子保存后才报告 0，stdout 模式不改变文件正文', async () => {
    for (const json of [false, true]) {
      const finalText = '  {"count":2}\n\n', f = fixture({ json, finalText })
      writeFileSync(join(f.cwd, 'schema.json'), JSON.stringify({ type: 'object', required: ['count'], properties: { count: { type: 'integer' } } }))
      f.context.argv.push('--output-schema', 'schema.json', '-o', 'answer.json')
      expect(await runExecCommand(f.context)).toBe(0)
      expect(readFileSync(join(f.cwd, 'answer.json'), 'utf8')).toBe(finalText)
      expect(f.instruction).toContain('[最终输出要求]'); expect(f.instruction).toContain('"count"')
      expect(f.prompt).toBe('  原始任务\n'); expect(f.executions).toBe(1)
      if (json) expect(JSON.parse(f.chunks.at(-1)!)).toMatchObject({ completion: { exitCode: 0 } })
      else expect(f.chunks.join('')).toBe(finalText)
    }
  })

  test('坏 Schema/输出路径在创建前退出 2；结果不合格退出 3，原文件保持且不重跑', async () => {
    const bad = fixture({ json: true })
    writeFileSync(join(bad.cwd, 'schema.json'), '{"type":"bad","description":"private-schema-value"}')
    bad.context.argv.push('--output-schema', 'schema.json')
    expect(await runExecCommand(bad.context)).toBe(2)
    expect(bad.creations).toBe(0); expect(bad.stopped).toBe(0)
    expect(bad.errors.join('')).not.toContain('private-schema-value')
    const path = fixture({ json: true }); path.context.argv.push('-o', 'missing/answer.txt')
    expect(await runExecCommand(path.context)).toBe(2); expect(path.creations).toBe(0)
    for (const finalText of ['not-json', '```json\n{}\n```', '{}']) {
      const f = fixture({ json: true, finalText })
      writeFileSync(join(f.cwd, 'schema.json'), '{"type":"object","required":["count"]}')
      writeFileSync(join(f.cwd, 'answer.json'), 'original')
      f.context.argv.push('--output-schema', 'schema.json', '-o', 'answer.json')
      expect(await runExecCommand(f.context)).toBe(3)
      expect(readFileSync(join(f.cwd, 'answer.json'), 'utf8')).toBe('original')
      expect(f.executions).toBe(1); expect(f.stopped).toBe(1)
      const events = f.chunks.map((line) => JSON.parse(line) as ExecEvent)
      expect(events.filter((event) => event.type === 'exec_finished')).toHaveLength(1)
      expect(events.at(-1)).toMatchObject({ completion: { exitCode: 3, cleanup: 'completed', error: { code: 'exec_schema_mismatch' } } })
    }
  })

  test('业务成功后输出目标被换成目录：文件失败退出 1，JSONL 不能误报 CLI 成功', async () => {
    let target = ''
    const f = fixture({ json: true, beforeFinish: () => mkdirSync(target) })
    target = join(f.cwd, 'answer.txt'); f.context.argv.push('-o', target)
    expect(await runExecCommand(f.context)).toBe(1)
    expect(f.executions).toBe(1); expect(existsSync(target)).toBe(true)
    expect(JSON.parse(f.chunks.at(-1)!)).toMatchObject({ completion: { exitCode: 1, error: { code: 'exec_file_output_error' } } })
  })

  test('启动能力预检失败的自清理不能把输入错误 2 覆盖成连接故障 1', async () => {
    const f = fixture({ json: true, unsupportedCapability: true })
    expect(await runExecCommand(f.context)).toBe(2)
    expect(f.creations).toBe(0); expect(f.executions).toBe(0); expect(f.stopped).toBe(1)
    expect(JSON.parse(f.chunks.at(-1)!)).toMatchObject({ type: 'exec_finished', completion: {
      exitCode: 2, cleanup: 'completed', error: { code: 'exec_invalid_input', category: 'configuration' },
    } })
    expect(f.errors.join('')).toContain('真实宿主沙箱不支持所选模式')
  })
})
