/** 进程入口：先保留私有协议输出，再解析可信启动参数并加载实际后端。 */
import { isolateAppServerStdio } from './stdio-isolation'
import { parseAppServerStartupConfig } from './startup-config'

const io = isolateAppServerStdio()
// 该标记只用于启动 Electron 自带执行器，不能进入工具环境或 Shell 快照。
delete process.env.ELECTRON_RUN_AS_NODE
try {
  const config = parseAppServerStartupConfig(process.argv.slice(2), process.env)
  const { runAppServer } = await import('./server')
  runAppServer(config, io)
} catch {
  io.diagnostic('startup_failed')
  process.exitCode = 1
}
