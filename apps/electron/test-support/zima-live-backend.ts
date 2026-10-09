/** Zima 单独 adapter 诊断：实际后端/凭据桥在 child，不冒充完整 Agent 桌面链。 */
import { join } from 'node:path'
import { AppServerConnection, JsonRpcPeer, RpcFault } from '@axon/app-server'
import type { AppServerBootstrap } from '@axon/app-server'
import { APP_SERVER_RPC_OPTIONS } from '@axon/shared'
import type { SDKAssistantMessage, SDKResultMessage } from '@axon/shared'
import { isolateAppServerStdio } from '../../app-server/src/stdio-isolation'
import { parseAppServerStartupConfig } from '../../app-server/src/startup-config'
import { bootstrapAppServerBackend } from '../../app-server/src/backend-bootstrap'
import { AppServerShutdown } from '../../app-server/src/server-shutdown'

const io = isolateAppServerStdio()
delete process.env.ELECTRON_RUN_AS_NODE
const config = parseAppServerStartupConfig(process.argv.slice(2), process.env)
const peer = new JsonRpcPeer(process.stdin, io.protocolOutput, APP_SERVER_RPC_OPTIONS)
let initialized: AppServerBootstrap | undefined
const connection = new AppServerConnection({ peer, bootstrap: async (input, signal) => {
  initialized = await bootstrapAppServerBackend(peer, input, config, signal)
  return initialized
} })
let started = false
// 仅限可信测试父端的一次诊断，生产程序没有此方法，不向 renderer 开放。
peer.handle('axon/test/zima/live', async (input, { signal }) => {
  if (!initialized || connection.closed || started) throw new RpcFault(-32002, '测试后端未就绪或已执行')
  if (Array.isArray(input) || Object.keys(input).some((key) => key !== 'channelId' && key !== 'modelId')
    || typeof input.channelId !== 'string' || !input.channelId
    || input.modelId !== undefined && typeof input.modelId !== 'string') throw new RpcFault(-32602, '测试渠道参数无效')
  started = true
  try {
    const backend = initialized.backend
    const channel = await backend.channels.resolve(input.channelId)
    const model = typeof input.modelId === 'string' ? input.modelId : channel.models.find((item) => item.enabled)?.id
    if (!channel.enabled || !model || !channel.models.some((item) => item.id === model && item.enabled)) throw new Error('测试模型不可用')
    const adapter = backend.getAdapter('zima')
    let result = 'missing', answer = ''
    // 保留原诊断的零工具边界，不能因为改用子进程而扩大模型可执行权限。
    for await (const event of adapter.query({
      sessionId: 'live-model-smoke', prompt: 'Reply with exactly AXON_ZIMA_OK.', model,
      cwd: config.homeDir, connection: channel, runtimeSessionDir: join(config.dataDir, 'runtime'),
      allowedBuiltinTools: [], abortSignal: signal,
    })) {
      if (event.kind !== 'sdk_message') continue
      if (event.message.type === 'assistant') {
        const message = event.message as SDKAssistantMessage
        answer = message.message.content.filter((block) => block.type === 'text')
          .map((block) => 'text' in block && typeof block.text === 'string' ? block.text : '').join('')
      }
      if (event.message.type === 'result') {
        const message = event.message as SDKResultMessage
        result = message.subtype === 'success' ? 'success' : message.error?.code ?? message.terminal_reason ?? 'failed'
      }
    }
    signal.throwIfAborted()
    return { runtime: 'zima', provider: channel.provider, model, result, answer: answer.slice(0, 200) }
  } catch { throw new RpcFault(-32003, 'Zima 独立诊断失败') }
})
// 诊断入口也复用生产的有界 drain；不能只 flush 管道而遗漏在途 Runtime。
const shutdown = new AppServerShutdown({ connection, input: process.stdin, output: io.protocolOutput,
  diagnostic: () => io.diagnostic('shutdown_failed'), exit: (code) => process.exit(code) })
peer.onClose((error) => shutdown.close(error.code === 'eof' || error.code === 'closed' ? 0 : 1))
process.once('SIGTERM', () => shutdown.close(0))
process.once('SIGINT', () => shutdown.close(0))
process.once('uncaughtException', () => shutdown.close(1))
process.once('unhandledRejection', () => shutdown.close(1))
io.diagnostic('ready')
