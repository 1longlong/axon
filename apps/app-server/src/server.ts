/** 独立 stdio 服务生命周期；日志隔离由 main 在导入本模块前完成。 */
import { AppServerConnection, JsonRpcPeer, RpcFault } from '@axon/app-server'
import { APP_SERVER_DIRECTORY_LOCK_ERROR, APP_SERVER_RPC_OPTIONS } from '@axon/shared'
import { bootstrapAppServerBackend } from './backend-bootstrap'
import type { AppServerStartupConfig } from './startup-config'
import type { AppServerStdio } from './stdio-isolation'
import { AppServerShutdown } from './server-shutdown'
import { acquireBackendDirectoryLease, BackendDirectoryLeaseError } from '@axon/host-node'
import type { BackendDirectoryLease } from '@axon/host-node'

/** 同一物理父连接拥有一个后端；EOF/信号先失效连接，再收束专用进程，不成为 daemon。 */
export function runAppServer(config: AppServerStartupConfig, io: AppServerStdio): void {
  const peer = new JsonRpcPeer(process.stdin, io.protocolOutput, APP_SERVER_RPC_OPTIONS)
  let directoryLease: BackendDirectoryLease | undefined
  const connection = new AppServerConnection({ peer, bootstrap: (input, signal) => bootstrapAppServerBackend(peer, input, config, signal,
    (lockSignal) => {
      lockSignal.throwIfAborted()
      // macOS 的所有正式服务入口共同遵守锁；其他平台桌面不被宣称拥有此能力。
      if (process.platform !== 'darwin' && config.entry !== 'exec') return
      try { directoryLease ??= acquireBackendDirectoryLease(config.dataDir) }
      catch (error) {
        if (error instanceof BackendDirectoryLeaseError) {
          throw new RpcFault(APP_SERVER_DIRECTORY_LOCK_ERROR, '后端数据目录无法独占', { code: error.code })
        }
        throw error
      }
    }) })
  const shutdown = new AppServerShutdown({ connection, input: process.stdin, output: io.protocolOutput,
    diagnostic: () => io.diagnostic('shutdown_failed'), exit: (code) => {
      // drain 和协议 flush 完成后才释放；强制期限退出也紧接着终止本次写入进程。
      try { directoryLease?.release() } catch {
        code = 1
        try { io.diagnostic('shutdown_failed') } catch { /* 诊断失败不能阻止实际退出。 */ }
      }
      process.exit(code)
    } })
  peer.onClose((error) => shutdown.close(error.code === 'eof' || error.code === 'closed' ? 0 : 1))
  process.on('SIGTERM', () => shutdown.close(0))
  process.on('SIGINT', () => shutdown.close(0))
  process.on('uncaughtException', () => shutdown.close(1))
  process.on('unhandledRejection', () => shutdown.close(1))
  io.diagnostic('ready')
}
