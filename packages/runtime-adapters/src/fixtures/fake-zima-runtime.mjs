/** 离线协议桩：由测试以受控可执行文件启动，不连接模型服务。 */
import { createInterface } from 'node:readline'
import { createHash } from 'node:crypto'
import { appendFileSync, mkdirSync, writeFileSync } from 'node:fs'
import { spawn } from 'node:child_process'
import { join } from 'node:path'

const bootId = 'fake-zima-boot'
const runs = new Map()
const mode = process.env.AXON_ZIMA_TEST_MODE
const tracePath = process.env.AXON_ZIMA_TEST_TRACE
function trace(method, params) {
  if (tracePath) appendFileSync(tracePath, `${JSON.stringify({ method, pid: process.pid,
    ...(method === 'interaction.resolve' ? { answers: params.answers } : {}) })}\n`)
}
if (mode) {
  process.on('SIGTERM', () => {})
  setInterval(() => {}, 1_000)
}
trace('started')
if (mode === 'group') {
  // helper 与本进程同组并持有输出管道；仅主进程退出不能结束父端 close 等待。
  spawn(process.execPath, ['-e', `import {appendFileSync} from 'node:fs';
    process.on('SIGTERM',()=>{});setInterval(()=>{},1000);
    appendFileSync(${JSON.stringify(tracePath)},JSON.stringify({method:'helper',pid:process.pid})+'\\n');`],
    { stdio: ['ignore', 'inherit', 'inherit'] })
}

function reply(id, result) {
  process.stdout.write(`${JSON.stringify({ jsonrpc: '2.0', id, result })}\n`)
}

function event(run, name, data) {
  run.sequence += 1
  process.stdout.write(`${JSON.stringify({
    jsonrpc: '2.0', method: 'runtime.event', params: {
      boot_id: bootId, session_id: run.sessionId, run_id: run.runId,
      sequence: run.sequence, event: name, data,
    },
  })}\n`)
}

function finish(run, status = 'success') {
  event(run, 'run.result', { status })
  runs.delete(run.runId)
}

function assistant(run, content, toolCalls = []) {
  event(run, 'assistant.message', {
    message: { message_id: `message-${run.runId}`, content, tool_calls: toolCalls },
    model: 'fake-model', usage: { prompt_tokens: 12, completion_tokens: 3 },
  })
}

/** 每个请求只响应一次；等待授权、宿主工具或停止时保留运行状态。 */
createInterface({ input: process.stdin }).on('line', (line) => {
  const request = JSON.parse(line)
  const { id, method, params = {} } = request
  trace(method, params)
  if (method === 'runtime.handshake') {
    if (mode === 'handshake') return
    reply(id, { protocol_version: mode === 'invalid-handshake' ? 1 : 2,
      runtime: { name: 'zima-agent-runtime', version: '1.0.0-test', boot_id: bootId } })
    return
  }
  if (method === 'runtime.shutdown') {
    if (mode === 'shutdown') return
    reply(id, { shutdown: true })
    process.exit(0)
  }
  if (method === 'session.run') {
    if (mode === 'accept') return
    const directory = join(params.runtime.session_directory, params.session_id)
    mkdirSync(directory, { recursive: true })
    writeFileSync(join(directory, 'state.json'), params.prompt === 'thinking-config'
      ? JSON.stringify({ thinking_level: params.model.thinking_level })
      : '{}')
    const run = { sessionId: params.session_id, runId: params.run_id, prompt: params.prompt, sequence: 0 }
    runs.set(run.runId, run)
    reply(id, { accepted: true, session_id: run.sessionId, run_id: run.runId, artifact_directory: directory })
    if (run.prompt === 'crash') process.exit(2)
    if (run.prompt === 'malformed') {
      process.stdout.write('{not-json}\n')
      return
    }
    if (run.prompt === 'abort') return
    if (run.prompt === 'ask-user') {
      // 完整参数必须通过生产 AskUserQuestion 解析，不能用接受任意参数的自定义工具代替。
      const tool = params.tools.host_tools.find((candidate) => candidate.name === 'AskUserQuestion')
      if (!tool?.input_schema.required.includes('questions')) throw new Error('缺少追问工具定义')
      run.toolName = tool.name
      const toolCallId = `tool-${run.runId}`
      const args = { questions: [{ question: '选择测试输出格式', options: [{ label: '简洁' }, { label: '详细' }] }] }
      assistant(run, '', [{ id: toolCallId, function: { name: tool.name, arguments: args } }])
      event(run, 'interaction.requested', { request_id: `callback-${run.runId}`, tool_call_id: toolCallId,
        name: tool.name, arguments: args })
      return
    }
    if (run.prompt === 'mcp') {
      // 使用实际下发的宿主工具目录；不绕开 Axon 的 MCP 发现、授权或执行链。
      const tool = params.tools.host_tools.find((candidate) => candidate.name === 'mcp__fixture__hold')
      if (!tool || tool.input_schema.properties?.value?.type !== 'string') throw new Error('缺少 MCP 宿主工具定义')
      run.toolName = tool.name
      const toolCallId = `tool-${run.runId}`
      const args = { value: '隔离 MCP 输入' }
      assistant(run, '', [{ id: toolCallId, function: { name: tool.name, arguments: args } }])
      event(run, 'host_tool.requested', { request_id: `callback-${run.runId}`, tool_call_id: toolCallId,
        name: tool.name, arguments: args })
      return
    }
    if (run.prompt === 'approval' || run.prompt === 'host' || run.prompt === 'interaction') {
      const name = run.prompt === 'approval' ? 'Write' : 'remote_echo'
      const toolCallId = `tool-${run.runId}`
      assistant(run, '', [{ id: toolCallId, function: { name, arguments: { path: 'demo.txt', value: 'hello' } } }])
      event(run, run.prompt === 'approval' ? 'approval.requested'
        : run.prompt === 'interaction' ? 'interaction.requested' : 'host_tool.requested', {
        request_id: `callback-${run.runId}`, tool_call_id: toolCallId,
        name, arguments: { path: 'demo.txt', value: 'hello' },
      })
      return
    }
    if (run.prompt === 'retry') {
      event(run, 'assistant.delta', { message_id: 'draft-old', channel: 'text', delta: '旧' })
      event(run, 'retry.scheduled', { discarded_message_ids: ['draft-old'], next_attempt: 2, max_attempts: 3, delay_seconds: 0 })
    }
    if (run.prompt === 'compact' || run.prompt === 'compact-missing') {
      event(run, 'context.compaction_started', { reason: 'threshold', step: 1 })
      const summaryId = 'summary-contract-test'
      {
        const filename = 'messages.0123456789abcdef0123456789abcdef.jsonl'
        const snapshot = run.prompt === 'compact'
          ? `${JSON.stringify({ index: 0, message: {
            role: 'system', content: '<context_summary>\n保留的会话摘要\n</context_summary>',
            metadata: { kind: 'context_summary', summary_id: summaryId },
          } })}\n`
          : ''
        writeFileSync(join(directory, filename), snapshot)
        writeFileSync(join(directory, 'state.json'), JSON.stringify({
          session_id: run.sessionId, messages_file: filename,
          messages_sha256: createHash('sha256').update(snapshot).digest('hex'),
        }))
      }
      event(run, 'context.compacted', { summary_id: summaryId, before_tokens: 100, after_tokens: 20 })
      finish(run)
      return
    }
    if (run.prompt === 'interleaved') {
      const messageId = `message-${run.runId}`
      const toolCallId = `tool-${run.runId}`
      event(run, 'assistant.delta', { message_id: messageId, channel: 'thinking', delta: '先思考' })
      event(run, 'assistant.delta', { message_id: messageId, channel: 'text', delta: '先回答' })
      event(run, 'assistant.delta', { message_id: messageId, channel: 'tool_call', phase: 'start', tool_call_id: toolCallId, name: 'Read', index: 0 })
      event(run, 'assistant.delta', { message_id: messageId, channel: 'tool_call', phase: 'arguments_delta', tool_call_id: toolCallId, name: 'Read', index: 0, delta: '{"path":"a.txt"}' })
      event(run, 'assistant.delta', { message_id: messageId, channel: 'thinking', delta: '再思考' })
      event(run, 'assistant.delta', { message_id: messageId, channel: 'text', delta: '再回答' })
      event(run, 'assistant.message', {
        message: { message_id: messageId, content: '先回答再回答', reasoning_content: '先思考再思考',
          tool_calls: [{ id: toolCallId, function: { name: 'Read', arguments: { path: 'a.txt' } } }] },
        model: 'fake-model', usage: { prompt_tokens: 12, completion_tokens: 3 },
      })
      finish(run)
      return
    }
    event(run, 'assistant.delta', { message_id: `message-${run.runId}`, channel: 'text', delta: '完成' })
    assistant(run, '完成')
    event(run, 'usage.updated', { run_usage: { prompt_tokens: 12, completion_tokens: 3 } })
    finish(run)
    return
  }
  const run = runs.get(params.run_id)
  if (method === 'session.abort' && run) {
    reply(id, { aborted: true })
    finish(run, 'aborted')
    return
  }
  if ((method === 'approval.resolve' || method === 'host_tool.resolve' || method === 'interaction.resolve') && run) {
    reply(id, { resolved: true })
    const toolCallId = `tool-${run.runId}`
    event(run, 'tool.finished', {
      tool_call_id: toolCallId, name: run.toolName ?? (run.prompt === 'approval' ? 'Write' : 'remote_echo'),
      result: { status: params.behavior === 'deny' || params.is_error ? 'error' : 'success', content: params.content ?? 'ok' },
    })
    finish(run)
  }
})
