/** 使用本机现有渠道做一次真实 Zima 模型请求；只输出状态，不输出凭据。 */
import { app } from 'electron'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { getChannelManager } from '../src/main/lib/channel/channel-manager-instance'
import { assertZimaConnection, ZimaAgentAdapter } from '../src/main/lib/adapters/zima-agent-adapter'

// 与正常开发启动的应用名保持一致，macOS 安全存储按应用身份读取既有凭据。
app.setName('@axon/electron')

void app.whenReady().then(async () => {
  const python = process.env.AXON_ZIMA_PYTHON
  const channelId = process.env.AXON_ZIMA_LIVE_CHANNEL_ID
  if (!python || !channelId) throw new Error('必须指定受控 Python 和明确的本机渠道 ID')
  const channel = getChannelManager().resolve(channelId)
  assertZimaConnection(channel)
  const model = process.env.AXON_ZIMA_LIVE_MODEL_ID ?? channel.models.find((item) => item.enabled)?.id
  if (!model) throw new Error('所选渠道没有启用的模型')

  const directory = mkdtempSync(join(tmpdir(), 'axon-zima-live-model-'))
  const adapter = new ZimaAgentAdapter(python, app.getVersion())
  const abort = new AbortController()
  const timer = setTimeout(() => abort.abort(), 45_000)
  let result = 'missing'
  let answer = ''
  try {
    for await (const event of adapter.query({
      sessionId: 'live-model-smoke', prompt: 'Reply with exactly AXON_ZIMA_OK.',
      model, cwd: directory, connection: channel,
      runtimeSessionDir: join(directory, 'runtime'), allowedBuiltinTools: [],
      abortSignal: abort.signal,
    })) {
      if (event.kind !== 'sdk_message') continue
      if (event.message.type === 'assistant') {
        answer = event.message.message.content
          .filter((block): block is { type: 'text'; text: string } => block.type === 'text' && 'text' in block)
          .map((block) => block.text).join('')
      }
      if (event.message.type === 'result') {
        result = event.message.subtype === 'success'
          ? 'success'
          : `${event.message.error?.code ?? event.message.terminal_reason ?? 'failed'}`
      }
    }
    console.log(JSON.stringify({ runtime: 'zima', provider: channel.provider, model, result, answer: answer.slice(0, 200) }))
    if (result !== 'success') throw new Error(`真实模型冒烟未成功：${result}`)
  } finally {
    clearTimeout(timer)
    adapter.dispose()
    rmSync(directory, { recursive: true, force: true })
  }
  app.exit(0)
}).catch((error: unknown) => {
  console.error(error instanceof Error ? error.message : '真实模型冒烟失败')
  app.exit(1)
})
