/** 独立 stdio 服务生命周期；日志隔离由 main 在导入本模块前完成。 */
import { AppServerConnection, JsonRpcPeer } from '@axon/app-server'
import { APP_SERVER_RPC_OPTIONS } from '@axon/shared'
import { bootstrapAppServerBackend } from './backend-bootstrap'
import type { AppServerStartupConfig } from './startup-config'
import type { AppServerStdio } from './stdio-isolation'
import { AppServerShutdown } from './server-shutdown'

/** 同一物理父连接拥有一个后端；EOF/信号先失效连接，再收束专用进程，不成为 daemon。 */
export function runAppServer(config: AppServerStartupConfig, io: AppServerStdio): void {
  const peer = new JsonRpcPeer(process.stdin, io.protocolOutput, APP_SERVER_RPC_OPTIONS)
  const connection = new AppServerConnection({ peer, bootstrap: (input, signal) => bootstrapAppServerBackend(peer, input, config, signal) })
  const shutdown = new AppServerShutdown({ connection, input: process.stdin, output: io.protocolOutput,
    diagnostic: () => io.diagnostic('shutdown_failed'), exit: (code) => process.exit(code) })
  peer.onClose((error) => shutdown.close(error.code === 'eof' || error.code === 'closed' ? 0 : 1))
  process.on('SIGTERM', () => shutdown.close(0))
  process.on('SIGINT', () => shutdown.close(0))
  process.on('uncaughtException', () => shutdown.close(1))
  process.on('unhandledRejection', () => shutdown.close(1))
  io.diagnostic('ready')
}
