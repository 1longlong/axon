import { afterAll, afterEach, beforeAll, describe, expect, test } from 'bun:test'
import { spawn } from 'node:child_process'
import { existsSync, lstatSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, realpathSync, renameSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type { AgentSessionMeta, ExecEvent } from '@axon/shared'
import { fileURLToPath } from 'node:url'
import { sourceExecRuntimeArguments } from './backend-launch'

const cleanups: Array<() => Promise<void>> = []
afterEach(async () => { for (const cleanup of cleanups.splice(0).reverse()) await cleanup() })
interface CompletionRequest { messages: Array<{ role: string; content?: unknown }>; tools?: Array<{ function: { name: string } }>; response_format?: unknown }

/** 真正执行 CLI 源码和独立后端/SDK/Seatbelt，只替换模型 HTTP；工作区/HOME/凭据全部隔离。 */
function fixture(mode: 'tool' | 'write' | 'unauthorized' | 'stall' | 'compact' | 'environment', finalText?: string, binary?: string) {
  const directory = realpathSync(mkdtempSync(join(tmpdir(), 'axon-exec-source-'))), cwd = join(directory, 'project'),
    homeDir = join(directory, 'home'), dataDir = join(directory, 'data'), config = join(directory, 'config.json')
  mkdirSync(cwd); mkdirSync(homeDir)
  cleanups.push(async () => { rmSync(directory, { recursive: true, force: true }) })
  const requests: CompletionRequest[] = [], keys: string[] = [], entered = Promise.withResolvers<void>(), aborted = Promise.withResolvers<void>()
  let ordinaryCompletions = 0
  const server = Bun.serve({ hostname: '127.0.0.1', port: 0, async fetch(request) {
    if (new URL(request.url).pathname !== '/v1/chat/completions') return new Response('', { status: 404 })
    const body = await request.json() as CompletionRequest
    requests.push(body); keys.push(request.headers.get('authorization') ?? ''); entered.resolve()
    if (mode === 'unauthorized') return Response.json({ error: { message: '夹具认证失败', type: 'authentication_error' } }, { status: 401 })
    if (mode === 'stall') {
      request.signal.addEventListener('abort', () => aborted.resolve(), { once: true })
      return new Response(new ReadableStream<Uint8Array>({
        start(controller) { controller.enqueue(new TextEncoder().encode(`data: ${JSON.stringify({ id: 'stall', model: 'axon-fixture',
          choices: [{ index: 0, delta: { role: 'assistant', content: '尚未完成' }, finish_reason: null }] })}\n\n`)) },
        cancel() { aborted.resolve() },
      }), { headers: { 'content-type': 'text/event-stream' } })
    }
    const summary = mode === 'compact' && !body.tools?.length
    if (mode === 'compact' && !summary) ordinaryCompletions += 1
    const tool = mode !== 'compact' && body.messages.at(-1)?.role !== 'tool'
    const delta = mode === 'compact' ? { role: 'assistant', content: summary ? 'real-compaction-summary-marker' : `回复 ${ordinaryCompletions}` }
      : tool ? { role: 'assistant', tool_calls: [{ index: 0, id: 'bash-cli', type: 'function',
      function: { name: 'bash', arguments: JSON.stringify({ command: mode === 'write' ? "printf 'tool-ok\\n' > marker.txt"
        : mode === 'environment' ? 'printf "%s" "${AXON_API_KEY-unset}"' : "pwd; printf 'tool-ok\\n'" }) } }] }
      : { role: 'assistant', content: finalText ?? '  真实 CLI 回复\n\n' }
    const promptTokens = mode === 'compact' && !summary && ordinaryCompletions === 2 ? 190000 : 12
    const frames = [{ choices: [{ index: 0, delta, finish_reason: null }] },
      { choices: [{ index: 0, delta: {}, finish_reason: tool ? 'tool_calls' : 'stop' }], usage: { prompt_tokens: promptTokens, completion_tokens: 3, total_tokens: promptTokens + 3 } }]
    return new Response(`${frames.map((frame) => `data: ${JSON.stringify({ id: 'cli-completion', model: 'axon-fixture', ...frame })}\n\n`).join('')}data: [DONE]\n\n`,
      { headers: { 'content-type': 'text/event-stream' } })
  } })
  const configuration = { defaults: { channel: 'local', skills: false, mcp: false, memory: false, tasks: false },
    channels: [{ id: 'local', provider: 'custom', baseUrl: `http://127.0.0.1:${server.port}/v1`, defaultModel: 'axon-fixture',
      apiKey: 'local-cli-secret', models: [{ id: 'axon-fixture' }] }] }
  writeFileSync(config, JSON.stringify(configuration))
  cleanups.push(async () => { server.stop(true) })
  const start = (options: { json?: boolean; timeout?: number; sandbox?: 'read-only' | 'workspace-write'; schema?: unknown; outputFile?: boolean;
    resume?: string | 'last'; all?: boolean; cwd?: string; prompt?: string; noKey?: boolean; extra?: string[] } = {}) => {
    const schemaFile = join(cwd, 'schema.json')
    if (options.schema !== undefined) writeFileSync(schemaFile, JSON.stringify(options.schema))
    const environment = { ...process.env, HOME: homeDir, SHELL: '/bin/bash', AXON_API_KEY: 'ignored-env-secret',
      NO_PROXY: '127.0.0.1,localhost', no_proxy: '127.0.0.1,localhost' }
    for (const key of ['HTTP_PROXY', 'HTTPS_PROXY', 'ALL_PROXY', 'http_proxy', 'https_proxy', 'all_proxy', 'ZDOTDIR', 'BASH_ENV', 'ENV', 'AXON_ZIMA_PYTHON']) {
      delete environment[key as keyof typeof environment]
    }
    if (binary) (environment as NodeJS.ProcessEnv).PATH = '/usr/bin:/bin:/usr/sbin:/sbin'
    writeFileSync(config, JSON.stringify({ ...configuration, channels: configuration.channels.map((channel) =>
      ({ ...channel, apiKey: options.noKey ? '' : channel.apiKey })) }))
    const child = spawn(binary ?? process.execPath, [...(binary ? [] : sourceExecRuntimeArguments(join(import.meta.dir, 'main.ts'))), 'exec',
      ...(options.resume ? ['resume', ...(options.resume === 'last' ? ['--last'] : [options.resume])] : []),
      ...(options.all ? ['--all'] : []), '--config-file', config, '--data-dir', dataDir,
      '-C', options.cwd ?? cwd, '--skip-git-repo-check', ...(options.json ? ['--json'] : []), ...(options.timeout ? ['--timeout', String(options.timeout)] : []),
      ...(options.sandbox ? ['--sandbox', options.sandbox] : []),
      ...(options.schema === undefined ? [] : ['--output-schema', schemaFile]), ...(options.outputFile ? ['-o', 'answer.json'] : []),
      ...(options.extra ?? []), options.prompt ?? '  源码任务\n'],
    { cwd, env: environment, stdio: ['pipe', 'pipe', 'pipe'] })
    let output = '', errors = ''
    child.stdout.on('data', (chunk: Buffer) => { output += chunk.toString() })
    child.stderr.on('data', (chunk: Buffer) => { errors += chunk.toString() })
    const closed = new Promise<{ code: number | null; signal: NodeJS.Signals | null }>((resolve, reject) => {
      child.once('error', reject); child.once('close', (code, signal) => resolve({ code, signal }))
    })
    const guard = setTimeout(() => child.kill('SIGKILL'), 18000)
    void closed.then(() => clearTimeout(guard), () => clearTimeout(guard))
    child.stdin.end()
    cleanups.push(async () => {
      if (child.exitCode === null && child.signalCode === null) child.kill('SIGKILL')
      await closed; child.stdin.destroy(); child.stdout.destroy(); child.stderr.destroy()
    })
    return { child, closed, get output() { return output }, get errors() { return errors } }
  }
  return { cwd, homeDir, dataDir, configuration, start, requests, keys, entered, aborted }
}
function history(dataDir: string): { sessions: AgentSessionMeta[]; text: string } {
  const catalogs = (JSON.parse(readFileSync(join(dataDir, 'agent-sessions.json'), 'utf8')) as { sessions: Array<{ id: string }> }).sessions
  const sessions = catalogs.map(({ id }) => {
    const state = JSON.parse(readFileSync(join(dataDir, 'agent-sessions', id, 'state.json'), 'utf8')) as { agents: { main: AgentSessionMeta } }
    return { ...state.agents.main, id }
  })
  const text = sessions.map((session) => readFileSync(join(dataDir, 'agent-sessions', session.id, 'agents', 'main', 'messages.jsonl'), 'utf8')).join('\n')
  return { sessions, text }
}
function allFiles(path: string): string[] {
  return readdirSync(path, { withFileTypes: true }).flatMap((item) => item.isDirectory() ? allFiles(join(path, item.name)) : [join(path, item.name)])
}

describe.skipIf(process.platform !== 'darwin')('CLI 源码真实闭环', () => {
  test('多渠道配置各用自己的密钥；恢复原渠道不受默认渠道或旧环境变量影响，缺密钥不借用', async () => {
    const f = fixture('tool'), originalChannel = { ...f.configuration.channels[0]!, id: 'original', apiKey: 'original-channel-secret' }
    f.configuration.channels.push(originalChannel)
    const first = f.start({ json: true, extra: ['--channel', 'original'] })
    expect(await first.closed).toEqual({ code: 0, signal: null })
    const original = history(f.dataDir).sessions[0]!
    expect(original.channelId).toBe('original')
    const resumed = f.start({ resume: original.id, json: true, prompt: '从原渠道继续' })
    expect(await resumed.closed).toEqual({ code: 0, signal: null })
    expect(f.keys).toEqual(Array(4).fill('Bearer original-channel-secret'))
    originalChannel.apiKey = ''
    const missing = f.start({ resume: original.id })
    expect(await missing.closed).toEqual({ code: 2, signal: null })
    expect(missing.errors).toContain('channel.apiKey')
    expect(f.requests).toHaveLength(4)
    const changed = f.start({ resume: original.id, extra: ['--channel', 'local'], json: true })
    expect(await changed.closed).toEqual({ code: 0, signal: null })
    expect(f.keys.slice(4)).toEqual(Array(2).fill('Bearer local-cli-secret'))
    const saved = allFiles(f.dataDir).map((path) => readFileSync(path, 'utf8')).join('')
    for (const secret of ['original-channel-secret', 'local-cli-secret', 'ignored-env-secret']) {
      expect(first.output + resumed.output + changed.output + saved).not.toContain(secret)
    }
  }, 15000)

  test('源码初始化不加载工作区 dotenv/bunfig，缺凭据不得从项目文件补出', async () => {
    const f = fixture('environment')
    writeFileSync(join(f.cwd, '.env'), 'AXON_API_KEY=unwanted-project-key\n')
    const marker = join(f.cwd, 'preloaded.txt')
    writeFileSync(join(f.cwd, 'preload.ts'), `import {writeFileSync} from 'node:fs'; writeFileSync(${JSON.stringify(marker)}, 'loaded')`)
    writeFileSync(join(f.cwd, 'bunfig.toml'), 'preload = ["./preload.ts"]\n')
    writeFileSync(join(f.homeDir, '.bunfig.toml'), `preload = [${JSON.stringify(join(f.cwd, 'preload.ts'))}]\n`)
    const missing = f.start({ noKey: true })
    expect(await missing.closed).toEqual({ code: 2, signal: null })
    expect(f.requests).toHaveLength(0); expect(existsSync(marker)).toBe(false)
    const command = f.start()
    expect(await command.closed).toEqual({ code: 0, signal: null })
    expect(existsSync(marker)).toBe(false)
    expect(f.keys).toEqual(['Bearer local-cli-secret', 'Bearer local-cli-secret'])
    expect(JSON.stringify(f.requests[1]?.messages.at(-1)?.content)).toContain('unset')
    expect(JSON.stringify(f.requests[1]?.messages.at(-1)?.content)).not.toContain('unwanted-project-key')
  }, 20000)

  test('真实 SDK 压缩保留应用原文/摘要；重启优先精确 artifact，丢失后从真实摘要语义恢复', async () => {
    const f = fixture('compact'), oldPrompt = 'old-compacted-marker\n' + 'old '.repeat(21000),
      recentPrompt = 'recent-kept-marker\n' + 'new '.repeat(21000)
    const first = f.start({ prompt: oldPrompt })
    expect(await first.closed).toEqual({ code: 0, signal: null })
    const original = history(f.dataDir).sessions[0]!
    const compacted = f.start({ resume: original.id, prompt: recentPrompt, json: true })
    expect(await compacted.closed).toEqual({ code: 0, signal: null })
    const summaryRequest = f.requests.find((request) => !request.tools?.length)
    expect(JSON.stringify(summaryRequest?.messages)).toContain('old-compacted-marker')
    const saved = history(f.dataDir)
    expect(saved.text).toContain(oldPrompt.replaceAll('\n', '\\n'))
    expect(saved.text).toContain('recent-kept-marker')
    expect(saved.text).toContain('real-compaction-summary-marker')
    expect(saved.text).toContain('compact_boundary')
    expect(compacted.output).toContain('compaction_status')
    expect(compacted.output).toContain('started')
    expect(saved.sessions[0]?.runtimeSessionFile).toBe(original.runtimeSessionFile)
    const beforeExact = f.requests.length, exact = f.start({ resume: original.id, prompt: '精确恢复的新任务' })
    expect(await exact.closed).toEqual({ code: 0, signal: null })
    expect(exact.errors).toBe('')
    const exactContext = JSON.stringify(f.requests[beforeExact]?.messages)
    expect(exactContext).toContain('real-compaction-summary-marker')
    expect(exactContext).toContain('recent-kept-marker')
    expect(exactContext).not.toContain('old-compacted-marker')
    expect(history(f.dataDir).sessions[0]?.sdkSessionId).toBe(original.sdkSessionId)
    rmSync(original.runtimeSessionFile!)
    const beforeFallback = f.requests.length, fallback = f.start({ resume: original.id, prompt: '语义恢复的新任务', json: true })
    expect(await fallback.closed).toEqual({ code: 0, signal: null })
    expect(fallback.errors).toContain('语义恢复')
    expect(fallback.output).toContain('runtime_session_recovered')
    expect(JSON.stringify(f.requests[beforeFallback]?.messages)).toContain('real-compaction-summary-marker')
    expect(JSON.stringify(f.requests[beforeFallback]?.messages)).toContain('会话恢复上下文')
    expect(history(f.dataDir).sessions[0]?.sdkSessionId).not.toBe(original.sdkSessionId)
    expect(history(f.dataDir).text).toContain('old-compacted-marker')
    expect(history(f.dataDir).sessions).toHaveLength(1)
  }, 25000)

  test('真实 ephemeral 私有后端不读写既有会话，工具修改/输出保留，业务 artifact/快照在 close 后清理', async () => {
    const body = '{"count":2}', f = fixture('write', body), first = f.start()
    expect(await first.closed).toEqual({ code: 0, signal: null })
    expect(existsSync(join(f.cwd, 'marker.txt'))).toBe(false)
    const previous = allFiles(f.dataDir).sort().map((path) => [path, readFileSync(path, 'utf8')])
    const ephemeral = f.start({ json: true, sandbox: 'workspace-write', outputFile: true,
      schema: { type: 'object', required: ['count'] }, extra: ['--ephemeral'], prompt: '独立的临时任务' })
    expect(await ephemeral.closed).toEqual({ code: 0, signal: null })
    expect(ephemeral.errors).toBe('')
    expect(readFileSync(join(f.cwd, 'marker.txt'), 'utf8')).toBe('tool-ok\n')
    expect(readFileSync(join(f.cwd, 'answer.json'), 'utf8')).toBe(body)
    expect(allFiles(f.dataDir).sort().map((path) => [path, readFileSync(path, 'utf8')])).toEqual(previous)
    expect(readdirSync(f.dataDir).some((path) => path.startsWith('.axon-ephemeral-'))).toBe(false)
    expect(history(f.dataDir).sessions).toHaveLength(1)
    expect(f.requests).toHaveLength(4)
    expect(f.requests[2]?.messages.filter((message) => message.role === 'user')).toHaveLength(1)
    expect(JSON.stringify(f.requests[2]?.messages)).not.toContain('源码任务')
    const events = ephemeral.output.trim().split('\n').map((line) => JSON.parse(line) as ExecEvent)
    expect(events.at(-1)).toMatchObject({ type: 'exec_finished', completion: { exitCode: 0, cleanup: 'completed' } })
    expect(() => process.kill(ephemeral.child.pid!, 0)).toThrow()
  }, 25000)

  test('真实 ephemeral 在模型错误、格式失败、SIGTERM 或期限后清理私有目录，不保留会话/覆盖输出', async () => {
    for (const mode of ['unauthorized', 'schema', 'signal', 'timeout'] as const) {
      const f = fixture(mode === 'unauthorized' ? 'unauthorized' : mode === 'schema' ? 'tool' : 'stall', '{}')
      writeFileSync(join(f.cwd, 'answer.json'), 'original')
      const command = f.start({ json: true, outputFile: true, extra: ['--ephemeral'],
        ...(mode === 'schema' ? { schema: { type: 'object', required: ['count'] } } : {}),
        ...(mode === 'timeout' ? { timeout: 5 } : {}) })
      if (mode === 'signal') {
        await Promise.race([f.entered.promise, command.closed.then(() => { throw new Error('模型请求前命令已退出') })])
        command.child.kill('SIGTERM')
      }
      const code = mode === 'unauthorized' ? 1 : mode === 'schema' ? 3 : mode === 'signal' ? 143 : 124
      expect(await command.closed).toEqual({ code, signal: null })
      expect(readdirSync(f.dataDir)).toEqual([])
      expect(readFileSync(join(f.cwd, 'answer.json'), 'utf8')).toBe('original')
      expect(JSON.parse(command.output.trim().split('\n').at(-1)!)).toMatchObject({ completion: { exitCode: code, cleanup: 'completed' } })
      expect(command.errors).not.toContain('local-cli-secret')
      expect(f.requests).toHaveLength(mode === 'schema' ? 2 : 1)
      expect(() => process.kill(command.child.pid!, 0)).toThrow()
    }
  }, 25000)

  test('真实 Pi SDK/Seatbelt 工具循环→JSONL/正文→历史落盘→实际退出；同目录再次执行不共写或隐式续跑', async () => {
    const f = fixture('tool')
    const first = f.start()
    expect(await first.closed).toEqual({ code: 0, signal: null })
    expect(first.output).toBe('  真实 CLI 回复\n\n'); expect(first.errors).toBe('')
    expect(f.requests).toHaveLength(2)
    expect(f.requests[0]?.tools?.some((tool) => tool.function.name === 'bash')).toBe(true)
    expect(JSON.stringify(f.requests[1]?.messages.find((message) => message.role === 'tool')?.content)).toContain('tool-ok')
    const previous = history(f.dataDir)
    expect(previous.sessions).toHaveLength(1)
    expect(previous.sessions[0]).toMatchObject({ creationOrigin: 'exec', runtimeId: 'pi', sandboxMode: 'readOnly', approvalPolicy: 'never', userInputPolicy: 'reject' })
    expect(previous.text).toContain('源码任务'); expect(previous.text).toContain('真实 CLI 回复')
    const second = f.start({ json: true })
    expect(await second.closed).toEqual({ code: 0, signal: null })
    const events = second.output.trim().split('\n').map((line) => JSON.parse(line) as ExecEvent)
    expect(events[0]?.type).toBe('exec_started')
    expect(events.at(-1)).toMatchObject({ type: 'exec_finished', completion: { exitCode: 0, cleanup: 'completed' } })
    expect(events.filter((event) => event.type === 'workflow_finished')).toHaveLength(1)
    expect(events.filter((event) => event.type === 'exec_finished')).toHaveLength(1)
    expect(events.map((event) => event.sequence)).toEqual(events.map((_, index) => index + 1))
    const restored = history(f.dataDir)
    expect(restored.sessions).toHaveLength(2)
    expect(restored.sessions[0]?.projectId).toBe(restored.sessions[1]?.projectId)
    expect(f.requests).toHaveLength(4)
    expect(f.keys).toEqual(Array(4).fill('Bearer local-cli-secret'))
    expect(existsSync(join(f.dataDir, '.axon-backend.lock'))).toBe(true)
    expect(second.output).not.toContain('local-cli-secret'); expect(second.output).not.toContain('clientId')
    expect(allFiles(f.dataDir).map((path) => readFileSync(path, 'utf8')).join('')).not.toContain('local-cli-secret')
    expect(() => process.kill(second.child.pid!, 0)).toThrow()
  }, 25000)

  test('真实 resume 精确续跑同一根/artifact；--last/--all 按范围选择、原工作区执行，不回放旧用户任务', async () => {
    const f = fixture('tool'), first = f.start()
    expect(await first.closed).toEqual({ code: 0, signal: null })
    const original = history(f.dataDir).sessions[0]!
    const second = f.start({ resume: original.id, prompt: '  恢复后的新任务\n' })
    expect(await second.closed).toEqual({ code: 0, signal: null })
    expect(second.errors).toBe('')
    const restored = history(f.dataDir)
    expect(restored.sessions).toHaveLength(1)
    expect(restored.sessions[0]?.sdkSessionId).toBe(original.sdkSessionId)
    expect(restored.sessions[0]?.runtimeSessionFile).toBe(original.runtimeSessionFile)
    expect(f.requests).toHaveLength(4)
    expect(f.requests[2]?.messages.filter((message) => message.role === 'user')).toHaveLength(2)
    expect(JSON.stringify(f.requests[2]?.messages)).toContain('源码任务')
    expect(JSON.stringify(f.requests[2]?.messages)).toContain('恢复后的新任务')
    expect(restored.text.match(/"type":"user"/g)).not.toBeNull()
    const other = join(f.cwd, 'other'); mkdirSync(other)
    const absent = f.start({ resume: 'last', cwd: other })
    expect(await absent.closed).toEqual({ code: 2, signal: null })
    expect(f.requests).toHaveLength(4)
    const all = f.start({ resume: 'last', all: true, cwd: other, json: true })
    expect(await all.closed).toEqual({ code: 0, signal: null })
    expect(history(f.dataDir).sessions).toHaveLength(1)
    const events = all.output.trim().split('\n').map((line) => JSON.parse(line) as ExecEvent)
    expect(events.at(-1)).toMatchObject({ type: 'exec_finished', completion: { exitCode: 0 } })
    expect(history(f.dataDir).sessions[0]?.projectId).toBe(original.projectId)
    expect(JSON.stringify(f.requests[5]?.messages.at(-1)?.content)).toContain(`${f.cwd}\\n`)
    expect(JSON.stringify(f.requests[5]?.messages.at(-1)?.content)).not.toContain(`${other}\\n`)
  }, 25000)

  test('恢复预检错误零模型请求；artifact 丢失从应用历史/摘要语义降级，不重跑旧工具', async () => {
    const f = fixture('tool'), first = f.start()
    expect(await first.closed).toEqual({ code: 0, signal: null })
    const original = history(f.dataDir).sessions[0]!
    for (const options of [{ noKey: true }, { extra: ['--model', 'missing'] }, { resume: 'missing' }]) {
      const invalid = f.start({ resume: original.id, ...options })
      expect(await invalid.closed).toEqual({ code: 2, signal: null })
      expect(f.requests).toHaveLength(2)
    }
    const messagesPath = join(f.dataDir, 'agent-sessions', original.id, 'agents', 'main', 'messages.jsonl')
    writeFileSync(messagesPath, readFileSync(messagesPath, 'utf8') + JSON.stringify({ type: 'system', subtype: 'compact_boundary',
      compact_result: 'success', summary: 'summary-fallback-marker', uuid: 'summary-fixture' }) + '\n')
    rmSync(original.runtimeSessionFile!)
    const recovered = f.start({ resume: original.id, json: true, prompt: '新的任务，不重复旧命令' })
    expect(await recovered.closed).toEqual({ code: 0, signal: null })
    expect(f.requests).toHaveLength(4)
    expect(JSON.stringify(f.requests[2]?.messages)).toContain('summary-fallback-marker')
    expect(JSON.stringify(f.requests[2]?.messages)).toContain('会话恢复上下文')
    expect(JSON.stringify(f.requests[2]?.messages)).toContain('新的任务，不重复旧命令')
    expect(recovered.output).toContain('runtime_session_recovered')
    expect(recovered.errors).toContain('语义恢复')
    expect(history(f.dataDir).sessions).toHaveLength(1)
    expect(history(f.dataDir).text).toContain('summary-fallback-marker')
    expect(history(f.dataDir).sessions[0]?.sdkSessionId).not.toBe(original.sdkSessionId)
    // 应用元数据中的恢复引用也丢失：仍从中立历史恢复，并产生明确的降级事件。
    const statePath = join(f.dataDir, 'agent-sessions', original.id, 'state.json')
    const state = JSON.parse(readFileSync(statePath, 'utf8')) as { agents: { main: AgentSessionMeta } }
    delete state.agents.main.sdkSessionId; delete state.agents.main.runtimeSessionFile
    writeFileSync(statePath, JSON.stringify(state))
    const lostReference = f.start({ resume: original.id, json: true, prompt: '引用丢失后的新任务' })
    expect(await lostReference.closed).toEqual({ code: 0, signal: null })
    expect(f.requests).toHaveLength(6)
    expect(JSON.stringify(f.requests[4]?.messages)).toContain('summary-fallback-marker')
    expect(JSON.stringify(f.requests[4]?.messages)).toContain('引用丢失后的新任务')
    expect(lostReference.output).toContain('runtime_session_recovered')
    expect(lostReference.errors).toContain('语义恢复')
    expect(history(f.dataDir).sessions).toHaveLength(1)
  }, 25000)

  test('实际模型认证错误退出 1，不重复请求/输出成功正文；失败终态仍落盘', async () => {
    const f = fixture('unauthorized'), command = f.start()
    expect(await command.closed).toEqual({ code: 1, signal: null })
    expect(f.requests).toHaveLength(1); expect(command.output).toBe('')
    expect(command.errors).not.toContain('local-cli-secret')
    expect(history(f.dataDir).text).toContain('"subtype":"error_during_execution"')
  }, 20000)

  test('真实模型工具循环收到根格式要求，完整最终 JSON 本地验证后才保存/输出，不伪造协议支持', async () => {
    for (const json of [false, true]) {
      const body = '  {"count":2}\n\n', f = fixture('tool', body)
      const command = f.start({ json, outputFile: true, schema: { type: 'object', required: ['count'], properties: { count: { type: 'integer' } } } })
      expect(await command.closed).toEqual({ code: 0, signal: null })
      expect(readFileSync(join(f.cwd, 'answer.json'), 'utf8')).toBe(body)
      expect(f.requests).toHaveLength(2)
      expect(JSON.stringify(f.requests[0]?.messages.find((message) => message.role === 'system')?.content)).toContain('[最终输出要求]')
      expect(f.requests[0]?.response_format).toBeUndefined()
      expect(history(f.dataDir).text).toContain('源码任务')
      if (json) {
        const events = command.output.trim().split('\n').map((line) => JSON.parse(line) as ExecEvent)
        expect(events.at(-1)).toMatchObject({ type: 'exec_finished', completion: { exitCode: 0, cleanup: 'completed' } })
      } else expect(command.output).toBe(body)
      expect(command.errors).toBe('')
    }
  }, 25000)

  test('真实 CLI：坏 Schema 不启动业务/联网；正常模型结果不合格退出 3，保留历史和旧输出、不重放', async () => {
    const invalid = fixture('tool'), rejected = invalid.start({ json: true, schema: { type: 'bad' } })
    expect(await rejected.closed).toEqual({ code: 2, signal: null })
    expect(invalid.requests).toHaveLength(0); expect(existsSync(invalid.dataDir)).toBe(false)
    expect(JSON.parse(rejected.output.trim().split('\n').at(-1)!)).toMatchObject({ completion: { exitCode: 2, cleanup: 'not_started' } })
    for (const json of [false, true]) {
      const f = fixture('tool', '{}'); writeFileSync(join(f.cwd, 'answer.json'), 'original')
      const command = f.start({ json, outputFile: true, schema: { type: 'object', required: ['count'] } })
      expect(await command.closed).toEqual({ code: 3, signal: null })
      expect(readFileSync(join(f.cwd, 'answer.json'), 'utf8')).toBe('original')
      expect(f.requests).toHaveLength(2)
      expect(history(f.dataDir).text).toContain('"subtype":"success"')
      if (json) expect(JSON.parse(command.output.trim().split('\n').at(-1)!)).toMatchObject({ completion: { exitCode: 3, cleanup: 'completed' } })
      else expect(command.output).toBe('')
      expect(command.errors).toContain('Schema')
      expect(command.errors).not.toContain('local-cli-secret')
    }
  }, 25000)

  test('同一真实 Bash 写命令：默认只读拒绝且不等待审批；显式 workspace-write 才可写项目', async () => {
    for (const sandbox of ['read-only', 'workspace-write'] as const) {
      const f = fixture('write'), command = f.start({ json: true, sandbox })
      expect(await command.closed).toEqual({ code: 0, signal: null })
      expect(f.requests).toHaveLength(2)
      expect(existsSync(join(f.cwd, 'marker.txt'))).toBe(sandbox === 'workspace-write')
      const events = command.output.trim().split('\n').map((line) => JSON.parse(line) as ExecEvent)
      expect(events.at(-1)).toMatchObject({ type: 'exec_finished', completion: { exitCode: 0, cleanup: 'completed' } })
      expect(history(f.dataDir).sessions[0]?.approvalPolicy).toBe('never')
      if (sandbox === 'workspace-write') expect(readFileSync(join(f.cwd, 'marker.txt'), 'utf8')).toBe('tool-ok\n')
      else expect(JSON.stringify(f.requests[1]?.messages.find((message) => message.role === 'tool')?.content)).toContain('审批策略为 never')
    }
  }, 25000)

  test('真实 SIGTERM 与总期限取消在途模型连接，待独立后端清理才输出退出码', async () => {
    for (const timeout of [false, true]) {
      const f = fixture('stall'), command = f.start({ json: true, ...(timeout ? { timeout: 5 } : {}) })
      await Promise.race([f.entered.promise, command.closed.then(() => { throw new Error('模型请求前命令已退出') })])
      if (!timeout) command.child.kill('SIGTERM')
      expect(await command.closed).toEqual({ code: timeout ? 124 : 143, signal: null })
      let guard: ReturnType<typeof setTimeout> | undefined
      try {
        await Promise.race([f.aborted.promise, new Promise<never>((_resolve, reject) => {
          guard = setTimeout(() => reject(new Error('模型连接未取消')), 1000)
        })])
      } finally { clearTimeout(guard) }
      const events = command.output.trim().split('\n').map((line) => JSON.parse(line) as ExecEvent)
      expect(events.at(-1)).toMatchObject({ type: 'exec_finished', completion: { exitCode: timeout ? 124 : 143, cleanup: 'completed' } })
      expect(events.filter((event) => event.type === 'exec_finished')).toHaveLength(1)
      expect(history(f.dataDir).text).toContain('"stopped_by_user":true')
      expect(command.errors).not.toContain('local-cli-secret')
      expect(() => process.kill(command.child.pid!, 0)).toThrow()
    }
  }, 20000)
})

describe.skipIf(process.platform !== 'darwin')('CLI 独立本机构建入口', () => {
  let directory: string, bundle: string, binary: string
  beforeAll(async () => {
    directory = realpathSync(mkdtempSync(join(tmpdir(), 'axon-exec-build-test-')))
    const original = join(directory, 'original')
    // 构建走正式独立命令，避免测试运行器的模块缓存/解析器影响 bundler。
    const building = Bun.spawn([process.execPath, fileURLToPath(new URL('../scripts/build.ts', import.meta.url)), '--outdir', original],
      { stdout: 'pipe', stderr: 'pipe' })
    const guard = setTimeout(() => building.kill('SIGKILL'), 25000)
    try {
      const [output, error, code] = await Promise.all([new Response(building.stdout).text(), new Response(building.stderr).text(), building.exited])
      if (code !== 0) throw new Error(`独立 CLI 构建失败：${output}${error}`)
    } finally { clearTimeout(guard); if (building.exitCode === null) { building.kill(); await building.exited } }
    // 真实移动到源码树之外、有空格的目录；不通过 Bun 命令、源码脚本或测试后端替身运行。
    bundle = join(directory, 'relocated bundle'); renameSync(original, bundle); binary = join(bundle, 'axon')
  }, 30000)
  afterAll(() => { if (directory) rmSync(directory, { recursive: true, force: true }) })

  test('独立产物可搬移、依赖链接不回指源码；无系统 Bun/Node 完成 Schema Worker/Pi/Seatbelt/输出', async () => {
    const manifest = JSON.parse(readFileSync(join(bundle, 'axon-cli-build.json'), 'utf8')) as {
      worker: string; dependencies: Array<{ name: string }> }
    expect(manifest.worker).toBe('embedded')
    expect(manifest.dependencies.some(({ name }) => name.startsWith('@axon/') || name.includes('electron'))).toBe(false)
    const pending = [join(bundle, 'backend/node_modules')]
    while (pending.length) {
      for (const item of readdirSync(pending.pop()!, { withFileTypes: true })) {
        const path = join(item.parentPath, item.name)
        if (item.isSymbolicLink()) {
          expect(readFileSync(join(realpathSync(path), 'package.json'), 'utf8')).toContain('"name"')
          expect(realpathSync(path).startsWith(`${bundle}/`)).toBe(true)
        } else if (item.isDirectory()) pending.push(path)
      }
    }
    const f = fixture('write', '{"count":2}', binary)
    writeFileSync(join(f.cwd, '.env'), 'AXON_API_KEY=unwanted-dotenv-key\n')
    const preload = join(f.cwd, 'preload.ts'), marker = join(f.cwd, 'preloaded.txt')
    writeFileSync(preload, `import {writeFileSync} from 'node:fs'; writeFileSync(${JSON.stringify(marker)}, 'loaded')`)
    writeFileSync(join(f.cwd, 'bunfig.toml'), 'preload = ["./preload.ts"]\n')
    const noKey = f.start({ noKey: true })
    expect(await noKey.closed).toEqual({ code: 2, signal: null }); expect(f.requests).toHaveLength(0)
    const command = f.start({ json: true, sandbox: 'workspace-write', outputFile: true,
      schema: { $schema: 'https://json-schema.org/draft/2020-12/schema', type: 'object', required: ['count'], properties: { count: { type: 'integer' } } } })
    const actual = await command.closed
    if (actual.code !== 0) throw new Error(JSON.stringify({ actual, diagnostic: command.errors, events: command.output, requests: f.requests.length }))
    expect(actual).toEqual({ code: 0, signal: null })
    expect(command.errors).toBe(''); expect(existsSync(marker)).toBe(false)
    expect(readFileSync(join(f.cwd, 'marker.txt'), 'utf8')).toBe('tool-ok\n')
    expect(readFileSync(join(f.cwd, 'answer.json'), 'utf8')).toBe('{"count":2}')
    expect(f.keys).toEqual(['Bearer local-cli-secret', 'Bearer local-cli-secret'])
    expect(JSON.parse(command.output.trim().split('\n').at(-1)!)).toMatchObject({ completion: { exitCode: 0, cleanup: 'completed' } })
    expect(history(f.dataDir).sessions).toHaveLength(1)
    expect(() => process.kill(command.child.pid!, 0)).toThrow()
  }, 25000)

  test('同一构建支持恢复/临时入口：原 artifact 精确续跑，临时结束保留输出且不改已有业务目录', async () => {
    const f = fixture('tool', '完整正文', binary), first = f.start({ json: true })
    const actual = await first.closed
    if (actual.code !== 0) throw new Error(JSON.stringify({ actual, diagnostic: first.errors, events: first.output, requests: f.requests.length }))
    expect(actual).toEqual({ code: 0, signal: null }); expect(first.output).toContain('完整正文')
    const original = history(f.dataDir).sessions[0]!
    const resumed = f.start({ resume: original.id, prompt: '构建入口的新任务' })
    expect(await resumed.closed).toEqual({ code: 0, signal: null })
    expect(history(f.dataDir).sessions).toHaveLength(1)
    expect(history(f.dataDir).sessions[0]?.runtimeSessionFile).toBe(original.runtimeSessionFile)
    expect(JSON.stringify(f.requests[2]?.messages)).toContain('源码任务')
    const previous = allFiles(f.dataDir).sort().map((path) => [path, readFileSync(path, 'utf8')])
    const ephemeral = f.start({ json: true, extra: ['--ephemeral'], outputFile: true })
    expect(await ephemeral.closed).toEqual({ code: 0, signal: null })
    expect(readFileSync(join(f.cwd, 'answer.json'), 'utf8')).toBe('完整正文')
    expect(allFiles(f.dataDir).sort().map((path) => [path, readFileSync(path, 'utf8')])).toEqual(previous)
  }, 25000)

  test('后端可执行文件或模块缺失时明确失败、零模型请求，不猜 PATH 或回退源码', async () => {
    for (const file of ['axon-app-server', 'app-server.mjs']) {
      const path = join(bundle, 'backend', file), moved = `${path}.test-missing`
      expect(lstatSync(path).isFile()).toBe(true); renameSync(path, moved)
      try {
        const f = fixture('tool', undefined, binary), command = f.start({ json: true })
        expect(await command.closed).toEqual({ code: 1, signal: null })
        expect(f.requests).toHaveLength(0)
        expect(JSON.parse(command.output.trim().split('\n').at(-1)!)).toMatchObject({ completion: { exitCode: 1 } })
        expect(command.errors).not.toContain('local-cli-secret')
      } finally { renameSync(moved, path) }
    }
  }, 25000)

  test('编译入口的格式失败/信号/期限仍保留旧输出、实际退出并清理临时根', async () => {
    for (const mode of ['schema', 'signal', 'timeout'] as const) {
      const f = fixture(mode === 'schema' ? 'tool' : 'stall', '{}', binary)
      writeFileSync(join(f.cwd, 'answer.json'), 'original')
      const command = f.start({ json: true, outputFile: true, extra: ['--ephemeral'],
        ...(mode === 'schema' ? { schema: { type: 'object', required: ['count'] } } : {}),
        ...(mode === 'timeout' ? { timeout: 5 } : {}) })
      if (mode === 'signal') {
        await Promise.race([f.entered.promise, command.closed.then(() => { throw new Error('模型请求前命令已退出') })])
        command.child.kill('SIGTERM')
      }
      const code = mode === 'schema' ? 3 : mode === 'signal' ? 143 : 124
      expect(await command.closed).toEqual({ code, signal: null })
      expect(readFileSync(join(f.cwd, 'answer.json'), 'utf8')).toBe('original')
      expect(readdirSync(f.dataDir)).toEqual([])
      expect(JSON.parse(command.output.trim().split('\n').at(-1)!)).toMatchObject({ completion: { exitCode: code, cleanup: 'completed' } })
      expect(f.requests).toHaveLength(mode === 'schema' ? 2 : 1)
      expect(() => process.kill(command.child.pid!, 0)).toThrow()
    }
  }, 25000)
})
