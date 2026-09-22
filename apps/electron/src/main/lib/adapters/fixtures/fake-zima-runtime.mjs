/** 离线协议桩：由测试以受控可执行文件启动，不连接模型服务。 */
import { createInterface } from 'node:readline'
import { createHash } from 'node:crypto'
import { mkdirSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'

const bootId = 'fake-zima-boot'
const runs = new Map()

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
  if (method === 'runtime.handshake') {
    reply(id, { protocol_version: 2, runtime: { name: 'zima-agent-runtime', version: '1.0.0-test', boot_id: bootId } })
    return
  }
  if (method === 'runtime.shutdown') {
    reply(id, { shutdown: true })
    process.exit(0)
  }
  if (method === 'session.run') {
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
    if (run.prompt === 'approval' || run.prompt === 'host') {
      const name = run.prompt === 'approval' ? 'Write' : 'remote_echo'
      const toolCallId = `tool-${run.runId}`
      assistant(run, '', [{ id: toolCallId, function: { name, arguments: { path: 'demo.txt', value: 'hello' } } }])
      event(run, run.prompt === 'approval' ? 'approval.requested' : 'host_tool.requested', {
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
  if ((method === 'approval.resolve' || method === 'host_tool.resolve') && run) {
    reply(id, { resolved: true })
    const toolCallId = `tool-${run.runId}`
    event(run, 'tool.finished', {
      tool_call_id: toolCallId, name: run.prompt === 'approval' ? 'Write' : 'remote_echo',
      result: { status: params.behavior === 'deny' || params.is_error ? 'error' : 'success', content: params.content ?? 'ok' },
    })
    finish(run)
  }
})
